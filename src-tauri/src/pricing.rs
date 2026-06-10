use serde_json::{json, Value};

pub fn default_pricing_profile() -> Value {
    json!({
        "id": "reference-2026-04-10",
        "name": "参考图 2026-04-10",
        "sourceLabel": "按社区实测折算，非官方账单金额",
        "updatedAt": 0,
        "plans": {
            "free": { "fiveHourUsd": null, "weeklyUsd": 10.58 },
            "plus": { "fiveHourUsd": 18.77, "weeklyUsd": 117.31 },
            "team": { "fiveHourUsd": 21.65, "weeklyUsd": 135.33 },
            "pro": { "fiveHourUsd": 317.16, "weeklyUsd": 1858.0 }
        }
    })
}

pub fn normalize_plan_key(plan_type: Option<&str>) -> &'static str {
    let value = plan_type.unwrap_or_default().trim().to_lowercase();
    if value.is_empty() {
        return "unknown";
    }
    if value.contains("team") || value.contains("business") || value.contains("enterprise") {
        return "team";
    }
    if value.contains("pro") {
        return "pro";
    }
    if value.contains("plus") {
        return "plus";
    }
    if value.contains("free")
        || value.contains("normal")
        || value.contains("default")
        || value.contains("普号")
        || value.contains("basic")
    {
        return "free";
    }
    "unknown"
}

pub fn normalize_existing_pricing_profile(input: Value) -> Value {
    normalize_pricing_profile_with_updated_at(input, None)
}

pub fn normalize_pricing_profile(input: Value) -> Value {
    normalize_pricing_profile_with_updated_at(input, Some(crate::service::now_ms()))
}

fn normalize_pricing_profile_with_updated_at(input: Value, updated_at: Option<i64>) -> Value {
    let fallback = default_pricing_profile();
    let mut next = fallback.clone();
    if let Some(id) = input
        .get("id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
    {
        next["id"] = json!(id);
    }
    if let Some(name) = input
        .get("name")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
    {
        next["name"] = json!(name);
    }
    if let Some(source_label) = input
        .get("sourceLabel")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
    {
        next["sourceLabel"] = json!(source_label);
    }
    next["updatedAt"] = json!(updated_at.unwrap_or_else(|| {
        input
            .get("updatedAt")
            .and_then(Value::as_i64)
            .filter(|value| *value >= 0)
            .unwrap_or_else(|| fallback["updatedAt"].as_i64().unwrap_or(0))
    }));

    for plan in ["free", "plus", "team", "pro"] {
        for field in ["fiveHourUsd", "weeklyUsd"] {
            if input["plans"][plan][field].is_null() {
                next["plans"][plan][field] = Value::Null;
            } else if let Some(value) = number_from_value(&input["plans"][plan][field]) {
                next["plans"][plan][field] = json!(value.max(0.0));
            }
        }
    }
    next
}

pub fn window_full_usd(profile: &Value, plan_key: &str, window_id: &str) -> Option<f64> {
    if plan_key == "unknown" {
        return None;
    }
    let field = if window_id == "five-hour" {
        "fiveHourUsd"
    } else {
        "weeklyUsd"
    };
    number_from_value(&profile["plans"][plan_key][field]).filter(|value| *value >= 0.0)
}

pub fn calculate_window_usd(
    profile: &Value,
    plan_key: &str,
    window_id: &str,
    points: Option<f64>,
) -> Option<f64> {
    let points = points?;
    let full = window_full_usd(profile, plan_key, window_id)?;
    Some((points.clamp(0.0, 100.0) / 100.0) * full)
}

fn number_from_value(value: &Value) -> Option<f64> {
    if let Some(number) = value.as_f64().filter(|number| number.is_finite()) {
        return Some(number);
    }
    value
        .as_str()
        .and_then(|text| text.trim().parse::<f64>().ok())
        .filter(|number| number.is_finite())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_plan_keys() {
        assert_eq!(normalize_plan_key(Some("ChatGPT Plus")), "plus");
        assert_eq!(normalize_plan_key(Some("Enterprise Team")), "team");
        assert_eq!(normalize_plan_key(Some("Pro")), "pro");
        assert_eq!(normalize_plan_key(Some("普号")), "free");
        assert_eq!(normalize_plan_key(None), "unknown");
    }

    #[test]
    fn normalizes_pricing_profile_numbers_and_nulls() {
        let profile = normalize_pricing_profile(json!({
            "id": "custom",
            "name": "Custom",
            "sourceLabel": "local",
            "plans": {
                "free": { "fiveHourUsd": null, "weeklyUsd": "12.5" },
                "plus": { "fiveHourUsd": -1, "weeklyUsd": "120" }
            }
        }));

        assert_eq!(profile["id"], "custom");
        assert_eq!(profile["name"], "Custom");
        assert!(profile["updatedAt"].as_i64().unwrap() > 0);
        assert!(profile["plans"]["free"]["fiveHourUsd"].is_null());
        assert_eq!(profile["plans"]["free"]["weeklyUsd"], 12.5);
        assert_eq!(profile["plans"]["plus"]["fiveHourUsd"], 0.0);
        assert_eq!(profile["plans"]["plus"]["weeklyUsd"], 120.0);
    }

    #[test]
    fn calculates_window_usd_by_points() {
        let profile = default_pricing_profile();

        assert_eq!(
            calculate_window_usd(&profile, "plus", "weekly", Some(50.0)),
            Some(58.655)
        );
        assert_eq!(
            calculate_window_usd(&profile, "unknown", "weekly", Some(50.0)),
            None
        );
        assert_eq!(calculate_window_usd(&profile, "plus", "weekly", None), None);
    }
}
