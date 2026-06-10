use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde_json::{json, Value};

use crate::{models::CpaTargetConfig, pricing};

const FIVE_HOUR_SECONDS: i64 = 18_000;
const WEEK_SECONDS: i64 = 604_800;
const FIVE_HOUR_FALLBACK_MAX_MS: i64 = (FIVE_HOUR_SECONDS + 15 * 60) * 1000;
const WEEK_FALLBACK_MAX_MS: i64 = (WEEK_SECONDS + 24 * 60 * 60) * 1000;

pub fn is_codex_file(file: &Value) -> bool {
    resolve_auth_provider(file) == "codex"
}

pub fn is_disabled_auth_file(file: &Value) -> bool {
    match get_field(file, &["disabled"]) {
        Some(Value::Bool(value)) => *value,
        Some(Value::Number(value)) => value.as_i64().unwrap_or(0) != 0,
        Some(Value::String(value)) => value.trim().eq_ignore_ascii_case("true"),
        _ => false,
    }
}

pub fn normalize_auth_index(file: &Value) -> Option<String> {
    normalize_string(get_field(file, &["auth_index", "authIndex"]))
}

pub fn resolve_auth_file_name(file: &Value) -> Option<String> {
    normalize_string(get_field(file, &["name", "fileName", "filename"]))
}

pub fn resolve_auth_id(file: &Value) -> Option<String> {
    normalize_string(get_field(file, &["id"]))
}

pub fn auth_file_matches_name(file: &Value, name: &str) -> bool {
    let name = name.trim();
    if name.is_empty() {
        return false;
    }
    [
        resolve_auth_file_name(file),
        resolve_auth_id(file),
        normalize_auth_index(file),
        Some(resolve_codex_account_key(file)),
    ]
    .into_iter()
    .flatten()
    .any(|candidate| candidate == name)
}

pub fn resolve_codex_chatgpt_account_id(file: &Value) -> Option<String> {
    for candidate in [
        get_field(file, &["id_token"]),
        nested_field(file, "metadata", &["id_token"]),
        nested_field(file, "attributes", &["id_token"]),
    ] {
        if let Some(payload) = parse_id_token_payload(candidate) {
            if let Some(account_id) = normalize_string(
                payload
                    .get("chatgpt_account_id")
                    .or_else(|| payload.get("chatgptAccountId")),
            ) {
                return Some(account_id);
            }
        }
    }
    None
}

pub fn resolve_codex_account_key(file: &Value) -> String {
    let plan_type = resolve_codex_plan_type(file, None);
    let normalized_plan = pricing::normalize_plan_key(plan_type.as_deref());
    resolve_codex_account_key_for_plan(file, normalized_plan)
}

pub fn build_codex_quota_row(
    target: &CpaTargetConfig,
    file: &Value,
    payload: Option<&Value>,
    pricing_profile: &Value,
    now_ms: i64,
    error: Option<String>,
) -> Value {
    let disabled = is_disabled_auth_file(file);
    let provider = resolve_auth_provider(file);
    let auth_index = normalize_auth_index(file);
    let auth_file_name = resolve_auth_file_name(file);
    let auth_id = resolve_auth_id(file);
    let account_id = resolve_codex_chatgpt_account_id(file);
    let plan_type = resolve_codex_plan_type(file, payload);
    let normalized_plan = pricing::normalize_plan_key(plan_type.as_deref());
    let account_key = resolve_codex_account_key_for_plan(file, normalized_plan);
    let name = auth_file_name
        .clone()
        .or_else(|| normalize_string(get_field(file, &["label", "email"])))
        .unwrap_or_else(|| account_key.clone());

    if payload.is_none() || error.is_some() {
        let sampled_at = if error.is_some() { Some(now_ms) } else { None };
        return json!({
            "cpaId": target.id,
            "cpaName": target.name,
            "accountKey": account_key,
            "name": name,
            "provider": provider,
            "authIndex": auth_index,
            "authFileName": auth_file_name,
            "authId": auth_id,
            "accountId": account_id,
            "disabled": disabled,
            "status": if disabled { "paused" } else { "failed" },
            "planType": plan_type,
            "normalizedPlan": normalized_plan,
            "fiveHour": null,
            "weekly": null,
            "recent30mConsumedUsd": null,
            "recent30mConsumptionState": "no-sample",
            "quotaSource": if disabled { "paused" } else { "failed" },
            "quotaSampledAt": sampled_at,
            "quotaAgeMs": sampled_at.map(|_| 0),
            "backoffUntil": null,
            "requestHeaderSource": null,
            "error": if disabled {
                error.map(Value::from).unwrap_or(Value::Null)
            } else {
                Value::from(error.unwrap_or_else(|| "usage 响应为空或不是有效 JSON".to_string()))
            }
        });
    }

    let payload = payload.expect("payload checked above");
    let rate_limit = payload
        .get("rate_limit")
        .or_else(|| payload.get("rateLimit"));
    let limit_reached = rate_limit
        .and_then(|rate| {
            rate.get("limit_reached")
                .or_else(|| rate.get("limitReached"))
        })
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let allowed = rate_limit
        .and_then(|rate| rate.get("allowed"))
        .cloned()
        .unwrap_or(Value::Null);
    let (five_hour_window, weekly_window) = pick_main_windows(rate_limit, now_ms);
    let five_hour = to_quota_window(
        pricing_profile,
        normalized_plan,
        "five-hour",
        five_hour_window,
        now_ms,
        limit_reached,
        &allowed,
    );
    let weekly = to_quota_window(
        pricing_profile,
        normalized_plan,
        "weekly",
        weekly_window,
        now_ms,
        limit_reached,
        &allowed,
    );
    let (status, quota_source, error) = if disabled {
        ("paused", "paused", Value::Null)
    } else {
        let mut missing = Vec::new();
        if !has_used_percent(&five_hour) {
            missing.push("5h");
        }
        if !has_used_percent(&weekly) {
            missing.push("周");
        }
        if missing.is_empty() {
            ("active", "fresh", Value::Null)
        } else {
            (
                "unknown",
                "failed",
                json!(format!("缺少 {} 主窗口额度数据", missing.join("/"))),
            )
        }
    };
    json!({
        "cpaId": target.id,
        "cpaName": target.name,
        "accountKey": account_key,
        "name": name,
        "provider": provider,
        "authIndex": auth_index,
        "authFileName": auth_file_name,
        "authId": auth_id,
        "accountId": account_id,
        "disabled": disabled,
        "status": status,
        "planType": plan_type,
        "normalizedPlan": normalized_plan,
        "fiveHour": five_hour,
        "weekly": weekly,
        "recent30mConsumedUsd": null,
        "recent30mConsumptionState": "no-sample",
        "quotaSource": quota_source,
        "quotaSampledAt": now_ms,
        "quotaAgeMs": 0,
        "backoffUntil": null,
        "requestHeaderSource": null,
        "error": error
    })
}

pub fn with_quota_source(
    mut row: Value,
    source: &str,
    now_ms: i64,
    error: Option<String>,
    backoff_until: Option<i64>,
) -> Value {
    if let Some(object) = row.as_object_mut() {
        object.insert("quotaSource".to_string(), json!(source));
        object.insert("quotaSampledAt".to_string(), json!(now_ms));
        object.insert("quotaAgeMs".to_string(), json!(0));
        object.insert(
            "backoffUntil".to_string(),
            backoff_until.map(Value::from).unwrap_or(Value::Null),
        );
        if let Some(error) = error {
            object.insert("error".to_string(), json!(error));
        }
    }
    row
}

pub fn with_request_header_source(mut row: Value, source: Option<&str>) -> Value {
    if let Some(object) = row.as_object_mut() {
        object.insert(
            "requestHeaderSource".to_string(),
            source.map(|value| json!(value)).unwrap_or(Value::Null),
        );
    }
    row
}

pub fn reprice_quota_row(row: &mut Value, pricing_profile: &Value) {
    let plan_key = row
        .get("normalizedPlan")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string();
    for (field, window_id) in [("fiveHour", "five-hour"), ("weekly", "weekly")] {
        let remaining_points = row
            .get(field)
            .and_then(|window| window.get("remainingPoints"))
            .and_then(Value::as_f64)
            .or_else(|| {
                row.get(field)
                    .and_then(|window| window.get("usedPercent"))
                    .and_then(Value::as_f64)
                    .map(|used_percent| (100.0 - used_percent).clamp(0.0, 100.0))
            });
        let remaining_usd =
            pricing::calculate_window_usd(pricing_profile, &plan_key, window_id, remaining_points);
        let full_usd = pricing::window_full_usd(pricing_profile, &plan_key, window_id);
        if let Some(window) = row.get_mut(field).and_then(Value::as_object_mut) {
            window.insert(
                "remainingUsd".to_string(),
                remaining_usd.map_or(Value::Null, |value| json!(value)),
            );
            window.insert(
                "fullUsd".to_string(),
                full_usd.map_or(Value::Null, |value| json!(value)),
            );
            window.insert("priced".to_string(), json!(remaining_usd.is_some()));
        }
    }
}

pub fn refresh_row_age(row: &mut Value, now_ms: i64) {
    let sampled_at = row.get("quotaSampledAt").and_then(Value::as_i64);
    if let (Some(object), Some(sampled_at)) = (row.as_object_mut(), sampled_at) {
        object.insert(
            "quotaAgeMs".to_string(),
            json!((now_ms - sampled_at).max(0)),
        );
    }
}

fn resolve_auth_provider(file: &Value) -> String {
    let raw = normalize_string(get_field(file, &["provider", "type"])).unwrap_or_default();
    let key = raw.trim().to_lowercase().replace('_', "-");
    if key == "x-ai" || key == "grok" {
        "xai".to_string()
    } else {
        key
    }
}

fn resolve_codex_account_key_for_plan(file: &Value, normalized_plan: &str) -> String {
    if normalized_plan == "team" {
        return normalize_auth_index(file)
            .or_else(|| resolve_codex_chatgpt_account_id(file))
            .or_else(|| normalize_string(get_field(file, &["name"])))
            .unwrap_or_else(|| "unknown-account".to_string());
    }
    resolve_codex_chatgpt_account_id(file)
        .or_else(|| normalize_auth_index(file))
        .or_else(|| normalize_string(get_field(file, &["name"])))
        .unwrap_or_else(|| "unknown-account".to_string())
}

fn resolve_codex_plan_type(file: &Value, payload: Option<&Value>) -> Option<String> {
    let mut candidates: Vec<Option<String>> = Vec::new();
    if let Some(payload) = payload {
        candidates.push(normalize_string(
            payload.get("plan_type").or_else(|| payload.get("planType")),
        ));
    }
    candidates.push(normalize_string(get_field(
        file,
        &["plan_type", "planType"],
    )));
    candidates.push(normalize_string(nested_field(
        file,
        "metadata",
        &["plan_type", "planType"],
    )));
    candidates.push(normalize_string(nested_field(
        file,
        "attributes",
        &["plan_type", "planType"],
    )));

    for candidate in [
        get_field(file, &["id_token"]),
        nested_field(file, "metadata", &["id_token"]),
        nested_field(file, "attributes", &["id_token"]),
    ] {
        if let Some(payload) = parse_id_token_payload(candidate) {
            candidates.push(normalize_string(
                payload.get("plan_type").or_else(|| payload.get("planType")),
            ));
        }
    }

    candidates
        .into_iter()
        .flatten()
        .next()
        .map(|value| value.to_lowercase())
}

fn pick_main_windows(rate_limit: Option<&Value>, now_ms: i64) -> (Option<&Value>, Option<&Value>) {
    let primary = rate_limit.and_then(|rate| {
        rate.get("primary_window")
            .or_else(|| rate.get("primaryWindow"))
    });
    let secondary = rate_limit.and_then(|rate| {
        rate.get("secondary_window")
            .or_else(|| rate.get("secondaryWindow"))
    });
    let mut five_hour = None;
    let mut weekly = None;
    for window in [primary, secondary].into_iter().flatten() {
        match get_window_seconds(window) {
            Some(FIVE_HOUR_SECONDS) if five_hour.is_none() => five_hour = Some(window),
            Some(WEEK_SECONDS) if weekly.is_none() => weekly = Some(window),
            _ => {}
        }
    }
    if five_hour.is_none()
        && primary
            .filter(|value| Some(*value) != weekly)
            .is_some_and(|value| is_plausible_fallback_window(value, "five-hour", now_ms))
    {
        five_hour = primary.filter(|value| Some(*value) != weekly);
    }
    if weekly.is_none()
        && secondary
            .filter(|value| Some(*value) != five_hour)
            .is_some_and(|value| is_plausible_fallback_window(value, "weekly", now_ms))
    {
        weekly = secondary.filter(|value| Some(*value) != five_hour);
    }
    (five_hour, weekly)
}

fn to_quota_window(
    pricing_profile: &Value,
    plan_key: &str,
    id: &str,
    window: Option<&Value>,
    now_ms: i64,
    limit_reached: bool,
    allowed: &Value,
) -> Option<Value> {
    let window = window?;
    let reset_at_ms = parse_reset_at_ms(window, now_ms);
    let raw_used_percent = number_from_value(
        window
            .get("used_percent")
            .or_else(|| window.get("usedPercent")),
    );
    let used_percent = raw_used_percent
        .map(|value| value.clamp(0.0, 100.0))
        .or_else(|| {
            if (limit_reached || allowed.as_bool() == Some(false)) && reset_at_ms.is_some() {
                Some(100.0)
            } else {
                None
            }
        });
    let remaining_points = used_percent.map(|value| (100.0 - value).clamp(0.0, 100.0));
    let remaining_usd =
        pricing::calculate_window_usd(pricing_profile, plan_key, id, remaining_points);
    let full_usd = pricing::window_full_usd(pricing_profile, plan_key, id);
    Some(json!({
        "id": id,
        "usedPercent": used_percent,
        "remainingPoints": remaining_points,
        "remainingUsd": remaining_usd,
        "fullUsd": full_usd,
        "resetAtMs": reset_at_ms,
        "priced": remaining_usd.is_some()
    }))
}

fn has_used_percent(window: &Option<Value>) -> bool {
    window
        .as_ref()
        .and_then(|value| value.get("usedPercent"))
        .and_then(Value::as_f64)
        .is_some()
}

fn get_window_seconds(window: &Value) -> Option<i64> {
    number_from_value(
        window
            .get("limit_window_seconds")
            .or_else(|| window.get("limitWindowSeconds")),
    )
    .map(|value| value as i64)
}

fn is_plausible_fallback_window(window: &Value, id: &str, now_ms: i64) -> bool {
    if get_window_seconds(window).is_some() {
        return false;
    }
    let Some(reset_at_ms) = parse_reset_at_ms(window, now_ms) else {
        return false;
    };
    if reset_at_ms <= now_ms {
        return false;
    }
    let max_ms = if id == "five-hour" {
        FIVE_HOUR_FALLBACK_MAX_MS
    } else {
        WEEK_FALLBACK_MAX_MS
    };
    reset_at_ms - now_ms <= max_ms
}

fn parse_reset_at_ms(window: &Value, now_ms: i64) -> Option<i64> {
    let raw = window.get("reset_at").or_else(|| window.get("resetAt"));
    if let Some(value) = number_from_value(raw) {
        let millis = if value < 10_000_000_000.0 {
            value * 1000.0
        } else {
            value
        };
        return Some(millis as i64);
    }
    if let Some(reset_after_seconds) = number_from_value(
        window
            .get("reset_after_seconds")
            .or_else(|| window.get("resetAfterSeconds")),
    ) {
        return Some(now_ms + (reset_after_seconds * 1000.0) as i64);
    }
    None
}

fn parse_id_token_payload(value: Option<&Value>) -> Option<Value> {
    match value? {
        Value::Object(_) => value.cloned(),
        Value::String(text) => {
            let trimmed = text.trim();
            if trimmed.starts_with('{') {
                return serde_json::from_str(trimmed).ok();
            }
            let segment = trimmed.split('.').nth(1)?;
            let bytes = URL_SAFE_NO_PAD.decode(segment).ok()?;
            serde_json::from_slice(&bytes).ok()
        }
        _ => None,
    }
}

fn get_field<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().find_map(|key| value.get(*key))
}

fn nested_field<'a>(value: &'a Value, object_key: &str, keys: &[&str]) -> Option<&'a Value> {
    value
        .get(object_key)
        .and_then(|object| get_field(object, keys))
}

fn normalize_string(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(text) => {
            let trimmed = text.trim();
            (!trimmed.is_empty()).then(|| trimmed.to_string())
        }
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    }
}

fn number_from_value(value: Option<&Value>) -> Option<f64> {
    match value? {
        Value::Number(number) => number.as_f64().filter(|value| value.is_finite()),
        Value::String(text) => text
            .trim()
            .parse::<f64>()
            .ok()
            .filter(|value| value.is_finite()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target() -> CpaTargetConfig {
        CpaTargetConfig {
            id: "main".to_string(),
            name: "Main CPA".to_string(),
            api_base: "http://127.0.0.1:8398".to_string(),
            enabled: true,
            has_management_key: true,
        }
    }

    fn id_token(payload: &str) -> String {
        format!("header.{}.signature", URL_SAFE_NO_PAD.encode(payload))
    }

    #[test]
    fn resolves_codex_account_key_from_id_token() {
        let file = json!({
            "provider": "codex",
            "auth_index": 3,
            "id_token": id_token(r#"{"chatgpt_account_id":"acct_123","plan_type":"plus"}"#)
        });

        assert!(is_codex_file(&file));
        assert_eq!(
            resolve_codex_chatgpt_account_id(&file).as_deref(),
            Some("acct_123")
        );
        assert_eq!(resolve_codex_account_key(&file), "acct_123");
    }

    #[test]
    fn team_account_key_prefers_auth_index_over_shared_account_id() {
        let file = json!({
            "provider": "codex",
            "auth_index": "team-slot-7",
            "id_token": id_token(r#"{"chatgpt_account_id":"shared_team_account","plan_type":"team"}"#)
        });

        assert_eq!(
            resolve_codex_chatgpt_account_id(&file).as_deref(),
            Some("shared_team_account")
        );
        assert_eq!(resolve_codex_account_key(&file), "team-slot-7");
    }

    #[test]
    fn builds_codex_quota_row_from_usage_payload() {
        let now = 1_000_000;
        let file = json!({
            "name": "Plus A",
            "provider": "codex",
            "authIndex": "7",
            "id_token": id_token(r#"{"chatgpt_account_id":"acct_plus","plan_type":"plus"}"#)
        });
        let payload = json!({
            "rate_limit": {
                "limit_reached": false,
                "allowed": true,
                "primary_window": {
                    "limit_window_seconds": 18000,
                    "used_percent": 20,
                    "reset_after_seconds": 600
                },
                "secondary_window": {
                    "limit_window_seconds": 604800,
                    "used_percent": 50,
                    "reset_at": 2000
                }
            }
        });

        let row = build_codex_quota_row(
            &target(),
            &file,
            Some(&payload),
            &pricing::default_pricing_profile(),
            now,
            None,
        );

        assert_eq!(row["status"], "active");
        assert_eq!(row["accountId"], "acct_plus");
        assert_eq!(row["normalizedPlan"], "plus");
        assert_eq!(row["fiveHour"]["remainingPoints"], 80.0);
        assert_eq!(row["weekly"]["remainingPoints"], 50.0);
        assert_eq!(row["fiveHour"]["resetAtMs"], now + 600_000);
        assert_eq!(row["weekly"]["resetAtMs"], 2_000_000);
        assert!((row["fiveHour"]["remainingUsd"].as_f64().unwrap() - 15.016).abs() < 0.001);
    }

    #[test]
    fn monthly_team_window_is_not_treated_as_five_hour_quota() {
        let now = 1_000_000;
        let file = json!({
            "name": "Team A",
            "provider": "codex",
            "authIndex": "team-a",
            "id_token": id_token(r#"{"chatgpt_account_id":"shared_team_account","plan_type":"team"}"#)
        });
        let payload = json!({
            "rate_limit": {
                "limit_reached": false,
                "allowed": true,
                "primary_window": {
                    "limit_window_seconds": 2_592_000,
                    "used_percent": 20,
                    "reset_after_seconds": 2_592_000
                }
            }
        });

        let row = build_codex_quota_row(
            &target(),
            &file,
            Some(&payload),
            &pricing::default_pricing_profile(),
            now,
            None,
        );

        assert_eq!(row["accountKey"], "team-a");
        assert_eq!(row["status"], "unknown");
        assert_eq!(row["quotaSource"], "failed");
        assert!(row["fiveHour"].is_null());
        assert!(row["weekly"].is_null());
        assert_eq!(row["error"], "缺少 5h/周 主窗口额度数据");
    }

    #[test]
    fn disabled_auth_file_becomes_paused_row() {
        let file = json!({
            "name": "Paused",
            "provider": "codex",
            "disabled": "true",
            "auth_index": "2"
        });

        let row = build_codex_quota_row(
            &target(),
            &file,
            None,
            &pricing::default_pricing_profile(),
            1,
            None,
        );

        assert_eq!(row["disabled"], true);
        assert_eq!(row["status"], "paused");
        assert_eq!(row["quotaSource"], "paused");
        assert!(row["error"].is_null());
    }

    #[test]
    fn disabled_auth_file_keeps_usage_reset_windows_when_payload_is_available() {
        let now = 1_000_000;
        let file = json!({
            "id": "auth-paused",
            "name": "paused-plus.json",
            "provider": "codex",
            "disabled": true,
            "auth_index": "2",
            "id_token": id_token(r#"{"chatgpt_account_id":"acct_paused","plan_type":"plus"}"#)
        });
        let payload = json!({
            "rate_limit": {
                "limit_reached": false,
                "allowed": true,
                "primary_window": {
                    "limit_window_seconds": 18000,
                    "used_percent": 10,
                    "reset_after_seconds": 1200
                },
                "secondary_window": {
                    "limit_window_seconds": 604800,
                    "used_percent": 30,
                    "reset_at": 3000
                }
            }
        });

        let row = build_codex_quota_row(
            &target(),
            &file,
            Some(&payload),
            &pricing::default_pricing_profile(),
            now,
            None,
        );

        assert_eq!(row["disabled"], true);
        assert_eq!(row["status"], "paused");
        assert_eq!(row["quotaSource"], "paused");
        assert_eq!(row["authFileName"], "paused-plus.json");
        assert_eq!(row["authId"], "auth-paused");
        assert_eq!(row["fiveHour"]["resetAtMs"], now + 1_200_000);
        assert_eq!(row["weekly"]["resetAtMs"], 3_000_000);
        assert!(row["error"].is_null());
    }
}
