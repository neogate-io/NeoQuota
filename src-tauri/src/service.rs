use anyhow::{anyhow, Context, Result};
use lettre::{transport::smtp::authentication::Credentials, Message, SmtpTransport, Transport};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter};
use tokio::{
    task::JoinSet,
    time::{sleep, Duration},
};

use crate::{
    cpa::{api_call_error_message, codex_usage_request, usage_risk_reason, CpaClient},
    models::{
        AppConfig, CollectorPreferences, CpaTargetConfig, EmailAlertSettings,
        SaveCollectorSettings, SaveEmailAlertSettings, SaveTargetRequest,
    },
    pricing, quota, secrets,
    storage::{build_latest_payload, normalize_api_base, Storage},
};

const MIN_COLLECT_TICK_SECONDS: u64 = 60;
const MAX_COLLECT_TICK_SECONDS: u64 = 60 * 60;
const MIN_COLLECT_CONCURRENCY: usize = 1;
const MAX_COLLECT_CONCURRENCY: usize = 10;
const MIN_USAGE_REQUESTS_PER_MINUTE: f64 = 1.0;
const MAX_USAGE_REQUESTS_PER_MINUTE: f64 = 60.0;
const RISK_FUSE_MIN_FAILURES: usize = 3;
const SOFT_QUOTA_WINDOW_MISSING_ALERT_KEY: &str = "account-issues:soft-quota-window-missing";

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectorState {
    pub status: String,
    pub last_started_at: Option<i64>,
    pub last_completed_at: Option<i64>,
    pub last_error: Option<String>,
    pub next_run_at: Option<i64>,
    pub progress_completed_accounts: Option<usize>,
    pub progress_total_accounts: Option<usize>,
}

#[derive(Debug)]
struct CollectJob {
    index: usize,
    file: Value,
}

#[derive(Debug)]
struct CollectJobResult {
    index: usize,
    account_key: String,
    row: Value,
    status_code: Option<u16>,
    risk_reason: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AccountIssueSeverity {
    Soft,
    Severe,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct AccountIssueSummary {
    severe: usize,
    soft: usize,
}

impl AccountIssueSummary {
    fn total(self) -> usize {
        self.severe + self.soft
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AlertDecisionKind {
    Risk,
    SevereAccountIssues,
    SoftAccountIssues,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct AlertDecision {
    kind: AlertDecisionKind,
    cooldown_key: String,
    cooldown_minutes: u32,
    persistent_cooldown: bool,
    level: String,
    reason: String,
}

#[derive(Debug)]
struct UsageRateLimiter {
    next_slot_at: Mutex<i64>,
}

impl UsageRateLimiter {
    fn new() -> Self {
        Self {
            next_slot_at: Mutex::new(0),
        }
    }

    async fn wait(&self, requests_per_minute: f64) {
        let rpm = normalize_usage_requests_per_minute_value(requests_per_minute);
        let spacing_ms = (60_000.0 / rpm).ceil() as i64;
        loop {
            let wait_ms = {
                let now = now_ms();
                let mut next_slot_at = self
                    .next_slot_at
                    .lock()
                    .expect("usage limiter mutex poisoned");
                if now >= *next_slot_at {
                    *next_slot_at = now + spacing_ms;
                    0
                } else {
                    *next_slot_at - now
                }
            };
            if wait_ms <= 0 {
                return;
            }
            sleep(Duration::from_millis(wait_ms as u64)).await;
        }
    }
}

impl Default for CollectorState {
    fn default() -> Self {
        Self {
            status: "idle".to_string(),
            last_started_at: None,
            last_completed_at: None,
            last_error: None,
            next_run_at: None,
            progress_completed_accounts: None,
            progress_total_accounts: None,
        }
    }
}

#[derive(Debug)]
pub struct AppService {
    storage: Storage,
    config: Mutex<AppConfig>,
    collector_states: Mutex<HashMap<String, CollectorState>>,
    running_targets: Mutex<HashSet<String>>,
    alert_last_sent_at: Mutex<HashMap<String, i64>>,
    app_handle: Mutex<Option<AppHandle>>,
    paused: AtomicBool,
    usage_limiter: Arc<UsageRateLimiter>,
}

impl AppService {
    pub fn new(storage: Storage) -> Result<Arc<Self>> {
        let mut config = storage.load_config()?;
        if sync_secret_flags(&mut config)? {
            storage.save_config(&config)?;
        }
        let paused = !config.collector.auto_collect_enabled;
        Ok(Arc::new(Self {
            storage,
            config: Mutex::new(config),
            collector_states: Mutex::new(HashMap::new()),
            running_targets: Mutex::new(HashSet::new()),
            alert_last_sent_at: Mutex::new(HashMap::new()),
            app_handle: Mutex::new(None),
            paused: AtomicBool::new(paused),
            usage_limiter: Arc::new(UsageRateLimiter::new()),
        }))
    }

    pub fn set_app_handle(&self, app_handle: AppHandle) {
        *self.app_handle.lock().expect("app handle mutex poisoned") = Some(app_handle);
    }

    pub fn start_background(self: &Arc<Self>) {
        let service = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            loop {
                let preferences = service.collector_preferences();
                let tick_seconds = preferences.collect_usage_tick_seconds.max(5);
                if preferences.auto_collect_enabled {
                    let targets = service.enabled_targets();
                    for target in targets {
                        let service = Arc::clone(&service);
                        if !service.is_target_running(&target.id) {
                            tauri::async_runtime::spawn(async move {
                                let _ = service.collect_target(target.id, false).await;
                            });
                        }
                    }
                }
                sleep(Duration::from_secs(tick_seconds)).await;
            }
        });
    }

    pub fn get_app_state(&self) -> Result<Value> {
        let config = self.config_with_secret_flags()?;
        let paused = !config.collector.auto_collect_enabled;
        Ok(json!({
            "configured": !config.targets.is_empty(),
            "targets": config.targets,
            "paused": paused,
            "collector": config.collector,
            "emailAlert": config.email_alert,
            "pricingProfile": config.pricing_profile
        }))
    }

    pub fn list_targets(&self) -> Result<Vec<CpaTargetConfig>> {
        Ok(self.config_with_secret_flags()?.targets)
    }

    pub fn save_target(&self, request: SaveTargetRequest) -> Result<CpaTargetConfig> {
        let name = request.name.trim();
        if name.is_empty() {
            return Err(anyhow!("请输入 CPA 名称"));
        }
        let api_base = normalize_api_base(&request.api_base)?;
        let mut config = self.config.lock().expect("config mutex poisoned");
        let id = request
            .id
            .as_deref()
            .map(sanitize_id)
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| unique_target_id(&config.targets, name));
        let existing = config
            .targets
            .iter()
            .find(|target| target.id == id)
            .cloned();
        let provided_key = request
            .management_key
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());
        if let Some(key) = provided_key {
            secrets::set_secret(&secrets::target_key_name(&id), key)?;
        }
        let has_management_key = secrets::get_secret(&secrets::target_key_name(&id))?.is_some();
        if !has_management_key {
            let message = if existing.is_some() {
                "CPA Management Key 未保存，请重新输入后保存"
            } else {
                "请输入 CPA Management Key"
            };
            return Err(anyhow!(message));
        }

        let target = CpaTargetConfig {
            id: id.clone(),
            name: name.to_string(),
            api_base,
            enabled: request.enabled,
            has_management_key,
        };
        if let Some(index) = config.targets.iter().position(|item| item.id == id) {
            config.targets[index] = target.clone();
        } else {
            config.targets.push(target.clone());
        }
        self.storage.save_config(&config)?;
        Ok(target)
    }

    pub fn delete_target(&self, target_id: String) -> Result<()> {
        let mut config = self.config.lock().expect("config mutex poisoned");
        config.targets.retain(|target| target.id != target_id);
        self.storage.save_config(&config)?;
        secrets::delete_secret(&secrets::target_key_name(&target_id))?;
        self.storage.clear_history(Some(&target_id))?;
        self.storage.clear_cooldowns(Some(&target_id))?;
        self.collector_states
            .lock()
            .expect("collector state mutex poisoned")
            .remove(&target_id);
        Ok(())
    }

    pub async fn test_target_connection(&self, request: SaveTargetRequest) -> Result<Value> {
        let api_base = normalize_api_base(&request.api_base)?;
        let id = request
            .id
            .as_deref()
            .map(sanitize_id)
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| sanitize_id(&request.name));
        let key = request
            .management_key
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .or_else(|| {
                secrets::get_secret(&secrets::target_key_name(&id))
                    .ok()
                    .flatten()
            })
            .ok_or_else(|| anyhow!("请输入 CPA Management Key"))?;
        let target = CpaTargetConfig {
            id,
            name: request.name.trim().to_string(),
            api_base,
            enabled: true,
            has_management_key: true,
        };
        let timeout = self.collector_preferences().cpa_request_timeout_seconds;
        let client = CpaClient::new(target, key, timeout)?;
        let files = client.list_auth_files().await?;
        let codex_count = files
            .iter()
            .filter(|file| quota::is_codex_file(file))
            .count();
        Ok(json!({
            "ok": true,
            "totalAuthFiles": files.len(),
            "codexAuthFiles": codex_count
        }))
    }

    pub fn latest_payload(&self, cpa_id: Option<String>) -> Result<Value> {
        let config = self.config.lock().expect("config mutex poisoned").clone();
        let selected = self.resolve_selected_target(&config, cpa_id.as_deref());
        let snapshot = selected
            .as_ref()
            .and_then(|target| self.storage.latest_snapshot(&target.id).ok().flatten());
        let history_since = now_ms() - 4 * 60 * 60 * 1000;
        let history = selected
            .as_ref()
            .map(|target| self.storage.recent_snapshots(&target.id, history_since))
            .transpose()?
            .unwrap_or_default();
        let collector_state = selected
            .as_ref()
            .map(|target| self.collector_state_value(&target.id))
            .unwrap_or_else(|| {
                serde_json::to_value(CollectorState::default()).unwrap_or(Value::Null)
            });
        Ok(build_latest_payload(
            &config.targets,
            selected.as_ref().map(|target| target.id.as_str()),
            snapshot,
            &history,
            collector_state,
            &config.collector,
            config.pricing_profile,
        ))
    }

    pub async fn refresh_target(&self, cpa_id: String) -> Result<Value> {
        self.collect_target(cpa_id.clone(), true).await?;
        self.latest_payload(Some(cpa_id))
    }

    pub async fn refresh_account(&self, cpa_id: String, account_key: String) -> Result<Value> {
        self.collect_account(cpa_id.clone(), account_key).await?;
        self.latest_payload(Some(cpa_id))
    }

    pub async fn set_account_disabled(
        &self,
        cpa_id: String,
        auth_file_name: String,
        disabled: bool,
    ) -> Result<Value> {
        let auth_file_name = normalize_auth_file_name(auth_file_name)?;
        {
            let mut running = self
                .running_targets
                .lock()
                .expect("running targets mutex poisoned");
            if !running.insert(cpa_id.clone()) {
                return Err(anyhow!("当前 CPA 正在采集中，请稍后再修改凭证状态"));
            }
        }

        let result = self
            .set_account_disabled_inner(cpa_id.clone(), auth_file_name, disabled)
            .await;
        self.running_targets
            .lock()
            .expect("running targets mutex poisoned")
            .remove(&cpa_id);
        result?;
        self.latest_payload(Some(cpa_id))
    }

    pub async fn delete_account_credential(
        &self,
        cpa_id: String,
        auth_file_name: String,
    ) -> Result<Value> {
        let auth_file_name = normalize_auth_file_name(auth_file_name)?;
        {
            let mut running = self
                .running_targets
                .lock()
                .expect("running targets mutex poisoned");
            if !running.insert(cpa_id.clone()) {
                return Err(anyhow!("当前 CPA 正在采集中，请稍后再删除凭证"));
            }
        }

        let result = self
            .delete_account_credential_inner(cpa_id.clone(), auth_file_name)
            .await;
        self.running_targets
            .lock()
            .expect("running targets mutex poisoned")
            .remove(&cpa_id);
        result?;
        self.latest_payload(Some(cpa_id))
    }

    pub fn clear_history(&self, cpa_id: Option<String>) -> Result<Value> {
        self.storage.clear_history(cpa_id.as_deref())?;
        Ok(json!({ "ok": true }))
    }

    pub fn get_pricing(&self) -> Value {
        self.config
            .lock()
            .expect("config mutex poisoned")
            .pricing_profile
            .clone()
    }

    pub fn save_pricing(&self, profile: Value) -> Result<Value> {
        let profile = pricing::normalize_pricing_profile(profile);
        let mut config = self.config.lock().expect("config mutex poisoned");
        config.pricing_profile = profile.clone();
        self.storage.save_config(&config)?;
        Ok(profile)
    }

    pub fn get_alert_settings(&self) -> Result<Value> {
        Ok(
            serde_json::to_value(self.config_with_secret_flags()?.email_alert)
                .unwrap_or(Value::Null),
        )
    }

    pub fn save_alert_settings(&self, settings: SaveEmailAlertSettings) -> Result<Value> {
        let has_password = if let Some(password) = settings
            .smtp_password
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            secrets::set_secret(secrets::smtp_password_name(), password)?;
            true
        } else {
            secrets::get_secret(secrets::smtp_password_name())?.is_some()
        };
        let sanitized = settings.without_password(has_password);
        let mut config = self.config.lock().expect("config mutex poisoned");
        config.email_alert = sanitized.clone();
        self.storage.save_config(&config)?;
        Ok(serde_json::to_value(sanitized).unwrap_or(Value::Null))
    }

    pub fn send_test_email(&self, settings: SaveEmailAlertSettings) -> Result<Value> {
        self.save_alert_settings(settings)?;
        let config = self
            .config
            .lock()
            .expect("config mutex poisoned")
            .email_alert
            .clone();
        let password = secrets::get_secret(secrets::smtp_password_name())?.unwrap_or_default();
        send_email(
            &config,
            &password,
            "[NeoQuota Monitor] 邮箱告警测试",
            "NeoQuota Monitor 邮箱告警配置可用。",
        )?;
        Ok(json!({ "ok": true }))
    }

    pub fn export_snapshot(&self, cpa_id: String) -> Result<Value> {
        let mut payload = self.latest_payload(Some(cpa_id))?;
        payload["exportedAt"] = json!(now_ms());
        Ok(payload)
    }

    pub fn pause_collector(&self) -> Result<Value> {
        self.set_auto_collect_enabled(false)
    }

    pub fn resume_collector(&self) -> Result<Value> {
        self.set_auto_collect_enabled(true)
    }

    pub fn toggle_collector(&self) -> Result<Value> {
        let enabled = self
            .config
            .lock()
            .expect("config mutex poisoned")
            .collector
            .auto_collect_enabled;
        self.set_auto_collect_enabled(!enabled)
    }

    pub fn save_collector_settings(&self, settings: SaveCollectorSettings) -> Result<Value> {
        let current_preferences = self.collector_preferences();
        let tick_seconds = normalize_collect_tick_seconds_with_default(
            &settings,
            current_preferences.collect_usage_tick_seconds,
        );
        let collect_concurrency = normalize_collect_concurrency(
            settings
                .collect_concurrency
                .unwrap_or(current_preferences.collect_concurrency),
        );
        let collect_manual_concurrency = normalize_collect_concurrency(
            settings
                .collect_manual_concurrency
                .unwrap_or(current_preferences.collect_manual_concurrency),
        );
        let requests_per_minute = normalize_usage_requests_per_minute_value(
            settings
                .collect_usage_max_requests_per_minute
                .unwrap_or(current_preferences.collect_usage_max_requests_per_minute),
        );
        let mut config = self.config.lock().expect("config mutex poisoned");
        config.collector.auto_collect_enabled = settings.auto_collect_enabled;
        config.collector.collect_usage_tick_seconds = tick_seconds;
        config.collector.collect_concurrency = collect_concurrency;
        config.collector.collect_manual_concurrency = collect_manual_concurrency;
        config.collector.collect_usage_max_requests_per_minute = requests_per_minute;
        config.collector.collect_manual_max_requests_per_minute = requests_per_minute;
        self.storage.save_config(&config)?;
        self.paused
            .store(!config.collector.auto_collect_enabled, Ordering::Relaxed);
        Ok(serde_json::to_value(&config.collector).unwrap_or(Value::Null))
    }

    pub async fn collect_first_enabled(self: Arc<Self>) {
        if let Some(target) = self.enabled_targets().first().cloned() {
            let _ = self.collect_target(target.id, true).await;
        }
    }

    async fn collect_target(&self, cpa_id: String, manual: bool) -> Result<()> {
        {
            let mut running = self
                .running_targets
                .lock()
                .expect("running targets mutex poisoned");
            if !running.insert(cpa_id.clone()) {
                return Ok(());
            }
        }

        let result = self.collect_target_inner(cpa_id.clone(), manual).await;
        self.running_targets
            .lock()
            .expect("running targets mutex poisoned")
            .remove(&cpa_id);
        result
    }

    async fn collect_account(&self, cpa_id: String, account_key: String) -> Result<()> {
        let account_key = account_key.trim().to_string();
        if account_key.is_empty() {
            return Err(anyhow!("账号标识不能为空"));
        }
        {
            let mut running = self
                .running_targets
                .lock()
                .expect("running targets mutex poisoned");
            if !running.insert(cpa_id.clone()) {
                return Err(anyhow!("当前 CPA 正在采集中，请稍后再刷新单个账号"));
            }
        }

        let result = self
            .collect_account_inner(cpa_id.clone(), account_key)
            .await;
        self.running_targets
            .lock()
            .expect("running targets mutex poisoned")
            .remove(&cpa_id);
        result
    }

    async fn set_account_disabled_inner(
        &self,
        cpa_id: String,
        auth_file_name: String,
        disabled: bool,
    ) -> Result<()> {
        let config = self.config.lock().expect("config mutex poisoned").clone();
        let target = config
            .targets
            .iter()
            .find(|target| target.id == cpa_id && target.enabled)
            .cloned()
            .ok_or_else(|| anyhow!("CPA 目标不存在或未启用"))?;
        let management_key = secrets::get_secret(&secrets::target_key_name(&target.id))?
            .ok_or_else(|| anyhow!("CPA Management Key 未保存"))?;
        let client = Arc::new(CpaClient::new(
            target.clone(),
            management_key,
            config.collector.cpa_request_timeout_seconds,
        )?);
        client
            .set_auth_file_disabled(&auth_file_name, disabled)
            .await?;
        let auth_files = client.list_auth_files().await?;
        let Some(file) = auth_files
            .into_iter()
            .filter(quota::is_codex_file)
            .find(|file| quota::auth_file_matches_name(file, &auth_file_name))
        else {
            return Err(anyhow!("未找到凭证：{auth_file_name}"));
        };

        let started_at = now_ms();
        let mut result = AppService::fetch_codex_row(
            Arc::clone(&client),
            target.clone(),
            file,
            config.pricing_profile.clone(),
            Arc::clone(&self.usage_limiter),
            collect_requests_per_minute(true, &config.collector),
        )
        .await;
        let row = self.finalize_collect_row(
            &target.id,
            &result.account_key,
            result.row,
            result.risk_reason.take(),
            result.status_code,
            &config.collector,
        )?;
        self.upsert_snapshot_row(&target, started_at, row, &auth_file_name)?;
        self.emit_latest(&target.id);
        self.evaluate_alerts(&target.id);
        Ok(())
    }

    async fn delete_account_credential_inner(
        &self,
        cpa_id: String,
        auth_file_name: String,
    ) -> Result<()> {
        let config = self.config.lock().expect("config mutex poisoned").clone();
        let target = config
            .targets
            .iter()
            .find(|target| target.id == cpa_id && target.enabled)
            .cloned()
            .ok_or_else(|| anyhow!("CPA 目标不存在或未启用"))?;
        let management_key = secrets::get_secret(&secrets::target_key_name(&target.id))?
            .ok_or_else(|| anyhow!("CPA Management Key 未保存"))?;
        let client = CpaClient::new(
            target.clone(),
            management_key,
            config.collector.cpa_request_timeout_seconds,
        )?;
        client.delete_auth_file(&auth_file_name).await?;

        let mut rows = self
            .storage
            .latest_snapshot(&target.id)?
            .map(|snapshot| snapshot.rows)
            .unwrap_or_default();
        let mut cooldown_keys = HashSet::new();
        rows.retain(|row| {
            let matches = row_matches_auth_file(row, &auth_file_name);
            if matches {
                collect_row_cooldown_keys(row, &mut cooldown_keys);
            }
            !matches
        });
        for key in cooldown_keys {
            self.storage.clear_cooldown(&target.id, &key)?;
        }
        self.save_snapshot_rows(&target, now_ms(), &rows)?;
        self.emit_latest(&target.id);
        self.evaluate_alerts(&target.id);
        Ok(())
    }

    async fn collect_account_inner(&self, cpa_id: String, account_key: String) -> Result<()> {
        let config = self.config.lock().expect("config mutex poisoned").clone();
        let target = config
            .targets
            .iter()
            .find(|target| target.id == cpa_id && target.enabled)
            .cloned()
            .ok_or_else(|| anyhow!("CPA 目标不存在或未启用"))?;
        let management_key = secrets::get_secret(&secrets::target_key_name(&target.id))?
            .ok_or_else(|| anyhow!("CPA Management Key 未保存"))?;
        let started_at = now_ms();
        let next_run_at = self.collector_state(&target.id).next_run_at.or(Some(
            started_at + (config.collector.collect_usage_tick_seconds as i64) * 1000,
        ));
        self.update_collector_state(
            &target.id,
            CollectorState {
                status: "collecting".to_string(),
                last_started_at: Some(started_at),
                next_run_at,
                progress_completed_accounts: Some(0),
                progress_total_accounts: Some(1),
                ..self.collector_state(&target.id)
            },
        );
        let client = match CpaClient::new(
            target.clone(),
            management_key,
            config.collector.cpa_request_timeout_seconds,
        ) {
            Ok(client) => Arc::new(client),
            Err(error) => {
                self.update_collector_state(
                    &target.id,
                    CollectorState {
                        status: "error".to_string(),
                        last_completed_at: Some(now_ms()),
                        last_error: Some(error.to_string()),
                        next_run_at,
                        progress_completed_accounts: None,
                        progress_total_accounts: None,
                        ..self.collector_state(&target.id)
                    },
                );
                return Err(error);
            }
        };
        let auth_files = match client.list_auth_files().await {
            Ok(files) => files,
            Err(error) => {
                self.update_collector_state(
                    &target.id,
                    CollectorState {
                        status: "error".to_string(),
                        last_completed_at: Some(now_ms()),
                        last_error: Some(error.to_string()),
                        next_run_at,
                        progress_completed_accounts: None,
                        progress_total_accounts: None,
                        ..self.collector_state(&target.id)
                    },
                );
                return Err(error);
            }
        };
        let Some(file) = auth_files
            .into_iter()
            .filter(quota::is_codex_file)
            .find(|file| quota::resolve_codex_account_key(file) == account_key)
        else {
            let message = format!("未找到账号：{account_key}");
            self.update_collector_state(
                &target.id,
                CollectorState {
                    status: "error".to_string(),
                    last_completed_at: Some(now_ms()),
                    last_error: Some(message.clone()),
                    next_run_at,
                    progress_completed_accounts: None,
                    progress_total_accounts: None,
                    ..self.collector_state(&target.id)
                },
            );
            return Err(anyhow!(message));
        };

        let mut result = AppService::fetch_codex_row(
            Arc::clone(&client),
            target.clone(),
            file,
            config.pricing_profile.clone(),
            Arc::clone(&self.usage_limiter),
            collect_requests_per_minute(true, &config.collector),
        )
        .await;
        let row = self.finalize_collect_row(
            &target.id,
            &result.account_key,
            result.row,
            result.risk_reason.take(),
            result.status_code,
            &config.collector,
        )?;
        let refreshed_error = row_error_for_summary(&row);
        self.upsert_snapshot_row(&target, started_at, row, &account_key)?;
        self.patch_progress(&target.id, 1, 1);
        self.update_collector_state(
            &target.id,
            CollectorState {
                status: if refreshed_error.is_some() {
                    "error".to_string()
                } else {
                    "ok".to_string()
                },
                last_completed_at: Some(now_ms()),
                next_run_at,
                last_error: refreshed_error,
                progress_completed_accounts: None,
                progress_total_accounts: None,
                ..self.collector_state(&target.id)
            },
        );
        self.emit_latest(&target.id);
        self.evaluate_alerts(&target.id);
        Ok(())
    }

    async fn collect_target_inner(&self, cpa_id: String, manual: bool) -> Result<()> {
        let config = self.config.lock().expect("config mutex poisoned").clone();
        let target = config
            .targets
            .iter()
            .find(|target| target.id == cpa_id && target.enabled)
            .cloned()
            .ok_or_else(|| anyhow!("CPA 目标不存在或未启用"))?;
        let management_key = secrets::get_secret(&secrets::target_key_name(&target.id))?
            .ok_or_else(|| anyhow!("CPA Management Key 未保存"))?;
        let started_at = now_ms();
        let next_run_at = started_at + (config.collector.collect_usage_tick_seconds as i64) * 1000;
        self.update_collector_state(
            &target.id,
            CollectorState {
                status: "collecting".to_string(),
                last_started_at: Some(started_at),
                next_run_at: Some(next_run_at),
                progress_completed_accounts: Some(0),
                progress_total_accounts: None,
                ..self.collector_state(&target.id)
            },
        );
        let client = Arc::new(CpaClient::new(
            target.clone(),
            management_key,
            config.collector.cpa_request_timeout_seconds,
        )?);
        let auth_files = match client.list_auth_files().await {
            Ok(files) => files,
            Err(error) => {
                self.update_collector_state(
                    &target.id,
                    CollectorState {
                        status: "error".to_string(),
                        last_completed_at: Some(now_ms()),
                        last_error: Some(error.to_string()),
                        next_run_at: Some(next_run_at),
                        progress_completed_accounts: None,
                        progress_total_accounts: None,
                        ..self.collector_state(&target.id)
                    },
                );
                return Err(error);
            }
        };
        let codex_files: Vec<Value> = auth_files
            .into_iter()
            .filter(quota::is_codex_file)
            .collect();
        let total = codex_files.len();
        self.patch_progress(&target.id, 0, total);
        let mut rows = vec![None; codex_files.len()];
        let mut jobs = VecDeque::new();
        let mut completed = 0usize;
        let collect_concurrency = collect_concurrency(manual, &config.collector);
        let requests_per_minute = collect_requests_per_minute(manual, &config.collector);
        for (index, file) in codex_files.iter().cloned().enumerate() {
            let account_key = quota::resolve_codex_account_key(&file);
            if let Some(cooldown) =
                self.storage
                    .active_cooldown(&target.id, &account_key, now_ms())?
            {
                let reason = format!("冷却中：{}", cooldown.reason);
                let row = quota::build_codex_quota_row(
                    &target,
                    &file,
                    None,
                    &config.pricing_profile,
                    now_ms(),
                    Some(reason.clone()),
                );
                let source = if quota::is_disabled_auth_file(&file) {
                    "paused"
                } else {
                    "backoff"
                };
                rows[index] = Some(quota::with_quota_source(
                    row,
                    source,
                    now_ms(),
                    Some(reason),
                    Some(cooldown.cooldown_until),
                ));
                completed += 1;
                self.patch_progress(&target.id, completed, total);
                continue;
            }

            jobs.push_back(CollectJob { index, file });
        }

        let mut running = JoinSet::new();
        let mut risk_failures = 0usize;
        let mut fuse_open = false;
        spawn_collect_jobs(
            &mut running,
            &mut jobs,
            collect_concurrency,
            Arc::clone(&client),
            target.clone(),
            config.pricing_profile.clone(),
            Arc::clone(&self.usage_limiter),
            requests_per_minute,
        );

        while let Some(joined) = running.join_next().await {
            let result = joined.context("采集 worker 执行失败")?;
            if result.risk_reason.is_some() && !result.row["disabled"].as_bool().unwrap_or(false) {
                risk_failures += 1;
            }
            let row = self.finalize_collect_row(
                &target.id,
                &result.account_key,
                result.row,
                result.risk_reason,
                result.status_code,
                &config.collector,
            )?;

            rows[result.index] = Some(row);
            completed += 1;
            self.patch_progress(&target.id, completed, total);

            if risk_failures >= RISK_FUSE_MIN_FAILURES && !fuse_open {
                fuse_open = true;
                let reason = "本轮风控错误过多，暂停剩余 usage 采集".to_string();
                while let Some(job) = jobs.pop_front() {
                    let row = quota::build_codex_quota_row(
                        &target,
                        &job.file,
                        None,
                        &config.pricing_profile,
                        now_ms(),
                        Some(reason.clone()),
                    );
                    let source = if quota::is_disabled_auth_file(&job.file) {
                        "paused"
                    } else {
                        "backoff"
                    };
                    rows[job.index] = Some(quota::with_quota_source(
                        row,
                        source,
                        now_ms(),
                        Some(reason.clone()),
                        None,
                    ));
                    completed += 1;
                    self.patch_progress(&target.id, completed, total);
                }
            }

            if !fuse_open {
                spawn_collect_jobs(
                    &mut running,
                    &mut jobs,
                    collect_concurrency,
                    Arc::clone(&client),
                    target.clone(),
                    config.pricing_profile.clone(),
                    Arc::clone(&self.usage_limiter),
                    requests_per_minute,
                );
            }
        }

        let rows: Vec<Value> = codex_files
            .iter()
            .enumerate()
            .map(|(index, file)| {
                rows[index].take().unwrap_or_else(|| {
                    let source = if quota::is_disabled_auth_file(file) {
                        "paused"
                    } else {
                        "failed"
                    };
                    quota::with_quota_source(
                        quota::build_codex_quota_row(
                            &target,
                            file,
                            None,
                            &config.pricing_profile,
                            now_ms(),
                            Some("采集未完成".to_string()),
                        ),
                        source,
                        now_ms(),
                        Some("采集未完成".to_string()),
                        None,
                    )
                })
            })
            .collect();
        let error_summary = self.save_snapshot_rows(&target, started_at, &rows)?;
        self.update_collector_state(
            &target.id,
            CollectorState {
                status: if error_summary.is_some() {
                    "error".to_string()
                } else {
                    "ok".to_string()
                },
                last_completed_at: Some(now_ms()),
                next_run_at: Some(next_run_at),
                last_error: error_summary,
                progress_completed_accounts: None,
                progress_total_accounts: None,
                ..self.collector_state(&target.id)
            },
        );
        self.emit_latest(&target.id);
        self.evaluate_alerts(&target.id);
        Ok(())
    }

    async fn fetch_codex_row(
        client: Arc<CpaClient>,
        target: CpaTargetConfig,
        file: Value,
        pricing_profile: Value,
        limiter: Arc<UsageRateLimiter>,
        requests_per_minute: f64,
    ) -> CollectJobResult {
        let now = now_ms();
        let account_key = quota::resolve_codex_account_key(&file);
        let auth_index = match quota::normalize_auth_index(&file) {
            Some(value) => value,
            None => {
                let row = quota::build_codex_quota_row(
                    &target,
                    &file,
                    None,
                    &pricing_profile,
                    now,
                    Some("缺少 auth_index，无法通过 api-call 获取额度".to_string()),
                );
                return CollectJobResult {
                    index: 0,
                    account_key,
                    row,
                    status_code: None,
                    risk_reason: None,
                };
            }
        };
        let request = codex_usage_request(
            &auth_index,
            quota::resolve_codex_chatgpt_account_id(&file),
            &file,
        );
        let header_source = request.header_source.clone();
        limiter.wait(requests_per_minute).await;
        match client.api_call(request.payload).await {
            Ok(result) if (200..300).contains(&result.status_code) => {
                let payload = if result.body.is_null() {
                    None
                } else {
                    Some(result.body)
                };
                let row = quota::with_request_header_source(
                    quota::build_codex_quota_row(
                        &target,
                        &file,
                        payload.as_ref(),
                        &pricing_profile,
                        now_ms(),
                        None,
                    ),
                    Some(&header_source),
                );
                let risk_reason = row
                    .get("error")
                    .and_then(Value::as_str)
                    .and_then(|message| usage_risk_reason(Some(result.status_code), message));
                CollectJobResult {
                    index: 0,
                    account_key,
                    row,
                    status_code: Some(result.status_code),
                    risk_reason,
                }
            }
            Ok(result) => {
                let message = api_call_error_message(&result);
                let risk_reason = usage_risk_reason(Some(result.status_code), &message);
                let row = quota::with_request_header_source(
                    quota::build_codex_quota_row(
                        &target,
                        &file,
                        None,
                        &pricing_profile,
                        now_ms(),
                        Some(message),
                    ),
                    Some(&header_source),
                );
                CollectJobResult {
                    index: 0,
                    account_key,
                    row,
                    status_code: Some(result.status_code),
                    risk_reason,
                }
            }
            Err(error) => {
                let message = error.to_string();
                let risk_reason = usage_risk_reason(None, &message);
                let row = quota::with_request_header_source(
                    quota::build_codex_quota_row(
                        &target,
                        &file,
                        None,
                        &pricing_profile,
                        now_ms(),
                        Some(message),
                    ),
                    Some(&header_source),
                );
                CollectJobResult {
                    index: 0,
                    account_key,
                    row,
                    status_code: None,
                    risk_reason,
                }
            }
        }
    }

    fn finalize_collect_row(
        &self,
        cpa_id: &str,
        account_key: &str,
        row: Value,
        risk_reason: Option<String>,
        status_code: Option<u16>,
        collector: &CollectorPreferences,
    ) -> Result<Value> {
        let row_disabled = row["disabled"].as_bool().unwrap_or(false);
        if let Some(reason) = risk_reason {
            let cooldown = self.storage.record_cooldown(
                cpa_id,
                account_key,
                &reason,
                status_code,
                now_ms(),
                collector.collect_usage_error_backoff_minutes,
                collector.collect_usage_error_backoff_max_minutes,
            )?;
            return Ok(quota::with_quota_source(
                row,
                if row_disabled { "paused" } else { "backoff" },
                now_ms(),
                Some(cooldown.reason),
                Some(cooldown.cooldown_until),
            ));
        }

        if row.get("error").and_then(Value::as_str).is_none() {
            self.storage.clear_cooldown(cpa_id, account_key)?;
            return Ok(row);
        }

        let Some(error) = row.get("error").and_then(Value::as_str).map(str::to_string) else {
            return Ok(row);
        };
        Ok(quota::with_quota_source(
            row,
            if row_disabled { "paused" } else { "failed" },
            now_ms(),
            Some(error),
            None,
        ))
    }

    fn upsert_snapshot_row(
        &self,
        target: &CpaTargetConfig,
        captured_at: i64,
        row: Value,
        fallback_match: &str,
    ) -> Result<Option<String>> {
        let mut rows = self
            .storage
            .latest_snapshot(&target.id)?
            .map(|snapshot| snapshot.rows)
            .unwrap_or_default();
        let mut candidates = row_identity_values(&row);
        if !fallback_match.trim().is_empty() {
            candidates.push(fallback_match.trim().to_string());
        }
        let mut replaced = false;
        for existing in rows.iter_mut() {
            if candidates
                .iter()
                .any(|candidate| row_matches_auth_file(existing, candidate))
            {
                *existing = row.clone();
                replaced = true;
                break;
            }
        }
        if !replaced {
            rows.push(row);
        }
        self.save_snapshot_rows(target, captured_at, &rows)
    }

    fn save_snapshot_rows(
        &self,
        target: &CpaTargetConfig,
        captured_at: i64,
        rows: &[Value],
    ) -> Result<Option<String>> {
        let error_summary = snapshot_error_summary(rows);
        self.storage
            .save_snapshot(target, captured_at, rows, "full", error_summary.clone())?;
        self.storage.prune_history()?;
        Ok(error_summary)
    }

    fn enabled_targets(&self) -> Vec<CpaTargetConfig> {
        self.config
            .lock()
            .expect("config mutex poisoned")
            .targets
            .iter()
            .filter(|target| {
                target.enabled
                    && target.has_management_key
                    && secrets::get_secret(&secrets::target_key_name(&target.id))
                        .ok()
                        .flatten()
                        .is_some()
            })
            .cloned()
            .collect()
    }

    fn config_with_secret_flags(&self) -> Result<AppConfig> {
        let mut config = self.config.lock().expect("config mutex poisoned").clone();
        sync_secret_flags(&mut config)?;
        Ok(config)
    }

    fn collector_preferences(&self) -> CollectorPreferences {
        self.config
            .lock()
            .expect("config mutex poisoned")
            .collector
            .clone()
    }

    fn set_auto_collect_enabled(&self, enabled: bool) -> Result<Value> {
        let mut config = self.config.lock().expect("config mutex poisoned");
        config.collector.auto_collect_enabled = enabled;
        self.storage.save_config(&config)?;
        self.paused.store(!enabled, Ordering::Relaxed);
        Ok(json!({
            "paused": !enabled,
            "collector": config.collector.clone()
        }))
    }

    fn resolve_selected_target(
        &self,
        config: &AppConfig,
        requested: Option<&str>,
    ) -> Option<CpaTargetConfig> {
        requested
            .and_then(|id| {
                config
                    .targets
                    .iter()
                    .find(|target| target.id == id && target.enabled)
                    .cloned()
            })
            .or_else(|| config.targets.iter().find(|target| target.enabled).cloned())
    }

    fn is_target_running(&self, cpa_id: &str) -> bool {
        self.running_targets
            .lock()
            .expect("running targets mutex poisoned")
            .contains(cpa_id)
    }

    fn collector_state(&self, cpa_id: &str) -> CollectorState {
        self.collector_states
            .lock()
            .expect("collector state mutex poisoned")
            .get(cpa_id)
            .cloned()
            .unwrap_or_default()
    }

    fn collector_state_value(&self, cpa_id: &str) -> Value {
        serde_json::to_value(self.collector_state(cpa_id)).unwrap_or(Value::Null)
    }

    fn update_collector_state(&self, cpa_id: &str, state: CollectorState) {
        self.collector_states
            .lock()
            .expect("collector state mutex poisoned")
            .insert(cpa_id.to_string(), state);
        self.emit_collector_state(cpa_id);
    }

    fn patch_progress(&self, cpa_id: &str, completed: usize, total: usize) {
        let mut state = self.collector_state(cpa_id);
        state.progress_completed_accounts = Some(completed);
        state.progress_total_accounts = Some(total);
        self.update_collector_state(cpa_id, state);
    }

    fn emit_collector_state(&self, cpa_id: &str) {
        if let Some(app) = self
            .app_handle
            .lock()
            .expect("app handle mutex poisoned")
            .as_ref()
        {
            let _ = app.emit(
                "collector-state",
                json!({
                    "cpaId": cpa_id,
                    "collectorState": self.collector_state_value(cpa_id)
                }),
            );
        }
    }

    fn emit_latest(&self, cpa_id: &str) {
        if let Some(app) = self
            .app_handle
            .lock()
            .expect("app handle mutex poisoned")
            .as_ref()
        {
            if let Ok(payload) = self.latest_payload(Some(cpa_id.to_string())) {
                let _ = app.emit("latest-payload", payload);
            }
        }
    }

    fn evaluate_alerts(&self, cpa_id: &str) {
        let Ok(payload) = self.latest_payload(Some(cpa_id.to_string())) else {
            return;
        };
        let config = self
            .config
            .lock()
            .expect("config mutex poisoned")
            .email_alert
            .clone();
        if !config.enabled || config.recipients.is_empty() || config.smtp_host.trim().is_empty() {
            return;
        }
        let issue_summary = account_issue_summary(&payload);
        let Some(decision) = build_alert_decision(cpa_id, &payload, &config, issue_summary) else {
            return;
        };
        let password = match secrets::get_secret(secrets::smtp_password_name()) {
            Ok(Some(value)) => value,
            _ => return,
        };
        let now = now_ms();
        let claimed = if decision.persistent_cooldown {
            self.storage
                .claim_alert_cooldown(&decision.cooldown_key, decision.cooldown_minutes, now)
                .unwrap_or(false)
        } else {
            self.claim_alert_slot(&decision.cooldown_key, decision.cooldown_minutes, now)
        };
        if !claimed {
            return;
        }
        let target_name = payload["snapshot"]["cpaName"].as_str().unwrap_or("CPA");
        let subject = alert_subject(&decision, target_name, &payload, issue_summary);
        let body = format!(
            "CPA：{target_name}\n触发原因：{}\n等级：{}\n{}\n{}\n{}\n可调度容量：{}\n异常账号数：{}\n快照时间：{}",
            decision.reason,
            decision.level,
            payload["risk"]["detail"].as_str().unwrap_or(""),
            capacity_coverage_note(&payload),
            account_issue_summary_note(issue_summary),
            payload["risk"]["conservativeUsableUsd"],
            issue_summary.total(),
            payload["snapshot"]["capturedAt"]
        );
        let _ = send_email(&config, &password, &subject, &body);
    }

    fn claim_alert_slot(&self, key: &str, cooldown_minutes: u32, now: i64) -> bool {
        let cooldown_ms = (cooldown_minutes.max(1) as i64) * 60 * 1000;
        let mut sent_at = self
            .alert_last_sent_at
            .lock()
            .expect("alert cooldown mutex poisoned");
        if sent_at
            .get(key)
            .map(|last| now - *last < cooldown_ms)
            .unwrap_or(false)
        {
            return false;
        }
        sent_at.insert(key.to_string(), now);
        true
    }
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn sanitize_id(value: &str) -> String {
    value
        .trim()
        .to_lowercase()
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
        .collect::<String>()
        .trim_matches('-')
        .chars()
        .take(64)
        .collect()
}

fn unique_target_id(targets: &[CpaTargetConfig], name: &str) -> String {
    let base = sanitize_id(name);
    let base = if base.is_empty() {
        "cpa".to_string()
    } else {
        base
    };
    if !targets.iter().any(|target| target.id == base) {
        return base;
    }
    for index in 2.. {
        let candidate = format!("{base}-{index}");
        if !targets.iter().any(|target| target.id == candidate) {
            return candidate;
        }
    }
    unreachable!("infinite iterator should return");
}

fn normalize_auth_file_name(value: String) -> Result<String> {
    let value = value.trim().to_string();
    if value.is_empty() {
        return Err(anyhow!("凭证名称不能为空"));
    }
    Ok(value)
}

fn row_identity_values(row: &Value) -> Vec<String> {
    [
        "authFileName",
        "authId",
        "accountKey",
        "authIndex",
        "name",
        "accountId",
    ]
    .into_iter()
    .filter_map(|key| {
        row.get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    })
    .collect()
}

fn collect_row_cooldown_keys(row: &Value, keys: &mut HashSet<String>) {
    for value in row_identity_values(row) {
        keys.insert(value);
    }
}

fn row_matches_auth_file(row: &Value, auth_file_name: &str) -> bool {
    let auth_file_name = auth_file_name.trim();
    if auth_file_name.is_empty() {
        return false;
    }
    row_identity_values(row)
        .into_iter()
        .any(|candidate| candidate == auth_file_name)
}

fn row_error_for_summary(row: &Value) -> Option<String> {
    if row["disabled"].as_bool().unwrap_or(false) {
        return None;
    }
    row.get("error")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn snapshot_error_summary(rows: &[Value]) -> Option<String> {
    let errors: Vec<String> = rows
        .iter()
        .filter_map(|row| {
            row_error_for_summary(row)
                .map(|error| format!("{}: {}", row["name"].as_str().unwrap_or("unknown"), error))
        })
        .take(5)
        .collect();
    (!errors.is_empty()).then(|| errors.join("\n"))
}

fn spawn_collect_jobs(
    running: &mut JoinSet<CollectJobResult>,
    jobs: &mut VecDeque<CollectJob>,
    concurrency: usize,
    client: Arc<CpaClient>,
    target: CpaTargetConfig,
    pricing_profile: Value,
    limiter: Arc<UsageRateLimiter>,
    requests_per_minute: f64,
) {
    while running.len() < concurrency {
        let Some(job) = jobs.pop_front() else {
            break;
        };
        let index = job.index;
        let client = Arc::clone(&client);
        let target = target.clone();
        let pricing_profile = pricing_profile.clone();
        let limiter = Arc::clone(&limiter);
        running.spawn(async move {
            let mut result = AppService::fetch_codex_row(
                client,
                target,
                job.file,
                pricing_profile,
                limiter,
                requests_per_minute,
            )
            .await;
            result.index = index;
            result
        });
    }
}

fn collect_concurrency(manual: bool, collector: &CollectorPreferences) -> usize {
    normalize_collect_concurrency(if manual {
        collector.collect_manual_concurrency
    } else {
        collector.collect_concurrency
    })
}

fn collect_requests_per_minute(manual: bool, collector: &CollectorPreferences) -> f64 {
    normalize_usage_requests_per_minute_value(if manual {
        collector.collect_manual_max_requests_per_minute
    } else {
        collector.collect_usage_max_requests_per_minute
    })
}

fn normalize_collect_concurrency(value: usize) -> usize {
    value.clamp(MIN_COLLECT_CONCURRENCY, MAX_COLLECT_CONCURRENCY)
}

fn normalize_usage_requests_per_minute_value(value: f64) -> f64 {
    if !value.is_finite() {
        return CollectorPreferences::default().collect_usage_max_requests_per_minute;
    }
    value.clamp(MIN_USAGE_REQUESTS_PER_MINUTE, MAX_USAGE_REQUESTS_PER_MINUTE)
}

#[cfg(test)]
fn normalize_collect_tick_seconds(settings: &SaveCollectorSettings) -> u64 {
    normalize_collect_tick_seconds_with_default(
        settings,
        CollectorPreferences::default().collect_usage_tick_seconds,
    )
}

fn normalize_collect_tick_seconds_with_default(
    settings: &SaveCollectorSettings,
    default_seconds: u64,
) -> u64 {
    let seconds = settings
        .collect_usage_tick_seconds
        .or_else(|| {
            settings
                .collect_usage_tick_minutes
                .map(|minutes| minutes.saturating_mul(60))
        })
        .unwrap_or(default_seconds);
    seconds.clamp(MIN_COLLECT_TICK_SECONDS, MAX_COLLECT_TICK_SECONDS)
}

fn send_email(
    settings: &crate::models::EmailAlertSettings,
    password: &str,
    subject: &str,
    body: &str,
) -> Result<()> {
    if settings.smtp_host.trim().is_empty() {
        return Err(anyhow!("请先填写 SMTP 服务器地址"));
    }
    if settings.recipients.is_empty() {
        return Err(anyhow!("请先填写告警收件人"));
    }
    let mut builder = Message::builder()
        .from(settings.smtp_from.parse().context("发件人地址格式不正确")?)
        .subject(subject);
    for recipient in &settings.recipients {
        builder = builder.to(recipient.parse().context("收件人地址格式不正确")?);
    }
    let message = builder
        .body(limit_message(body, settings.max_message_chars))
        .context("构建邮件失败")?;
    let credentials = Credentials::new(settings.smtp_username.clone(), password.to_string());
    let timeout = Some(Duration::from_secs(settings.timeout_seconds.max(1) as u64));
    let mailer = if settings.smtp_secure {
        SmtpTransport::relay(&settings.smtp_host)?
            .port(settings.smtp_port)
            .credentials(credentials)
            .timeout(timeout)
            .build()
    } else {
        SmtpTransport::builder_dangerous(&settings.smtp_host)
            .port(settings.smtp_port)
            .credentials(credentials)
            .timeout(timeout)
            .build()
    };
    mailer.send(&message).context("发送邮件失败")?;
    Ok(())
}

fn should_send_risk_alert(tone: &str, min_tone: &str) -> bool {
    let tone_rank = risk_tone_rank(tone);
    tone_rank > 0 && tone_rank >= risk_tone_rank(min_tone).max(1)
}

fn risk_tone_rank(tone: &str) -> u8 {
    match tone.trim().to_ascii_lowercase().as_str() {
        "watch" => 1,
        "warn" => 2,
        "critical" => 3,
        _ => 0,
    }
}

fn build_alert_decision(
    cpa_id: &str,
    payload: &Value,
    config: &EmailAlertSettings,
    issue_summary: AccountIssueSummary,
) -> Option<AlertDecision> {
    let tone = payload["risk"]["tone"].as_str().unwrap_or("muted");
    let risk_matches = should_send_risk_alert(tone, &config.min_tone);
    let threshold = config.account_issue_threshold.max(1) as usize;
    if risk_matches {
        let reason = if issue_summary.severe > 0 {
            format!(
                "容量风险达到 {tone}，且 {} 个严重账号异常",
                issue_summary.severe
            )
        } else if issue_summary.soft > 0 {
            format!(
                "容量风险达到 {tone}，另有 {} 个软异常账号",
                issue_summary.soft
            )
        } else {
            format!("容量风险达到 {tone}")
        };
        return Some(AlertDecision {
            kind: AlertDecisionKind::Risk,
            cooldown_key: format!("{cpa_id}:risk:{tone}"),
            cooldown_minutes: config.cooldown_minutes,
            persistent_cooldown: false,
            level: tone.to_string(),
            reason,
        });
    }
    if issue_summary.severe >= threshold && issue_summary.severe > 0 {
        return Some(AlertDecision {
            kind: AlertDecisionKind::SevereAccountIssues,
            cooldown_key: format!("{cpa_id}:account-issues"),
            cooldown_minutes: config.cooldown_minutes,
            persistent_cooldown: false,
            level: "account".to_string(),
            reason: format!("{} 个严重账号异常", issue_summary.severe),
        });
    }
    if issue_summary.severe == 0 && issue_summary.soft >= threshold && issue_summary.soft > 0 {
        return Some(AlertDecision {
            kind: AlertDecisionKind::SoftAccountIssues,
            cooldown_key: format!("{cpa_id}:{SOFT_QUOTA_WINDOW_MISSING_ALERT_KEY}"),
            cooldown_minutes: config.soft_issue_cooldown_minutes,
            persistent_cooldown: true,
            level: "soft".to_string(),
            reason: format!("{} 个软异常账号", issue_summary.soft),
        });
    }
    None
}

fn alert_subject(
    decision: &AlertDecision,
    target_name: &str,
    payload: &Value,
    issue_summary: AccountIssueSummary,
) -> String {
    match decision.kind {
        AlertDecisionKind::Risk => format!(
            "[CPA预警][{}] {target_name}：{}",
            decision.level,
            payload["risk"]["title"].as_str().unwrap_or("容量预警")
        ),
        AlertDecisionKind::SevereAccountIssues => {
            format!(
                "[CPA预警][account] {target_name}：{} 个严重异常账号",
                issue_summary.severe
            )
        }
        AlertDecisionKind::SoftAccountIssues => {
            format!(
                "[CPA提示][soft] {target_name}：{} 个软异常账号",
                issue_summary.soft
            )
        }
    }
}

#[cfg(test)]
fn account_issue_count(payload: &Value) -> usize {
    account_issue_summary(payload).total()
}

fn account_issue_summary(payload: &Value) -> AccountIssueSummary {
    payload["accounts"]
        .as_array()
        .map(|accounts| {
            accounts
                .iter()
                .fold(AccountIssueSummary::default(), |mut summary, account| {
                    match account_issue_severity(account) {
                        Some(AccountIssueSeverity::Soft) => summary.soft += 1,
                        Some(AccountIssueSeverity::Severe) => summary.severe += 1,
                        None => {}
                    }
                    summary
                })
        })
        .unwrap_or_default()
}

fn account_issue_severity(account: &Value) -> Option<AccountIssueSeverity> {
    if account["disabled"].as_bool().unwrap_or(false) {
        return None;
    }
    let status = account["status"].as_str().unwrap_or_default();
    let source = account["quotaSource"].as_str().unwrap_or_default();
    let is_issue = matches!(status, "failed" | "unknown") || matches!(source, "failed" | "backoff");
    if !is_issue {
        return None;
    }
    if source == "backoff" {
        return Some(AccountIssueSeverity::Severe);
    }
    let error = account["error"].as_str().unwrap_or_default();
    if is_soft_quota_window_missing_error(error) {
        Some(AccountIssueSeverity::Soft)
    } else {
        Some(AccountIssueSeverity::Severe)
    }
}

fn is_soft_quota_window_missing_error(error: &str) -> bool {
    let value = error.trim();
    value.starts_with("缺少 ") && value.ends_with("主窗口额度数据")
}

fn account_issue_summary_note(summary: AccountIssueSummary) -> String {
    if summary.soft > 0 {
        format!(
            "账号异常：严重 {}，软异常 {}（缺少主窗口额度，已按可测账号继续监控）",
            summary.severe, summary.soft
        )
    } else {
        format!("账号异常：严重 {}，软异常 0", summary.severe)
    }
}

fn capacity_coverage_note(payload: &Value) -> String {
    let capacity = &payload["capacity"];
    let enabled = capacity["enabledAccounts"].as_u64().unwrap_or(0);
    let included = capacity["includedAccounts"].as_u64().unwrap_or(0);
    let excluded = capacity["excludedAccounts"]
        .as_u64()
        .unwrap_or_else(|| enabled.saturating_sub(included));
    if enabled == 0 {
        "容量覆盖：无启用账号".to_string()
    } else if excluded > 0 {
        format!("容量覆盖：可测容量 {included}/{enabled}，{excluded} 个账号异常未计入容量")
    } else {
        format!("容量覆盖：可测容量 {included}/{enabled}")
    }
}

fn limit_message(body: &str, max_chars: u32) -> String {
    let max_chars = max_chars as usize;
    if max_chars == 0 || body.chars().count() <= max_chars {
        return body.to_string();
    }
    body.chars().take(max_chars).collect()
}

fn sync_secret_flags(config: &mut AppConfig) -> Result<bool> {
    let mut changed = false;
    for target in &mut config.targets {
        let has_key = secrets::get_secret(&secrets::target_key_name(&target.id))?.is_some();
        if target.has_management_key != has_key {
            target.has_management_key = has_key;
            changed = true;
        }
    }
    let has_smtp_password = secrets::get_secret(secrets::smtp_password_name())?.is_some();
    if config.email_alert.has_smtp_password != has_smtp_password {
        config.email_alert.has_smtp_password = has_smtp_password;
        changed = true;
    }
    Ok(changed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn sanitizes_target_ids() {
        assert_eq!(sanitize_id("Main CPA"), "main-cpa");
        assert_eq!(sanitize_id("  默认 CPA  "), "cpa");
    }

    #[test]
    fn applies_alert_tone_thresholds() {
        assert!(should_send_risk_alert("watch", "watch"));
        assert!(!should_send_risk_alert("watch", "warn"));
        assert!(should_send_risk_alert("critical", "warn"));
        assert!(!should_send_risk_alert("ok", "watch"));
    }

    fn alert_payload(tone: &str, accounts: Vec<Value>) -> Value {
        json!({
            "risk": {
                "tone": tone,
                "title": "容量预警",
                "detail": "",
                "conservativeUsableUsd": 100.0
            },
            "accounts": accounts
        })
    }

    fn soft_issue_account(error: &str) -> Value {
        json!({ "status": "unknown", "quotaSource": "failed", "error": error })
    }

    fn severe_issue_account(error: &str) -> Value {
        json!({ "status": "failed", "quotaSource": "failed", "error": error })
    }

    #[test]
    fn classifies_soft_and_severe_account_issues_for_alerts() {
        let payload = json!({
            "accounts": [
                { "status": "active", "quotaSource": "fresh" },
                { "status": "unknown", "quotaSource": "failed", "error": "缺少 5h/周 主窗口额度数据" },
                { "status": "unknown", "quotaSource": "failed", "error": "缺少 周 主窗口额度数据" },
                { "status": "unknown", "quotaSource": "failed", "error": "缺少 5h 主窗口额度数据" },
                { "status": "active", "quotaSource": "backoff", "error": "冷却中：403 forbidden" },
                { "status": "failed", "quotaSource": "failed", "error": "采集未完成" },
                { "status": "failed", "quotaSource": "failed", "error": "usage 查询失败" }
            ]
        });
        let summary = account_issue_summary(&payload);

        assert_eq!(summary.soft, 3);
        assert_eq!(summary.severe, 3);
        assert_eq!(account_issue_count(&payload), 6);
        assert_eq!(
            account_issue_severity(&severe_issue_account("429 limited")),
            Some(AccountIssueSeverity::Severe)
        );
        assert_eq!(
            account_issue_severity(&severe_issue_account("challenge 退避")),
            Some(AccountIssueSeverity::Severe)
        );
    }

    #[test]
    fn disabled_accounts_are_ignored_for_alert_issue_counts() {
        let payload = json!({
            "accounts": [
                { "disabled": true, "status": "paused", "quotaSource": "paused", "error": "403 forbidden" },
                { "disabled": true, "status": "paused", "quotaSource": "backoff", "error": "冷却中：429 limited" },
                { "disabled": false, "status": "active", "quotaSource": "fresh" }
            ]
        });

        let summary = account_issue_summary(&payload);

        assert_eq!(summary.soft, 0);
        assert_eq!(summary.severe, 0);
        assert_eq!(account_issue_count(&payload), 0);
    }

    #[test]
    fn alert_decision_soft_issues_use_persistent_long_cooldown() {
        let config = EmailAlertSettings {
            enabled: true,
            account_issue_threshold: 2,
            soft_issue_cooldown_minutes: 720,
            ..EmailAlertSettings::default()
        };
        let payload = alert_payload(
            "muted",
            vec![
                soft_issue_account("缺少 5h/周 主窗口额度数据"),
                soft_issue_account("缺少 周 主窗口额度数据"),
            ],
        );
        let summary = account_issue_summary(&payload);
        let decision = build_alert_decision("main", &payload, &config, summary).unwrap();

        assert_eq!(decision.kind, AlertDecisionKind::SoftAccountIssues);
        assert_eq!(
            decision.cooldown_key,
            "main:account-issues:soft-quota-window-missing"
        );
        assert_eq!(decision.cooldown_minutes, 720);
        assert!(decision.persistent_cooldown);
    }

    #[test]
    fn alert_decision_severe_issues_keep_standard_cooldown() {
        let config = EmailAlertSettings {
            enabled: true,
            account_issue_threshold: 1,
            cooldown_minutes: 30,
            soft_issue_cooldown_minutes: 720,
            ..EmailAlertSettings::default()
        };
        let payload = alert_payload(
            "muted",
            vec![
                severe_issue_account("usage 查询失败"),
                soft_issue_account("缺少 5h/周 主窗口额度数据"),
            ],
        );
        let summary = account_issue_summary(&payload);
        let decision = build_alert_decision("main", &payload, &config, summary).unwrap();

        assert_eq!(decision.kind, AlertDecisionKind::SevereAccountIssues);
        assert_eq!(decision.cooldown_key, "main:account-issues");
        assert_eq!(decision.cooldown_minutes, 30);
        assert!(!decision.persistent_cooldown);
    }

    #[test]
    fn alert_decision_risk_precedes_soft_issues() {
        let config = EmailAlertSettings {
            enabled: true,
            min_tone: "watch".to_string(),
            account_issue_threshold: 1,
            soft_issue_cooldown_minutes: 720,
            ..EmailAlertSettings::default()
        };
        let payload = alert_payload(
            "warn",
            vec![soft_issue_account("缺少 5h/周 主窗口额度数据")],
        );
        let summary = account_issue_summary(&payload);
        let decision = build_alert_decision("main", &payload, &config, summary).unwrap();

        assert_eq!(decision.kind, AlertDecisionKind::Risk);
        assert_eq!(decision.cooldown_key, "main:risk:warn");
        assert_eq!(decision.cooldown_minutes, config.cooldown_minutes);
        assert!(!decision.persistent_cooldown);
    }

    #[test]
    fn alert_cooldown_claims_once_per_window() {
        let temp = tempdir().unwrap();
        let storage = Storage::new(temp.path().join("config"), temp.path().join("data")).unwrap();
        let service = AppService::new(storage).unwrap();

        assert!(service.claim_alert_slot("main:risk:warn", 10, 1_000));
        assert!(!service.claim_alert_slot("main:risk:warn", 10, 2_000));
        assert!(service.claim_alert_slot("main:risk:warn", 10, 601_000));
    }

    #[test]
    fn email_alert_settings_default_soft_issue_cooldown_for_old_config() {
        let settings = serde_json::from_value::<EmailAlertSettings>(json!({
            "enabled": true,
            "recipients": ["ops@example.com"],
            "minTone": "warn",
            "accountIssueThreshold": 1,
            "cooldownMinutes": 30,
            "timeoutSeconds": 10,
            "maxMessageChars": 4000,
            "smtpHost": "smtp.example.com",
            "smtpPort": 465,
            "smtpSecure": true,
            "smtpUsername": "ops@example.com",
            "smtpFrom": "NeoQuota Monitor <ops@example.com>"
        }))
        .unwrap();

        assert_eq!(settings.soft_issue_cooldown_minutes, 720);
    }

    #[test]
    fn collector_preferences_defaults_auto_collect_for_old_config() {
        let preferences = serde_json::from_value::<CollectorPreferences>(json!({
            "collectUsageMode": "full",
            "collectUsageTickSeconds": 300,
            "collectUsageErrorBackoffMinutes": 10,
            "collectUsageErrorBackoffMaxMinutes": 120,
            "cpaRequestTimeoutSeconds": 60,
            "cacheTrustMaxMinutes": 60,
            "alertPoolRemainingHoursWarn": 6.0,
            "alertPoolRemainingHoursCritical": 3.0,
            "alertPoolRemainingHoursEmergency": 1.0
        }))
        .unwrap();

        assert!(preferences.auto_collect_enabled);
        assert_eq!(preferences.collect_usage_max_requests_per_minute, 30.0);
        assert_eq!(preferences.collect_concurrency, 3);
        assert_eq!(preferences.collect_manual_concurrency, 8);
        assert_eq!(preferences.collect_manual_max_requests_per_minute, 30.0);
    }

    #[test]
    fn normalizes_collector_tick_seconds() {
        assert_eq!(
            normalize_collect_tick_seconds(&SaveCollectorSettings {
                auto_collect_enabled: true,
                collect_usage_tick_seconds: Some(30),
                collect_usage_tick_minutes: None,
                collect_usage_max_requests_per_minute: None,
                collect_concurrency: None,
                collect_manual_concurrency: None,
            }),
            60
        );
        assert_eq!(
            normalize_collect_tick_seconds(&SaveCollectorSettings {
                auto_collect_enabled: true,
                collect_usage_tick_seconds: None,
                collect_usage_tick_minutes: Some(3),
                collect_usage_max_requests_per_minute: None,
                collect_concurrency: None,
                collect_manual_concurrency: None,
            }),
            180
        );
        assert_eq!(
            normalize_collect_tick_seconds(&SaveCollectorSettings {
                auto_collect_enabled: true,
                collect_usage_tick_seconds: None,
                collect_usage_tick_minutes: Some(99),
                collect_usage_max_requests_per_minute: None,
                collect_concurrency: None,
                collect_manual_concurrency: None,
            }),
            3600
        );
    }

    #[test]
    fn normalizes_collector_concurrency_and_rate_limits() {
        assert_eq!(normalize_collect_concurrency(0), 1);
        assert_eq!(normalize_collect_concurrency(7), 7);
        assert_eq!(normalize_collect_concurrency(99), 10);
        assert_eq!(normalize_usage_requests_per_minute_value(0.0), 1.0);
        assert_eq!(normalize_usage_requests_per_minute_value(12.5), 12.5);
        assert_eq!(normalize_usage_requests_per_minute_value(99.0), 60.0);
        assert_eq!(
            normalize_usage_requests_per_minute_value(f64::NAN),
            CollectorPreferences::default().collect_usage_max_requests_per_minute
        );
    }

    #[test]
    fn saves_collector_settings_and_pause_commands_to_config() {
        let temp = tempdir().unwrap();
        let storage = Storage::new(temp.path().join("config"), temp.path().join("data")).unwrap();
        let service = AppService::new(storage).unwrap();

        let saved = service
            .save_collector_settings(SaveCollectorSettings {
                auto_collect_enabled: false,
                collect_usage_tick_seconds: None,
                collect_usage_tick_minutes: Some(3),
                collect_usage_max_requests_per_minute: Some(70.0),
                collect_concurrency: Some(0),
                collect_manual_concurrency: Some(99),
            })
            .unwrap();
        assert_eq!(saved["autoCollectEnabled"], false);
        assert_eq!(saved["collectUsageTickSeconds"], 180);
        assert_eq!(saved["collectUsageMaxRequestsPerMinute"], 60.0);
        assert_eq!(saved["collectManualMaxRequestsPerMinute"], 60.0);
        assert_eq!(saved["collectConcurrency"], 1);
        assert_eq!(saved["collectManualConcurrency"], 10);
        assert_eq!(service.get_app_state().unwrap()["paused"], true);
        assert!(!service.collector_preferences().auto_collect_enabled);

        let saved_again = service
            .save_collector_settings(SaveCollectorSettings {
                auto_collect_enabled: true,
                collect_usage_tick_seconds: None,
                collect_usage_tick_minutes: None,
                collect_usage_max_requests_per_minute: None,
                collect_concurrency: None,
                collect_manual_concurrency: None,
            })
            .unwrap();
        assert_eq!(saved_again["collectUsageTickSeconds"], 180);
        assert_eq!(saved_again["collectUsageMaxRequestsPerMinute"], 60.0);
        assert_eq!(saved_again["collectConcurrency"], 1);
        assert_eq!(saved_again["collectManualConcurrency"], 10);

        let resumed = service.resume_collector().unwrap();
        assert_eq!(resumed["paused"], false);
        assert!(service.collector_preferences().auto_collect_enabled);

        let paused = service.pause_collector().unwrap();
        assert_eq!(paused["paused"], true);
        assert!(!service.collector_preferences().auto_collect_enabled);
    }

    #[test]
    fn limits_email_body_by_characters() {
        assert_eq!(limit_message("abcdef", 3), "abc");
        assert_eq!(limit_message("你好世界", 2), "你好");
        assert_eq!(limit_message("abcdef", 0), "abcdef");
    }
}
