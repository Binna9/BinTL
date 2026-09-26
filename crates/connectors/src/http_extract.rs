use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use storage::LiveConnection;

use crate::extract::{with_sequence, with_sequence_header, ExtractOptions};
use crate::ConnectError;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HttpKv {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HttpRequestSpec {
    #[serde(default = "default_request_type")]
    pub request_type: String,
    #[serde(default = "default_method")]
    pub method: String,
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub query: Vec<HttpKv>,
    #[serde(default)]
    pub headers: Vec<HttpKv>,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default = "default_body_mode")]
    pub body_mode: String,
    #[serde(default)]
    pub form: Vec<HttpKv>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
    #[serde(default)]
    pub graphql_query: String,
    #[serde(default)]
    pub graphql_variables: Value,
    #[serde(default)]
    pub graphql_operation_name: String,
    #[serde(default)]
    pub records_path: String,
}

fn default_method() -> String {
    "GET".into()
}

fn default_request_type() -> String {
    "rest".into()
}

fn default_body_mode() -> String {
    "json".into()
}

#[derive(Debug, Clone)]
pub struct HttpPreview {
    pub status: u16,
    pub response: Value,
    pub columns: Vec<String>,
    pub rows: Vec<BTreeMap<String, String>>,
    pub row_count: usize,
    pub conversion_error: Option<String>,
}

pub fn parse_http_spec(raw: &str) -> Result<HttpRequestSpec, ConnectError> {
    let mut spec: HttpRequestSpec = serde_json::from_str(raw)
        .map_err(|error| ConnectError::Invalid(format!("invalid http source: {error}")))?;
    spec.method = spec.method.trim().to_ascii_uppercase();
    if spec.method.is_empty() {
        spec.method = "GET".into();
    }
    if !matches!(
        spec.method.as_str(),
        "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS"
    ) {
        return Err(ConnectError::Invalid(format!(
            "unsupported http method {}",
            spec.method
        )));
    }
    spec.request_type = spec.request_type.trim().to_ascii_lowercase();
    if spec.request_type.is_empty() {
        spec.request_type = "rest".into();
    }
    if !matches!(spec.request_type.as_str(), "rest" | "graphql") {
        return Err(ConnectError::Invalid(format!(
            "unsupported request type {}",
            spec.request_type
        )));
    }
    if spec.request_type == "graphql" && spec.graphql_query.trim().is_empty() {
        return Err(ConnectError::Invalid("graphql query required".into()));
    }
    spec.body_mode = spec.body_mode.trim().to_ascii_lowercase();
    if spec.body_mode.is_empty() {
        spec.body_mode = "json".into();
    }
    if !matches!(
        spec.body_mode.as_str(),
        "json" | "raw" | "urlencoded" | "multipart"
    ) {
        return Err(ConnectError::Invalid(format!(
            "unsupported body mode {}",
            spec.body_mode
        )));
    }
    Ok(spec)
}

pub async fn preview_http(
    connection: &LiveConnection,
    spec: &HttpRequestSpec,
    limit: usize,
) -> Result<HttpPreview, ConnectError> {
    let (status, value) = execute_http(connection, spec).await?;
    let limit = limit.clamp(1, 500);
    let converted = select_records(&value, &spec.records_path).and_then(|records| {
        let total = record_count(records);
        records_to_table(records, limit).map(|(columns, rows)| (total, columns, rows))
    });
    let (row_count, columns, rows, conversion_error) = match converted {
        Ok((total, columns, rows)) => (total, columns, rows, None),
        Err(error) => (0, Vec::new(), Vec::new(), Some(error.to_string())),
    };
    Ok(HttpPreview {
        status,
        response: value,
        columns,
        rows,
        row_count,
        conversion_error,
    })
}

pub async fn extract_http(
    connection: &LiveConnection,
    spec: &HttpRequestSpec,
    dest: &Path,
    opts: &ExtractOptions,
    mut on_progress: Option<&(dyn Fn(u64) + Send + Sync)>,
) -> Result<u64, ConnectError> {
    let (_status, value) = execute_http(connection, spec).await?;
    let records = select_records(&value, &spec.records_path)?;
    let (columns, rows) = records_to_table(records, record_count(records))?;
    let mut writer = csv::WriterBuilder::new()
        .delimiter(opts.delimiter)
        .quote(opts.quote)
        .from_path(dest)?;
    if opts.header {
        writer.write_record(&with_sequence_header(opts.add_sequence, columns.clone()))?;
    }
    let mut n = 0u64;
    for row in rows {
        n += 1;
        let fields = columns
            .iter()
            .map(|key| row.get(key).cloned().unwrap_or_default())
            .collect::<Vec<_>>();
        writer.write_record(&with_sequence(opts.add_sequence, n, fields))?;
        if let Some(cb) = on_progress.as_mut() {
            cb(n);
        }
    }
    writer.flush()?;
    Ok(n)
}

pub async fn ping_http(connection: &LiveConnection) -> Result<(), ConnectError> {
    let base = normalize_base_url(&connection.host)?;
    let client = http_client()?;
    let tokens = acquire_custom_tokens(&client, connection).await?;
    let mut request = apply_connection_auth(client.get(&base), connection);
    if let Some(tokens) = &tokens {
        request = apply_access_token(request, connection, &tokens.access);
    }
    let response = request
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|error| ConnectError::Invalid(format!("http request failed: {error}")))?;
    let status = response.status().as_u16();
    if status == 401 || status == 403 {
        return Err(ConnectError::Invalid(format!(
            "http status {status}: authentication failed"
        )));
    }
    Ok(())
}

async fn execute_http(
    connection: &LiveConnection,
    spec: &HttpRequestSpec,
) -> Result<(u16, Value), ConnectError> {
    let url = build_url(&connection.host, &spec.path, &spec.query)?;
    let client = http_client()?;
    let timeout =
        std::time::Duration::from_millis(spec.timeout_ms.unwrap_or(60_000).clamp(1_000, 300_000));
    let tokens = acquire_custom_tokens(&client, connection).await?;
    let mut response = send_http(&client, connection, spec, &url, timeout, tokens.as_ref()).await?;
    if response.status().as_u16() == 401 {
        if let Some(refreshed) = refresh_custom_tokens(&client, connection, tokens.as_ref()).await?
        {
            response =
                send_http(&client, connection, spec, &url, timeout, Some(&refreshed)).await?;
        }
    }
    read_json_response(response).await
}

async fn send_http(
    client: &reqwest::Client,
    connection: &LiveConnection,
    spec: &HttpRequestSpec,
    url: &str,
    timeout: std::time::Duration,
    tokens: Option<&TokenPair>,
) -> Result<reqwest::Response, ConnectError> {
    let mut request = apply_connection_auth(method_request(client, spec, url), connection);
    if let Some(tokens) = tokens {
        request = apply_access_token(request, connection, &tokens.access);
    }
    request = apply_spec_payload(request, spec);
    request
        .timeout(timeout)
        .send()
        .await
        .map_err(|error| ConnectError::Invalid(format!("http request failed: {error}")))
}

fn method_request(
    client: &reqwest::Client,
    spec: &HttpRequestSpec,
    url: &str,
) -> reqwest::RequestBuilder {
    match if spec.request_type == "graphql" {
        "POST"
    } else {
        spec.method.as_str()
    } {
        "POST" => client.post(url),
        "PUT" => client.put(url),
        "PATCH" => client.patch(url),
        "DELETE" => client.delete(url),
        "HEAD" => client.head(url),
        "OPTIONS" => client.request(reqwest::Method::OPTIONS, url),
        _ => client.get(url),
    }
}

fn apply_spec_payload(
    mut request: reqwest::RequestBuilder,
    spec: &HttpRequestSpec,
) -> reqwest::RequestBuilder {
    for header in &spec.headers {
        let name = header.name.trim();
        if name.is_empty() {
            continue;
        }
        request = request.header(name, header.value.as_str());
    }
    if spec.request_type == "graphql" {
        let mut payload = serde_json::json!({
            "query": spec.graphql_query,
            "variables": spec.graphql_variables,
        });
        if !spec.graphql_operation_name.trim().is_empty() {
            payload["operationName"] = Value::String(spec.graphql_operation_name.clone());
        }
        return request.json(&payload);
    }
    if !matches!(
        spec.method.as_str(),
        "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS"
    ) {
        return request;
    }
    let body = spec.body.clone().unwrap_or_default();
    match spec.body_mode.as_str() {
        "urlencoded" => {
            let fields = spec
                .form
                .iter()
                .filter(|item| !item.name.trim().is_empty())
                .map(|item| (item.name.as_str(), item.value.as_str()))
                .collect::<Vec<_>>();
            request.form(&fields)
        }
        "multipart" => {
            let form = spec
                .form
                .iter()
                .filter(|item| !item.name.trim().is_empty())
                .fold(reqwest::multipart::Form::new(), |form, item| {
                    form.text(item.name.clone(), item.value.clone())
                });
            request.multipart(form)
        }
        "raw" => {
            if body.trim().is_empty() {
                request
            } else {
                request.body(body)
            }
        }
        _ => {
            if body.trim().is_empty() {
                request
            } else {
                request
                    .header(reqwest::header::CONTENT_TYPE, "application/json")
                    .body(body)
            }
        }
    }
}

async fn read_json_response(response: reqwest::Response) -> Result<(u16, Value), ConnectError> {
    let status = response.status().as_u16();
    let text = response
        .text()
        .await
        .map_err(|error| ConnectError::Invalid(format!("http body read failed: {error}")))?;
    if !(200..300).contains(&status) {
        return Err(ConnectError::Invalid(format!(
            "http status {status}: {}",
            truncate(&text, 240)
        )));
    }
    if text.trim().is_empty() {
        return Ok((status, Value::Array(Vec::new())));
    }
    let value: Value = serde_json::from_str(&text)
        .map_err(|error| ConnectError::Invalid(format!("response is not JSON: {error}")))?;
    Ok((status, value))
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum StaticAuth {
    None,
    Bearer(String),
    Basic { user: String, password: String },
    ApiKeyHeader { name: String, value: String },
    ApiKeyQuery { name: String, value: String },
}

#[derive(Debug, Clone)]
struct TokenPair {
    access: String,
    refresh: Option<String>,
}

fn resolved_auth_mode(connection: &LiveConnection) -> String {
    if let Some(auth) = &connection.http_auth {
        let mode = auth.mode.trim().to_ascii_lowercase();
        if !mode.is_empty() {
            return mode;
        }
    }
    let user = connection.username.trim();
    let secret = connection.password.trim();
    if secret.is_empty() {
        "none".into()
    } else if user.is_empty() {
        "bearer".into()
    } else {
        "basic".into()
    }
}

fn static_auth(connection: &LiveConnection) -> StaticAuth {
    let secret = connection.password.trim();
    match resolved_auth_mode(connection).as_str() {
        "bearer" if !secret.is_empty() => StaticAuth::Bearer(secret.to_string()),
        "basic" => StaticAuth::Basic {
            user: connection.username.trim().to_string(),
            password: connection.password.clone(),
        },
        "api_key" if !secret.is_empty() => {
            let auth = connection.http_auth.as_ref();
            let name = auth
                .map(|item| item.api_key_name.trim())
                .filter(|name| !name.is_empty())
                .unwrap_or("X-API-Key")
                .to_string();
            let value = secret.to_string();
            if auth.map(|item| item.api_key_location.as_str()) == Some("query") {
                StaticAuth::ApiKeyQuery { name, value }
            } else {
                StaticAuth::ApiKeyHeader { name, value }
            }
        }
        _ => StaticAuth::None,
    }
}

fn apply_connection_auth(
    request: reqwest::RequestBuilder,
    connection: &LiveConnection,
) -> reqwest::RequestBuilder {
    match static_auth(connection) {
        StaticAuth::None => request,
        StaticAuth::Bearer(token) => request.bearer_auth(token),
        StaticAuth::Basic { user, password } => request.basic_auth(user, Some(password)),
        StaticAuth::ApiKeyHeader { name, value } => request.header(name, value),
        StaticAuth::ApiKeyQuery { name, value } => request.query(&[(name, value)]),
    }
}

fn apply_access_token(
    request: reqwest::RequestBuilder,
    connection: &LiveConnection,
    token: &str,
) -> reqwest::RequestBuilder {
    let auth = connection.http_auth.as_ref();
    let header = auth
        .map(|item| item.token_header.trim())
        .filter(|name| !name.is_empty())
        .unwrap_or("Authorization");
    let prefix = auth
        .map(|item| item.token_prefix.trim())
        .unwrap_or("Bearer");
    let value = if prefix.is_empty() {
        token.to_string()
    } else {
        format!("{prefix} {token}")
    };
    request.header(header, value)
}

// ponytail: login on every custom request. Cache/reuse tokens if a vendor rate-limits login.
async fn acquire_custom_tokens(
    client: &reqwest::Client,
    connection: &LiveConnection,
) -> Result<Option<TokenPair>, ConnectError> {
    if resolved_auth_mode(connection) != "custom" {
        return Ok(None);
    }
    Ok(Some(login_tokens(client, connection).await?))
}

async fn refresh_custom_tokens(
    client: &reqwest::Client,
    connection: &LiveConnection,
    tokens: Option<&TokenPair>,
) -> Result<Option<TokenPair>, ConnectError> {
    let Some(tokens) = tokens else {
        return Ok(None);
    };
    let Some(refresh) = tokens.refresh.as_deref().filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let Some(auth) = connection.http_auth.as_ref() else {
        return Ok(None);
    };
    if auth.refresh_path.trim().is_empty() {
        return Ok(None);
    }
    Ok(Some(refresh_tokens(client, connection, refresh).await?))
}

async fn login_tokens(
    client: &reqwest::Client,
    connection: &LiveConnection,
) -> Result<TokenPair, ConnectError> {
    let auth = connection
        .http_auth
        .as_ref()
        .ok_or_else(|| ConnectError::Invalid("HTTP login settings required".into()))?;
    let url = build_url(&connection.host, &auth.login_path, &[])?;
    let user = connection.username.trim();
    let password = connection.password.as_str();
    let mut request = client.post(&url);
    request = match auth.login_body_mode.as_str() {
        "urlencoded" => request.form(&[
            (auth.username_field.trim(), user),
            (auth.password_field.trim(), password),
        ]),
        _ => {
            let mut body = serde_json::json!({});
            set_json_path(
                &mut body,
                &auth.username_field,
                Value::String(user.to_string()),
            )?;
            set_json_path(
                &mut body,
                &auth.password_field,
                Value::String(password.to_string()),
            )?;
            request.json(&body)
        }
    };
    let value = send_auth_json(request, "login").await?;
    tokens_from_login(auth, &value)
}

async fn refresh_tokens(
    client: &reqwest::Client,
    connection: &LiveConnection,
    refresh: &str,
) -> Result<TokenPair, ConnectError> {
    let auth = connection
        .http_auth
        .as_ref()
        .ok_or_else(|| ConnectError::Invalid("HTTP login settings required".into()))?;
    let url = build_url(&connection.host, &auth.refresh_path, &[])?;
    let field = auth.refresh_field.trim();
    let mut request = client.post(&url);
    request = match auth.refresh_body_mode.as_str() {
        "header" => request.header(field, refresh),
        "urlencoded" => request.form(&[(field, refresh)]),
        _ => request.json(&serde_json::json!({ field: refresh })),
    };
    let value = send_auth_json(request, "refresh").await?;
    let access = json_string_at(&value, &auth.access_token_path)?;
    let next_refresh = json_string_at(&value, &auth.refresh_token_path)
        .ok()
        .or_else(|| Some(refresh.to_string()));
    Ok(TokenPair {
        access,
        refresh: next_refresh,
    })
}

fn tokens_from_login(
    auth: &storage::HttpAuthConfig,
    value: &Value,
) -> Result<TokenPair, ConnectError> {
    let access = json_string_at(value, &auth.access_token_path)?;
    let refresh =
        if auth.refresh_path.trim().is_empty() || auth.refresh_token_path.trim().is_empty() {
            None
        } else {
            json_string_at(value, &auth.refresh_token_path).ok()
        };
    Ok(TokenPair { access, refresh })
}

async fn send_auth_json(
    request: reqwest::RequestBuilder,
    kind: &str,
) -> Result<Value, ConnectError> {
    let response = request
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|error| ConnectError::Invalid(format!("http {kind} failed: {error}")))?;
    let status = response.status().as_u16();
    let text = response
        .text()
        .await
        .map_err(|error| ConnectError::Invalid(format!("http {kind} body read failed: {error}")))?;
    if !(200..300).contains(&status) {
        return Err(ConnectError::Invalid(format!(
            "http {kind} status {status}: {}",
            truncate(&text, 240)
        )));
    }
    serde_json::from_str(&text)
        .map_err(|error| ConnectError::Invalid(format!("http {kind} is not JSON: {error}")))
}

fn json_at<'a>(value: &'a Value, path: &str) -> Option<&'a Value> {
    let path = path.trim().trim_start_matches('$').trim_start_matches('.');
    if path.is_empty() {
        return Some(value);
    }
    let mut cursor = value;
    for part in path.split('.').filter(|part| !part.is_empty()) {
        cursor = cursor.get(part)?;
    }
    Some(cursor)
}

fn json_string_at(value: &Value, path: &str) -> Result<String, ConnectError> {
    match json_at(value, path) {
        Some(Value::String(text)) if !text.is_empty() => Ok(text.clone()),
        Some(Value::Number(number)) => Ok(number.to_string()),
        Some(_) => Err(ConnectError::Invalid(format!(
            "token path is not a string: {path}"
        ))),
        None => Err(ConnectError::Invalid(format!(
            "token path not found: {path}"
        ))),
    }
}

fn set_json_path(root: &mut Value, path: &str, value: Value) -> Result<(), ConnectError> {
    let parts: Vec<&str> = path
        .trim()
        .split('.')
        .filter(|part| !part.is_empty())
        .collect();
    if parts.is_empty() {
        return Err(ConnectError::Invalid("JSON field path required".into()));
    }
    let mut cursor = root;
    for (index, part) in parts.iter().enumerate() {
        if index + 1 == parts.len() {
            if !cursor.is_object() {
                *cursor = serde_json::json!({});
            }
            cursor[*part] = value;
            return Ok(());
        }
        if !cursor.get(*part).map(Value::is_object).unwrap_or(false) {
            cursor[*part] = serde_json::json!({});
        }
        cursor = cursor
            .get_mut(*part)
            .ok_or_else(|| ConnectError::Invalid("JSON field path required".into()))?;
    }
    Ok(())
}

fn http_client() -> Result<reqwest::Client, ConnectError> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|error| ConnectError::Invalid(format!("http client: {error}")))
}

fn normalize_base_url(host: &str) -> Result<String, ConnectError> {
    let host = host.trim().trim_end_matches('/');
    if host.is_empty() {
        return Err(ConnectError::Invalid("http base URL required".into()));
    }
    if host.starts_with("http://") || host.starts_with("https://") {
        return Ok(host.to_string());
    }
    Ok(format!("https://{host}"))
}

fn build_url(base: &str, path: &str, query: &[HttpKv]) -> Result<String, ConnectError> {
    let base = normalize_base_url(base)?;
    let path = path.trim();
    let joined = if path.is_empty() {
        base
    } else if path.starts_with("http://") || path.starts_with("https://") {
        path.trim_end_matches('/').to_string()
    } else if path.starts_with('/') {
        format!("{base}{path}")
    } else {
        format!("{base}/{path}")
    };
    let mut url = reqwest::Url::parse(&joined)
        .map_err(|error| ConnectError::Invalid(format!("invalid url: {error}")))?;
    {
        let mut pairs = url.query_pairs_mut();
        for item in query {
            let name = item.name.trim();
            if name.is_empty() {
                continue;
            }
            pairs.append_pair(name, item.value.as_str());
        }
    }
    Ok(url.to_string())
}

fn select_records<'a>(value: &'a Value, records_path: &str) -> Result<&'a Value, ConnectError> {
    let path = records_path
        .trim()
        .trim_start_matches('$')
        .trim_start_matches('.');
    if path.is_empty() {
        return Ok(value);
    }
    let mut cursor = value;
    for part in path.split('.').filter(|part| !part.is_empty()) {
        cursor = cursor.get(part).ok_or_else(|| {
            ConnectError::Invalid(format!("records_path not found: {records_path}"))
        })?;
    }
    Ok(cursor)
}

fn record_count(value: &Value) -> usize {
    match value {
        Value::Array(items) => items.len(),
        Value::Object(_) => 1,
        _ => 0,
    }
}

fn records_to_table(
    value: &Value,
    limit: usize,
) -> Result<(Vec<String>, Vec<BTreeMap<String, String>>), ConnectError> {
    let items: Vec<&Value> = match value {
        Value::Array(items) => items.iter().collect(),
        Value::Object(_) => vec![value],
        other => {
            return Err(ConnectError::Invalid(format!(
                "records_path must point to an array or object, got {other}"
            )))
        }
    };
    let mut columns = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for item in items.iter().take(limit.max(1)) {
        match item {
            Value::Object(map) => {
                for key in map.keys() {
                    if seen.insert(key.clone()) {
                        columns.push(key.clone());
                    }
                }
            }
            _ => {
                if seen.insert("value".into()) {
                    columns.push("value".into());
                }
            }
        }
    }
    if columns.is_empty() {
        columns.push("value".into());
    }
    let mut rows = Vec::new();
    for item in items.into_iter().take(limit) {
        let mut row = BTreeMap::new();
        match item {
            Value::Object(map) => {
                for key in &columns {
                    row.insert(key.clone(), json_cell(map.get(key)));
                }
            }
            other => {
                row.insert("value".into(), json_cell(Some(other)));
            }
        }
        rows.push(row);
    }
    Ok((columns, rows))
}

fn json_cell(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(text)) => text.clone(),
        Some(Value::Bool(flag)) => flag.to_string(),
        Some(Value::Number(number)) => number.to_string(),
        Some(other) => other.to_string(),
    }
}

fn truncate(text: &str, max: usize) -> String {
    let compact = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if compact.chars().count() <= max {
        return compact;
    }
    let cut: String = compact.chars().take(max).collect();
    format!("{cut}…")
}

#[cfg(test)]
mod tests {
    use super::*;
    use storage::{HttpAuthConfig, LiveConnection};

    fn live(username: &str, password: &str, http_auth: Option<HttpAuthConfig>) -> LiveConnection {
        LiveConnection {
            http_auth,
            id: "c1".into(),
            name: "api".into(),
            driver: "http".into(),
            host: "https://api.example.com".into(),
            port: 0,
            database: String::new(),
            username: username.into(),
            password: password.into(),
            ssl: true,
        }
    }

    #[test]
    fn legacy_auth_is_inferred() {
        assert_eq!(resolved_auth_mode(&live("", "", None)), "none");
        assert_eq!(resolved_auth_mode(&live("", "tok", None)), "bearer");
        assert_eq!(resolved_auth_mode(&live("user", "secret", None)), "basic");
        assert_eq!(
            static_auth(&live("", "tok", None)),
            StaticAuth::Bearer("tok".into())
        );
        assert_eq!(
            static_auth(&live("user", "secret", None)),
            StaticAuth::Basic {
                user: "user".into(),
                password: "secret".into()
            }
        );
    }

    #[test]
    fn explicit_mode_wins_over_legacy_guess() {
        let none = HttpAuthConfig {
            mode: "none".into(),
            ..Default::default()
        };
        assert_eq!(
            static_auth(&live("user", "secret", Some(none))),
            StaticAuth::None
        );
        let bearer = HttpAuthConfig {
            mode: "bearer".into(),
            ..Default::default()
        };
        assert_eq!(
            static_auth(&live("user", "tok", Some(bearer))),
            StaticAuth::Bearer("tok".into())
        );
        let key = HttpAuthConfig {
            mode: "api_key".into(),
            api_key_name: "X-Key".into(),
            api_key_location: "query".into(),
            ..Default::default()
        };
        assert_eq!(
            static_auth(&live("", "abc", Some(key))),
            StaticAuth::ApiKeyQuery {
                name: "X-Key".into(),
                value: "abc".into()
            }
        );
        let custom = HttpAuthConfig {
            mode: "custom".into(),
            ..Default::default()
        };
        assert_eq!(
            static_auth(&live("user", "secret", Some(custom))),
            StaticAuth::None
        );
    }

    #[test]
    fn json_paths_read_and_write_nested_fields() {
        let value = serde_json::json!({"data": {"accessToken": "tok", "n": 7}});
        assert_eq!(json_string_at(&value, "data.accessToken").unwrap(), "tok");
        assert_eq!(json_string_at(&value, "data.n").unwrap(), "7");
        assert!(json_string_at(&value, "data.missing").is_err());
        let mut body = serde_json::json!({});
        set_json_path(&mut body, "user.email", Value::String("a@b.c".into())).unwrap();
        assert_eq!(body["user"]["email"], "a@b.c");
    }
}
