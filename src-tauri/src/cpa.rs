use anyhow::{anyhow, Context, Result};
use reqwest::{Client, Method};
use serde_json::{json, Value};
use std::{collections::BTreeMap, time::Duration};

use crate::models::CpaTargetConfig;

pub const CODEX_USAGE_URL: &str = "https://chatgpt.com/backend-api/wham/usage";
pub const CODEX_DEFAULT_USER_AGENT: &str =
    "codex-tui/0.135.0 (Mac OS 26.5.0; arm64) iTerm.app/3.6.10 (codex-tui; 0.135.0)";
pub const CODEX_DEFAULT_ORIGINATOR: &str = "codex-tui";

pub const CODEX_REQUEST_HEADERS: &[(&str, &str)] = &[
    ("Authorization", "Bearer $TOKEN$"),
    ("Content-Type", "application/json"),
    ("Accept", "application/json"),
    ("Connection", "Keep-Alive"),
    ("Originator", CODEX_DEFAULT_ORIGINATOR),
    ("User-Agent", CODEX_DEFAULT_USER_AGENT),
];

#[derive(Debug, Clone)]
pub struct CpaClient {
    client: Client,
    target: CpaTargetConfig,
    management_key: String,
}

impl CpaClient {
    pub fn new(
        target: CpaTargetConfig,
        management_key: String,
        timeout_seconds: u64,
    ) -> Result<Self> {
        let client = Client::builder()
            .timeout(Duration::from_secs(timeout_seconds.max(1)))
            .build()
            .context("创建 HTTP 客户端失败")?;
        Ok(Self {
            client,
            target,
            management_key,
        })
    }

    pub async fn list_auth_files(&self) -> Result<Vec<Value>> {
        let payload = self.request("/auth-files", None).await?;
        if let Some(items) = payload.as_array() {
            return Ok(items.clone());
        }
        if let Some(items) = payload.get("files").and_then(Value::as_array) {
            return Ok(items.clone());
        }
        if let Some(items) = payload.get("items").and_then(Value::as_array) {
            return Ok(items.clone());
        }
        Ok(Vec::new())
    }

    pub async fn api_call(&self, request: Value) -> Result<ApiCallResult> {
        let payload = self.request("/api-call", Some(request)).await?;
        let status_code = payload
            .get("status_code")
            .or_else(|| payload.get("statusCode"))
            .and_then(Value::as_u64)
            .unwrap_or(0) as u16;
        let body_raw = payload.get("body").cloned().unwrap_or(Value::Null);
        let body_text = match &body_raw {
            Value::Null => String::new(),
            Value::String(text) => text.clone(),
            value => value.to_string(),
        };
        let body = parse_body(&body_raw, &body_text);
        Ok(ApiCallResult {
            status_code,
            body_text,
            body,
        })
    }

    pub async fn set_auth_file_disabled(&self, name: &str, disabled: bool) -> Result<()> {
        self.request_with_method(
            Method::PATCH,
            "/auth-files/status",
            Some(json!({
                "name": name,
                "disabled": disabled
            })),
        )
        .await?;
        Ok(())
    }

    pub async fn delete_auth_file(&self, name: &str) -> Result<()> {
        let query = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("name", name)
            .finish();
        let path = format!("/auth-files?{query}");
        self.request_with_method(Method::DELETE, &path, None)
            .await?;
        Ok(())
    }

    async fn request(&self, path: &str, body: Option<Value>) -> Result<Value> {
        let method = if body.is_some() {
            Method::POST
        } else {
            Method::GET
        };
        self.request_with_method(method, path, body).await
    }

    async fn request_with_method(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<Value> {
        let url = format!(
            "{}/v0/management{}",
            self.target.api_base.trim_end_matches('/'),
            path
        );
        let builder = if let Some(body) = body {
            self.client.request(method, &url).json(&body)
        } else {
            self.client.request(method, &url)
        };
        let response = builder
            .bearer_auth(&self.management_key)
            .header("Content-Type", "application/json")
            .send()
            .await
            .with_context(|| format!("CPA Management 请求失败：{path}"))?;
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        let payload = if text.trim().is_empty() {
            Value::Null
        } else {
            serde_json::from_str::<Value>(&text).unwrap_or_else(|_| Value::String(text.clone()))
        };
        if !status.is_success() {
            return Err(anyhow!(
                "{} {}",
                status.as_u16(),
                error_message(
                    &payload,
                    status.canonical_reason().unwrap_or("Request failed")
                )
            ));
        }
        Ok(payload)
    }
}

#[derive(Debug, Clone)]
pub struct ApiCallResult {
    pub status_code: u16,
    pub body_text: String,
    pub body: Value,
}

#[derive(Debug, Clone)]
pub struct CodexUsageRequest {
    pub payload: Value,
    pub header_source: String,
}

pub fn api_call_error_message(result: &ApiCallResult) -> String {
    if let Some(message) = summarize_api_call_error(result) {
        return message;
    }
    let message = error_message(&result.body, result.body_text.as_str());
    if result.status_code > 0 {
        format!("{} {}", result.status_code, message)
            .trim()
            .to_string()
    } else if message.trim().is_empty() {
        "Request failed".to_string()
    } else {
        message
    }
}

fn summarize_api_call_error(result: &ApiCallResult) -> Option<String> {
    let text = result.body_text.trim();
    let lower = text.to_ascii_lowercase();
    let looks_like_html = lower.starts_with("<!doctype html")
        || lower.starts_with("<html")
        || lower.contains("<html")
        || lower.contains("<body");
    let looks_like_cloudflare = lower.contains("cf_chl")
        || lower.contains("challenge-platform")
        || lower.contains("enable javascript and cookies");
    if result.status_code == 403 && looks_like_cloudflare {
        return Some("403 ChatGPT Cloudflare challenge：usage 接口被风控拦截，请稍后重试或在 CPA 侧检查账号会话 / IP 环境".to_string());
    }
    if looks_like_html && result.status_code > 0 {
        return Some(format!(
            "{} ChatGPT usage 返回 HTML 页面而不是 JSON，可能被风控、登录态失效或上游网关拦截",
            result.status_code
        ));
    }
    None
}

pub fn codex_usage_request(
    auth_index: &str,
    account_id: Option<String>,
    auth_file: &Value,
) -> CodexUsageRequest {
    let mut header = BTreeMap::<String, String>::new();
    for (key, value) in CODEX_REQUEST_HEADERS {
        header.insert((*key).to_string(), (*value).to_string());
    }
    let custom_headers = extract_codex_custom_headers(auth_file);
    let mut used_custom_headers = false;
    for (key, value) in custom_headers {
        if is_sensitive_header(&key) {
            continue;
        }
        header.insert(key, value);
        used_custom_headers = true;
    }
    for (key, value) in CODEX_REQUEST_HEADERS {
        if is_required_header(key) {
            header.insert((*key).to_string(), (*value).to_string());
        }
    }
    if let Some(account_id) = account_id.filter(|value| !value.trim().is_empty()) {
        header.insert("Chatgpt-Account-Id".to_string(), account_id);
    }
    let header = header
        .into_iter()
        .map(|(key, value)| (key, json!(value)))
        .collect::<serde_json::Map<String, Value>>();
    CodexUsageRequest {
        payload: json!({
            "authIndex": auth_index,
            "method": "GET",
            "url": CODEX_USAGE_URL,
            "header": header
        }),
        header_source: if used_custom_headers {
            "cpa-metadata".to_string()
        } else {
            "default".to_string()
        },
    }
}

fn extract_codex_custom_headers(auth_file: &Value) -> BTreeMap<String, String> {
    let mut headers = BTreeMap::new();
    collect_header_prefixes(auth_file.get("attributes"), &mut headers);
    collect_header_prefixes(auth_file.get("metadata"), &mut headers);
    collect_header_prefixes(Some(auth_file), &mut headers);
    collect_header_object(auth_file.get("headers"), &mut headers);
    collect_header_object(auth_file.pointer("/attributes/headers"), &mut headers);
    collect_header_object(auth_file.pointer("/metadata/headers"), &mut headers);
    headers
}

fn collect_header_prefixes(value: Option<&Value>, headers: &mut BTreeMap<String, String>) {
    let Some(object) = value.and_then(Value::as_object) else {
        return;
    };
    for (key, value) in object {
        let Some(name) = key.trim().strip_prefix("header:").map(str::trim) else {
            continue;
        };
        if name.is_empty() {
            continue;
        }
        if let Some(value) = header_value(value) {
            headers.insert(name.to_string(), value);
        }
    }
}

fn collect_header_object(value: Option<&Value>, headers: &mut BTreeMap<String, String>) {
    let Some(object) = value.and_then(Value::as_object) else {
        return;
    };
    for (key, value) in object {
        let name = key.trim();
        if name.is_empty() {
            continue;
        }
        if let Some(value) = header_value(value) {
            headers.insert(name.to_string(), value);
        }
    }
}

fn header_value(value: &Value) -> Option<String> {
    let text = match value {
        Value::String(value) => value.trim().to_string(),
        Value::Number(value) => value.to_string(),
        Value::Bool(value) => value.to_string(),
        _ => return None,
    };
    (!text.is_empty()).then_some(text)
}

fn is_sensitive_header(key: &str) -> bool {
    matches!(
        key.trim().to_ascii_lowercase().as_str(),
        "authorization" | "host" | "content-length" | "cookie" | "proxy-authorization"
    )
}

fn is_required_header(key: &str) -> bool {
    matches!(
        key.trim().to_ascii_lowercase().as_str(),
        "authorization" | "content-type"
    )
}

pub fn is_usage_risk_status(status_code: u16) -> bool {
    matches!(status_code, 403 | 429)
}

pub fn is_usage_risk_message(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("cloudflare")
        || lower.contains("challenge")
        || lower.contains("429")
        || lower.contains("403")
        || lower.contains("rate limit")
        || lower.contains("timed out")
        || lower.contains("timeout")
}

pub fn usage_risk_reason(status_code: Option<u16>, message: &str) -> Option<String> {
    if status_code.map(is_usage_risk_status).unwrap_or(false) || is_usage_risk_message(message) {
        let trimmed = message.trim();
        Some(if trimmed.is_empty() {
            status_code
                .map(|status| format!("usage 请求返回 {status}"))
                .unwrap_or_else(|| "usage 请求触发风控或限流".to_string())
        } else {
            trimmed.to_string()
        })
    } else {
        None
    }
}

fn parse_body(body_raw: &Value, body_text: &str) -> Value {
    match body_raw {
        Value::String(text) => {
            serde_json::from_str::<Value>(text).unwrap_or_else(|_| Value::String(text.clone()))
        }
        Value::Null if body_text.trim().is_empty() => Value::Null,
        value => value.clone(),
    }
}

fn error_message(payload: &Value, fallback: &str) -> String {
    if let Some(error) = payload.get("error") {
        if let Some(message) = error.get("message").and_then(Value::as_str) {
            return message.to_string();
        }
        if let Some(message) = error.as_str() {
            return message.to_string();
        }
    }
    payload
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or(fallback)
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::TcpListener,
        thread,
    };

    fn target(api_base: String) -> CpaTargetConfig {
        CpaTargetConfig {
            id: "main".to_string(),
            name: "Main".to_string(),
            api_base,
            enabled: true,
            has_management_key: true,
        }
    }

    fn serve_once(
        expected_request_prefix: &'static str,
        response_status: u16,
        response_body: &'static str,
    ) -> (String, thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock server");
        let address = listener.local_addr().expect("mock server address");
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept request");
            let mut buffer = [0u8; 8192];
            let size = stream.read(&mut buffer).expect("read request");
            let request = String::from_utf8_lossy(&buffer[..size]);
            assert!(
                request.starts_with(expected_request_prefix),
                "unexpected request: {request}"
            );
            assert!(
                request
                    .to_ascii_lowercase()
                    .contains("authorization: bearer secret"),
                "missing bearer auth header: {request}"
            );
            let reason = if response_status == 200 {
                "OK"
            } else {
                "Error"
            };
            write!(
                stream,
                "HTTP/1.1 {response_status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                response_body.len(),
                response_body
            )
            .expect("write response");
        });
        (format!("http://{address}"), handle)
    }

    #[tokio::test]
    async fn lists_auth_files_from_array_response() {
        let (api_base, handle) = serve_once(
            "GET /v0/management/auth-files HTTP/1.1",
            200,
            r#"[{"name":"Codex Plus","provider":"codex"}]"#,
        );
        let client = CpaClient::new(target(api_base), "secret".to_string(), 5).unwrap();

        let files = client.list_auth_files().await.unwrap();
        handle.join().unwrap();

        assert_eq!(files.len(), 1);
        assert_eq!(files[0]["provider"], "codex");
    }

    #[tokio::test]
    async fn parses_api_call_body_string() {
        let (api_base, handle) = serve_once(
            "POST /v0/management/api-call HTTP/1.1",
            200,
            r#"{"status_code":429,"body":"{\"error\":{\"message\":\"rate limit\"}}"}"#,
        );
        let client = CpaClient::new(target(api_base), "secret".to_string(), 5).unwrap();

        let result = client.api_call(json!({ "authIndex": "0" })).await.unwrap();
        handle.join().unwrap();

        assert_eq!(result.status_code, 429);
        assert_eq!(result.body["error"]["message"], "rate limit");
        assert_eq!(api_call_error_message(&result), "429 rate limit");
    }

    #[test]
    fn summarizes_cloudflare_html_errors() {
        let result = ApiCallResult {
            status_code: 403,
            body_text: r#"<html><body>Enable JavaScript and cookies to continue<script src="/cdn-cgi/challenge-platform"></script></body></html>"#.to_string(),
            body: Value::String("<html>challenge</html>".to_string()),
        };

        let message = api_call_error_message(&result);

        assert!(message.contains("Cloudflare challenge"));
        assert!(!message.contains("<html>"));
    }

    #[test]
    fn builds_codex_usage_request_headers() {
        let usage_request = codex_usage_request("7", Some("acct_123".to_string()), &Value::Null);
        let request = usage_request.payload;

        assert_eq!(request["method"], "GET");
        assert_eq!(request["url"], CODEX_USAGE_URL);
        assert_eq!(request["authIndex"], "7");
        assert_eq!(request["header"]["Chatgpt-Account-Id"], "acct_123");
        assert_eq!(request["header"]["Authorization"], "Bearer $TOKEN$");
        assert_eq!(request["header"]["Content-Type"], "application/json");
        assert_eq!(request["header"]["Accept"], "application/json");
        assert_eq!(request["header"]["Connection"], "Keep-Alive");
        assert_eq!(request["header"]["Originator"], CODEX_DEFAULT_ORIGINATOR);
        assert_eq!(request["header"]["User-Agent"], CODEX_DEFAULT_USER_AGENT);
        assert_eq!(usage_request.header_source, "default");
    }

    #[test]
    fn applies_codex_header_overrides_from_auth_file_metadata() {
        let usage_request = codex_usage_request(
            "7",
            None,
            &json!({
                "attributes": {
                    "header:User-Agent": "custom-codex/1.0",
                    "header:Accept-Language": "zh-CN"
                }
            }),
        );
        let request = usage_request.payload;

        assert_eq!(request["header"]["User-Agent"], "custom-codex/1.0");
        assert_eq!(request["header"]["Accept-Language"], "zh-CN");
        assert_eq!(request["header"]["Authorization"], "Bearer $TOKEN$");
        assert_eq!(usage_request.header_source, "cpa-metadata");
    }

    #[test]
    fn applies_codex_header_overrides_from_headers_object() {
        let usage_request = codex_usage_request(
            "7",
            None,
            &json!({
                "metadata": {
                    "headers": {
                        "User-Agent": "metadata-agent",
                        "X-Codex-Client": "neo"
                    }
                }
            }),
        );
        let request = usage_request.payload;

        assert_eq!(request["header"]["User-Agent"], "metadata-agent");
        assert_eq!(request["header"]["X-Codex-Client"], "neo");
        assert_eq!(usage_request.header_source, "cpa-metadata");
    }

    #[test]
    fn ignores_sensitive_codex_header_overrides() {
        let usage_request = codex_usage_request(
            "7",
            None,
            &json!({
                "attributes": {
                    "header:Authorization": "Bearer evil",
                    "header:Cookie": "session=1",
                    "header:User-Agent": "safe-agent"
                }
            }),
        );
        let request = usage_request.payload;

        assert_eq!(request["header"]["Authorization"], "Bearer $TOKEN$");
        assert!(request["header"]["Cookie"].is_null());
        assert_eq!(request["header"]["User-Agent"], "safe-agent");
        assert_eq!(usage_request.header_source, "cpa-metadata");
    }
}
