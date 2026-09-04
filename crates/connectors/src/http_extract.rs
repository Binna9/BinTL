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
    #[serde(default)]
    pub records_path: String,
}

fn default_method() -> String {
    "GET".into()
}

#[derive(Debug, Clone)]
pub struct HttpPreview {
    pub status: u16,
    pub columns: Vec<String>,
    pub rows: Vec<BTreeMap<String, String>>,
    pub row_count: usize,
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
        "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
    ) {
        return Err(ConnectError::Invalid(format!(
            "unsupported http method {}",
            spec.method
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
    let records = select_records(&value, &spec.records_path)?;
    let total = record_count(records);
    let limit = limit.clamp(1, 500);
    let (columns, rows) = records_to_table(records, limit)?;
    Ok(HttpPreview {
        status,
        columns,
        rows,
        row_count: total,
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
    let response = client
        .get(base)
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|error| ConnectError::Invalid(format!("http request failed: {error}")))?;
    // Any HTTP response means the host is reachable enough for a connection test.
    let _ = response.status();
    Ok(())
}

async fn execute_http(
    connection: &LiveConnection,
    spec: &HttpRequestSpec,
) -> Result<(u16, Value), ConnectError> {
    let url = build_url(&connection.host, &spec.path, &spec.query)?;
    let client = http_client()?;
    let mut request = match spec.method.as_str() {
        "POST" => client.post(&url),
        "PUT" => client.put(&url),
        "PATCH" => client.patch(&url),
        "DELETE" => client.delete(&url),
        _ => client.get(&url),
    };
    request = apply_connection_auth(request, connection);
    for header in &spec.headers {
        let name = header.name.trim();
        if name.is_empty() {
            continue;
        }
        request = request.header(name, header.value.as_str());
    }
    if matches!(spec.method.as_str(), "POST" | "PUT" | "PATCH") {
        let body = spec.body.clone().unwrap_or_default();
        if !body.trim().is_empty() {
            request = request
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .body(body);
        }
    }
    let response = request
        .timeout(std::time::Duration::from_secs(60))
        .send()
        .await
        .map_err(|error| ConnectError::Invalid(format!("http request failed: {error}")))?;
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

fn apply_connection_auth(
    request: reqwest::RequestBuilder,
    connection: &LiveConnection,
) -> reqwest::RequestBuilder {
    let user = connection.username.trim();
    let secret = connection.password.trim();
    if secret.is_empty() {
        return request;
    }
    if user.is_empty() {
        request.bearer_auth(secret)
    } else {
        request.basic_auth(user, Some(secret))
    }
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
    let path = records_path.trim().trim_start_matches('$').trim_start_matches('.');
    if path.is_empty() {
        return Ok(value);
    }
    let mut cursor = value;
    for part in path.split('.').filter(|part| !part.is_empty()) {
        cursor = cursor
            .get(part)
            .ok_or_else(|| ConnectError::Invalid(format!("records_path not found: {records_path}")))?;
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
