use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::{
    collections::{BTreeSet, HashMap},
    fs,
    path::PathBuf,
};

use crate::{
    models::{AppConfig, CollectorPreferences, CpaTargetConfig},
    pricing,
    quota::{refresh_row_age, reprice_quota_row},
    service::now_ms,
};

#[derive(Debug, Clone)]
pub struct Storage {
    pub config_path: PathBuf,
    pub db_path: PathBuf,
}

#[derive(Debug, Clone)]
pub struct SnapshotRecord {
    pub id: i64,
    pub cpa_id: String,
    pub cpa_name: String,
    pub captured_at: i64,
    pub rows: Vec<Value>,
    pub strategy: String,
    pub error_summary: Option<String>,
}

#[derive(Debug, Clone)]
pub struct CooldownRecord {
    pub cpa_id: String,
    pub account_key: String,
    pub cooldown_until: i64,
    pub reason: String,
    pub consecutive_failures: u32,
    pub last_status_code: Option<u16>,
    pub updated_at: i64,
}

impl Storage {
    pub fn new(config_dir: PathBuf, data_dir: PathBuf) -> Result<Self> {
        fs::create_dir_all(&config_dir).context("创建配置目录失败")?;
        fs::create_dir_all(&data_dir).context("创建数据目录失败")?;
        let storage = Self {
            config_path: config_dir.join("config.json"),
            db_path: data_dir.join("quota-monitor.sqlite"),
        };
        storage.ensure_db()?;
        Ok(storage)
    }

    pub fn load_config(&self) -> Result<AppConfig> {
        if !self.config_path.exists() {
            let config = AppConfig::default();
            self.save_config(&config)?;
            return Ok(config);
        }
        let text = fs::read_to_string(&self.config_path).context("读取客户端配置失败")?;
        let mut config = serde_json::from_str::<AppConfig>(&text).unwrap_or_default();
        config.targets.iter_mut().for_each(|target| {
            target.api_base = normalize_api_base(&target.api_base)
                .unwrap_or_else(|_| target.api_base.trim().trim_end_matches('/').to_string());
        });
        let normalized_pricing =
            pricing::normalize_existing_pricing_profile(config.pricing_profile.clone());
        let pricing_changed = normalized_pricing != config.pricing_profile;
        if pricing_changed {
            config.pricing_profile = normalized_pricing;
        }
        if apply_capacity_v1_collector_defaults(&mut config) || pricing_changed {
            self.save_config(&config)?;
        }
        Ok(config)
    }

    pub fn save_config(&self, config: &AppConfig) -> Result<()> {
        let text = serde_json::to_string_pretty(config).context("序列化客户端配置失败")?;
        fs::write(&self.config_path, text).context("保存客户端配置失败")
    }

    pub fn save_snapshot(
        &self,
        target: &CpaTargetConfig,
        captured_at: i64,
        rows: &[Value],
        strategy: &str,
        error_summary: Option<String>,
    ) -> Result<i64> {
        let conn = self.open()?;
        conn.execute(
            "INSERT INTO snapshots (cpa_id, cpa_name, cpa_api_base, captured_at, rows_json, collect_strategy, error_summary)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                target.id,
                target.name,
                target.api_base,
                captured_at,
                serde_json::to_string(rows)?,
                strategy,
                error_summary
            ],
        )?;
        Ok(conn.last_insert_rowid())
    }

    pub fn latest_snapshot(&self, cpa_id: &str) -> Result<Option<SnapshotRecord>> {
        let conn = self.open()?;
        conn.query_row(
            "SELECT id, cpa_id, cpa_name, captured_at, rows_json, collect_strategy, error_summary
             FROM snapshots WHERE cpa_id = ?1 ORDER BY captured_at DESC, id DESC LIMIT 1",
            params![cpa_id],
            |row| {
                let rows_json: String = row.get(4)?;
                let rows = serde_json::from_str::<Vec<Value>>(&rows_json).unwrap_or_default();
                Ok(SnapshotRecord {
                    id: row.get(0)?,
                    cpa_id: row.get(1)?,
                    cpa_name: row.get(2)?,
                    captured_at: row.get(3)?,
                    rows,
                    strategy: row.get(5)?,
                    error_summary: row.get(6)?,
                })
            },
        )
        .optional()
        .context("读取最新快照失败")
    }

    pub fn recent_snapshots(&self, cpa_id: &str, since: i64) -> Result<Vec<SnapshotRecord>> {
        let conn = self.open()?;
        let mut statement = conn
            .prepare(
                "SELECT id, cpa_id, cpa_name, captured_at, rows_json, collect_strategy, error_summary
                 FROM snapshots WHERE cpa_id = ?1 AND captured_at >= ?2 ORDER BY captured_at ASC, id ASC",
            )
            .context("准备读取历史快照失败")?;
        let rows = statement
            .query_map(params![cpa_id, since], |row| {
                let rows_json: String = row.get(4)?;
                let rows = serde_json::from_str::<Vec<Value>>(&rows_json).unwrap_or_default();
                Ok(SnapshotRecord {
                    id: row.get(0)?,
                    cpa_id: row.get(1)?,
                    cpa_name: row.get(2)?,
                    captured_at: row.get(3)?,
                    rows,
                    strategy: row.get(5)?,
                    error_summary: row.get(6)?,
                })
            })
            .context("读取历史快照失败")?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .context("解析历史快照失败")
    }

    pub fn clear_history(&self, cpa_id: Option<&str>) -> Result<()> {
        let conn = self.open()?;
        if let Some(cpa_id) = cpa_id {
            conn.execute("DELETE FROM snapshots WHERE cpa_id = ?1", params![cpa_id])?;
        } else {
            conn.execute("DELETE FROM snapshots", [])?;
        }
        Ok(())
    }

    pub fn active_cooldown(
        &self,
        cpa_id: &str,
        account_key: &str,
        now: i64,
    ) -> Result<Option<CooldownRecord>> {
        let Some(record) = self.cooldown(cpa_id, account_key)? else {
            return Ok(None);
        };
        if record.cooldown_until > now {
            Ok(Some(record))
        } else {
            Ok(None)
        }
    }

    pub fn record_cooldown(
        &self,
        cpa_id: &str,
        account_key: &str,
        reason: &str,
        status_code: Option<u16>,
        now: i64,
        base_minutes: u64,
        max_minutes: u64,
    ) -> Result<CooldownRecord> {
        let previous = self.cooldown(cpa_id, account_key)?;
        let consecutive_failures = previous
            .as_ref()
            .map(|record| record.consecutive_failures.saturating_add(1))
            .unwrap_or(1);
        let shift = consecutive_failures.saturating_sub(1).min(8);
        let multiplier = 1u64 << shift;
        let minutes = base_minutes
            .max(1)
            .saturating_mul(multiplier)
            .min(max_minutes.max(1));
        let cooldown_until = now + (minutes as i64) * 60_000;
        let trimmed_reason = reason.trim();
        let record = CooldownRecord {
            cpa_id: cpa_id.to_string(),
            account_key: account_key.to_string(),
            cooldown_until,
            reason: if trimmed_reason.is_empty() {
                "usage 请求失败".to_string()
            } else {
                trimmed_reason.to_string()
            },
            consecutive_failures,
            last_status_code: status_code,
            updated_at: now,
        };
        let conn = self.open()?;
        conn.execute(
            "INSERT INTO account_cooldowns
                (cpa_id, account_key, cooldown_until, reason, consecutive_failures, last_status_code, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(cpa_id, account_key) DO UPDATE SET
                cooldown_until = excluded.cooldown_until,
                reason = excluded.reason,
                consecutive_failures = excluded.consecutive_failures,
                last_status_code = excluded.last_status_code,
                updated_at = excluded.updated_at",
            params![
                &record.cpa_id,
                &record.account_key,
                record.cooldown_until,
                &record.reason,
                record.consecutive_failures,
                record.last_status_code.map(i64::from),
                record.updated_at
            ],
        )?;
        Ok(record)
    }

    pub fn clear_cooldown(&self, cpa_id: &str, account_key: &str) -> Result<()> {
        let conn = self.open()?;
        conn.execute(
            "DELETE FROM account_cooldowns WHERE cpa_id = ?1 AND account_key = ?2",
            params![cpa_id, account_key],
        )?;
        Ok(())
    }

    pub fn clear_cooldowns(&self, cpa_id: Option<&str>) -> Result<()> {
        let conn = self.open()?;
        if let Some(cpa_id) = cpa_id {
            conn.execute(
                "DELETE FROM account_cooldowns WHERE cpa_id = ?1",
                params![cpa_id],
            )?;
        } else {
            conn.execute("DELETE FROM account_cooldowns", [])?;
        }
        Ok(())
    }

    pub fn claim_alert_cooldown(&self, key: &str, cooldown_minutes: u32, now: i64) -> Result<bool> {
        let conn = self.open()?;
        let current_until = conn
            .query_row(
                "SELECT cooldown_until FROM alert_cooldowns WHERE key = ?1",
                params![key],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .context("读取告警冷却状态失败")?;
        if current_until.map(|until| until > now).unwrap_or(false) {
            return Ok(false);
        }
        let cooldown_until = now + (cooldown_minutes.max(1) as i64) * 60_000;
        conn.execute(
            "INSERT INTO alert_cooldowns (key, cooldown_until, updated_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET
                cooldown_until = excluded.cooldown_until,
                updated_at = excluded.updated_at",
            params![key, cooldown_until, now],
        )
        .context("保存告警冷却状态失败")?;
        Ok(true)
    }

    pub fn prune_history(&self) -> Result<()> {
        let cutoff = now_ms() - 7 * 24 * 60 * 60 * 1000;
        let conn = self.open()?;
        conn.execute(
            "DELETE FROM snapshots WHERE captured_at < ?1",
            params![cutoff],
        )?;
        Ok(())
    }

    fn cooldown(&self, cpa_id: &str, account_key: &str) -> Result<Option<CooldownRecord>> {
        let conn = self.open()?;
        conn.query_row(
            "SELECT cpa_id, account_key, cooldown_until, reason, consecutive_failures, last_status_code, updated_at
             FROM account_cooldowns WHERE cpa_id = ?1 AND account_key = ?2",
            params![cpa_id, account_key],
            |row| {
                let last_status_code: Option<i64> = row.get(5)?;
                Ok(CooldownRecord {
                    cpa_id: row.get(0)?,
                    account_key: row.get(1)?,
                    cooldown_until: row.get(2)?,
                    reason: row.get(3)?,
                    consecutive_failures: row.get(4)?,
                    last_status_code: last_status_code.and_then(|value| u16::try_from(value).ok()),
                    updated_at: row.get(6)?,
                })
            },
        )
        .optional()
        .context("读取账号冷却状态失败")
    }

    fn open(&self) -> Result<Connection> {
        Connection::open(&self.db_path).context("打开 SQLite 数据库失败")
    }

    fn ensure_db(&self) -> Result<()> {
        let conn = self.open()?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS snapshots (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                cpa_id TEXT NOT NULL,
                cpa_name TEXT NOT NULL,
                cpa_api_base TEXT NOT NULL,
                captured_at INTEGER NOT NULL,
                rows_json TEXT NOT NULL,
                collect_strategy TEXT NOT NULL,
                error_summary TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_snapshots_cpa_captured ON snapshots(cpa_id, captured_at DESC);
            CREATE TABLE IF NOT EXISTS account_cooldowns (
                cpa_id TEXT NOT NULL,
                account_key TEXT NOT NULL,
                cooldown_until INTEGER NOT NULL,
                reason TEXT NOT NULL,
                consecutive_failures INTEGER NOT NULL,
                last_status_code INTEGER,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (cpa_id, account_key)
            );
            CREATE INDEX IF NOT EXISTS idx_account_cooldowns_until ON account_cooldowns(cooldown_until);
            CREATE TABLE IF NOT EXISTS alert_cooldowns (
                key TEXT PRIMARY KEY,
                cooldown_until INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_alert_cooldowns_until ON alert_cooldowns(cooldown_until);",
        )?;
        Ok(())
    }
}

pub fn normalize_api_base(input: &str) -> Result<String> {
    let trimmed = input.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        anyhow::bail!("请输入 CPA 地址");
    }
    let parsed = url::Url::parse(trimmed).context("CPA 地址必须包含 http:// 或 https://")?;
    match parsed.scheme() {
        "http" | "https" => Ok(trimmed.to_string()),
        _ => anyhow::bail!("CPA 地址只支持 http:// 或 https://"),
    }
}

fn apply_capacity_v1_collector_defaults(config: &mut AppConfig) -> bool {
    let mut changed = false;
    let using_previous_speed_defaults =
        (config.collector.collect_usage_max_requests_per_minute - 10.0).abs() < f64::EPSILON
            && (config.collector.collect_manual_max_requests_per_minute - 10.0).abs()
                < f64::EPSILON
            && config.collector.collect_concurrency == 2
            && matches!(config.collector.collect_manual_concurrency, 4 | 10);
    if config.collector.collect_usage_mode == "continuous" {
        config.collector.collect_usage_mode = "full".to_string();
        changed = true;
    }
    if config.collector.collect_usage_tick_seconds == 180 {
        config.collector.collect_usage_tick_seconds = 300;
        changed = true;
    }
    if using_previous_speed_defaults
        || (config.collector.collect_usage_max_requests_per_minute - 2.0).abs() < f64::EPSILON
    {
        config.collector.collect_usage_max_requests_per_minute = 30.0;
        config.collector.collect_manual_max_requests_per_minute = 30.0;
        config.collector.collect_concurrency = 3;
        config.collector.collect_manual_concurrency = 8;
        changed = true;
    } else if config.collector.collect_manual_concurrency == 10 {
        config.collector.collect_manual_concurrency = 8;
        changed = true;
    }
    changed
}

pub fn build_latest_payload(
    targets: &[CpaTargetConfig],
    selected_cpa_id: Option<&str>,
    snapshot: Option<SnapshotRecord>,
    history: &[SnapshotRecord],
    collector_state: Value,
    collector: &CollectorPreferences,
    pricing_profile: Value,
) -> Value {
    let pricing_profile = pricing::normalize_existing_pricing_profile(pricing_profile);
    let mut snapshot = snapshot;
    if let Some(snapshot) = snapshot.as_mut() {
        reprice_snapshot(snapshot, &pricing_profile);
    }
    let mut history = history.to_vec();
    for record in history.iter_mut() {
        reprice_snapshot(record, &pricing_profile);
    }
    let public_targets: Vec<Value> = targets
        .iter()
        .filter(|target| target.enabled)
        .map(|target| serde_json::to_value(target.public_target()).unwrap_or(Value::Null))
        .collect();
    let selected_id = selected_cpa_id
        .map(str::to_string)
        .or_else(|| {
            public_targets
                .first()
                .and_then(|target| target.get("id"))
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_default();
    let now = now_ms();
    let mut rows = snapshot
        .as_ref()
        .map(|record| record.rows.clone())
        .unwrap_or_default();
    rows.iter_mut().for_each(|row| refresh_row_age(row, now));
    let stats = build_stats(&rows);
    let consumption = build_consumption_summary(
        &history,
        now,
        stats["enabledAccounts"].as_u64().unwrap_or(0) as usize,
    );
    apply_recent_consumption(&mut rows, &consumption);
    let capacity_burn = get_hourly_burn_estimate(&consumption);
    let capacity = build_capacity(
        snapshot.as_ref(),
        &history,
        &collector_state,
        &capacity_burn,
        collector,
        now,
    );
    let risk = build_risk(&rows, &stats, &consumption, now, collector);
    let prediction = build_prediction(&risk);
    let refresh_buckets = build_refresh_buckets(&rows);
    let snapshot_summary = snapshot.map(|record| {
        let collection = json!({
            "strategy": record.strategy,
            "enabledAccounts": stats["enabledAccounts"],
            "freshAccounts": rows.iter().filter(|row| row["quotaSource"] == "fresh").count(),
            "cachedAccounts": rows.iter().filter(|row| row["quotaSource"] == "cached").count(),
            "backoffAccounts": rows.iter().filter(|row| row["quotaSource"] == "backoff").count(),
            "pendingAccounts": rows.iter().filter(|row| row["quotaSource"] == "pending").count(),
            "failedAccounts": rows.iter().filter(|row| row["quotaSource"] == "failed").count(),
            "priorityAccounts": 0
        });
        json!({
            "id": record.id,
            "cpaId": record.cpa_id,
            "cpaName": record.cpa_name,
            "capturedAt": record.captured_at,
            "stats": stats,
            "collection": collection,
            "errorSummary": record.error_summary
        })
    });
    json!({
        "targets": public_targets,
        "selectedCpaId": selected_id,
        "snapshot": snapshot_summary,
        "accounts": rows,
        "refreshBuckets": refresh_buckets,
        "consumption": consumption,
        "capacity": capacity,
        "prediction": prediction,
        "risk": risk,
        "pricingProfile": pricing_profile,
        "collectorState": collector_state
    })
}

fn reprice_snapshot(snapshot: &mut SnapshotRecord, pricing_profile: &Value) {
    snapshot
        .rows
        .iter_mut()
        .for_each(|row| reprice_quota_row(row, pricing_profile));
}

fn build_stats(rows: &[Value]) -> Value {
    let total_accounts = rows.len();
    let enabled_rows = rows
        .iter()
        .filter(|row| !is_disabled_row(row))
        .collect::<Vec<_>>();
    let enabled_accounts = rows.iter().filter(|row| !is_disabled_row(row)).count();
    let paused_accounts = rows.iter().filter(|row| row["status"] == "paused").count();
    let failed_or_unknown_accounts = rows
        .iter()
        .filter(|row| {
            !is_disabled_row(row) && (row["status"] == "failed" || row["status"] == "unknown")
        })
        .count();
    let successful_accounts = enabled_rows
        .iter()
        .filter(|row| row["status"] == "active")
        .count();
    let five_hour_remaining_points = enabled_rows
        .iter()
        .filter_map(|row| row["fiveHour"]["remainingPoints"].as_f64())
        .sum::<f64>();
    let weekly_remaining_points = enabled_rows
        .iter()
        .filter_map(|row| row["weekly"]["remainingPoints"].as_f64())
        .sum::<f64>();
    let five_hour_remaining_usd = enabled_rows
        .iter()
        .filter_map(|row| row["fiveHour"]["remainingUsd"].as_f64())
        .sum::<f64>();
    let weekly_remaining_usd = enabled_rows
        .iter()
        .filter_map(|row| row["weekly"]["remainingUsd"].as_f64())
        .sum::<f64>();
    let unpriced_five_hour_accounts = rows
        .iter()
        .filter(|row| {
            !row["disabled"].as_bool().unwrap_or(false) && row["fiveHour"]["remainingUsd"].is_null()
        })
        .count();
    let unpriced_weekly_accounts = rows
        .iter()
        .filter(|row| {
            !row["disabled"].as_bool().unwrap_or(false) && row["weekly"]["remainingUsd"].is_null()
        })
        .count();
    json!({
        "totalAccounts": total_accounts,
        "enabledAccounts": enabled_accounts,
        "pausedAccounts": paused_accounts,
        "failedOrUnknownAccounts": failed_or_unknown_accounts,
        "successfulAccounts": successful_accounts,
        "fiveHourRemainingPoints": five_hour_remaining_points,
        "weeklyRemainingPoints": weekly_remaining_points,
        "fiveHourRemainingUsd": five_hour_remaining_usd,
        "weeklyRemainingUsd": weekly_remaining_usd,
        "unpricedFiveHourAccounts": unpriced_five_hour_accounts,
        "unpricedWeeklyAccounts": unpriced_weekly_accounts
    })
}

const ZERO_CONSUMPTION_MIN_COVERAGE_PERCENT: f64 = 60.0;
const MAX_BOUNDARY_BASELINE_MS: i64 = 90 * 60 * 1000;
const HOUR_MS: i64 = 60 * 60 * 1000;
const FUTURE_FIVE_HOUR_HORIZON_HOURS: i64 = 5;
const CAPACITY_EXPIRED_AFTER_MS: i64 = 15 * 60 * 1000;
const CAPACITY_RELEASE_EPSILON_USD: f64 = 0.01;

#[derive(Debug, Clone)]
struct HistoricalWindowSample {
    cpa_id: String,
    account_key: String,
    captured_at: i64,
    used_percent: Option<f64>,
    consumed_usd_per_point: Option<f64>,
}

#[derive(Debug, Clone)]
struct AccountConsumption {
    usd: Option<f64>,
    state: &'static str,
}

#[derive(Debug, Clone)]
struct ConsumptionWindow {
    total_usd: f64,
    by_account: HashMap<String, AccountConsumption>,
    comparable_series: usize,
    unpriced_series: usize,
}

#[derive(Debug, Clone)]
struct BurnEstimate {
    hourly_burn_usd: Option<f64>,
    one_hour_burn_usd: Option<f64>,
    three_hour_burn_usd: Option<f64>,
    thirty_minute_burn_usd: Option<f64>,
    burn_rate_basis: &'static str,
    consumption_coverage_percent: f64,
    spike_detected: bool,
}

#[derive(Debug, Clone)]
struct EffectiveCapacityBurn {
    observed_hourly_usd: Option<f64>,
    effective_hourly_usd: Option<f64>,
    coverage_multiplier: Option<f64>,
}

#[derive(Debug, Clone)]
struct SupportSimulation {
    available_hours: Option<f64>,
    estimated_depletion_at: Option<i64>,
    depleted_within_horizon: bool,
    projected_usable_usd: f64,
    projected_spend_usd: Option<f64>,
    projected_margin_usd: Option<f64>,
    coverage_ratio: Option<f64>,
    status: &'static str,
}

fn build_consumption_summary(
    history: &[SnapshotRecord],
    now: i64,
    enabled_account_count: usize,
) -> Value {
    let samples = historical_samples(history);
    let ten = calculate_consumption_from_samples(&samples, 10, now);
    let thirty = calculate_consumption_from_samples(&samples, 30, now);
    let sixty = calculate_consumption_from_samples(&samples, 60, now);
    let three_hours = calculate_consumption_from_samples(&samples, 180, now);
    let by_account30m = thirty
        .by_account
        .iter()
        .map(|(key, value)| {
            (
                key.clone(),
                json!({
                    "usd": value.usd,
                    "state": value.state
                }),
            )
        })
        .collect::<serde_json::Map<String, Value>>();
    json!({
        "tenMinutes": summarize_consumption_window(&ten, enabled_account_count),
        "thirtyMinutes": summarize_consumption_window(&thirty, enabled_account_count),
        "sixtyMinutes": summarize_consumption_window(&sixty, enabled_account_count),
        "oneHour": summarize_consumption_window(&sixty, enabled_account_count),
        "threeHours": summarize_consumption_window(&three_hours, enabled_account_count),
        "byAccount30m": Value::Object(by_account30m)
    })
}

fn historical_samples(history: &[SnapshotRecord]) -> Vec<HistoricalWindowSample> {
    history
        .iter()
        .flat_map(|snapshot| {
            snapshot
                .rows
                .iter()
                .filter(|row| is_countable_quota_row(row))
                .map(|row| to_historical_window_sample(row, snapshot.captured_at))
        })
        .collect()
}

fn to_historical_window_sample(row: &Value, captured_at: i64) -> HistoricalWindowSample {
    let window = &row["fiveHour"];
    let remaining_usd = window["remainingUsd"].as_f64();
    let remaining_points = window["remainingPoints"].as_f64();
    let consumed_usd_per_point = match (remaining_usd, remaining_points) {
        (Some(usd), Some(points)) if points > 0.0 && usd.is_finite() && points.is_finite() => {
            Some(usd / points)
        }
        _ => None,
    };
    HistoricalWindowSample {
        cpa_id: row["cpaId"].as_str().unwrap_or_default().to_string(),
        account_key: row_consumption_account_key(row),
        captured_at,
        used_percent: window["usedPercent"].as_f64(),
        consumed_usd_per_point,
    }
}

fn calculate_consumption_from_samples(
    samples: &[HistoricalWindowSample],
    minutes: i64,
    now: i64,
) -> ConsumptionWindow {
    let cutoff = now - minutes * 60 * 1000;
    let baseline_cutoff = cutoff - MAX_BOUNDARY_BASELINE_MS;
    let mut series: HashMap<String, Vec<HistoricalWindowSample>> = HashMap::new();
    for sample in samples
        .iter()
        .filter(|sample| {
            sample.used_percent.is_some()
                && sample.captured_at >= baseline_cutoff
                && sample.captured_at <= now
        })
        .cloned()
    {
        let key = format!("{}::{}", sample.cpa_id, sample.account_key);
        series.entry(key).or_default().push(sample);
    }

    let mut by_account = HashMap::new();
    let mut comparable_series = 0usize;
    let mut unpriced_series = 0usize;
    for (account_key, entries) in series.iter_mut() {
        entries.sort_by_key(|sample| sample.captured_at);
        if entries.len() < 2 {
            continue;
        }
        let mut consumed_usd = 0.0;
        let mut has_unpriced_delta = false;
        let mut has_comparable_delta = false;
        let mut previous = entries[0].clone();
        for current in entries.iter().skip(1).cloned() {
            let current_inside_window = current.captured_at >= cutoff && current.captured_at <= now;
            let Some(previous_used_percent) = previous.used_percent else {
                previous = current;
                continue;
            };
            let Some(current_used_percent) = current.used_percent else {
                previous = current;
                continue;
            };
            let delta = current_used_percent - previous_used_percent;
            let consumed_percent = if delta > 0.0 {
                delta
            } else if delta < 0.0 {
                current_used_percent
            } else {
                0.0
            };
            if !current_inside_window {
                previous = current;
                continue;
            }
            has_comparable_delta = true;
            if consumed_percent > 0.0 {
                let usd_per_point = current
                    .consumed_usd_per_point
                    .or(previous.consumed_usd_per_point);
                if let Some(usd_per_point) = usd_per_point.filter(|value| value.is_finite()) {
                    consumed_usd += consumed_percent * usd_per_point;
                } else {
                    has_unpriced_delta = true;
                }
            }
            previous = current;
        }

        if !has_comparable_delta {
            continue;
        }
        comparable_series += 1;
        if has_unpriced_delta {
            unpriced_series += 1;
            by_account.insert(
                account_key.clone(),
                AccountConsumption {
                    usd: None,
                    state: "unpriced",
                },
            );
        } else {
            by_account.insert(
                account_key.clone(),
                AccountConsumption {
                    usd: Some(consumed_usd),
                    state: "priced",
                },
            );
        }
    }
    let total_usd = by_account
        .values()
        .filter_map(|value| value.usd)
        .sum::<f64>();
    ConsumptionWindow {
        total_usd,
        by_account,
        comparable_series,
        unpriced_series,
    }
}

fn summarize_consumption_window(value: &ConsumptionWindow, enabled_account_count: usize) -> Value {
    let raw_coverage_percent = if enabled_account_count > 0 {
        value.comparable_series as f64 / enabled_account_count as f64 * 100.0
    } else {
        100.0
    };
    let coverage_percent = raw_coverage_percent.clamp(0.0, 100.0);
    json!({
        "totalUsd": value.total_usd,
        "comparableSeries": value.comparable_series,
        "unpricedSeries": value.unpriced_series,
        "coveragePercent": coverage_percent,
        "zeroConsumptionReliable": value.total_usd > 0.0
            || value.comparable_series == 0
            || coverage_percent >= ZERO_CONSUMPTION_MIN_COVERAGE_PERCENT
    })
}

fn apply_recent_consumption(rows: &mut [Value], consumption: &Value) {
    for row in rows {
        let account_key = row_consumption_account_key(row);
        let key = format!(
            "{}::{}",
            row["cpaId"].as_str().unwrap_or_default(),
            account_key
        );
        let fallback_key = format!(
            "{}::{}",
            row["cpaId"].as_str().unwrap_or_default(),
            row["accountKey"]
                .as_str()
                .or_else(|| row["name"].as_str())
                .unwrap_or_default()
        );
        let name_fallback_key = format!(
            "{}::{}",
            row["cpaId"].as_str().unwrap_or_default(),
            row["name"].as_str().unwrap_or_default()
        );
        let account = consumption["byAccount30m"]
            .get(&key)
            .or_else(|| consumption["byAccount30m"].get(&fallback_key))
            .or_else(|| consumption["byAccount30m"].get(&name_fallback_key));
        if let Some(object) = row.as_object_mut() {
            object.insert(
                "recent30mConsumedUsd".to_string(),
                account
                    .and_then(|value| value.get("usd"))
                    .cloned()
                    .unwrap_or(Value::Null),
            );
            object.insert(
                "recent30mConsumptionState".to_string(),
                json!(account
                    .and_then(|value| value.get("state"))
                    .and_then(Value::as_str)
                    .unwrap_or("no-sample")),
            );
        }
    }
}

fn row_consumption_account_key(row: &Value) -> String {
    if row["normalizedPlan"] == "team" {
        if let Some(auth_index) = row["authIndex"].as_str().filter(|value| !value.is_empty()) {
            return auth_index.to_string();
        }
    }
    row["accountKey"]
        .as_str()
        .or_else(|| row["authIndex"].as_str())
        .or_else(|| row["name"].as_str())
        .unwrap_or_default()
        .to_string()
}

fn is_countable_quota_row(row: &Value) -> bool {
    !is_disabled_row(row)
        && row["status"] == "active"
        && (row["quotaSource"] == "fresh" || row["quotaSource"] == "cached")
        && row["fiveHour"]["usedPercent"].as_f64().is_some()
        && row["fiveHour"]["remainingUsd"].as_f64().is_some()
        && row["weekly"]["usedPercent"].as_f64().is_some()
        && row["weekly"]["remainingUsd"].as_f64().is_some()
}

fn build_risk(
    rows: &[Value],
    stats: &Value,
    consumption: &Value,
    now: i64,
    collector: &CollectorPreferences,
) -> Value {
    let trust_max_ms = (collector.cache_trust_max_minutes as i64) * 60 * 1000;
    let enabled_count = stats["enabledAccounts"].as_f64().unwrap_or(0.0);
    let trusted_rows: Vec<&Value> = rows
        .iter()
        .filter(|row| {
            if row["disabled"].as_bool().unwrap_or(false) {
                return false;
            }
            let source = row["quotaSource"].as_str().unwrap_or_default();
            if source != "fresh" && source != "cached" {
                return false;
            }
            row["quotaSampledAt"]
                .as_i64()
                .map(|sampled_at| now - sampled_at <= trust_max_ms)
                .unwrap_or(false)
        })
        .collect();
    let conservative_five_hour_usd = trusted_rows
        .iter()
        .filter_map(|row| row["fiveHour"]["remainingUsd"].as_f64())
        .sum::<f64>();
    let conservative_weekly_usd = trusted_rows
        .iter()
        .filter_map(|row| row["weekly"]["remainingUsd"].as_f64())
        .sum::<f64>();
    let conservative_usable_usd = trusted_rows.iter().map(|row| usable_usd(row)).sum::<f64>();
    let nominal_usable_usd = rows
        .iter()
        .filter(|row| !is_disabled_row(row))
        .map(usable_usd)
        .sum::<f64>();
    let burn = get_hourly_burn_estimate(consumption);
    let hourly_burn_usd = burn.hourly_burn_usd;
    let support_simulation = simulate_support(&trusted_rows, now, hourly_burn_usd);
    let available_hours_capped = hourly_burn_usd == Some(0.0);
    let available_hours = if available_hours_capped {
        Some(7.0 * 24.0)
    } else {
        support_simulation.available_hours
    };
    let estimated_depletion_at = if available_hours_capped {
        None
    } else {
        support_simulation.estimated_depletion_at
    };
    let projected_five_hour_spend_usd = hourly_burn_usd.unwrap_or(0.0) * 5.0;
    let future_five_hour_at = now + FUTURE_FIVE_HOUR_HORIZON_HOURS * HOUR_MS;
    let future_five_hour = build_future_five_hour(&support_simulation);
    let future_five_hour_refresh_usd =
        (sum_projected_window_usd(&trusted_rows, "fiveHour", now, future_five_hour_at)
            - conservative_five_hour_usd)
            .max(0.0);
    let future_weekly_refresh_usd =
        (sum_projected_window_usd(&trusted_rows, "weekly", now, future_five_hour_at)
            - conservative_weekly_usd)
            .max(0.0);
    let fresh_usable_accounts = rows
        .iter()
        .filter(|row| {
            !is_disabled_row(row) && row["quotaSource"] == "fresh" && usable_usd(row) > 0.0
        })
        .count();
    let trusted_cached_accounts = trusted_rows
        .iter()
        .filter(|row| row["quotaSource"] == "cached")
        .count();
    let stale_cached_accounts = rows
        .iter()
        .filter(|row| {
            !is_disabled_row(row)
                && row["quotaSource"] == "cached"
                && row["quotaSampledAt"]
                    .as_i64()
                    .map(|sampled_at| now - sampled_at > trust_max_ms)
                    .unwrap_or(true)
        })
        .count();
    let trusted_coverage_percent = if enabled_count > 0.0 {
        trusted_rows.len() as f64 / enabled_count * 100.0
    } else {
        0.0
    };
    let fresh_coverage_percent = if enabled_count > 0.0 {
        fresh_usable_accounts as f64 / enabled_count * 100.0
    } else {
        0.0
    };
    let failed = stats["failedOrUnknownAccounts"].as_u64().unwrap_or(0);
    let (tone, title, detail) = if rows.is_empty() {
        ("muted", "等待 CPA 数据", "当前没有可用的 CPA 号池数据。")
    } else if failed > 0 {
        (
            "watch",
            "账号池存在异常账号",
            "部分账号采集失败或额度窗口无法识别，请查看账号明细。",
        )
    } else if hourly_burn_usd.is_none() {
        (
            "ok",
            "号池运行稳定",
            "当前可调度容量可用，等待更多 fresh 对比样本后可估算消耗速度。",
        )
    } else if hourly_burn_usd == Some(0.0) {
        (
            if trusted_coverage_percent < 60.0 {
                "watch"
            } else {
                "ok"
            },
            if trusted_coverage_percent < 60.0 {
                "消耗低但采样不足"
            } else {
                "当前消耗趋近于 0"
            },
            if trusted_coverage_percent < 60.0 {
                "近期未观察到明显消耗，但可用样本覆盖偏低。"
            } else {
                "近期未观察到明显消耗，当前无需按消耗补号。"
            },
        )
    } else if available_hours
        .map(|hours| hours <= collector.alert_pool_remaining_hours_emergency)
        .unwrap_or(false)
    {
        (
            "critical",
            "容量即将耗尽，紧急补号",
            "按当前消耗趋势估算，账号池预计 1 小时内可能耗尽。",
        )
    } else if available_hours
        .map(|hours| hours <= collector.alert_pool_remaining_hours_critical)
        .unwrap_or(false)
    {
        (
            "critical",
            "容量风险严重",
            "按当前消耗趋势估算，账号池预计撑不过严重预警阈值。",
        )
    } else if available_hours
        .map(|hours| hours <= collector.alert_pool_remaining_hours_warn)
        .unwrap_or(false)
    {
        (
            "warn",
            "需要准备补号",
            "按当前消耗趋势估算，保守 5h 容量不足以稳定覆盖后续几小时。",
        )
    } else if burn.spike_detected
        && available_hours
            .map(|hours| hours <= collector.alert_pool_remaining_hours_warn * 1.5)
            .unwrap_or(false)
    {
        (
            "watch",
            "短时消耗正在抬升",
            "近 30 分钟消耗速度明显高于平滑趋势，建议关注后续一轮采样。",
        )
    } else if trusted_coverage_percent < 60.0 {
        (
            "watch",
            "容量看起来够，但可信度偏低",
            "当前账面容量包含较多过期缓存或 fresh 覆盖不足，建议等待下一轮采集或手动点击智能采集。",
        )
    } else {
        (
            "ok",
            "号池容量稳定",
            "按近 1-3 小时消耗趋势和未来 5h 刷新节奏估算，保守容量可以覆盖后续窗口。",
        )
    };
    let curve = build_curve(
        &trusted_rows,
        now,
        conservative_five_hour_usd,
        conservative_weekly_usd,
        hourly_burn_usd,
    );
    let lowest_projected = curve
        .as_array()
        .and_then(|points| {
            points.iter().min_by(|left, right| {
                left["projectedUsd"]
                    .as_f64()
                    .unwrap_or(f64::INFINITY)
                    .partial_cmp(&right["projectedUsd"].as_f64().unwrap_or(f64::INFINITY))
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
        })
        .cloned()
        .unwrap_or_else(|| json!({ "projectedUsd": conservative_usable_usd, "at": now }));
    json!({
        "tone": tone,
        "title": title,
        "detail": detail,
        "conservativeFiveHourUsd": conservative_five_hour_usd,
        "nominalFiveHourUsd": stats["fiveHourRemainingUsd"],
        "conservativeWeeklyUsd": conservative_weekly_usd,
        "nominalWeeklyUsd": stats["weeklyRemainingUsd"],
        "conservativeUsableUsd": conservative_usable_usd,
        "nominalUsableUsd": nominal_usable_usd,
        "hourlyBurnUsd": hourly_burn_usd,
        "oneHourBurnUsd": burn.one_hour_burn_usd,
        "threeHourBurnUsd": burn.three_hour_burn_usd,
        "thirtyMinuteBurnUsd": burn.thirty_minute_burn_usd,
        "burnRateBasis": burn.burn_rate_basis,
        "availableHours": available_hours,
        "availableHoursCapped": available_hours_capped,
        "estimatedDepletionAt": estimated_depletion_at,
        "projectedFiveHourSpendUsd": projected_five_hour_spend_usd,
        "futureFiveHour": future_five_hour,
        "futureFiveHourRefreshUsd": future_five_hour_refresh_usd,
        "futureWeeklyRefreshUsd": future_weekly_refresh_usd,
        "lowestProjectedFiveHourUsd": lowest_projected["projectedUsd"],
        "lowestProjectedAt": lowest_projected["at"],
        "consumptionCoveragePercent": burn.consumption_coverage_percent,
        "spikeDetected": burn.spike_detected,
        "freshUsableAccounts": fresh_usable_accounts,
        "trustedCachedAccounts": trusted_cached_accounts,
        "staleCachedAccounts": stale_cached_accounts,
        "excludedAccounts": (enabled_count as usize).saturating_sub(trusted_rows.len()),
        "simulationExcludedAccounts": {
            "disabled": rows.iter().filter(|row| row["disabled"].as_bool().unwrap_or(false)).count(),
            "inactive": rows.iter().filter(|row| !row["disabled"].as_bool().unwrap_or(false) && row["status"] != "active").count(),
            "staleCached": stale_cached_accounts,
            "unpriced": rows.iter().filter(|row| !is_disabled_row(row) && row["normalizedPlan"] == "unknown").count(),
            "missingQuota": rows.iter().filter(|row| !is_disabled_row(row) && (row["fiveHour"].is_null() || row["weekly"].is_null())).count(),
            "untrustedSource": rows.iter().filter(|row| !is_disabled_row(row) && row["quotaSource"] != "fresh" && row["quotaSource"] != "cached").count()
        },
        "freshCoveragePercent": fresh_coverage_percent,
        "trustedCoveragePercent": trusted_coverage_percent,
        "cacheTrustMaxMinutes": collector.cache_trust_max_minutes,
        "curve": curve
    })
}

fn build_prediction(risk: &Value) -> Value {
    let tone = risk["tone"].as_str().unwrap_or("muted");
    if risk["hourlyBurnUsd"].is_null() {
        json!({
            "tone": "muted",
            "title": "样本不足",
            "detail": "需要至少两轮 fresh 对比样本后才能估算可撑时间。",
            "projectedFiveHourUsd": 0
        })
    } else if tone == "ok" {
        json!({
            "tone": "ok",
            "title": "当前池容量足够",
            "detail": "当前可调度容量可用，后台会持续采集形成消耗趋势。",
            "projectedFiveHourUsd": risk["projectedFiveHourSpendUsd"]
        })
    } else {
        json!({
            "tone": if tone == "critical" || tone == "warn" { "warn" } else { "muted" },
            "title": risk["title"],
            "detail": risk["detail"],
            "projectedFiveHourUsd": risk["projectedFiveHourSpendUsd"]
        })
    }
}

fn build_capacity(
    latest_snapshot: Option<&SnapshotRecord>,
    history: &[SnapshotRecord],
    collector_state: &Value,
    burn: &BurnEstimate,
    collector: &CollectorPreferences,
    now: i64,
) -> Value {
    let effective_burn = effective_capacity_burn(burn);
    let Some((snapshot, fresh_complete)) = latest_capacity_snapshot(latest_snapshot, history)
    else {
        let fallback_enabled = latest_snapshot.map(enabled_account_count).unwrap_or(0);
        let fallback_included = latest_snapshot
            .map(|snapshot| {
                snapshot
                    .rows
                    .iter()
                    .filter(|row| is_capacity_row(row))
                    .count()
            })
            .unwrap_or(0);
        let status = if collector_state["status"] == "collecting" {
            "collecting"
        } else {
            "waiting"
        };
        return json!({
            "snapshotCapturedAt": Value::Null,
            "snapshotAgeMs": Value::Null,
            "freshComplete": false,
            "enabledAccounts": fallback_enabled,
            "includedAccounts": fallback_included,
            "excludedAccounts": fallback_enabled.saturating_sub(fallback_included),
            "currentUsableUsd": Value::Null,
            "hourlyBurnUsd": burn.hourly_burn_usd,
            "observedHourlyBurnUsd": effective_burn.observed_hourly_usd,
            "effectiveHourlyBurnUsd": effective_burn.effective_hourly_usd,
            "burnCoverageMultiplier": effective_burn.coverage_multiplier,
            "burnRateBasis": burn.burn_rate_basis,
            "consumptionCoveragePercent": burn.consumption_coverage_percent,
            "supportHours": Value::Null,
            "estimatedDepletionAt": Value::Null,
            "supportStatus": "insufficient-sample",
            "projectedFiveHourSpendUsd": Value::Null,
            "projectedFiveHourMarginUsd": Value::Null,
            "fiveHourTimeline": [],
            "twentyFourHourSummary": empty_twenty_four_hour_summary(),
            "status": status
        });
    };

    let age_ms = (now - snapshot.captured_at).max(0);
    let included_rows: Vec<&Value> = snapshot
        .rows
        .iter()
        .filter(|row| is_capacity_row(row))
        .collect();
    let enabled_accounts = enabled_account_count(snapshot);
    let included_accounts = included_rows.len();
    let excluded_accounts = enabled_accounts.saturating_sub(included_accounts);
    let has_capacity_rows = included_accounts > 0;
    let is_expired = age_ms > CAPACITY_EXPIRED_AFTER_MS;
    let current_usable_usd = sum_projected_usable_usd(&included_rows, now, now);
    let five_hour_timeline = if is_expired || !has_capacity_rows {
        Value::Array(Vec::new())
    } else {
        build_capacity_timeline(&included_rows, now, 5, effective_burn.effective_hourly_usd)
    };
    let twenty_four_hour_summary = if is_expired || !has_capacity_rows {
        empty_twenty_four_hour_summary()
    } else {
        build_twenty_four_hour_capacity_summary(&included_rows, now)
    };
    let projected_five_hour_spend_usd = effective_burn
        .effective_hourly_usd
        .map(|hourly| hourly * 5.0);
    let five_hour_minimum = five_hour_timeline
        .as_array()
        .and_then(|points| {
            points.iter().min_by(|left, right| {
                left["projectedRemainingUsd"]
                    .as_f64()
                    .or_else(|| left["usableUsd"].as_f64())
                    .unwrap_or(f64::INFINITY)
                    .partial_cmp(
                        &right["projectedRemainingUsd"]
                            .as_f64()
                            .or_else(|| right["usableUsd"].as_f64())
                            .unwrap_or(f64::INFINITY),
                    )
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
        })
        .and_then(|point| point["projectedRemainingUsd"].as_f64());
    let five_hour_capacity_minimum = five_hour_timeline
        .as_array()
        .and_then(|points| {
            points.iter().min_by(|left, right| {
                left["usableUsd"]
                    .as_f64()
                    .unwrap_or(f64::INFINITY)
                    .partial_cmp(&right["usableUsd"].as_f64().unwrap_or(f64::INFINITY))
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
        })
        .and_then(|point| point["usableUsd"].as_f64())
        .unwrap_or(current_usable_usd);
    let projected_five_hour_margin_usd = five_hour_timeline
        .as_array()
        .and_then(|points| points.last())
        .and_then(|point| point["projectedRemainingUsd"].as_f64());
    let support_simulation = if is_expired || !has_capacity_rows {
        None
    } else {
        Some(simulate_support(
            &included_rows,
            now,
            effective_burn.effective_hourly_usd,
        ))
    };
    let support_status = match support_simulation.as_ref() {
        None => "insufficient-sample",
        Some(simulation) if simulation.status == "insufficient-sample" => "insufficient-sample",
        Some(simulation) if simulation.status == "idle" => "idle",
        Some(simulation) if simulation.depleted_within_horizon => "within-5h",
        Some(_) => "beyond-5h",
    };
    let support_hours = support_simulation
        .as_ref()
        .filter(|simulation| simulation.depleted_within_horizon)
        .and_then(|simulation| simulation.available_hours);
    let estimated_depletion_at = support_simulation
        .as_ref()
        .filter(|simulation| simulation.depleted_within_horizon)
        .and_then(|simulation| simulation.estimated_depletion_at);
    let status = if is_expired {
        "waiting"
    } else if !has_capacity_rows {
        "untrusted"
    } else if burn.hourly_burn_usd.is_none() {
        "untrusted"
    } else if support_simulation
        .as_ref()
        .map(|simulation| simulation.depleted_within_horizon)
        .unwrap_or(false)
        || support_simulation
            .as_ref()
            .and_then(|simulation| simulation.available_hours)
            .map(|hours| hours <= collector.alert_pool_remaining_hours_warn)
            .unwrap_or(false)
    {
        "tight"
    } else if five_hour_minimum
        .map(|value| value <= CAPACITY_RELEASE_EPSILON_USD)
        .unwrap_or(false)
        || five_hour_capacity_minimum <= CAPACITY_RELEASE_EPSILON_USD
    {
        "tight"
    } else {
        "ready"
    };

    json!({
        "snapshotCapturedAt": snapshot.captured_at,
        "snapshotAgeMs": age_ms,
        "freshComplete": fresh_complete,
        "enabledAccounts": enabled_accounts,
        "includedAccounts": included_accounts,
        "excludedAccounts": excluded_accounts,
        "currentUsableUsd": if is_expired || !has_capacity_rows { Value::Null } else { json!(current_usable_usd) },
        "hourlyBurnUsd": burn.hourly_burn_usd,
        "observedHourlyBurnUsd": effective_burn.observed_hourly_usd,
        "effectiveHourlyBurnUsd": effective_burn.effective_hourly_usd,
        "burnCoverageMultiplier": effective_burn.coverage_multiplier,
        "burnRateBasis": burn.burn_rate_basis,
        "consumptionCoveragePercent": burn.consumption_coverage_percent,
        "supportHours": support_hours,
        "estimatedDepletionAt": estimated_depletion_at,
        "supportStatus": support_status,
        "projectedFiveHourSpendUsd": projected_five_hour_spend_usd,
        "projectedFiveHourMarginUsd": projected_five_hour_margin_usd,
        "fiveHourTimeline": five_hour_timeline,
        "twentyFourHourSummary": twenty_four_hour_summary,
        "status": status
    })
}

fn latest_capacity_snapshot<'a>(
    latest_snapshot: Option<&'a SnapshotRecord>,
    history: &'a [SnapshotRecord],
) -> Option<(&'a SnapshotRecord, bool)> {
    let mut best = history
        .iter()
        .filter(|snapshot| snapshot.strategy == "full")
        .max_by_key(|snapshot| (snapshot.captured_at, snapshot.id));
    if let Some(snapshot) = latest_snapshot.filter(|snapshot| snapshot.strategy == "full") {
        let replace = best
            .map(|best| (snapshot.captured_at, snapshot.id) > (best.captured_at, best.id))
            .unwrap_or(true);
        if replace {
            best = Some(snapshot);
        }
    }
    let snapshot = best?;
    let fresh_complete = is_complete_fresh_snapshot(snapshot);
    if fresh_complete || snapshot.rows.iter().any(is_capacity_row) {
        Some((snapshot, fresh_complete))
    } else {
        None
    }
}

fn is_complete_fresh_snapshot(snapshot: &SnapshotRecord) -> bool {
    if snapshot.strategy != "full" || snapshot.error_summary.is_some() {
        return false;
    }
    let enabled = enabled_account_count(snapshot);
    enabled > 0
        && snapshot
            .rows
            .iter()
            .filter(|row| !is_disabled_row(row))
            .all(is_complete_fresh_row)
}

fn is_complete_fresh_row(row: &Value) -> bool {
    if is_disabled_row(row) {
        return false;
    }
    row["status"] == "active" && row["quotaSource"] == "fresh" && row["error"].is_null()
}

fn is_capacity_row(row: &Value) -> bool {
    if is_disabled_row(row) {
        return false;
    }
    row["status"] == "active"
        && row["quotaSource"] == "fresh"
        && row["error"].is_null()
        && row["fiveHour"]["remainingUsd"].as_f64().is_some()
        && row["weekly"]["remainingUsd"].as_f64().is_some()
}

fn is_disabled_row(row: &Value) -> bool {
    row["disabled"].as_bool().unwrap_or(false)
}

fn enabled_account_count(snapshot: &SnapshotRecord) -> usize {
    snapshot
        .rows
        .iter()
        .filter(|row| !is_disabled_row(row))
        .count()
}

fn build_capacity_timeline(
    rows: &[&Value],
    now: i64,
    horizon_hours: i64,
    hourly_burn_usd: Option<f64>,
) -> Value {
    Value::Array(
        (0..=horizon_hours)
            .map(|hour| {
                let at = now + hour * HOUR_MS;
                let five_hour_usd = sum_projected_window_usd(rows, "fiveHour", now, at);
                let weekly_usd = sum_projected_window_usd(rows, "weekly", now, at);
                let usable_usd = sum_projected_usable_usd(rows, now, at);
                let projected_spend_usd = hourly_burn_usd.map(|hourly| hourly * hour as f64);
                let projected_remaining_usd = projected_spend_usd.map(|spend| usable_usd - spend);
                json!({
                    "offsetMinutes": hour * 60,
                    "at": at,
                    "usableUsd": usable_usd,
                    "projectedSpendUsd": projected_spend_usd,
                    "projectedRemainingUsd": projected_remaining_usd,
                    "fiveHourUsd": five_hour_usd,
                    "weeklyUsd": weekly_usd
                })
            })
            .collect(),
    )
}

fn build_twenty_four_hour_capacity_summary(rows: &[&Value], now: i64) -> Value {
    let horizon_end = now + 24 * HOUR_MS;
    let current_usable_usd = sum_projected_usable_usd(rows, now, now);
    let horizon_usable_usd = sum_projected_usable_usd(rows, now, horizon_end);
    let mut previous_usable_usd = current_usable_usd;
    let mut release_events = Vec::new();
    let mut lowest_usable_usd = current_usable_usd;
    let mut lowest_at = now;

    for at in capacity_reset_times(rows, now, horizon_end)
        .into_iter()
        .chain(std::iter::once(horizon_end))
    {
        let usable_usd = sum_projected_usable_usd(rows, now, at);
        if usable_usd < lowest_usable_usd {
            lowest_usable_usd = usable_usd;
            lowest_at = at;
        }
        let released_usd = (usable_usd - previous_usable_usd).max(0.0);
        if released_usd > CAPACITY_RELEASE_EPSILON_USD {
            release_events.push(json!({
                "at": at,
                "releasedUsd": released_usd,
                "usableUsd": usable_usd
            }));
        }
        previous_usable_usd = usable_usd;
    }

    let next_major_release = release_events.first().cloned().unwrap_or(Value::Null);
    json!({
        "horizonHours": 24,
        "projectedAddedUsableUsd": (horizon_usable_usd - current_usable_usd).max(0.0),
        "lowestUsableUsd": lowest_usable_usd,
        "lowestAt": lowest_at,
        "nextMajorReleaseAt": next_major_release["at"],
        "nextMajorReleaseUsd": next_major_release["releasedUsd"],
        "releaseEvents": release_events
    })
}

fn empty_twenty_four_hour_summary() -> Value {
    json!({
        "horizonHours": 24,
        "projectedAddedUsableUsd": Value::Null,
        "lowestUsableUsd": Value::Null,
        "lowestAt": Value::Null,
        "nextMajorReleaseAt": Value::Null,
        "nextMajorReleaseUsd": Value::Null,
        "releaseEvents": []
    })
}

fn capacity_reset_times(rows: &[&Value], now: i64, horizon_end: i64) -> Vec<i64> {
    let mut times = BTreeSet::new();
    for row in rows {
        for field in ["fiveHour", "weekly"] {
            if let Some(reset_at) = row[field]["resetAtMs"].as_i64() {
                if reset_at > now && reset_at <= horizon_end {
                    times.insert(reset_at);
                }
            }
        }
    }
    times.into_iter().collect()
}

fn is_consumption_reliable(window: &Value) -> bool {
    window["comparableSeries"].as_u64().unwrap_or(0) > 0
        && (window["totalUsd"].as_f64().unwrap_or(0.0) > 0.0
            || window["zeroConsumptionReliable"].as_bool().unwrap_or(false))
}

fn get_hourly_burn_estimate(consumption: &Value) -> BurnEstimate {
    let thirty_reliable = is_consumption_reliable(&consumption["thirtyMinutes"]);
    let one_hour_reliable = is_consumption_reliable(&consumption["oneHour"]);
    let three_hour_reliable = is_consumption_reliable(&consumption["threeHours"]);
    let thirty_minute_burn_usd = thirty_reliable.then(|| {
        consumption["thirtyMinutes"]["totalUsd"]
            .as_f64()
            .unwrap_or(0.0)
            * 2.0
    });
    let one_hour_burn_usd =
        one_hour_reliable.then(|| consumption["oneHour"]["totalUsd"].as_f64().unwrap_or(0.0));
    let three_hour_burn_usd = three_hour_reliable.then(|| {
        consumption["threeHours"]["totalUsd"]
            .as_f64()
            .unwrap_or(0.0)
            / 3.0
    });

    if let Some(three_hour) = three_hour_burn_usd.filter(|value| *value > 0.0) {
        let one_hour_is_clearly_higher = one_hour_burn_usd
            .map(|one_hour| one_hour > three_hour * 1.25)
            .unwrap_or(false);
        let hourly = if one_hour_is_clearly_higher {
            one_hour_burn_usd.unwrap_or(three_hour)
        } else {
            three_hour
        };
        let spike_detected = thirty_minute_burn_usd
            .map(|thirty| hourly > 0.0 && thirty > hourly * 1.8)
            .unwrap_or(false);
        return BurnEstimate {
            hourly_burn_usd: Some(hourly),
            one_hour_burn_usd,
            three_hour_burn_usd,
            thirty_minute_burn_usd,
            burn_rate_basis: if one_hour_is_clearly_higher {
                "one-hour"
            } else {
                "three-hour"
            },
            consumption_coverage_percent: if one_hour_is_clearly_higher {
                consumption["oneHour"]["coveragePercent"]
                    .as_f64()
                    .unwrap_or(0.0)
            } else {
                consumption["threeHours"]["coveragePercent"]
                    .as_f64()
                    .unwrap_or(0.0)
            },
            spike_detected,
        };
    }

    if let Some(one_hour) = one_hour_burn_usd.filter(|value| *value > 0.0) {
        let spike_detected = thirty_minute_burn_usd
            .map(|thirty| thirty > one_hour * 1.8)
            .unwrap_or(false);
        return BurnEstimate {
            hourly_burn_usd: Some(one_hour),
            one_hour_burn_usd,
            three_hour_burn_usd,
            thirty_minute_burn_usd,
            burn_rate_basis: "one-hour",
            consumption_coverage_percent: consumption["oneHour"]["coveragePercent"]
                .as_f64()
                .unwrap_or(0.0),
            spike_detected,
        };
    }

    if let Some(thirty) = thirty_minute_burn_usd.filter(|value| *value > 0.0) {
        return BurnEstimate {
            hourly_burn_usd: Some(thirty),
            one_hour_burn_usd,
            three_hour_burn_usd,
            thirty_minute_burn_usd,
            burn_rate_basis: "thirty-minute-spike",
            consumption_coverage_percent: consumption["thirtyMinutes"]["coveragePercent"]
                .as_f64()
                .unwrap_or(0.0),
            spike_detected: true,
        };
    }

    if three_hour_burn_usd == Some(0.0)
        || one_hour_burn_usd == Some(0.0)
        || thirty_minute_burn_usd == Some(0.0)
    {
        return BurnEstimate {
            hourly_burn_usd: Some(0.0),
            one_hour_burn_usd,
            three_hour_burn_usd,
            thirty_minute_burn_usd,
            burn_rate_basis: "zero",
            consumption_coverage_percent: [
                consumption["threeHours"]["coveragePercent"]
                    .as_f64()
                    .unwrap_or(0.0),
                consumption["oneHour"]["coveragePercent"]
                    .as_f64()
                    .unwrap_or(0.0),
                consumption["thirtyMinutes"]["coveragePercent"]
                    .as_f64()
                    .unwrap_or(0.0),
            ]
            .into_iter()
            .fold(0.0, f64::max),
            spike_detected: false,
        };
    }

    BurnEstimate {
        hourly_burn_usd: None,
        one_hour_burn_usd,
        three_hour_burn_usd,
        thirty_minute_burn_usd,
        burn_rate_basis: "insufficient",
        consumption_coverage_percent: [
            consumption["threeHours"]["coveragePercent"]
                .as_f64()
                .unwrap_or(0.0),
            consumption["oneHour"]["coveragePercent"]
                .as_f64()
                .unwrap_or(0.0),
            consumption["thirtyMinutes"]["coveragePercent"]
                .as_f64()
                .unwrap_or(0.0),
        ]
        .into_iter()
        .fold(0.0, f64::max),
        spike_detected: false,
    }
}

fn effective_capacity_burn(burn: &BurnEstimate) -> EffectiveCapacityBurn {
    let observed_hourly_usd = burn
        .hourly_burn_usd
        .filter(|value| value.is_finite() && *value >= 0.0);
    let Some(observed) = observed_hourly_usd else {
        return EffectiveCapacityBurn {
            observed_hourly_usd,
            effective_hourly_usd: None,
            coverage_multiplier: None,
        };
    };

    if observed <= 0.0 {
        return EffectiveCapacityBurn {
            observed_hourly_usd,
            effective_hourly_usd: Some(0.0),
            coverage_multiplier: Some(1.0),
        };
    }

    let coverage_percent = if burn.consumption_coverage_percent.is_finite() {
        burn.consumption_coverage_percent.clamp(0.0, 100.0)
    } else {
        0.0
    };
    let effective_coverage_percent = coverage_percent.max(ZERO_CONSUMPTION_MIN_COVERAGE_PERCENT);
    let multiplier = 100.0 / effective_coverage_percent;
    EffectiveCapacityBurn {
        observed_hourly_usd,
        effective_hourly_usd: Some(observed * multiplier),
        coverage_multiplier: Some(multiplier),
    }
}

fn simulate_support(rows: &[&Value], now: i64, hourly_burn_usd: Option<f64>) -> SupportSimulation {
    let horizon_hours = FUTURE_FIVE_HOUR_HORIZON_HOURS as f64;
    let at = now + FUTURE_FIVE_HOUR_HORIZON_HOURS * HOUR_MS;
    let projected_usable_usd = sum_projected_usable_usd(rows, now, at);
    let Some(hourly_burn_usd) = hourly_burn_usd else {
        return SupportSimulation {
            available_hours: None,
            estimated_depletion_at: None,
            depleted_within_horizon: false,
            projected_usable_usd,
            projected_spend_usd: None,
            projected_margin_usd: None,
            coverage_ratio: None,
            status: "insufficient-sample",
        };
    };

    if hourly_burn_usd <= 0.0 {
        return SupportSimulation {
            available_hours: Some(7.0 * 24.0),
            estimated_depletion_at: None,
            depleted_within_horizon: false,
            projected_usable_usd,
            projected_spend_usd: Some(0.0),
            projected_margin_usd: Some(projected_usable_usd),
            coverage_ratio: None,
            status: "idle",
        };
    }

    let projected_spend_usd = (hourly_burn_usd * horizon_hours).max(0.0);
    let projected_margin_usd = projected_usable_usd - projected_spend_usd;
    let coverage_ratio = (projected_usable_usd / projected_spend_usd)
        .is_finite()
        .then_some(projected_usable_usd / projected_spend_usd);
    let mut cumulative_spend_usd = 0.0;
    let mut segment_start = now;
    for event_at in projection_event_times(rows, now, at) {
        let segment_capacity =
            sum_projected_usable_usd(rows, now, segment_start) - cumulative_spend_usd;
        if segment_capacity <= 0.0 {
            let available_hours = (segment_start - now) as f64 / HOUR_MS as f64;
            return SupportSimulation {
                available_hours: Some(available_hours),
                estimated_depletion_at: Some(segment_start),
                depleted_within_horizon: true,
                projected_usable_usd,
                projected_spend_usd: Some(projected_spend_usd),
                projected_margin_usd: Some(projected_margin_usd),
                coverage_ratio,
                status: "shortfall",
            };
        }
        let elapsed_hours = (event_at - segment_start) as f64 / HOUR_MS as f64;
        let segment_spend_usd = hourly_burn_usd * elapsed_hours;
        if segment_spend_usd > segment_capacity {
            let depletion_at =
                segment_start + ((segment_capacity / hourly_burn_usd) * HOUR_MS as f64) as i64;
            let available_hours = (depletion_at - now) as f64 / HOUR_MS as f64;
            return SupportSimulation {
                available_hours: Some(available_hours),
                estimated_depletion_at: Some(depletion_at),
                depleted_within_horizon: true,
                projected_usable_usd,
                projected_spend_usd: Some(projected_spend_usd),
                projected_margin_usd: Some(projected_margin_usd),
                coverage_ratio,
                status: "shortfall",
            };
        }
        cumulative_spend_usd += segment_spend_usd;
        segment_start = event_at;
    }

    let available_hours = horizon_hours + projected_margin_usd.max(0.0) / hourly_burn_usd;
    let estimated_depletion_at = now + (available_hours * HOUR_MS as f64) as i64;
    SupportSimulation {
        available_hours: Some(available_hours),
        estimated_depletion_at: Some(estimated_depletion_at),
        depleted_within_horizon: false,
        projected_usable_usd,
        projected_spend_usd: Some(projected_spend_usd),
        projected_margin_usd: Some(projected_margin_usd),
        coverage_ratio,
        status: "enough",
    }
}

fn build_future_five_hour(simulation: &SupportSimulation) -> Value {
    let status = if simulation.depleted_within_horizon {
        "shortfall"
    } else {
        simulation.status
    };

    json!({
        "horizonHours": FUTURE_FIVE_HOUR_HORIZON_HOURS,
        "projectedUsableUsd": simulation.projected_usable_usd,
        "projectedSpendUsd": simulation.projected_spend_usd,
        "projectedMarginUsd": simulation.projected_margin_usd,
        "coverageRatio": simulation.coverage_ratio,
        "status": status
    })
}

fn projection_event_times(rows: &[&Value], now: i64, horizon_end: i64) -> Vec<i64> {
    let mut times = BTreeSet::new();
    times.insert(horizon_end);
    for row in rows {
        for field in ["fiveHour", "weekly"] {
            if let Some(reset_at) = row[field]["resetAtMs"].as_i64() {
                if reset_at > now && reset_at <= horizon_end {
                    times.insert(reset_at);
                }
            }
        }
    }
    times.into_iter().collect()
}

fn build_curve(
    rows: &[&Value],
    now: i64,
    five_hour_usd: f64,
    weekly_usd: f64,
    hourly_burn_usd: Option<f64>,
) -> Value {
    let mut points = Vec::new();
    for hour in 0..=5 {
        let at = now + hour * HOUR_MS;
        let consumed_usd = hourly_burn_usd.unwrap_or(0.0) * hour as f64;
        let projected_usable_usd = sum_projected_usable_usd(rows, now, at);
        let projected_five_hour_usd = sum_projected_window_usd(rows, "fiveHour", now, at);
        let projected_weekly_usd = sum_projected_window_usd(rows, "weekly", now, at);
        let refreshed_five_hour = (projected_five_hour_usd - five_hour_usd).max(0.0);
        let refreshed_weekly = (projected_weekly_usd - weekly_usd).max(0.0);
        let projected = (projected_usable_usd - consumed_usd).max(0.0);
        points.push(json!({
            "offsetMinutes": hour * 60,
            "at": at,
            "projectedUsd": projected,
            "consumedUsd": consumed_usd,
            "refreshedUsd": refreshed_five_hour + refreshed_weekly,
            "fiveHourUsd": projected_five_hour_usd,
            "weeklyUsd": projected_weekly_usd,
            "usableUsd": projected,
            "refreshedFiveHourUsd": refreshed_five_hour,
            "refreshedWeeklyUsd": refreshed_weekly
        }));
    }
    Value::Array(points)
}

fn sum_projected_usable_usd(rows: &[&Value], now: i64, at: i64) -> f64 {
    rows.iter()
        .map(|row| projected_usable_usd(row, now, at))
        .sum::<f64>()
}

fn sum_projected_window_usd(rows: &[&Value], field: &str, now: i64, at: i64) -> f64 {
    rows.iter()
        .map(|row| projected_window_remaining_usd(row, field, now, at))
        .sum::<f64>()
}

fn projected_usable_usd(row: &Value, now: i64, at: i64) -> f64 {
    if is_disabled_row(row) {
        return 0.0;
    }
    let five = projected_window_remaining_usd(row, "fiveHour", now, at);
    let weekly = projected_window_remaining_usd(row, "weekly", now, at);
    if five <= 0.0 || weekly <= 0.0 {
        0.0
    } else {
        five.min(weekly)
    }
}

fn projected_window_remaining_usd(row: &Value, field: &str, now: i64, at: i64) -> f64 {
    let remaining = row[field]["remainingUsd"].as_f64().unwrap_or(0.0).max(0.0);
    let reset_inside_window = row[field]["resetAtMs"]
        .as_i64()
        .map(|reset| reset > now && reset <= at)
        .unwrap_or(false);
    if reset_inside_window {
        row[field]["fullUsd"]
            .as_f64()
            .unwrap_or(remaining)
            .max(remaining)
            .max(0.0)
    } else {
        remaining
    }
}

fn build_refresh_buckets(rows: &[Value]) -> Value {
    let mut buckets = Vec::new();
    for row in rows {
        let name = row["name"].as_str().unwrap_or("unknown");
        for (field, key) in [
            ("fiveHour", "fiveHourAccounts"),
            ("weekly", "weeklyAccounts"),
        ] {
            if let Some(reset_at) = row[field]["resetAtMs"].as_i64() {
                let sort_minute = reset_at / 60_000;
                let bucket = format!("{}", sort_minute);
                if let Some(existing) = buckets
                    .iter_mut()
                    .find(|item: &&mut Value| item["bucket"] == bucket)
                {
                    if let Some(array) = existing[key].as_array_mut() {
                        array.push(json!(name));
                    }
                } else {
                    buckets.push(json!({
                        "bucket": bucket,
                        "sortMinute": sort_minute,
                        "fiveHourAccounts": if key == "fiveHourAccounts" { vec![name] } else { Vec::<&str>::new() },
                        "weeklyAccounts": if key == "weeklyAccounts" { vec![name] } else { Vec::<&str>::new() }
                    }));
                }
            }
        }
    }
    Value::Array(buckets)
}

fn usable_usd(row: &Value) -> f64 {
    if is_disabled_row(row) {
        return 0.0;
    }
    let five = row["fiveHour"]["remainingUsd"].as_f64().unwrap_or(0.0);
    let weekly = row["weekly"]["remainingUsd"].as_f64().unwrap_or(0.0);
    if five <= 0.0 || weekly <= 0.0 {
        0.0
    } else {
        five.min(weekly)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn target() -> CpaTargetConfig {
        CpaTargetConfig {
            id: "main".to_string(),
            name: "Main CPA".to_string(),
            api_base: "http://127.0.0.1:8398".to_string(),
            enabled: true,
            has_management_key: true,
        }
    }

    fn active_row(
        account_key: &str,
        sampled_at: i64,
        five_used_percent: f64,
        five_remaining_usd: f64,
        weekly_remaining_usd: f64,
        five_reset_at: i64,
        weekly_reset_at: i64,
    ) -> Value {
        json!({
            "cpaId": "main",
            "cpaName": "Main CPA",
            "accountKey": account_key,
            "name": account_key,
            "disabled": false,
            "status": "active",
            "quotaSource": "fresh",
            "quotaSampledAt": sampled_at,
            "normalizedPlan": "plus",
            "fiveHour": {
                "usedPercent": five_used_percent,
                "remainingUsd": five_remaining_usd,
                "remainingPoints": five_remaining_usd,
                "fullUsd": 100.0,
                "resetAtMs": five_reset_at
            },
            "weekly": {
                "usedPercent": 10.0,
                "remainingUsd": weekly_remaining_usd,
                "remainingPoints": weekly_remaining_usd,
                "fullUsd": 100.0,
                "resetAtMs": weekly_reset_at
            }
        })
    }

    fn failed_missing_quota_row(account_key: &str, sampled_at: i64) -> Value {
        json!({
            "cpaId": "main",
            "cpaName": "Main CPA",
            "accountKey": account_key,
            "name": account_key,
            "disabled": false,
            "status": "unknown",
            "quotaSource": "failed",
            "quotaSampledAt": sampled_at,
            "normalizedPlan": "plus",
            "fiveHour": Value::Null,
            "weekly": Value::Null,
            "error": "缺少 5h/周 主窗口额度数据"
        })
    }

    fn assert_number_close(value: &Value, expected: f64) {
        let actual = value.as_f64().expect("expected JSON number");
        assert!(
            (actual - expected).abs() < 0.000_001,
            "expected {expected}, got {actual}"
        );
    }

    fn assert_timestamp_close(value: &Value, expected: i64) {
        let actual = value.as_i64().expect("expected JSON timestamp");
        assert!(
            (actual - expected).abs() <= 10,
            "expected timestamp near {expected}, got {actual}"
        );
    }

    fn unit_pricing_profile() -> Value {
        let mut profile = crate::pricing::default_pricing_profile();
        for plan in ["free", "plus", "team", "pro"] {
            profile["plans"][plan]["fiveHourUsd"] = json!(100.0);
            profile["plans"][plan]["weeklyUsd"] = json!(100.0);
        }
        profile
    }

    fn latest_payload_from_rows(
        latest_rows: Vec<Value>,
        previous_rows: Vec<Value>,
        captured_at: i64,
        previous_at: i64,
    ) -> Value {
        let target = target();
        let history = vec![
            SnapshotRecord {
                id: 1,
                cpa_id: "main".to_string(),
                cpa_name: "Main CPA".to_string(),
                captured_at: previous_at,
                rows: previous_rows,
                strategy: "full".to_string(),
                error_summary: None,
            },
            SnapshotRecord {
                id: 2,
                cpa_id: "main".to_string(),
                cpa_name: "Main CPA".to_string(),
                captured_at,
                rows: latest_rows.clone(),
                strategy: "full".to_string(),
                error_summary: None,
            },
        ];
        build_latest_payload(
            &[target.clone()],
            Some("main"),
            Some(SnapshotRecord {
                id: 2,
                cpa_id: "main".to_string(),
                cpa_name: "Main CPA".to_string(),
                captured_at,
                rows: latest_rows,
                strategy: "full".to_string(),
                error_summary: None,
            }),
            &history,
            json!({ "status": "ok" }),
            &CollectorPreferences::default(),
            unit_pricing_profile(),
        )
    }

    fn burn_estimate(hourly_burn_usd: Option<f64>, coverage_percent: f64) -> BurnEstimate {
        BurnEstimate {
            hourly_burn_usd,
            one_hour_burn_usd: hourly_burn_usd,
            three_hour_burn_usd: hourly_burn_usd,
            thirty_minute_burn_usd: None,
            burn_rate_basis: if hourly_burn_usd.is_some() {
                "three-hour"
            } else {
                "insufficient"
            },
            consumption_coverage_percent: coverage_percent,
            spike_detected: false,
        }
    }

    fn capacity_payload_from_burn(
        rows: Vec<Value>,
        captured_at: i64,
        now: i64,
        burn: BurnEstimate,
        collector_state: Value,
    ) -> Value {
        let snapshot = SnapshotRecord {
            id: 1,
            cpa_id: "main".to_string(),
            cpa_name: "Main CPA".to_string(),
            captured_at,
            rows,
            strategy: "full".to_string(),
            error_summary: None,
        };
        build_capacity(
            Some(&snapshot),
            &[],
            &collector_state,
            &burn,
            &CollectorPreferences::default(),
            now,
        )
    }

    #[test]
    fn normalizes_api_base() {
        assert_eq!(
            normalize_api_base(" http://127.0.0.1:8398/ ").unwrap(),
            "http://127.0.0.1:8398"
        );
        assert!(normalize_api_base("127.0.0.1:8398").is_err());
        assert!(normalize_api_base("ftp://127.0.0.1").is_err());
    }

    #[test]
    fn disabled_rows_with_quota_windows_are_excluded_from_capacity_and_nominal_totals() {
        let captured_at = now_ms();
        let previous_at = captured_at - 30 * 60 * 1000;
        let active = active_row(
            "active",
            captured_at,
            40.0,
            60.0,
            80.0,
            captured_at + 60 * 60 * 1000,
            captured_at + 7 * 24 * 60 * 60 * 1000,
        );
        let paused = json!({
            "cpaId": "main",
            "cpaName": "Main CPA",
            "accountKey": "paused",
            "name": "paused.json",
            "disabled": true,
            "status": "paused",
            "quotaSource": "paused",
            "quotaSampledAt": captured_at,
            "normalizedPlan": "plus",
            "fiveHour": {
                "usedPercent": 1.0,
                "remainingUsd": 999.0,
                "remainingPoints": 99.0,
                "fullUsd": 1000.0,
                "resetAtMs": captured_at + 30 * 60 * 1000
            },
            "weekly": {
                "usedPercent": 1.0,
                "remainingUsd": 999.0,
                "remainingPoints": 99.0,
                "fullUsd": 1000.0,
                "resetAtMs": captured_at + 24 * 60 * 60 * 1000
            }
        });
        let payload = latest_payload_from_rows(
            vec![active.clone(), paused.clone()],
            vec![
                active_row(
                    "active",
                    previous_at,
                    30.0,
                    70.0,
                    90.0,
                    captured_at + 60 * 60 * 1000,
                    captured_at + 7 * 24 * 60 * 60 * 1000,
                ),
                paused,
            ],
            captured_at,
            previous_at,
        );

        assert_eq!(payload["snapshot"]["stats"]["totalAccounts"], 2);
        assert_eq!(payload["snapshot"]["stats"]["enabledAccounts"], 1);
        assert_eq!(payload["snapshot"]["stats"]["pausedAccounts"], 1);
        assert_number_close(&payload["snapshot"]["stats"]["fiveHourRemainingUsd"], 60.0);
        assert_number_close(&payload["risk"]["nominalUsableUsd"], 60.0);
        assert_eq!(payload["capacity"]["enabledAccounts"], 1);
        assert_eq!(payload["capacity"]["includedAccounts"], 1);
        assert_number_close(&payload["capacity"]["currentUsableUsd"], 60.0);
        assert_eq!(payload["snapshot"]["collection"]["enabledAccounts"], 1);
    }

    #[test]
    fn migrates_previous_collector_speed_defaults() {
        let temp = tempdir().unwrap();
        let storage = Storage::new(temp.path().join("config"), temp.path().join("data")).unwrap();
        let mut config = AppConfig::default();
        config.collector.collect_usage_max_requests_per_minute = 10.0;
        config.collector.collect_manual_max_requests_per_minute = 10.0;
        config.collector.collect_concurrency = 2;
        config.collector.collect_manual_concurrency = 4;
        storage.save_config(&config).unwrap();

        let loaded = storage.load_config().unwrap();

        assert_eq!(loaded.collector.collect_usage_max_requests_per_minute, 30.0);
        assert_eq!(
            loaded.collector.collect_manual_max_requests_per_minute,
            30.0
        );
        assert_eq!(loaded.collector.collect_concurrency, 3);
        assert_eq!(loaded.collector.collect_manual_concurrency, 8);
    }

    #[test]
    fn saves_reads_and_clears_snapshots() {
        let temp = tempdir().unwrap();
        let storage = Storage::new(temp.path().join("config"), temp.path().join("data")).unwrap();
        let rows = vec![json!({
            "name": "Plus A",
            "disabled": false,
            "status": "active",
            "quotaSource": "fresh",
            "quotaSampledAt": 1_000,
            "fiveHour": { "remainingUsd": 10.0, "remainingPoints": 50.0, "resetAtMs": 2_000 },
            "weekly": { "remainingUsd": 20.0, "remainingPoints": 80.0, "resetAtMs": 3_000 },
            "normalizedPlan": "plus"
        })];

        let id = storage
            .save_snapshot(
                &target(),
                1_000,
                &rows,
                "full",
                Some("one warning".to_string()),
            )
            .unwrap();
        let latest = storage.latest_snapshot("main").unwrap().unwrap();

        assert_eq!(latest.id, id);
        assert_eq!(latest.cpa_name, "Main CPA");
        assert_eq!(latest.strategy, "full");
        assert_eq!(latest.error_summary.as_deref(), Some("one warning"));
        assert_eq!(latest.rows[0]["name"], "Plus A");

        storage.clear_history(Some("main")).unwrap();
        assert!(storage.latest_snapshot("main").unwrap().is_none());
    }

    #[test]
    fn records_and_clears_account_cooldowns() {
        let temp = tempdir().unwrap();
        let storage = Storage::new(temp.path().join("config"), temp.path().join("data")).unwrap();
        let first = storage
            .record_cooldown("main", "acct-1", "403 forbidden", Some(403), 1_000, 10, 120)
            .unwrap();

        assert_eq!(first.consecutive_failures, 1);
        assert_eq!(first.cooldown_until, 601_000);
        assert!(storage
            .active_cooldown("main", "acct-1", 2_000)
            .unwrap()
            .is_some());
        assert!(storage
            .active_cooldown("main", "acct-1", 700_000)
            .unwrap()
            .is_none());

        let second = storage
            .record_cooldown("main", "acct-1", "429 limited", Some(429), 2_000, 10, 120)
            .unwrap();
        assert_eq!(second.consecutive_failures, 2);
        assert_eq!(second.cooldown_until, 1_202_000);

        storage.clear_cooldown("main", "acct-1").unwrap();
        assert!(storage
            .active_cooldown("main", "acct-1", 3_000)
            .unwrap()
            .is_none());
    }

    #[test]
    fn alert_cooldown_claim_persists_until_window_expires() {
        let temp = tempdir().unwrap();
        let storage = Storage::new(temp.path().join("config"), temp.path().join("data")).unwrap();
        let key = "main:account-issues:soft-quota-window-missing";

        assert!(storage.claim_alert_cooldown(key, 720, 1_000).unwrap());
        assert!(!storage.claim_alert_cooldown(key, 720, 2_000).unwrap());
        assert!(storage.claim_alert_cooldown(key, 720, 43_201_000).unwrap());
    }

    #[test]
    fn latest_payload_keeps_public_shape() {
        let payload = build_latest_payload(
            &[target()],
            Some("main"),
            None,
            &[],
            json!({ "status": "idle" }),
            &CollectorPreferences::default(),
            unit_pricing_profile(),
        );

        assert_eq!(payload["selectedCpaId"], "main");
        assert_eq!(payload["targets"][0]["name"], "Main CPA");
        assert!(payload["snapshot"].is_null());
        assert!(payload["accounts"].as_array().unwrap().is_empty());
        assert_eq!(payload["collectorState"]["status"], "idle");
    }

    #[test]
    fn latest_payload_reprices_snapshot_rows_from_current_profile() {
        let captured_at = now_ms();
        let mut pricing_profile = crate::pricing::default_pricing_profile();
        pricing_profile["id"] = json!("custom");
        pricing_profile["plans"]["plus"]["fiveHourUsd"] = json!(200.0);
        pricing_profile["plans"]["plus"]["weeklyUsd"] = json!(300.0);
        let row = json!({
            "cpaId": "main",
            "cpaName": "Main CPA",
            "accountKey": "acct-a",
            "name": "Plus A",
            "disabled": false,
            "status": "active",
            "quotaSource": "fresh",
            "quotaSampledAt": captured_at,
            "normalizedPlan": "plus",
            "fiveHour": {
                "usedPercent": 50.0,
                "remainingUsd": 1.0,
                "remainingPoints": 50.0,
                "fullUsd": 2.0,
                "resetAtMs": captured_at + HOUR_MS
            },
            "weekly": {
                "usedPercent": 50.0,
                "remainingUsd": 2.0,
                "remainingPoints": 50.0,
                "fullUsd": 4.0,
                "resetAtMs": captured_at + 2 * HOUR_MS
            }
        });
        let snapshot = SnapshotRecord {
            id: 1,
            cpa_id: "main".to_string(),
            cpa_name: "Main CPA".to_string(),
            captured_at,
            rows: vec![row],
            strategy: "full".to_string(),
            error_summary: None,
        };

        let payload = build_latest_payload(
            &[target()],
            Some("main"),
            Some(snapshot.clone()),
            &[snapshot],
            json!({ "status": "ok" }),
            &CollectorPreferences::default(),
            pricing_profile,
        );

        assert_number_close(&payload["accounts"][0]["fiveHour"]["remainingUsd"], 100.0);
        assert_number_close(&payload["accounts"][0]["fiveHour"]["fullUsd"], 200.0);
        assert_number_close(&payload["accounts"][0]["weekly"]["remainingUsd"], 150.0);
        assert_number_close(&payload["accounts"][0]["weekly"]["fullUsd"], 300.0);
        assert_eq!(payload["accounts"][0]["fiveHour"]["priced"], true);
        assert_number_close(&payload["snapshot"]["stats"]["fiveHourRemainingUsd"], 100.0);
        assert_number_close(&payload["snapshot"]["stats"]["weeklyRemainingUsd"], 150.0);
    }

    #[test]
    fn latest_payload_estimates_available_hours_from_history() {
        let target = target();
        let captured_at = now_ms();
        let previous_at = captured_at - 30 * 60 * 1000;
        let base_row = json!({
            "cpaId": "main",
            "cpaName": "Main CPA",
            "accountKey": "acct-a",
            "name": "Plus A",
            "disabled": false,
            "status": "active",
            "quotaSource": "fresh",
            "quotaSampledAt": previous_at,
            "normalizedPlan": "plus",
            "fiveHour": {
                "usedPercent": 10.0,
                "remainingUsd": 90.0,
                "remainingPoints": 90.0,
                "fullUsd": 100.0,
                "resetAtMs": 10_000_000
            },
            "weekly": {
                "usedPercent": 10.0,
                "remainingUsd": 90.0,
                "remainingPoints": 90.0,
                "fullUsd": 100.0,
                "resetAtMs": 20_000_000
            }
        });
        let latest_row = json!({
            "cpaId": "main",
            "cpaName": "Main CPA",
            "accountKey": "acct-a",
            "name": "Plus A",
            "disabled": false,
            "status": "active",
            "quotaSource": "fresh",
            "quotaSampledAt": captured_at,
            "normalizedPlan": "plus",
            "fiveHour": {
                "usedPercent": 20.0,
                "remainingUsd": 80.0,
                "remainingPoints": 80.0,
                "fullUsd": 100.0,
                "resetAtMs": 10_000_000
            },
            "weekly": {
                "usedPercent": 10.0,
                "remainingUsd": 90.0,
                "remainingPoints": 90.0,
                "fullUsd": 100.0,
                "resetAtMs": 20_000_000
            }
        });
        let history = vec![
            SnapshotRecord {
                id: 1,
                cpa_id: "main".to_string(),
                cpa_name: "Main CPA".to_string(),
                captured_at: previous_at,
                rows: vec![base_row],
                strategy: "full".to_string(),
                error_summary: None,
            },
            SnapshotRecord {
                id: 2,
                cpa_id: "main".to_string(),
                cpa_name: "Main CPA".to_string(),
                captured_at,
                rows: vec![latest_row.clone()],
                strategy: "full".to_string(),
                error_summary: None,
            },
        ];
        let payload = build_latest_payload(
            &[target.clone()],
            Some("main"),
            Some(SnapshotRecord {
                id: 2,
                cpa_id: "main".to_string(),
                cpa_name: "Main CPA".to_string(),
                captured_at,
                rows: vec![latest_row],
                strategy: "full".to_string(),
                error_summary: None,
            }),
            &history,
            json!({ "status": "ok" }),
            &CollectorPreferences::default(),
            unit_pricing_profile(),
        );

        assert_eq!(payload["consumption"]["thirtyMinutes"]["totalUsd"], 10.0);
        assert_eq!(payload["risk"]["hourlyBurnUsd"], 10.0);
        assert_eq!(payload["risk"]["availableHours"], 8.0);
        assert_eq!(payload["accounts"][0]["recent30mConsumedUsd"], 10.0);
    }

    #[test]
    fn latest_payload_counts_team_consumption_by_auth_index() {
        let captured_at = now_ms();
        let previous_at = captured_at - 30 * 60 * 1000;
        let outside_horizon = captured_at + 10 * HOUR_MS;
        let mut previous_a = active_row(
            "shared-team-account",
            previous_at,
            10.0,
            90.0,
            90.0,
            outside_horizon,
            outside_horizon,
        );
        previous_a["normalizedPlan"] = json!("team");
        previous_a["authIndex"] = json!("slot-a");
        let mut previous_b = active_row(
            "shared-team-account",
            previous_at,
            10.0,
            90.0,
            90.0,
            outside_horizon,
            outside_horizon,
        );
        previous_b["normalizedPlan"] = json!("team");
        previous_b["authIndex"] = json!("slot-b");
        let mut latest_a = active_row(
            "shared-team-account",
            captured_at,
            20.0,
            80.0,
            90.0,
            outside_horizon,
            outside_horizon,
        );
        latest_a["normalizedPlan"] = json!("team");
        latest_a["authIndex"] = json!("slot-a");
        let mut latest_b = active_row(
            "shared-team-account",
            captured_at,
            15.0,
            85.0,
            90.0,
            outside_horizon,
            outside_horizon,
        );
        latest_b["normalizedPlan"] = json!("team");
        latest_b["authIndex"] = json!("slot-b");

        let payload = latest_payload_from_rows(
            vec![latest_a, latest_b],
            vec![previous_a, previous_b],
            captured_at,
            previous_at,
        );

        assert_eq!(
            payload["consumption"]["thirtyMinutes"]["comparableSeries"],
            2
        );
        assert_number_close(
            &payload["consumption"]["thirtyMinutes"]["coveragePercent"],
            100.0,
        );
        assert_number_close(&payload["consumption"]["thirtyMinutes"]["totalUsd"], 15.0);
        assert_number_close(&payload["accounts"][0]["recent30mConsumedUsd"], 10.0);
        assert_number_close(&payload["accounts"][1]["recent30mConsumedUsd"], 5.0);
    }

    #[test]
    fn latest_payload_counts_zero_consumption_when_reset_time_rolls_forward() {
        let captured_at = now_ms();
        let previous_at = captured_at - 30 * 60 * 1000;
        let outside_horizon = captured_at + 10 * HOUR_MS;
        let previous_row = active_row(
            "rolling-reset",
            previous_at,
            1.0,
            99.0,
            99.0,
            previous_at + 5 * HOUR_MS,
            outside_horizon,
        );
        let latest_row = active_row(
            "rolling-reset",
            captured_at,
            1.0,
            99.0,
            99.0,
            captured_at + 5 * HOUR_MS,
            outside_horizon,
        );

        let payload = latest_payload_from_rows(
            vec![latest_row],
            vec![previous_row],
            captured_at,
            previous_at,
        );

        assert_eq!(
            payload["consumption"]["thirtyMinutes"]["comparableSeries"],
            1
        );
        assert_number_close(
            &payload["consumption"]["thirtyMinutes"]["coveragePercent"],
            100.0,
        );
        assert_number_close(&payload["consumption"]["thirtyMinutes"]["totalUsd"], 0.0);
        assert_number_close(&payload["risk"]["hourlyBurnUsd"], 0.0);
    }

    #[test]
    fn latest_payload_counts_positive_consumption_when_reset_time_rolls_forward() {
        let captured_at = now_ms();
        let previous_at = captured_at - 30 * 60 * 1000;
        let outside_horizon = captured_at + 10 * HOUR_MS;
        let previous_row = active_row(
            "rolling-reset",
            previous_at,
            1.0,
            99.0,
            99.0,
            previous_at + 5 * HOUR_MS,
            outside_horizon,
        );
        let latest_row = active_row(
            "rolling-reset",
            captured_at,
            5.0,
            95.0,
            99.0,
            captured_at + 5 * HOUR_MS,
            outside_horizon,
        );

        let payload = latest_payload_from_rows(
            vec![latest_row],
            vec![previous_row],
            captured_at,
            previous_at,
        );

        assert_eq!(
            payload["consumption"]["thirtyMinutes"]["comparableSeries"],
            1
        );
        assert_number_close(
            &payload["consumption"]["thirtyMinutes"]["coveragePercent"],
            100.0,
        );
        assert_number_close(&payload["consumption"]["thirtyMinutes"]["totalUsd"], 4.0);
        assert_number_close(&payload["risk"]["hourlyBurnUsd"], 4.0);
    }

    #[test]
    fn latest_payload_counts_current_usage_when_five_hour_usage_rolls_back() {
        let captured_at = now_ms();
        let previous_at = captured_at - 30 * 60 * 1000;
        let outside_horizon = captured_at + 10 * HOUR_MS;
        let previous_row = active_row(
            "rolling-reset",
            previous_at,
            80.0,
            20.0,
            99.0,
            previous_at + 5 * HOUR_MS,
            outside_horizon,
        );
        let latest_row = active_row(
            "rolling-reset",
            captured_at,
            3.0,
            97.0,
            99.0,
            captured_at + 5 * HOUR_MS,
            outside_horizon,
        );

        let payload = latest_payload_from_rows(
            vec![latest_row],
            vec![previous_row],
            captured_at,
            previous_at,
        );

        assert_eq!(
            payload["consumption"]["thirtyMinutes"]["comparableSeries"],
            1
        );
        assert_number_close(
            &payload["consumption"]["thirtyMinutes"]["coveragePercent"],
            100.0,
        );
        assert_number_close(&payload["consumption"]["thirtyMinutes"]["totalUsd"], 3.0);
        assert_number_close(&payload["risk"]["hourlyBurnUsd"], 3.0);
        assert_number_close(&payload["accounts"][0]["recent30mConsumedUsd"], 3.0);
    }

    #[test]
    fn latest_payload_counts_consumption_when_weekly_reset_time_rolls_forward() {
        let captured_at = now_ms();
        let previous_at = captured_at - 30 * 60 * 1000;
        let five_reset_at = captured_at + 5 * HOUR_MS;
        let mut previous_row = active_row(
            "weekly-rolling-reset",
            previous_at,
            1.0,
            99.0,
            99.0,
            five_reset_at,
            previous_at + 7 * 24 * HOUR_MS,
        );
        let mut latest_row = active_row(
            "weekly-rolling-reset",
            captured_at,
            5.0,
            95.0,
            99.0,
            five_reset_at,
            captured_at + 7 * 24 * HOUR_MS,
        );
        previous_row["weekly"]["usedPercent"] = json!(20.0);
        latest_row["weekly"]["usedPercent"] = json!(20.0);
        latest_row["weekly"]["remainingUsd"] = json!(40.0);
        latest_row["weekly"]["remainingPoints"] = json!(40.0);

        let payload = latest_payload_from_rows(
            vec![latest_row],
            vec![previous_row],
            captured_at,
            previous_at,
        );

        assert_eq!(
            payload["consumption"]["thirtyMinutes"]["comparableSeries"],
            1
        );
        assert_number_close(
            &payload["consumption"]["thirtyMinutes"]["coveragePercent"],
            100.0,
        );
        assert_number_close(&payload["consumption"]["thirtyMinutes"]["totalUsd"], 4.0);
        assert_number_close(&payload["risk"]["hourlyBurnUsd"], 4.0);
        assert_number_close(&payload["risk"]["conservativeUsableUsd"], 40.0);
        assert_number_close(&payload["capacity"]["currentUsableUsd"], 40.0);
    }

    #[test]
    fn consumption_window_caps_coverage_percent_at_one_hundred() {
        let summary = summarize_consumption_window(
            &ConsumptionWindow {
                total_usd: 0.0,
                by_account: HashMap::new(),
                comparable_series: 3,
                unpriced_series: 0,
            },
            1,
        );

        assert_eq!(summary["comparableSeries"], 3);
        assert_number_close(&summary["coveragePercent"], 100.0);
    }

    #[test]
    fn latest_payload_uses_current_usable_capacity_for_available_hours() {
        let target = target();
        let captured_at = now_ms();
        let previous_at = captured_at - 30 * 60 * 1000;
        let previous_row = active_row(
            "acct-a",
            previous_at,
            10.0,
            90.0,
            20.0,
            10_000_000,
            20_000_000,
        );
        let latest_row = active_row(
            "acct-a",
            captured_at,
            20.0,
            80.0,
            20.0,
            10_000_000,
            20_000_000,
        );
        let history = vec![
            SnapshotRecord {
                id: 1,
                cpa_id: "main".to_string(),
                cpa_name: "Main CPA".to_string(),
                captured_at: previous_at,
                rows: vec![previous_row],
                strategy: "full".to_string(),
                error_summary: None,
            },
            SnapshotRecord {
                id: 2,
                cpa_id: "main".to_string(),
                cpa_name: "Main CPA".to_string(),
                captured_at,
                rows: vec![latest_row.clone()],
                strategy: "full".to_string(),
                error_summary: None,
            },
        ];
        let payload = build_latest_payload(
            &[target.clone()],
            Some("main"),
            Some(SnapshotRecord {
                id: 2,
                cpa_id: "main".to_string(),
                cpa_name: "Main CPA".to_string(),
                captured_at,
                rows: vec![latest_row],
                strategy: "full".to_string(),
                error_summary: None,
            }),
            &history,
            json!({ "status": "ok" }),
            &CollectorPreferences::default(),
            unit_pricing_profile(),
        );

        assert_eq!(payload["risk"]["hourlyBurnUsd"], 10.0);
        assert_eq!(payload["risk"]["conservativeFiveHourUsd"], 80.0);
        assert_eq!(payload["risk"]["conservativeUsableUsd"], 20.0);
        assert_eq!(payload["risk"]["availableHours"], 2.0);
    }

    #[test]
    fn latest_payload_does_not_count_release_after_depletion() {
        let captured_at = now_ms();
        let previous_at = captured_at - 30 * 60 * 1000;
        let five_reset_at = captured_at + 2 * HOUR_MS;
        let outside_horizon = captured_at + 10 * HOUR_MS;
        let previous_row = active_row(
            "acct-a",
            previous_at,
            10.0,
            20.0,
            100.0,
            five_reset_at,
            outside_horizon,
        );
        let latest_row = active_row(
            "acct-a",
            captured_at,
            20.0,
            10.0,
            100.0,
            five_reset_at,
            outside_horizon,
        );
        let payload = latest_payload_from_rows(
            vec![latest_row],
            vec![previous_row],
            captured_at,
            previous_at,
        );

        assert_eq!(payload["risk"]["hourlyBurnUsd"], 10.0);
        assert_eq!(payload["risk"]["conservativeUsableUsd"], 10.0);
        assert_eq!(payload["risk"]["availableHours"], 1.0);
        assert_eq!(payload["risk"]["futureFiveHour"]["status"], "shortfall");
        assert_number_close(
            &payload["risk"]["futureFiveHour"]["projectedMarginUsd"],
            50.0,
        );
    }

    #[test]
    fn latest_payload_extends_available_hours_when_release_arrives_before_depletion() {
        let captured_at = now_ms();
        let previous_at = captured_at - 30 * 60 * 1000;
        let five_reset_at = captured_at + 2 * HOUR_MS;
        let outside_horizon = captured_at + 10 * HOUR_MS;
        let previous_row = active_row(
            "acct-a",
            previous_at,
            10.0,
            35.0,
            100.0,
            five_reset_at,
            outside_horizon,
        );
        let latest_row = active_row(
            "acct-a",
            captured_at,
            20.0,
            25.0,
            100.0,
            five_reset_at,
            outside_horizon,
        );
        let payload = latest_payload_from_rows(
            vec![latest_row],
            vec![previous_row],
            captured_at,
            previous_at,
        );

        assert_eq!(payload["risk"]["hourlyBurnUsd"], 10.0);
        assert_eq!(payload["risk"]["conservativeUsableUsd"], 25.0);
        assert_eq!(payload["risk"]["availableHours"], 10.0);
        assert_eq!(payload["risk"]["futureFiveHour"]["status"], "enough");
        assert_number_close(
            &payload["risk"]["futureFiveHour"]["projectedMarginUsd"],
            50.0,
        );
    }

    #[test]
    fn latest_payload_projects_future_five_hour_capacity_per_account() {
        let target = target();
        let captured_at = now_ms();
        let previous_at = captured_at - 30 * 60 * 1000;
        let five_reset_at = captured_at + 2 * HOUR_MS;
        let weekly_reset_at = captured_at + 3 * HOUR_MS;
        let outside_horizon = captured_at + 10 * HOUR_MS;
        let rows = vec![
            active_row(
                "five-reset",
                captured_at,
                0.0,
                0.0,
                100.0,
                five_reset_at,
                outside_horizon,
            ),
            active_row(
                "weekly-reset",
                captured_at,
                0.0,
                100.0,
                0.0,
                outside_horizon,
                weekly_reset_at,
            ),
            active_row(
                "burn",
                captured_at,
                20.0,
                80.0,
                80.0,
                outside_horizon,
                outside_horizon,
            ),
        ];
        let previous_rows = vec![
            active_row(
                "five-reset",
                previous_at,
                0.0,
                0.0,
                100.0,
                five_reset_at,
                outside_horizon,
            ),
            active_row(
                "weekly-reset",
                previous_at,
                0.0,
                100.0,
                0.0,
                outside_horizon,
                weekly_reset_at,
            ),
            active_row(
                "burn",
                previous_at,
                10.0,
                90.0,
                80.0,
                outside_horizon,
                outside_horizon,
            ),
        ];
        let history = vec![
            SnapshotRecord {
                id: 1,
                cpa_id: "main".to_string(),
                cpa_name: "Main CPA".to_string(),
                captured_at: previous_at,
                rows: previous_rows,
                strategy: "full".to_string(),
                error_summary: None,
            },
            SnapshotRecord {
                id: 2,
                cpa_id: "main".to_string(),
                cpa_name: "Main CPA".to_string(),
                captured_at,
                rows: rows.clone(),
                strategy: "full".to_string(),
                error_summary: None,
            },
        ];
        let payload = build_latest_payload(
            &[target.clone()],
            Some("main"),
            Some(SnapshotRecord {
                id: 2,
                cpa_id: "main".to_string(),
                cpa_name: "Main CPA".to_string(),
                captured_at,
                rows,
                strategy: "full".to_string(),
                error_summary: None,
            }),
            &history,
            json!({ "status": "ok" }),
            &CollectorPreferences::default(),
            unit_pricing_profile(),
        );

        let future = &payload["risk"]["futureFiveHour"];
        assert_eq!(payload["risk"]["hourlyBurnUsd"], 10.0);
        assert_eq!(future["horizonHours"], 5);
        assert_eq!(future["status"], "enough");
        assert_number_close(&future["projectedUsableUsd"], 280.0);
        assert_number_close(&future["projectedSpendUsd"], 50.0);
        assert_number_close(&future["projectedMarginUsd"], 230.0);
        assert_number_close(&future["coverageRatio"], 5.6);
        assert_number_close(&payload["risk"]["curve"][5]["projectedUsd"], 230.0);
        assert_number_close(
            &payload["capacity"]["fiveHourTimeline"][5]["usableUsd"],
            280.0,
        );
        assert_number_close(
            &payload["capacity"]["fiveHourTimeline"][5]["projectedRemainingUsd"],
            230.0,
        );
    }

    #[test]
    fn latest_payload_capacity_uses_complete_fresh_snapshot() {
        let captured_at = now_ms();
        let outside_horizon = captured_at + 10 * HOUR_MS;
        let rows = vec![
            active_row(
                "weekly-limited",
                captured_at,
                20.0,
                80.0,
                50.0,
                outside_horizon,
                outside_horizon,
            ),
            active_row(
                "five-hour-reset",
                captured_at,
                100.0,
                0.0,
                100.0,
                captured_at + 2 * HOUR_MS,
                outside_horizon,
            ),
        ];
        let target = target();
        let history = vec![SnapshotRecord {
            id: 1,
            cpa_id: "main".to_string(),
            cpa_name: "Main CPA".to_string(),
            captured_at,
            rows: rows.clone(),
            strategy: "full".to_string(),
            error_summary: None,
        }];
        let payload = build_latest_payload(
            &[target.clone()],
            Some("main"),
            Some(SnapshotRecord {
                id: 1,
                cpa_id: "main".to_string(),
                cpa_name: "Main CPA".to_string(),
                captured_at,
                rows,
                strategy: "full".to_string(),
                error_summary: None,
            }),
            &history,
            json!({ "status": "ok" }),
            &CollectorPreferences::default(),
            unit_pricing_profile(),
        );

        assert_eq!(payload["capacity"]["freshComplete"], true);
        assert_eq!(payload["capacity"]["status"], "untrusted");
        assert_eq!(payload["capacity"]["supportStatus"], "insufficient-sample");
        assert!(payload["capacity"]["supportHours"].is_null());
        assert!(payload["capacity"]["estimatedDepletionAt"].is_null());
        assert_eq!(payload["capacity"]["enabledAccounts"], 2);
        assert_eq!(payload["capacity"]["includedAccounts"], 2);
        assert_number_close(&payload["capacity"]["currentUsableUsd"], 50.0);
        assert_number_close(
            &payload["capacity"]["fiveHourTimeline"][0]["usableUsd"],
            50.0,
        );
        assert_number_close(
            &payload["capacity"]["fiveHourTimeline"][2]["usableUsd"],
            150.0,
        );
        assert!(payload["capacity"]["fiveHourTimeline"][2]["projectedRemainingUsd"].is_null());
    }

    #[test]
    fn capacity_accepts_fresh_snapshot_with_partial_window_coverage() {
        let captured_at = now_ms();
        let outside_horizon = captured_at + 10 * HOUR_MS;
        let mut missing_weekly = active_row(
            "missing-weekly",
            captured_at,
            20.0,
            80.0,
            100.0,
            outside_horizon,
            outside_horizon,
        );
        missing_weekly["weekly"]["priced"] = json!(false);
        missing_weekly["weekly"]["remainingUsd"] = Value::Null;
        missing_weekly["weekly"]["remainingPoints"] = Value::Null;
        missing_weekly["weekly"]["resetAtMs"] = Value::Null;

        let payload = capacity_payload_from_burn(
            vec![
                missing_weekly,
                active_row(
                    "complete-window",
                    captured_at,
                    20.0,
                    80.0,
                    40.0,
                    outside_horizon,
                    outside_horizon,
                ),
            ],
            captured_at,
            captured_at,
            burn_estimate(Some(10.0), 100.0),
            json!({ "status": "ok" }),
        );

        assert_eq!(payload["freshComplete"], true);
        assert_eq!(payload["snapshotCapturedAt"], captured_at);
        assert_eq!(payload["status"], "tight");
        assert_eq!(payload["enabledAccounts"], 2);
        assert_eq!(payload["includedAccounts"], 1);
        assert_eq!(payload["excludedAccounts"], 1);
        assert_number_close(&payload["currentUsableUsd"], 40.0);
        assert_number_close(&payload["fiveHourTimeline"][0]["usableUsd"], 40.0);
    }

    #[test]
    fn capacity_uses_partial_snapshot_when_some_accounts_have_official_quota_window_bug() {
        let captured_at = now_ms();
        let outside_horizon = captured_at + 10 * HOUR_MS;
        let mut rows = Vec::new();
        for index in 0..30 {
            rows.push(active_row(
                &format!("good-{index}"),
                captured_at,
                20.0,
                40.0,
                80.0,
                outside_horizon,
                outside_horizon,
            ));
        }
        for index in 0..4 {
            rows.push(failed_missing_quota_row(
                &format!("missing-window-{index}"),
                captured_at,
            ));
        }
        let snapshot = SnapshotRecord {
            id: 1,
            cpa_id: "main".to_string(),
            cpa_name: "Main CPA".to_string(),
            captured_at,
            rows,
            strategy: "full".to_string(),
            error_summary: Some("缺少 5h/周 主窗口额度数据".to_string()),
        };
        let payload = build_capacity(
            Some(&snapshot),
            &[],
            &json!({ "status": "ok" }),
            &burn_estimate(Some(10.0), 100.0),
            &CollectorPreferences::default(),
            captured_at,
        );

        assert_eq!(payload["freshComplete"], false);
        assert_eq!(payload["status"], "ready");
        assert_eq!(payload["enabledAccounts"], 34);
        assert_eq!(payload["includedAccounts"], 30);
        assert_eq!(payload["excludedAccounts"], 4);
        assert_number_close(&payload["currentUsableUsd"], 1200.0);
        assert!(!payload["fiveHourTimeline"].as_array().unwrap().is_empty());
    }

    #[test]
    fn capacity_excludes_team_when_weekly_window_is_missing() {
        let captured_at = now_ms();
        let outside_horizon = captured_at + 10 * HOUR_MS;
        let mut team_row = active_row(
            "team-missing-weekly",
            captured_at,
            20.0,
            80.0,
            100.0,
            outside_horizon,
            outside_horizon,
        );
        team_row["normalizedPlan"] = json!("team");
        team_row["weekly"]["priced"] = json!(false);
        team_row["weekly"]["remainingUsd"] = Value::Null;
        team_row["weekly"]["remainingPoints"] = Value::Null;
        team_row["weekly"]["resetAtMs"] = Value::Null;

        let payload = capacity_payload_from_burn(
            vec![team_row],
            captured_at,
            captured_at,
            burn_estimate(Some(10.0), 100.0),
            json!({ "status": "ok" }),
        );

        assert_eq!(payload["freshComplete"], true);
        assert_eq!(payload["status"], "untrusted");
        assert_eq!(payload["enabledAccounts"], 1);
        assert_eq!(payload["includedAccounts"], 0);
        assert_eq!(payload["excludedAccounts"], 1);
        assert!(payload["currentUsableUsd"].is_null());
        assert!(payload["fiveHourTimeline"].as_array().unwrap().is_empty());
    }

    #[test]
    fn capacity_effective_burn_matches_observed_at_full_coverage() {
        let captured_at = now_ms();
        let outside_horizon = captured_at + 10 * HOUR_MS;
        let payload = capacity_payload_from_burn(
            vec![active_row(
                "acct-a",
                captured_at,
                20.0,
                1000.0,
                1000.0,
                outside_horizon,
                outside_horizon,
            )],
            captured_at,
            captured_at,
            burn_estimate(Some(10.0), 100.0),
            json!({ "status": "ok" }),
        );

        assert_eq!(payload["status"], "ready");
        assert_number_close(&payload["observedHourlyBurnUsd"], 10.0);
        assert_number_close(&payload["effectiveHourlyBurnUsd"], 10.0);
        assert_number_close(&payload["burnCoverageMultiplier"], 1.0);
        assert_number_close(&payload["projectedFiveHourSpendUsd"], 50.0);
    }

    #[test]
    fn capacity_effective_burn_scales_by_partial_coverage() {
        let captured_at = now_ms();
        let outside_horizon = captured_at + 10 * HOUR_MS;
        let payload = capacity_payload_from_burn(
            vec![active_row(
                "acct-a",
                captured_at,
                20.0,
                1000.0,
                1000.0,
                outside_horizon,
                outside_horizon,
            )],
            captured_at,
            captured_at,
            burn_estimate(Some(40.67), 73.0),
            json!({ "status": "ok" }),
        );
        let expected_effective = 40.67 / 0.73;

        assert_eq!(payload["status"], "ready");
        assert_number_close(&payload["hourlyBurnUsd"], 40.67);
        assert_number_close(&payload["observedHourlyBurnUsd"], 40.67);
        assert_number_close(&payload["effectiveHourlyBurnUsd"], expected_effective);
        assert_number_close(&payload["burnCoverageMultiplier"], 100.0 / 73.0);
        assert_number_close(
            &payload["projectedFiveHourSpendUsd"],
            expected_effective * 5.0,
        );
        assert_number_close(
            &payload["fiveHourTimeline"][5]["projectedSpendUsd"],
            expected_effective * 5.0,
        );
    }

    #[test]
    fn capacity_low_consumption_coverage_uses_floor_for_result() {
        let captured_at = now_ms();
        let outside_horizon = captured_at + 10 * HOUR_MS;
        let payload = capacity_payload_from_burn(
            vec![active_row(
                "acct-a",
                captured_at,
                20.0,
                100.0,
                100.0,
                outside_horizon,
                outside_horizon,
            )],
            captured_at,
            captured_at,
            burn_estimate(Some(30.0), 50.0),
            json!({ "status": "ok" }),
        );

        assert_eq!(payload["status"], "tight");
        assert_number_close(&payload["effectiveHourlyBurnUsd"], 50.0);
        assert_number_close(&payload["burnCoverageMultiplier"], 100.0 / 60.0);
        assert_number_close(&payload["projectedFiveHourSpendUsd"], 250.0);
    }

    #[test]
    fn capacity_keeps_result_for_stale_but_unexpired_snapshot() {
        let now = now_ms();
        let captured_at = now - 11 * 60 * 1000;
        let outside_horizon = now + 10 * HOUR_MS;
        let payload = capacity_payload_from_burn(
            vec![active_row(
                "acct-a",
                captured_at,
                20.0,
                80.0,
                80.0,
                outside_horizon,
                outside_horizon,
            )],
            captured_at,
            now,
            burn_estimate(Some(10.0), 100.0),
            json!({
                "status": "collecting",
                "progressCompletedAccounts": 18,
                "progressTotalAccounts": 30
            }),
        );

        assert_eq!(payload["status"], "ready");
        assert_number_close(&payload["currentUsableUsd"], 80.0);
    }

    #[test]
    fn latest_payload_capacity_status_uses_future_consumption_margin() {
        let captured_at = now_ms();
        let previous_at = captured_at - 30 * 60 * 1000;
        let outside_horizon = captured_at + 10 * HOUR_MS;
        let previous_row = active_row(
            "burn",
            previous_at,
            0.0,
            100.0,
            100.0,
            outside_horizon,
            outside_horizon,
        );
        let latest_row = active_row(
            "burn",
            captured_at,
            20.0,
            80.0,
            80.0,
            outside_horizon,
            outside_horizon,
        );
        let payload = latest_payload_from_rows(
            vec![latest_row],
            vec![previous_row],
            captured_at,
            previous_at,
        );

        assert_eq!(payload["capacity"]["status"], "tight");
        assert_eq!(payload["capacity"]["supportStatus"], "within-5h");
        assert_number_close(&payload["capacity"]["supportHours"], 4.0);
        assert_timestamp_close(
            &payload["capacity"]["estimatedDepletionAt"],
            captured_at + 4 * HOUR_MS,
        );
        assert_number_close(&payload["capacity"]["hourlyBurnUsd"], 20.0);
        assert_number_close(&payload["capacity"]["projectedFiveHourSpendUsd"], 100.0);
        assert_number_close(&payload["capacity"]["projectedFiveHourMarginUsd"], -20.0);
        assert_number_close(
            &payload["capacity"]["fiveHourTimeline"][5]["projectedRemainingUsd"],
            -20.0,
        );
    }

    #[test]
    fn latest_payload_capacity_support_ignores_release_after_depletion() {
        let captured_at = now_ms();
        let previous_at = captured_at - 30 * 60 * 1000;
        let five_reset_at = captured_at + 2 * HOUR_MS;
        let outside_horizon = captured_at + 10 * HOUR_MS;
        let previous_row = active_row(
            "acct-a",
            previous_at,
            10.0,
            20.0,
            100.0,
            five_reset_at,
            outside_horizon,
        );
        let latest_row = active_row(
            "acct-a",
            captured_at,
            20.0,
            10.0,
            100.0,
            five_reset_at,
            outside_horizon,
        );
        let payload = latest_payload_from_rows(
            vec![latest_row],
            vec![previous_row],
            captured_at,
            previous_at,
        );

        assert_eq!(payload["capacity"]["status"], "tight");
        assert_eq!(payload["capacity"]["supportStatus"], "within-5h");
        assert_number_close(&payload["capacity"]["supportHours"], 1.0);
        assert_timestamp_close(
            &payload["capacity"]["estimatedDepletionAt"],
            captured_at + HOUR_MS,
        );
        assert_number_close(&payload["capacity"]["projectedFiveHourMarginUsd"], 50.0);
    }

    #[test]
    fn latest_payload_capacity_support_counts_release_before_depletion() {
        let captured_at = now_ms();
        let previous_at = captured_at - 30 * 60 * 1000;
        let five_reset_at = captured_at + 2 * HOUR_MS;
        let outside_horizon = captured_at + 10 * HOUR_MS;
        let previous_row = active_row(
            "acct-a",
            previous_at,
            10.0,
            30.0,
            45.0,
            five_reset_at,
            outside_horizon,
        );
        let latest_row = active_row(
            "acct-a",
            captured_at,
            20.0,
            25.0,
            45.0,
            five_reset_at,
            outside_horizon,
        );
        let payload = latest_payload_from_rows(
            vec![latest_row],
            vec![previous_row],
            captured_at,
            previous_at,
        );

        assert_eq!(payload["capacity"]["supportStatus"], "within-5h");
        assert_number_close(&payload["capacity"]["supportHours"], 4.5);
        assert_timestamp_close(
            &payload["capacity"]["estimatedDepletionAt"],
            captured_at + (4.5 * HOUR_MS as f64) as i64,
        );
        assert_number_close(&payload["capacity"]["currentUsableUsd"], 25.0);
    }

    #[test]
    fn latest_payload_capacity_support_marks_beyond_five_hours() {
        let captured_at = now_ms();
        let previous_at = captured_at - 30 * 60 * 1000;
        let outside_horizon = captured_at + 10 * HOUR_MS;
        let previous_row = active_row(
            "acct-a",
            previous_at,
            10.0,
            95.0,
            95.0,
            outside_horizon,
            outside_horizon,
        );
        let latest_row = active_row(
            "acct-a",
            captured_at,
            20.0,
            90.0,
            90.0,
            outside_horizon,
            outside_horizon,
        );
        let payload = latest_payload_from_rows(
            vec![latest_row],
            vec![previous_row],
            captured_at,
            previous_at,
        );

        assert_eq!(payload["capacity"]["status"], "ready");
        assert_eq!(payload["capacity"]["supportStatus"], "beyond-5h");
        assert!(payload["capacity"]["supportHours"].is_null());
        assert!(payload["capacity"]["estimatedDepletionAt"].is_null());
        assert_number_close(&payload["capacity"]["projectedFiveHourMarginUsd"], 40.0);
    }

    #[test]
    fn latest_payload_capacity_uses_latest_partial_snapshot_over_previous_complete_snapshot() {
        let captured_at = now_ms();
        let previous_at = captured_at - 60_000;
        let outside_horizon = captured_at + 10 * HOUR_MS;
        let previous_row = active_row(
            "acct-a",
            previous_at,
            20.0,
            40.0,
            80.0,
            outside_horizon,
            outside_horizon,
        );
        let latest_row = active_row(
            "acct-a",
            captured_at,
            20.0,
            25.0,
            80.0,
            outside_horizon,
            outside_horizon,
        );
        let failed_row = failed_missing_quota_row("acct-b", captured_at);
        let target = target();
        let history = vec![
            SnapshotRecord {
                id: 1,
                cpa_id: "main".to_string(),
                cpa_name: "Main CPA".to_string(),
                captured_at: previous_at,
                rows: vec![previous_row.clone()],
                strategy: "full".to_string(),
                error_summary: None,
            },
            SnapshotRecord {
                id: 2,
                cpa_id: "main".to_string(),
                cpa_name: "Main CPA".to_string(),
                captured_at,
                rows: vec![latest_row.clone(), failed_row.clone()],
                strategy: "full".to_string(),
                error_summary: Some("usage 查询失败".to_string()),
            },
        ];
        let payload = build_latest_payload(
            &[target.clone()],
            Some("main"),
            Some(SnapshotRecord {
                id: 2,
                cpa_id: "main".to_string(),
                cpa_name: "Main CPA".to_string(),
                captured_at,
                rows: vec![latest_row, failed_row],
                strategy: "full".to_string(),
                error_summary: Some("usage 查询失败".to_string()),
            }),
            &history,
            json!({ "status": "ok" }),
            &CollectorPreferences::default(),
            unit_pricing_profile(),
        );

        assert_eq!(payload["capacity"]["snapshotCapturedAt"], captured_at);
        assert_eq!(payload["capacity"]["freshComplete"], false);
        assert_eq!(payload["capacity"]["status"], "untrusted");
        assert_eq!(payload["capacity"]["enabledAccounts"], 2);
        assert_eq!(payload["capacity"]["includedAccounts"], 1);
        assert_eq!(payload["capacity"]["excludedAccounts"], 1);
        assert_number_close(&payload["capacity"]["currentUsableUsd"], 25.0);
        assert!(!payload["capacity"]["fiveHourTimeline"]
            .as_array()
            .unwrap()
            .is_empty());
    }

    #[test]
    fn latest_payload_capacity_waits_when_latest_snapshot_has_no_capacity_rows() {
        let captured_at = now_ms();
        let previous_at = captured_at - 60_000;
        let outside_horizon = captured_at + 10 * HOUR_MS;
        let previous_row = active_row(
            "acct-a",
            previous_at,
            20.0,
            40.0,
            80.0,
            outside_horizon,
            outside_horizon,
        );
        let failed_row = failed_missing_quota_row("acct-a", captured_at);
        let target = target();
        let history = vec![
            SnapshotRecord {
                id: 1,
                cpa_id: "main".to_string(),
                cpa_name: "Main CPA".to_string(),
                captured_at: previous_at,
                rows: vec![previous_row],
                strategy: "full".to_string(),
                error_summary: None,
            },
            SnapshotRecord {
                id: 2,
                cpa_id: "main".to_string(),
                cpa_name: "Main CPA".to_string(),
                captured_at,
                rows: vec![failed_row.clone()],
                strategy: "full".to_string(),
                error_summary: Some("usage 查询失败".to_string()),
            },
        ];
        let payload = build_latest_payload(
            &[target.clone()],
            Some("main"),
            Some(SnapshotRecord {
                id: 2,
                cpa_id: "main".to_string(),
                cpa_name: "Main CPA".to_string(),
                captured_at,
                rows: vec![failed_row],
                strategy: "full".to_string(),
                error_summary: Some("usage 查询失败".to_string()),
            }),
            &history,
            json!({ "status": "ok" }),
            &CollectorPreferences::default(),
            unit_pricing_profile(),
        );

        assert!(payload["capacity"]["snapshotCapturedAt"].is_null());
        assert_eq!(payload["capacity"]["freshComplete"], false);
        assert_eq!(payload["capacity"]["status"], "waiting");
        assert_eq!(payload["capacity"]["enabledAccounts"], 1);
        assert_eq!(payload["capacity"]["includedAccounts"], 0);
        assert!(payload["capacity"]["currentUsableUsd"].is_null());
        assert!(payload["capacity"]["fiveHourTimeline"]
            .as_array()
            .unwrap()
            .is_empty());
    }

    #[test]
    fn latest_payload_capacity_marks_untrusted_and_expired_snapshots() {
        let target = target();
        let outside_horizon = now_ms() + 10 * HOUR_MS;
        let stale_at = now_ms() - 11 * 60 * 1000;
        let stale_row = active_row(
            "acct-a",
            stale_at,
            20.0,
            40.0,
            80.0,
            outside_horizon,
            outside_horizon,
        );
        let stale_payload = build_latest_payload(
            &[target.clone()],
            Some("main"),
            Some(SnapshotRecord {
                id: 1,
                cpa_id: "main".to_string(),
                cpa_name: "Main CPA".to_string(),
                captured_at: stale_at,
                rows: vec![stale_row.clone()],
                strategy: "full".to_string(),
                error_summary: None,
            }),
            &[],
            json!({ "status": "ok" }),
            &CollectorPreferences::default(),
            unit_pricing_profile(),
        );
        assert_eq!(stale_payload["capacity"]["status"], "untrusted");
        assert_number_close(&stale_payload["capacity"]["currentUsableUsd"], 40.0);

        let expired_at = now_ms() - 16 * 60 * 1000;
        let expired_payload = build_latest_payload(
            &[target.clone()],
            Some("main"),
            Some(SnapshotRecord {
                id: 2,
                cpa_id: "main".to_string(),
                cpa_name: "Main CPA".to_string(),
                captured_at: expired_at,
                rows: vec![stale_row],
                strategy: "full".to_string(),
                error_summary: None,
            }),
            &[],
            json!({ "status": "ok" }),
            &CollectorPreferences::default(),
            unit_pricing_profile(),
        );
        assert_eq!(expired_payload["capacity"]["status"], "waiting");
        assert_eq!(
            expired_payload["capacity"]["supportStatus"],
            "insufficient-sample"
        );
        assert!(expired_payload["capacity"]["supportHours"].is_null());
        assert!(expired_payload["capacity"]["estimatedDepletionAt"].is_null());
        assert!(expired_payload["capacity"]["currentUsableUsd"].is_null());
        assert!(expired_payload["capacity"]["fiveHourTimeline"]
            .as_array()
            .unwrap()
            .is_empty());
    }

    #[test]
    fn latest_payload_caps_available_hours_for_zero_consumption() {
        let target = target();
        let captured_at = now_ms();
        let previous_at = captured_at - 30 * 60 * 1000;
        let row = json!({
            "cpaId": "main",
            "cpaName": "Main CPA",
            "accountKey": "acct-a",
            "name": "Plus A",
            "disabled": false,
            "status": "active",
            "quotaSource": "fresh",
            "quotaSampledAt": captured_at,
            "normalizedPlan": "plus",
            "fiveHour": {
                "usedPercent": 10.0,
                "remainingUsd": 90.0,
                "remainingPoints": 90.0,
                "fullUsd": 100.0,
                "resetAtMs": 10_000_000
            },
            "weekly": {
                "usedPercent": 10.0,
                "remainingUsd": 90.0,
                "remainingPoints": 90.0,
                "fullUsd": 100.0,
                "resetAtMs": 20_000_000
            }
        });
        let mut previous_row = row.clone();
        previous_row["quotaSampledAt"] = json!(previous_at);
        let history = vec![
            SnapshotRecord {
                id: 1,
                cpa_id: "main".to_string(),
                cpa_name: "Main CPA".to_string(),
                captured_at: previous_at,
                rows: vec![previous_row],
                strategy: "full".to_string(),
                error_summary: None,
            },
            SnapshotRecord {
                id: 2,
                cpa_id: "main".to_string(),
                cpa_name: "Main CPA".to_string(),
                captured_at,
                rows: vec![row.clone()],
                strategy: "full".to_string(),
                error_summary: None,
            },
        ];
        let payload = build_latest_payload(
            &[target.clone()],
            Some("main"),
            Some(SnapshotRecord {
                id: 2,
                cpa_id: "main".to_string(),
                cpa_name: "Main CPA".to_string(),
                captured_at,
                rows: vec![row],
                strategy: "full".to_string(),
                error_summary: None,
            }),
            &history,
            json!({ "status": "ok" }),
            &CollectorPreferences::default(),
            unit_pricing_profile(),
        );

        assert_eq!(payload["risk"]["hourlyBurnUsd"], 0.0);
        assert_eq!(payload["risk"]["availableHours"], 168.0);
        assert_eq!(payload["risk"]["availableHoursCapped"], true);
        assert_eq!(payload["risk"]["futureFiveHour"]["status"], "idle");
        assert_eq!(payload["risk"]["futureFiveHour"]["projectedSpendUsd"], 0.0);
        assert!(payload["risk"]["futureFiveHour"]["coverageRatio"].is_null());
        assert!(payload["risk"]["estimatedDepletionAt"].is_null());
        assert_eq!(payload["capacity"]["supportStatus"], "idle");
        assert!(payload["capacity"]["supportHours"].is_null());
        assert!(payload["capacity"]["estimatedDepletionAt"].is_null());
    }
}
