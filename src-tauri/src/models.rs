use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CpaTarget {
    pub id: String,
    pub name: String,
    pub api_base: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CpaTargetConfig {
    pub id: String,
    pub name: String,
    pub api_base: String,
    pub enabled: bool,
    #[serde(default)]
    pub has_management_key: bool,
}

impl CpaTargetConfig {
    pub fn public_target(&self) -> CpaTarget {
        CpaTarget {
            id: self.id.clone(),
            name: self.name.clone(),
            api_base: self.api_base.clone(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveTargetRequest {
    pub id: Option<String>,
    pub name: String,
    pub api_base: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub management_key: Option<String>,
}

fn default_true() -> bool {
    true
}

fn default_schema_version() -> u32 {
    1
}

fn default_collect_usage_mode() -> String {
    "full".to_string()
}

fn default_collect_usage_tick_seconds() -> u64 {
    300
}

fn default_collect_usage_max_requests_per_minute() -> f64 {
    30.0
}

fn default_collect_concurrency() -> usize {
    3
}

fn default_collect_manual_concurrency() -> usize {
    8
}

fn default_collect_usage_error_backoff_minutes() -> u64 {
    10
}

fn default_collect_usage_error_backoff_max_minutes() -> u64 {
    120
}

fn default_cpa_request_timeout_seconds() -> u64 {
    60
}

fn default_cache_trust_max_minutes() -> u64 {
    60
}

fn default_alert_pool_remaining_hours_warn() -> f64 {
    6.0
}

fn default_alert_pool_remaining_hours_critical() -> f64 {
    3.0
}

fn default_alert_pool_remaining_hours_emergency() -> f64 {
    1.0
}

fn default_soft_issue_cooldown_minutes() -> u32 {
    12 * 60
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmailAlertSettings {
    pub enabled: bool,
    pub recipients: Vec<String>,
    pub min_tone: String,
    pub account_issue_threshold: u32,
    pub cooldown_minutes: u32,
    #[serde(default = "default_soft_issue_cooldown_minutes")]
    pub soft_issue_cooldown_minutes: u32,
    pub timeout_seconds: u32,
    pub max_message_chars: u32,
    pub smtp_host: String,
    pub smtp_port: u16,
    pub smtp_secure: bool,
    pub smtp_username: String,
    pub smtp_from: String,
    #[serde(default)]
    pub has_smtp_password: bool,
}

impl Default for EmailAlertSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            recipients: Vec::new(),
            min_tone: "warn".to_string(),
            account_issue_threshold: 1,
            cooldown_minutes: 30,
            soft_issue_cooldown_minutes: default_soft_issue_cooldown_minutes(),
            timeout_seconds: 10,
            max_message_chars: 4000,
            smtp_host: String::new(),
            smtp_port: 465,
            smtp_secure: true,
            smtp_username: String::new(),
            smtp_from: String::new(),
            has_smtp_password: false,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveEmailAlertSettings {
    pub enabled: bool,
    pub recipients: Vec<String>,
    pub min_tone: String,
    pub account_issue_threshold: u32,
    pub cooldown_minutes: u32,
    #[serde(default = "default_soft_issue_cooldown_minutes")]
    pub soft_issue_cooldown_minutes: u32,
    pub timeout_seconds: u32,
    pub max_message_chars: u32,
    pub smtp_host: String,
    pub smtp_port: u16,
    pub smtp_secure: bool,
    pub smtp_username: String,
    pub smtp_from: String,
    #[serde(default)]
    pub smtp_password: Option<String>,
    #[serde(default)]
    pub has_smtp_password: bool,
}

impl SaveEmailAlertSettings {
    pub fn without_password(self, has_password: bool) -> EmailAlertSettings {
        EmailAlertSettings {
            enabled: self.enabled,
            recipients: self.recipients,
            min_tone: self.min_tone,
            account_issue_threshold: self.account_issue_threshold,
            cooldown_minutes: self.cooldown_minutes,
            soft_issue_cooldown_minutes: self.soft_issue_cooldown_minutes,
            timeout_seconds: self.timeout_seconds,
            max_message_chars: self.max_message_chars,
            smtp_host: self.smtp_host,
            smtp_port: self.smtp_port,
            smtp_secure: self.smtp_secure,
            smtp_username: self.smtp_username,
            smtp_from: self.smtp_from,
            has_smtp_password: has_password || self.has_smtp_password,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectorPreferences {
    #[serde(default = "default_true")]
    pub auto_collect_enabled: bool,
    #[serde(default = "default_collect_usage_mode")]
    pub collect_usage_mode: String,
    #[serde(default = "default_collect_usage_tick_seconds")]
    pub collect_usage_tick_seconds: u64,
    #[serde(default = "default_collect_usage_max_requests_per_minute")]
    pub collect_usage_max_requests_per_minute: f64,
    #[serde(default = "default_collect_concurrency")]
    pub collect_concurrency: usize,
    #[serde(default = "default_collect_manual_concurrency")]
    pub collect_manual_concurrency: usize,
    #[serde(default = "default_collect_usage_max_requests_per_minute")]
    pub collect_manual_max_requests_per_minute: f64,
    #[serde(default = "default_collect_usage_error_backoff_minutes")]
    pub collect_usage_error_backoff_minutes: u64,
    #[serde(default = "default_collect_usage_error_backoff_max_minutes")]
    pub collect_usage_error_backoff_max_minutes: u64,
    #[serde(default = "default_cpa_request_timeout_seconds")]
    pub cpa_request_timeout_seconds: u64,
    #[serde(default = "default_cache_trust_max_minutes")]
    pub cache_trust_max_minutes: u64,
    #[serde(default = "default_alert_pool_remaining_hours_warn")]
    pub alert_pool_remaining_hours_warn: f64,
    #[serde(default = "default_alert_pool_remaining_hours_critical")]
    pub alert_pool_remaining_hours_critical: f64,
    #[serde(default = "default_alert_pool_remaining_hours_emergency")]
    pub alert_pool_remaining_hours_emergency: f64,
}

impl Default for CollectorPreferences {
    fn default() -> Self {
        Self {
            auto_collect_enabled: true,
            collect_usage_mode: "full".to_string(),
            collect_usage_tick_seconds: 300,
            collect_usage_max_requests_per_minute: 30.0,
            collect_concurrency: 3,
            collect_manual_concurrency: 8,
            collect_manual_max_requests_per_minute: 30.0,
            collect_usage_error_backoff_minutes: 10,
            collect_usage_error_backoff_max_minutes: 120,
            cpa_request_timeout_seconds: 60,
            cache_trust_max_minutes: 60,
            alert_pool_remaining_hours_warn: 6.0,
            alert_pool_remaining_hours_critical: 3.0,
            alert_pool_remaining_hours_emergency: 1.0,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveCollectorSettings {
    pub auto_collect_enabled: bool,
    #[serde(default)]
    pub collect_usage_tick_seconds: Option<u64>,
    #[serde(default)]
    pub collect_usage_tick_minutes: Option<u64>,
    #[serde(default)]
    pub collect_usage_max_requests_per_minute: Option<f64>,
    #[serde(default)]
    pub collect_concurrency: Option<usize>,
    #[serde(default)]
    pub collect_manual_concurrency: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    #[serde(default = "default_schema_version")]
    pub schema_version: u32,
    #[serde(default)]
    pub targets: Vec<CpaTargetConfig>,
    #[serde(default)]
    pub collector: CollectorPreferences,
    #[serde(default)]
    pub email_alert: EmailAlertSettings,
    #[serde(default = "crate::pricing::default_pricing_profile")]
    pub pricing_profile: Value,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            schema_version: 1,
            targets: Vec::new(),
            collector: CollectorPreferences::default(),
            email_alert: EmailAlertSettings::default(),
            pricing_profile: crate::pricing::default_pricing_profile(),
        }
    }
}
