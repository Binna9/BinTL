use axum::extract::{Path, Query, State};
use axum::http::header::{AUTHORIZATION, CONTENT_TYPE};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use engine::{PolarsEngine, TransformSpec};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::access::{self, CurrentUser};
use crate::error::AppError;
use crate::state::AppState;
use storage::{ChipRow, Store};

const DEFAULT_LIMIT: usize = 10_000;
const MAX_LIMIT: usize = 100_000;

pub fn public_routes() -> Router<AppState> {
    Router::new().route("/p/{slug}", get(publish))
}

#[derive(Debug, Deserialize)]
struct ServeQuery {
    format: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
}

#[derive(Debug, Clone)]
pub struct ServeConfig {
    pub slug: String,
    pub api_key_hash: String,
    pub freshness: String,
}

pub fn generate_api_key() -> String {
    format!(
        "btl_{}",
        Uuid::new_v4().simple().to_string() + &Uuid::new_v4().simple().to_string()
    )
}

pub fn hash_api_key(key: &str) -> String {
    hex::encode(Sha256::digest(key.trim().as_bytes()))
}

pub fn normalize_slug(raw: &str) -> Result<String, AppError> {
    let slug = raw.trim();
    if slug.is_empty() {
        return Err(AppError::bad("path name required"));
    }
    if slug.len() > 64 {
        return Err(AppError::bad("path name must be 64 characters or fewer"));
    }
    if slug == "." || slug == ".." {
        return Err(AppError::bad("invalid path name"));
    }
    if slug
        .chars()
        .any(|ch| ch.is_whitespace() || matches!(ch, '/' | '\\' | '?' | '#' | '&' | '=' | '%'))
    {
        return Err(AppError::bad(
            "path name cannot contain spaces or / \\ ? # & = %",
        ));
    }
    Ok(slug.to_string())
}

pub fn redact_config(config: &mut Value) {
    let has_key = config
        .get("api_key_hash")
        .and_then(Value::as_str)
        .is_some_and(|value| !value.is_empty());
    let slug = config
        .get("slug")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if let Some(object) = config.as_object_mut() {
        object.remove("api_key");
        object.remove("api_key_hash");
        object.insert("has_api_key".into(), json!(has_key));
        if !slug.is_empty() {
            object.insert("public_path".into(), json!(format!("/p/{slug}")));
        }
    }
}

pub fn parse_serve_config(config: &Value) -> Result<ServeConfig, AppError> {
    let slug = normalize_slug(config.get("slug").and_then(Value::as_str).unwrap_or(""))?;
    let api_key_hash = config
        .get("api_key_hash")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if api_key_hash.is_empty() {
        return Err(AppError::bad("API key is not configured"));
    }
    let freshness = match config
        .get("freshness")
        .and_then(Value::as_str)
        .unwrap_or("slot")
        .trim()
    {
        "live" => "live",
        "slot" | "" => "slot",
        _ => return Err(AppError::bad("freshness must be slot or live")),
    };
    Ok(ServeConfig {
        slug,
        api_key_hash,
        freshness: freshness.into(),
    })
}

pub async fn validate_serve_config(
    store: &Store,
    chip_id: Option<&str>,
    incoming: Value,
    existing: Option<&Value>,
    generate_if_missing: bool,
) -> Result<(Value, Option<String>), AppError> {
    let slug = normalize_slug(incoming.get("slug").and_then(Value::as_str).unwrap_or(""))?;
    let freshness = match incoming
        .get("freshness")
        .and_then(Value::as_str)
        .or_else(|| existing.and_then(|value| value.get("freshness").and_then(Value::as_str)))
        .unwrap_or("slot")
        .trim()
    {
        "live" => "live",
        "slot" | "" => "slot",
        _ => return Err(AppError::bad("freshness must be slot or live")),
    };
    ensure_slug_unique(store, &slug, chip_id).await?;
    let provided = incoming
        .get("api_key")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let existing_hash = existing
        .and_then(|value| value.get("api_key_hash").and_then(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let (api_key_hash, revealed) = if let Some(key) = provided {
        (hash_api_key(key), Some(key.to_string()))
    } else if let Some(hash) = existing_hash {
        (hash.to_string(), None)
    } else if generate_if_missing {
        let key = generate_api_key();
        (hash_api_key(&key), Some(key))
    } else {
        return Err(AppError::bad("API key is not configured"));
    };
    Ok((
        json!({
            "slug": slug,
            "api_key_hash": api_key_hash,
            "freshness": freshness,
        }),
        revealed,
    ))
}

async fn ensure_slug_unique(
    store: &Store,
    slug: &str,
    chip_id: Option<&str>,
) -> Result<(), AppError> {
    // ponytail: O(n) scan of serve chips. Add a unique slug column if this grows.
    for (id, raw) in store.list_serve_chip_configs().await? {
        if chip_id.is_some_and(|chip_id| chip_id == id) {
            continue;
        }
        let Some(raw) = raw else {
            continue;
        };
        let Ok(config) = serde_json::from_str::<Value>(&raw) else {
            continue;
        };
        let other = config
            .get("slug")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        if other == slug {
            return Err(AppError::conflict("path name already in use"));
        }
    }
    Ok(())
}

fn provided_api_key(headers: &HeaderMap) -> Option<String> {
    if let Some(value) = headers.get("x-api-key").and_then(|value| value.to_str().ok()) {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    let auth = headers.get(AUTHORIZATION)?.to_str().ok()?.trim();
    let token = auth
        .strip_prefix("Bearer ")
        .or_else(|| auth.strip_prefix("bearer "))
        .unwrap_or(auth)
        .trim();
    if token.is_empty() {
        None
    } else {
        Some(token.to_string())
    }
}

fn hash_eq(left: &str, right: &str) -> bool {
    let left = left.as_bytes();
    let right = right.as_bytes();
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right.iter())
        .fold(0u8, |acc, (a, b)| acc | (a ^ b))
        == 0
}

async fn find_serve_chip(store: &Store, slug: &str) -> Result<Option<(ChipRow, ServeConfig)>, AppError> {
    let slug = normalize_slug(slug)?;
    let mut found = None;
    for (id, raw) in store.list_serve_chip_configs().await? {
        let Some(raw) = raw else {
            continue;
        };
        let Ok(config) = serde_json::from_str::<Value>(&raw) else {
            continue;
        };
        let Ok(parsed) = parse_serve_config(&config) else {
            continue;
        };
        if parsed.slug != slug {
            continue;
        }
        let Some(chip) = store.get_chip(&id).await? else {
            continue;
        };
        if chip.active == 0 {
            continue;
        }
        found = Some((chip, parsed));
        break;
    }
    Ok(found)
}

async fn publish(
    State(state): State<AppState>,
    Path(slug): Path<String>,
    Query(query): Query<ServeQuery>,
    headers: HeaderMap,
) -> Result<Response, AppError> {
    let key = provided_api_key(&headers).ok_or_else(AppError::unauthorized)?;
    let (chip, config) = find_serve_chip(&state.store, &slug)
        .await?
        .ok_or_else(|| AppError::not_found("path not found"))?;
    if !hash_eq(&hash_api_key(&key), &config.api_key_hash) {
        return Err(AppError::unauthorized());
    }
    let workspace_id = state
        .store
        .chip_workspace_hint(&chip.id)
        .await?
        .ok_or_else(|| AppError::conflict("API chip is not placed on a workspace"))?;
    let edges = state.store.list_chip_edges(&workspace_id).await?;
    let incoming = edges
        .into_iter()
        .find(|edge| edge.kind == "data" && edge.to_chip_id == chip.id)
        .ok_or_else(|| AppError::conflict("API chip is not connected"))?;
    let source = state
        .store
        .get_chip(&incoming.from_chip_id)
        .await?
        .ok_or_else(|| AppError::not_found("source chip not found"))?;
    if config.freshness == "live" && source.kind == "extract" {
        let owner = state
            .store
            .get_user(&chip.owner_user_id)
            .await?
            .ok_or_else(|| AppError::not_found("chip owner not found"))?;
        crate::chip::run_extract_chip_sync(&state, &CurrentUser(owner), &workspace_id, &source.id)
            .await?;
    }
    let dataset_id = state
        .store
        .latest_chip_output_for_workspace(&workspace_id, &source.id)
        .await?
        .ok_or_else(|| AppError::conflict("source chip has not run"))?;
    let dataset = state
        .store
        .get_dataset(&dataset_id)
        .await?
        .ok_or_else(|| AppError::not_found("dataset not found"))?;
    if dataset.status != "materialized" || dataset.stored_path.trim().is_empty() {
        return Err(AppError::conflict("source chip has not run"));
    }
    let path = state.store.resolve(&dataset.stored_path);
    if !path.is_file() {
        return Err(AppError::conflict("source chip has not run"));
    }
    let offset = query.offset.unwrap_or(0).max(0) as usize;
    let limit = query
        .limit
        .unwrap_or(DEFAULT_LIMIT as i64)
        .clamp(1, MAX_LIMIT as i64) as usize;
    let delimiter = dataset.delimiter.clone();
    let has_header = dataset.has_header.map(|value| value != 0);
    let take = offset.saturating_add(limit).max(1);
    let preview = tokio::task::spawn_blocking(move || {
        let spec = TransformSpec::identity().with_read(delimiter, has_header);
        PolarsEngine.inspect(&path, &spec, take)
    })
    .await
    .map_err(|error| AppError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))??;
    let columns: Vec<String> = preview.columns.iter().map(|column| column.name.clone()).collect();
    let rows: Vec<Vec<String>> = preview.rows.into_iter().skip(offset).take(limit).collect();
    let row_count = preview.row_count.unwrap_or(preview.sampled_rows as u64);
    let truncated = preview.truncated || offset + rows.len() < row_count as usize;
    let csv = query
        .format
        .as_deref()
        .is_some_and(|value| value.eq_ignore_ascii_case("csv"));
    if csv {
        let mut out = String::new();
        out.push_str(&csv_row(&columns));
        for row in &rows {
            out.push_str(&csv_row(row));
        }
        let mut response = out.into_response();
        response.headers_mut().insert(
            CONTENT_TYPE,
            HeaderValue::from_static("text/csv; charset=utf-8"),
        );
        return Ok(response);
    }
    let objects: Vec<Value> = rows
        .iter()
        .map(|row| {
            let mut object = Map::new();
            for (index, name) in columns.iter().enumerate() {
                object.insert(name.clone(), json!(row.get(index).cloned().unwrap_or_default()));
            }
            Value::Object(object)
        })
        .collect();
    Ok(Json(json!({
        "name": config.slug,
        "as_of": dataset.updated_at,
        "columns": columns,
        "rows": objects,
        "row_count": row_count,
        "offset": offset,
        "limit": limit,
        "truncated": truncated,
    }))
    .into_response())
}

fn csv_row(fields: &[String]) -> String {
    let mut line = String::new();
    for (index, field) in fields.iter().enumerate() {
        if index > 0 {
            line.push(',');
        }
        if field.contains([',', '"', '\n', '\r']) {
            line.push('"');
            line.push_str(&field.replace('"', "\"\""));
            line.push('"');
        } else {
            line.push_str(field);
        }
    }
    line.push('\n');
    line
}

pub async fn queue_serve_chip_run(
    state: &AppState,
    user: &CurrentUser,
    chip: &ChipRow,
    workspace_id: &str,
    execution_id: Option<&str>,
) -> Result<storage::ChipRunRow, AppError> {
    access::require_workspace(&state.store, user, workspace_id).await?;
    if chip.active == 0 {
        return Err(AppError::conflict("chip is inactive"));
    }
    let raw = state
        .store
        .resolve_chip_config_json(chip)
        .await
        .map_err(|error| AppError::bad(error.to_string()))?;
    let config: Value = serde_json::from_str(&raw)
        .map_err(|error| AppError::bad(format!("stored chip config is invalid: {error}")))?;
    parse_serve_config(&config)?;
    let run = if let Some(execution_id) = execution_id {
        state
            .store
            .create_chip_run_in_execution(
                &chip.id,
                workspace_id,
                chip.revision,
                &raw,
                None,
                Some(execution_id),
            )
            .await?
    } else {
        state
            .store
            .create_chip_run(&chip.id, workspace_id, chip.revision, &raw, None)
            .await?
    };
    finish_serve_run(state, &run.id, &config).await?;
    state
        .store
        .get_chip_run(&run.id)
        .await?
        .ok_or_else(|| AppError::not_found("chip run disappeared"))
}

pub async fn finish_serve_run(state: &AppState, run_id: &str, config: &Value) -> Result<(), AppError> {
    let slug = config
        .get("slug")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let result = json!({ "slug": slug, "path": format!("/p/{slug}") }).to_string();
    match state.store.set_chip_run_running(run_id).await {
        Ok(()) => state
            .store
            .set_chip_run_succeeded_with_result(run_id, Some(&result), None)
            .await?,
        Err(_) => {
            let run = state
                .store
                .get_chip_run(run_id)
                .await?
                .ok_or_else(|| AppError::not_found("chip run disappeared"))?;
            if run.status != "running" && run.status != "succeeded" {
                return Err(AppError::conflict("chip run must be queued before starting"));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slug_and_key_hash_are_stable() {
        assert!(normalize_slug("주문목록").is_ok());
        assert!(normalize_slug("orders-v2").is_ok());
        assert!(normalize_slug("has space").is_err());
        assert!(normalize_slug("a/b").is_err());
        assert!(normalize_slug("").is_err());
        let key = "btl_secret";
        assert_eq!(hash_api_key(key), hash_api_key(" btl_secret "));
        assert_ne!(hash_api_key(key), hash_api_key("other"));
        assert!(hash_eq(&hash_api_key(key), &hash_api_key(key)));
        assert!(!hash_eq(&hash_api_key(key), &hash_api_key("other")));
    }
}
