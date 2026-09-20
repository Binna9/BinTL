use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use connectors::{
    extract_query, extract_table, load_table, normalize_sql, normalize_sql_script, parse_delimiter,
    parse_http_spec, parse_ident, parse_table, run_sql_script, sniff_delimiter, sql_kind,
    table_select_sql, with_database,
    ExtractOptions, HttpKv, HttpRequestSpec, SqlKind,
};
use engine::{Engine, PolarsEngine, TransformSpec, ValidationSpec};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use storage::{
    ChipRow, ChipRunRow, DatasetUpsert, RegisterExtractChip, RegisterLoadChip,
    RegisterTransformChip, Store,
};
use tokio::sync::Notify;

use crate::access::{self, CurrentUser};
use crate::error::AppError;
use crate::state::AppState;

const LOAD_NULL_MARKER: &str = "\u{1e}BINTL_NULL\u{1e}";

mod workspace_execution;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/chips", get(list_catalog).post(register_chip))
        .route(
            "/api/workspaces/{id}/chips",
            get(list_chips).post(create_chip),
        )
        .route(
            "/api/chips/{id}",
            get(get_chip).patch(update_chip).delete(delete_chip),
        )
        .route("/api/chips/{id}/run", post(run_chip))
        .route("/api/workspaces/{id}/run", post(run_workspace))
        .route("/api/workspaces/{id}/runs", get(list_runs))
        .route("/api/workspaces/{id}/executions", get(list_workspace_runs))
        .route(
            "/api/workspaces/{id}/executions/{execution_id}/cancel",
            post(cancel_workspace_run),
        )
        .route("/api/chip-runs/{id}", get(get_run))
        .route("/api/chip-runs/{id}/cancel", post(cancel_chip_run))
        .route("/api/chip-runs/{id}/logs", get(get_run_logs))
        .route(
            "/api/workspaces/{id}/chips/{chip_id}/input-slot",
            get(get_input_slot),
        )
}

#[derive(Deserialize)]
struct CreateChipBody {
    name: String,
    kind: String,
    config: Value,
}

#[derive(Deserialize)]
struct PatchChipBody {
    name: Option<String>,
    kind: Option<String>,
    config: Option<Value>,
    active: Option<bool>,
    #[serde(default)]
    extract: Option<Value>,
    #[serde(default)]
    output_filename: Option<String>,
}

#[derive(Deserialize)]
struct RunChipBody {
    workspace_id: String,
    #[serde(default)]
    input_dataset_id: Option<String>,
}

#[derive(Deserialize)]
struct RegisterChipBody {
    name: String,
    kind: String,
    #[serde(default)]
    workspace_id: Option<String>,
    #[serde(default)]
    place_on_workspace: bool,
    /// Queue a workspace run after register. Defaults to true when `place_on_workspace`.
    #[serde(default)]
    run_after: Option<bool>,
    #[serde(default)]
    extract: Option<Value>,
    #[serde(default)]
    transform_id: Option<String>,
    #[serde(default)]
    load_definition_id: Option<String>,
    #[serde(default)]
    output_filename: Option<String>,
    #[serde(default)]
    config: Option<Value>,
}

#[derive(Debug, Deserialize)]
struct ExtractConfig {
    #[serde(default)]
    connection_id: String,
    #[serde(default)]
    source: ExtractSource,
    #[serde(default)]
    delimiter: Option<String>,
    #[serde(default)]
    header: Option<bool>,
    #[serde(default)]
    add_sequence: Option<bool>,
    #[serde(default)]
    output_filename: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ExtractSource {
    Table {
        #[serde(default)]
        table: String,
        #[serde(default)]
        database: Option<String>,
    },
    Query {
        #[serde(default)]
        sql: String,
        #[serde(default)]
        database: Option<String>,
    },
    Http {
        #[serde(default)]
        request_type: String,
        #[serde(default = "default_http_method")]
        method: String,
        #[serde(default)]
        path: String,
        #[serde(default)]
        query: Vec<HttpKv>,
        #[serde(default)]
        headers: Vec<HttpKv>,
        #[serde(default)]
        body: Option<String>,
        #[serde(default)]
        body_mode: String,
        #[serde(default)]
        form: Vec<HttpKv>,
        #[serde(default)]
        timeout_ms: Option<u64>,
        #[serde(default)]
        graphql_query: String,
        #[serde(default)]
        graphql_variables: Value,
        #[serde(default)]
        graphql_operation_name: String,
        #[serde(default)]
        records_path: String,
    },
}

fn default_http_method() -> String {
    "GET".into()
}

impl Default for ExtractSource {
    fn default() -> Self {
        Self::Table {
            table: String::new(),
            database: None,
        }
    }
}

#[derive(Debug, Deserialize)]
struct TransformConfig {
    #[serde(default)]
    input_dataset_id: Option<String>,
    spec: Value,
}

#[derive(Debug, Deserialize, Serialize)]
struct ValidationConfig {
    #[serde(default)]
    validation_rule_id: Option<String>,
    source_data_file_id: String,
    #[serde(default)]
    target_load_chip_id: Option<String>,
    #[serde(default)]
    keys: Vec<String>,
    #[serde(default)]
    columns: Vec<String>,
    #[serde(default = "validation_true")]
    compare_row_count: bool,
    #[serde(default = "validation_true")]
    compare_schema: bool,
}

fn validation_true() -> bool {
    true
}

async fn list_catalog(
    State(state): State<AppState>,
    user: CurrentUser,
) -> Result<Json<Value>, AppError> {
    let chips = state.store.list_owned_chips(user.id()).await?;
    let mut out = Vec::with_capacity(chips.len());
    for chip in &chips {
        out.push(chip_json(&state.store, chip).await?);
    }
    Ok(Json(json!({ "chips": out })))
}

async fn register_chip(
    State(state): State<AppState>,
    user: CurrentUser,
    Json(body): Json<RegisterChipBody>,
) -> Result<(StatusCode, Json<Value>), AppError> {
    if body.place_on_workspace {
        let workspace_id = body
            .workspace_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| AppError::bad("workspace_id required when place_on_workspace"))?;
        access::require_workspace(&state.store, &user, workspace_id).await?;
    }
    let name = body.name.trim();
    if name.is_empty() {
        return Err(AppError::bad("chip name required"));
    }
    let chip = match body.kind.as_str() {
        "extract" => {
            let raw = body
                .extract
                .ok_or_else(|| AppError::bad("extract definition required"))?;
            let config = validate_extract_config(&state.store, raw).await?;
            let connection_id = config
                .get("connection_id")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string();
            if connection_id.is_empty() {
                return Err(AppError::bad("connection_id required"));
            }
            let source = config
                .get("source")
                .cloned()
                .ok_or_else(|| AppError::bad("source required"))?;
            let delimiter = config
                .get("delimiter")
                .and_then(Value::as_str)
                .unwrap_or(",")
                .to_string();
            let header = config
                .get("header")
                .and_then(Value::as_bool)
                .unwrap_or(true);
            let source_json =
                serde_json::to_string(&source).map_err(|error| AppError::bad(error.to_string()))?;
            let extract_kind = match source.get("type").and_then(Value::as_str) {
                Some("http") => "api",
                _ => "database",
            };
            state
                .store
                .register_extract_chip(&RegisterExtractChip {
                    name: name.to_string(),
                    owner_user_id: user.id().to_string(),
                    workspace_id: body.workspace_id.clone(),
                    kind: extract_kind.into(),
                    connection_id,
                    source_json,
                    delimiter,
                    header,
                    add_sequence: config
                        .get("add_sequence")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                    output_filename: body.output_filename.clone(),
                    place_on_workspace: body.place_on_workspace,
                })
                .await?
        }
        "transform" => {
            let transform_id = body
                .transform_id
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| AppError::bad("transform_id required"))?;
            access::require_transform(&state.store, &user, transform_id).await?;
            state
                .store
                .register_transform_chip(&RegisterTransformChip {
                    name: name.to_string(),
                    owner_user_id: user.id().to_string(),
                    workspace_id: body.workspace_id.clone(),
                    transform_id: transform_id.to_string(),
                    place_on_workspace: body.place_on_workspace,
                })
                .await?
        }
        "load" => {
            let load_definition_id = body
                .load_definition_id
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| AppError::bad("load_definition_id required"))?;
            crate::load::require_load(&state.store, &user, load_definition_id).await?;
            state
                .store
                .register_load_chip(&RegisterLoadChip {
                    name: name.to_string(),
                    owner_user_id: user.id().to_string(),
                    workspace_id: body.workspace_id.clone(),
                    load_definition_id: load_definition_id.to_string(),
                    place_on_workspace: body.place_on_workspace,
                })
                .await?
        }
        "validation" => {
            let raw = body.config.unwrap_or_else(|| json!({}));
            let config = validate_validation_config(&state.store, "", raw).await?;
            if config.keys.is_empty() {
                return Err(AppError::bad("at least one validation key required"));
            }
            let config_json =
                serde_json::to_string(&config).map_err(|error| AppError::bad(error.to_string()))?;
            state
                .store
                .register_validation_chip(user.id(), name, &config_json)
                .await?
        }
        _ => {
            return Err(AppError::bad(
                "chip kind must be extract, transform, load, or validation",
            ))
        }
    };
    let chip_json = chip_json(&state.store, &chip).await?;
    let should_run = body.run_after.unwrap_or(body.place_on_workspace);
    if body.place_on_workspace && should_run {
        if let Some(workspace_id) = body
            .workspace_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            if let Err(error) = queue_chip_run(&state, &user, &chip, workspace_id, None, None).await
            {
                tracing::warn!(
                    chip_id = %chip.id,
                    ?error,
                    "register succeeded but initial run failed"
                );
            }
        }
    }
    Ok((StatusCode::CREATED, Json(chip_json)))
}

async fn list_chips(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(workspace_id): Path<String>,
) -> Result<Json<Value>, AppError> {
    access::require_workspace(&state.store, &user, &workspace_id).await?;
    let chips = state.store.list_chips(&workspace_id).await?;
    let mut out = Vec::with_capacity(chips.len());
    for chip in &chips {
        out.push(chip_json_for_workspace(&state.store, chip, &workspace_id).await?);
    }
    Ok(Json(json!({ "chips": out })))
}

async fn create_chip(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(workspace_id): Path<String>,
    Json(body): Json<CreateChipBody>,
) -> Result<(StatusCode, Json<Value>), AppError> {
    access::require_workspace(&state.store, &user, &workspace_id).await?;
    let (config, revealed_key) = if body.kind == "serve" {
        crate::serve::validate_serve_config(&state.store, None, body.config, None, true).await?
    } else {
        (
            validate_config(&state.store, &workspace_id, &body.kind, body.config).await?,
            None,
        )
    };
    let config_json =
        serde_json::to_string(&config).map_err(|error| AppError::bad(error.to_string()))?;
    let chip = state
        .store
        .insert_chip(
            user.id(),
            &workspace_id,
            &body.name,
            &body.kind,
            &config_json,
        )
        .await?;
    let mut payload = chip_json(&state.store, &chip).await?;
    if let Some(key) = revealed_key {
        payload["api_key"] = json!(key);
    }
    Ok((StatusCode::CREATED, Json(payload)))
}

async fn get_chip(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> Result<Json<Value>, AppError> {
    let chip = access::require_chip(&state.store, &user, &id).await?;
    Ok(Json(chip_json(&state.store, &chip).await?))
}

async fn update_chip(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
    Json(body): Json<PatchChipBody>,
) -> Result<Json<Value>, AppError> {
    let current = access::require_chip(&state.store, &user, &id).await?;
    if body.name.is_none()
        && body.kind.is_none()
        && body.config.is_none()
        && body.active.is_none()
        && body.extract.is_none()
    {
        return Ok(Json(chip_json(&state.store, &current).await?));
    }
    if let Some(raw) = body.extract {
        if current.kind != "extract" {
            return Err(AppError::bad(
                "extract definition is only valid for extract chips",
            ));
        }
        let config = validate_extract_config(&state.store, raw).await?;
        let connection_id = config
            .get("connection_id")
            .and_then(Value::as_str)
            .unwrap_or("");
        let source = config
            .get("source")
            .cloned()
            .ok_or_else(|| AppError::bad("source required"))?;
        let source_json =
            serde_json::to_string(&source).map_err(|error| AppError::bad(error.to_string()))?;
        let delimiter = config
            .get("delimiter")
            .and_then(Value::as_str)
            .unwrap_or(",");
        let header = config
            .get("header")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        let add_sequence = config
            .get("add_sequence")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let chip = state
            .store
            .update_extract_chip(
                &id,
                body.name.as_deref().unwrap_or(&current.name),
                connection_id,
                &source_json,
                body.output_filename.as_deref(),
                delimiter,
                header,
                add_sequence,
            )
            .await?;
        return Ok(Json(chip_json(&state.store, &chip).await?));
    }
    let mut revealed_key = None;
    let config_json = if body.kind.is_some() || body.config.is_some() {
        if state.store.get_chip_binding(&id).await?.is_some() {
            return Err(AppError::bad(
                "registered chips update definitions, not inline config",
            ));
        }
        let kind = body.kind.as_deref().unwrap_or(current.kind.as_str());
        let raw_config = match body.config.as_ref() {
            Some(config) => config.clone(),
            None => {
                let raw = state
                    .store
                    .resolve_chip_config_json(&current)
                    .await
                    .map_err(|error| AppError::bad(error.to_string()))?;
                serde_json::from_str(&raw).map_err(|error| {
                    AppError::bad(format!("stored chip config is invalid: {error}"))
                })?
            }
        };
        let workspace_id = state
            .store
            .chip_workspace_hint(&id)
            .await
            .map_err(|error| AppError::bad(error.to_string()))?;
        if workspace_id.is_none()
            && kind != "sql"
            && kind != "serve"
            && kind != "script"
            && kind != "memo"
        {
            return Err(AppError::bad("chip is not placed on a workspace"));
        }
        let config = if kind == "serve" {
            let existing = match current.config_json.as_deref() {
                Some(raw) => Some(serde_json::from_str::<Value>(raw).map_err(|error| {
                    AppError::bad(format!("stored chip config is invalid: {error}"))
                })?),
                None => None,
            };
            crate::serve::validate_serve_config(
                &state.store,
                Some(&id),
                raw_config,
                existing.as_ref(),
                false,
            )
            .await
            .map(|(value, key)| {
                revealed_key = key;
                value
            })?
        } else {
            validate_config(
                &state.store,
                workspace_id.as_deref().unwrap_or(""),
                kind,
                raw_config,
            )
            .await?
        };
        Some(serde_json::to_string(&config).map_err(|error| AppError::bad(error.to_string()))?)
    } else {
        None
    };
    let chip = state
        .store
        .update_chip(
            &id,
            body.name.as_deref(),
            body.kind.as_deref(),
            config_json.as_deref(),
            body.active,
        )
        .await?;
    let mut payload = chip_json(&state.store, &chip).await?;
    if let Some(key) = revealed_key {
        payload["api_key"] = json!(key);
    }
    Ok(Json(payload))
}

async fn delete_chip(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> Result<Json<Value>, AppError> {
    let _chip = access::require_chip(&state.store, &user, &id).await?;
    state.store.delete_chip(&id).await?;
    Ok(Json(json!({ "ok": true })))
}

async fn queue_chip_run(
    state: &AppState,
    user: &CurrentUser,
    chip: &ChipRow,
    workspace_id: &str,
    requested_input: Option<String>,
    execution_id: Option<&str>,
) -> Result<ChipRunRow, AppError> {
    access::require_etl_run(user)?;
    match chip.kind.as_str() {
        "extract" => {
            queue_extract_chip_run(
                state,
                user,
                chip,
                workspace_id,
                requested_input,
                execution_id,
            )
            .await
        }
        "transform" => {
            queue_transform_chip_run(
                state,
                user,
                chip,
                workspace_id,
                requested_input,
                execution_id,
            )
            .await
        }
        "load" => {
            queue_load_chip_run(
                state,
                user,
                chip,
                workspace_id,
                requested_input,
                execution_id,
            )
            .await
        }
        "validation" => {
            queue_validation_chip_run(
                state,
                user,
                chip,
                workspace_id,
                requested_input,
                execution_id,
            )
            .await
        }
        "sql" => {
            queue_sql_chip_run(
                state,
                user,
                chip,
                workspace_id,
                requested_input,
                execution_id,
            )
            .await
        }
        "serve" => {
            crate::serve::queue_serve_chip_run(state, user, chip, workspace_id, execution_id).await
        }
        "script" => {
            queue_script_chip_run(
                state,
                user,
                chip,
                workspace_id,
                requested_input,
                execution_id,
            )
            .await
        }
        "memo" => {
            access::require_workspace(&state.store, user, workspace_id).await?;
            Err(AppError::bad("memo chips cannot run"))
        }
        _ => {
            access::require_workspace(&state.store, user, workspace_id).await?;
            if chip.active == 0 {
                return Err(AppError::conflict("chip is inactive"));
            }
            Err(AppError::bad("unsupported chip kind"))
        }
    }
}

async fn queue_validation_chip_run(
    state: &AppState,
    user: &CurrentUser,
    chip: &ChipRow,
    workspace_id: &str,
    requested_input: Option<String>,
    execution_id: Option<&str>,
) -> Result<ChipRunRow, AppError> {
    access::require_workspace(&state.store, user, workspace_id).await?;
    if chip.active == 0 {
        return Err(AppError::conflict("chip is inactive"));
    }
    let config_raw = state
        .store
        .resolve_chip_config_json(chip)
        .await
        .map_err(|error| AppError::bad(error.to_string()))?;
    let mut raw: Value = serde_json::from_str(&config_raw)
        .map_err(|error| AppError::bad(format!("stored chip config is invalid: {error}")))?;
    let data_edges = state
        .store
        .list_chip_edges(workspace_id)
        .await?
        .into_iter()
        .filter(|edge| edge.kind == "data" && edge.to_chip_id == chip.id)
        .collect::<Vec<_>>();
    let mut load_target_id: Option<String> = None;
    let connected_pair = if data_edges.len() == 2 {
        let source_edge = data_edges
            .iter()
            .find(|edge| edge.to_port == "source")
            .unwrap_or(&data_edges[0]);
        let target_edge = data_edges
            .iter()
            .find(|edge| edge.to_port == "target")
            .unwrap_or_else(|| {
                if source_edge.id == data_edges[0].id {
                    &data_edges[1]
                } else {
                    &data_edges[0]
                }
            });
        let source_chip = state
            .store
            .get_chip(&source_edge.from_chip_id)
            .await?
            .ok_or_else(|| AppError::bad("validation source chip not found"))?;
        if source_chip.kind == "load" {
            return Err(AppError::bad(
                "load chips can only be the validation TARGET",
            ));
        }
        let target_chip = state
            .store
            .get_chip(&target_edge.from_chip_id)
            .await?
            .ok_or_else(|| AppError::bad("validation target chip not found"))?;
        let source_id = state
            .store
            .latest_chip_output_for_workspace(workspace_id, &source_edge.from_chip_id)
            .await?
            .ok_or_else(|| AppError::bad("validation source chip has no materialized output"))?;
        raw["source_data_file_id"] = json!(source_id);
        if target_chip.kind == "load" {
            load_target_id = Some(target_chip.id);
            None
        } else {
            let target_id = state
                .store
                .latest_chip_output_for_workspace(workspace_id, &target_edge.from_chip_id)
                .await?
                .ok_or_else(|| {
                    AppError::bad("validation target chip has no materialized output")
                })?;
            Some(target_id)
        }
    } else if let Some(edge) = data_edges.first() {
        let from = state
            .store
            .get_chip(&edge.from_chip_id)
            .await?
            .ok_or_else(|| AppError::bad("validation target chip not found"))?;
        if from.kind == "load" && edge.to_port != "source" {
            load_target_id = Some(from.id);
        }
        None
    } else {
        None
    };
    let mut config = validate_validation_config(&state.store, workspace_id, raw).await?;
    if let Some(load_id) = load_target_id {
        config.target_load_chip_id = Some(load_id);
    }
    if config.source_data_file_id.is_empty()
        || (config.keys.is_empty()
            && config
                .validation_rule_id
                .as_deref()
                .unwrap_or("")
                .is_empty())
    {
        return Err(AppError::bad(
            "configure the validation chip before running",
        ));
    }
    access::require_dataset(&state.store, user, &config.source_data_file_id).await?;
    let target_id = if config.target_load_chip_id.is_some() {
        None
    } else {
        Some(match connected_pair {
            Some(id) => id,
            None => {
                crate::planned_input::resolve_materialized_transform_input(
                    state,
                    user,
                    workspace_id,
                    &chip.id,
                    requested_input,
                    None,
                )
                .await?
            }
        })
    };
    if target_id
        .as_deref()
        .is_some_and(|id| id == config.source_data_file_id)
    {
        return Err(AppError::bad("source and target data files must differ"));
    }
    let resolved_config = serde_json::to_string(&config).map_err(|error| {
        AppError::bad(format!("validation config serialization failed: {error}"))
    })?;
    enqueue_chip_run(
        state,
        chip,
        workspace_id,
        &resolved_config,
        target_id.as_deref(),
        execution_id,
    )
    .await
}

async fn queue_load_chip_run(
    state: &AppState,
    user: &CurrentUser,
    chip: &ChipRow,
    workspace_id: &str,
    requested_input: Option<String>,
    execution_id: Option<&str>,
) -> Result<ChipRunRow, AppError> {
    access::require_workspace(&state.store, user, workspace_id).await?;
    if chip.active == 0 {
        return Err(AppError::conflict("chip is inactive"));
    }
    if chip.kind != "load" {
        return Err(AppError::bad("expected load chip"));
    }
    let binding = state.store.get_chip_binding(&chip.id).await?;
    if !binding
        .as_ref()
        .is_some_and(|binding| binding.ref_kind == "load_recipe")
    {
        return Err(AppError::bad(
            "적재 설정이 적용되지 않았습니다. 적재 칩을 편집하고 저장해 주세요.",
        ));
    }
    let config_raw = state
        .store
        .resolve_chip_config_json(chip)
        .await
        .map_err(|error| AppError::bad(error.to_string()))?;
    let value: Value =
        serde_json::from_str(&config_raw).map_err(|e| AppError::bad(e.to_string()))?;
    reject_forbidden_config(&value)?;
    crate::load::validate_load_config(&state.store, value).await?;
    let dataset_id = crate::planned_input::resolve_materialized_transform_input(
        state,
        user,
        workspace_id,
        &chip.id,
        requested_input,
        None,
    )
    .await?;
    let dataset = state
        .store
        .get_dataset(&dataset_id)
        .await?
        .ok_or_else(|| AppError::not_found("input dataset not found"))?;
    if !state.store.resolve(&dataset.stored_path).is_file() {
        return Err(AppError::not_found("input dataset file missing"));
    }
    enqueue_chip_run(
        state,
        chip,
        workspace_id,
        &config_raw,
        Some(&dataset_id),
        execution_id,
    )
    .await
}

async fn queue_sql_chip_run(
    state: &AppState,
    user: &CurrentUser,
    chip: &ChipRow,
    workspace_id: &str,
    requested_input: Option<String>,
    execution_id: Option<&str>,
) -> Result<ChipRunRow, AppError> {
    access::require_workspace(&state.store, user, workspace_id).await?;
    if chip.active == 0 {
        return Err(AppError::conflict("chip is inactive"));
    }
    if chip.kind != "sql" {
        return Err(AppError::bad("expected SQL chip"));
    }
    if requested_input.is_some() {
        return Err(AppError::bad("SQL chips do not accept input_dataset_id"));
    }
    let config_raw = state
        .store
        .resolve_chip_config_json(chip)
        .await
        .map_err(|error| AppError::bad(error.to_string()))?;
    let config: Value = serde_json::from_str(&config_raw)
        .map_err(|error| AppError::bad(format!("stored chip config is invalid: {error}")))?;
    reject_forbidden_config(&config)?;
    let config = validate_sql_config(&state.store, config).await?;
    let config_raw =
        serde_json::to_string(&config).map_err(|error| AppError::bad(error.to_string()))?;
    enqueue_chip_run(state, chip, workspace_id, &config_raw, None, execution_id).await
}

async fn queue_script_chip_run(
    state: &AppState,
    user: &CurrentUser,
    chip: &ChipRow,
    workspace_id: &str,
    requested_input: Option<String>,
    execution_id: Option<&str>,
) -> Result<ChipRunRow, AppError> {
    access::require_workspace(&state.store, user, workspace_id).await?;
    if chip.active == 0 {
        return Err(AppError::conflict("chip is inactive"));
    }
    if chip.kind != "script" {
        return Err(AppError::bad("expected script chip"));
    }
    let config_raw = state
        .store
        .resolve_chip_config_json(chip)
        .await
        .map_err(|error| AppError::bad(error.to_string()))?;
    let config: Value = serde_json::from_str(&config_raw)
        .map_err(|error| AppError::bad(format!("stored chip config is invalid: {error}")))?;
    reject_forbidden_config(&config)?;
    let config = crate::script::validate_script_config(&state.store, config).await?;
    let parsed = crate::script::parse_script_config(&config)?;
    let edges = state.store.list_chip_edges(workspace_id).await?;
    let incoming: Vec<_> = edges
        .iter()
        .filter(|edge| edge.kind == "data" && edge.to_chip_id == chip.id)
        .collect();
    if incoming.len() > crate::script::MAX_SCRIPT_INPUTS {
        return Err(AppError::bad("too many script inputs"));
    }
    let mut edge_inputs = Vec::new();
    for edge in &incoming {
        let source = state
            .store
            .get_chip(&edge.from_chip_id)
            .await?
            .ok_or_else(|| {
                AppError::bad("input connection references an inactive or missing chip")
            })?;
        let dataset_id = if let Some(dataset_id) = state
            .store
            .latest_chip_output_for_workspace(workspace_id, &edge.from_chip_id)
            .await?
        {
            dataset_id
        } else {
            crate::chip::run_extract_chip_sync(state, user, workspace_id, &edge.from_chip_id)
                .await?;
            state
                .store
                .latest_chip_output_for_workspace(workspace_id, &edge.from_chip_id)
                .await?
                .ok_or_else(|| AppError::bad("upstream extract did not produce a dataset"))?
        };
        edge_inputs.push(crate::script::ScriptInput {
            name: crate::script::input_name_from_label(&source.name),
            dataset_id,
        });
    }
    let mut extras = parsed.inputs;
    if incoming.is_empty() && extras.is_empty() {
        if let Some(id) = requested_input.clone() {
            extras.push(crate::script::ScriptInput {
                name: "input".into(),
                dataset_id: id,
            });
        }
    }
    let inputs = crate::script::merge_script_inputs(edge_inputs, extras)?;
    let mut config = config;
    config["inputs"] = json!(inputs);
    config["input_dataset_id"] = json!(inputs.first().map(|item| item.dataset_id.clone()));
    let config_raw =
        serde_json::to_string(&config).map_err(|error| AppError::bad(error.to_string()))?;
    enqueue_chip_run(
        state,
        chip,
        workspace_id,
        &config_raw,
        inputs.first().map(|item| item.dataset_id.as_str()),
        execution_id,
    )
    .await
}

async fn queue_extract_chip_run(
    state: &AppState,
    user: &CurrentUser,
    chip: &ChipRow,
    workspace_id: &str,
    requested_input: Option<String>,
    execution_id: Option<&str>,
) -> Result<ChipRunRow, AppError> {
    access::require_workspace(&state.store, user, workspace_id).await?;
    if chip.active == 0 {
        return Err(AppError::conflict("chip is inactive"));
    }
    if chip.kind != "extract" {
        return Err(AppError::bad("expected extract chip"));
    }
    if requested_input.is_some() {
        return Err(AppError::bad(
            "extract chips do not accept input_dataset_id",
        ));
    }
    let config_raw = state
        .store
        .resolve_chip_config_json(chip)
        .await
        .map_err(|error| AppError::bad(error.to_string()))?;
    let config: Value = serde_json::from_str(&config_raw)
        .map_err(|error| AppError::bad(format!("stored chip config is invalid: {error}")))?;
    reject_forbidden_config(&config)?;
    let config = validate_extract_config(&state.store, config).await?;
    if config
        .get("connection_id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .is_empty()
    {
        return Err(AppError::bad("configure the extract chip before running"));
    }
    enqueue_chip_run(state, chip, workspace_id, &config_raw, None, execution_id).await
}

async fn queue_transform_chip_run(
    state: &AppState,
    user: &CurrentUser,
    chip: &ChipRow,
    workspace_id: &str,
    requested_input: Option<String>,
    execution_id: Option<&str>,
) -> Result<ChipRunRow, AppError> {
    access::require_workspace(&state.store, user, workspace_id).await?;
    if chip.active == 0 {
        return Err(AppError::conflict("chip is inactive"));
    }
    if chip.kind != "transform" {
        return Err(AppError::bad("expected transform chip"));
    }
    let binding = state.store.get_chip_binding(&chip.id).await?;
    if !binding
        .as_ref()
        .is_some_and(|binding| binding.ref_kind == "transform")
    {
        return Err(AppError::bad(
            "변환 레시피가 설정되지 않았습니다. 변환 칩을 편집하고 저장해 주세요.",
        ));
    }
    let config_raw = state
        .store
        .resolve_chip_config_json(chip)
        .await
        .map_err(|error| AppError::bad(error.to_string()))?;
    let config: Value = serde_json::from_str(&config_raw)
        .map_err(|error| AppError::bad(format!("stored chip config is invalid: {error}")))?;
    reject_forbidden_config(&config)?;
    let config = validate_transform_config(&state.store, workspace_id, config).await?;
    let dataset_id = crate::planned_input::resolve_materialized_transform_input(
        state,
        user,
        workspace_id,
        &chip.id,
        requested_input,
        config.input_dataset_id,
    )
    .await?;
    let dataset = state
        .store
        .get_dataset(&dataset_id)
        .await?
        .ok_or_else(|| AppError::not_found("input dataset not found"))?;
    if dataset.workspace_id != workspace_id {
        return Err(AppError::bad("input dataset belongs to another workspace"));
    }
    if !state.store.resolve(&dataset.stored_path).is_file() {
        return Err(AppError::not_found("input dataset file missing"));
    }
    enqueue_chip_run(
        state,
        chip,
        workspace_id,
        &config_raw,
        Some(&dataset_id),
        execution_id,
    )
    .await
}

async fn enqueue_chip_run(
    state: &AppState,
    chip: &ChipRow,
    workspace_id: &str,
    config_raw: &str,
    input_dataset_id: Option<&str>,
    execution_id: Option<&str>,
) -> Result<ChipRunRow, AppError> {
    let run = state
        .store
        .create_chip_run_in_execution(
            &chip.id,
            workspace_id,
            chip.revision,
            config_raw,
            input_dataset_id,
            execution_id,
        )
        .await?;
    state.wake();
    Ok(run)
}

async fn run_chip(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
    Json(body): Json<RunChipBody>,
) -> Result<Json<Value>, AppError> {
    let chip = access::require_chip(&state.store, &user, &id).await?;
    let run = queue_chip_run(
        &state,
        &user,
        &chip,
        &body.workspace_id,
        body.input_dataset_id,
        None,
    )
    .await?;
    Ok(Json(json!({
        "ok": true,
        "id": run.id,
        "status": "queued",
        "run": chip_run_json(&run)?,
    })))
}

fn workspace_run_order(
    chips: Vec<ChipRow>,
    edges: &[storage::ChipEdgeRow],
) -> Result<Vec<ChipRow>, AppError> {
    let chips = chips
        .into_iter()
        .filter(|chip| chip.active != 0 && chip.kind != "memo")
        .collect::<Vec<_>>();
    let mut incoming = chips
        .iter()
        .map(|chip| (chip.id.clone(), 0usize))
        .collect::<HashMap<_, _>>();
    let mut outgoing = chips
        .iter()
        .map(|chip| (chip.id.clone(), Vec::<String>::new()))
        .collect::<HashMap<_, _>>();
    for edge in edges {
        if !incoming.contains_key(&edge.from_chip_id) || !incoming.contains_key(&edge.to_chip_id) {
            continue;
        }
        outgoing
            .entry(edge.from_chip_id.clone())
            .or_default()
            .push(edge.to_chip_id.clone());
        *incoming.entry(edge.to_chip_id.clone()).or_default() += 1;
    }
    let mut ready = chips
        .iter()
        .filter(|chip| incoming.get(&chip.id) == Some(&0))
        .map(|chip| chip.id.clone())
        .collect::<VecDeque<_>>();
    let by_id = chips
        .into_iter()
        .map(|chip| (chip.id.clone(), chip))
        .collect::<HashMap<_, _>>();
    let mut ordered = Vec::with_capacity(by_id.len());
    while let Some(id) = ready.pop_front() {
        if let Some(chip) = by_id.get(&id) {
            ordered.push(chip.clone());
        }
        for next in outgoing.get(&id).into_iter().flatten() {
            let left = incoming.get(next).copied().unwrap_or(1).saturating_sub(1);
            incoming.insert(next.clone(), left);
            if left == 0 {
                ready.push_back(next.clone());
            }
        }
    }
    if ordered.len() != by_id.len() {
        return Err(AppError::conflict("workspace chip graph contains a cycle"));
    }
    Ok(ordered)
}

async fn run_workspace(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(workspace_id): Path<String>,
) -> Result<Json<Value>, AppError> {
    access::require_etl_run(&user)?;
    access::require_workspace(&state.store, &user, &workspace_id).await?;
    let execution_id = state
        .store
        .create_workspace_execution(&workspace_id, user.id())
        .await?;
    let run_state = state.clone();
    let run_user = user.clone();
    let run_workspace_id = workspace_id.clone();
    let run_execution_id = execution_id.clone();
    tokio::spawn(async move {
        if let Err(error) =
            finish_workspace_execution(&run_state, &run_user, &run_workspace_id, &run_execution_id)
                .await
        {
            if error.message() != "canceled" {
                tracing::error!(
                    execution_id = run_execution_id,
                    error = error.message(),
                    "workspace execution failed"
                );
            }
        }
    });
    Ok(Json(json!({
        "ok": true,
        "status": "running",
        "workspace_id": workspace_id,
        "execution_id": execution_id,
    })))
}

pub(crate) async fn run_workspace_internal(
    state: &AppState,
    user: &CurrentUser,
    workspace_id: &str,
) -> Result<Vec<String>, AppError> {
    let execution_id = state
        .store
        .create_workspace_execution(workspace_id, &user.0.id)
        .await?;
    finish_workspace_execution(state, user, workspace_id, &execution_id).await
}

async fn finish_workspace_execution(
    state: &AppState,
    user: &CurrentUser,
    workspace_id: &str,
    execution_id: &str,
) -> Result<Vec<String>, AppError> {
    let result = workspace_execution::execute(state, user, workspace_id, execution_id).await;
    let canceled = result
        .as_ref()
        .is_err_and(|error| error.message() == "canceled")
        || state
            .store
            .get_execution(execution_id)
            .await?
            .is_some_and(|row| row.status == "canceled");
    if result.is_err() {
        state
            .store
            .skip_waiting_workspace_steps(execution_id, "전체 실행이 중단되어 실행하지 않았습니다.")
            .await?;
    }
    if canceled {
        state
            .store
            .finish_workspace_execution_as(
                execution_id,
                "canceled",
                Some(storage::EXECUTION_CANCELED_MESSAGE),
            )
            .await?;
        return Err(AppError::bad("canceled"));
    }
    let error = result
        .as_ref()
        .err()
        .map(|error| error.message().to_string());
    state
        .store
        .finish_workspace_execution(execution_id, error.as_deref())
        .await?;
    result
}

async fn list_runs(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(workspace_id): Path<String>,
) -> Result<Json<Value>, AppError> {
    access::require_workspace(&state.store, &user, &workspace_id).await?;
    let runs = state
        .store
        .list_chip_runs(&workspace_id)
        .await?
        .iter()
        .map(chip_run_json)
        .collect::<Result<Vec<_>, _>>()?;
    let workspace_runs = state.store.list_workspace_executions(&workspace_id).await?;
    Ok(Json(
        json!({ "runs": runs, "workspace_runs": workspace_runs }),
    ))
}

async fn list_workspace_runs(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(workspace_id): Path<String>,
) -> Result<Json<Value>, AppError> {
    access::require_workspace(&state.store, &user, &workspace_id).await?;
    let runs = state.store.list_workspace_executions(&workspace_id).await?;
    Ok(Json(json!({ "runs": runs })))
}

async fn cancel_workspace_run(
    State(state): State<AppState>,
    user: CurrentUser,
    Path((workspace_id, execution_id)): Path<(String, String)>,
) -> Result<Json<Value>, AppError> {
    access::require_etl_run(&user)?;
    access::require_workspace(&state.store, &user, &workspace_id).await?;
    let execution = state
        .store
        .get_execution(&execution_id)
        .await?
        .ok_or_else(|| AppError::not_found("workspace execution not found"))?;
    if execution.workspace_id != workspace_id || execution.source != "workspace" {
        return Err(AppError::not_found("workspace execution not found"));
    }
    if !state
        .store
        .cancel_workspace_execution(&execution_id)
        .await?
    {
        return Err(AppError::conflict("실행 중이 아닙니다"));
    }
    Ok(Json(json!({
        "ok": true,
        "status": "canceled",
        "id": execution_id,
    })))
}

async fn cancel_chip_run(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> Result<Json<Value>, AppError> {
    access::require_etl_run(&user)?;
    let run = state
        .store
        .get_chip_run(&id)
        .await?
        .ok_or_else(|| AppError::not_found("chip run not found"))?;
    access::require_workspace(&state.store, &user, &run.workspace_id).await?;
    if !matches!(run.status.as_str(), "queued" | "running") {
        return Err(AppError::conflict("실행 중이 아닙니다"));
    }
    let canceled = if run.execution_source == "workspace" {
        state
            .store
            .cancel_workspace_execution(&run.execution_id)
            .await?
    } else {
        state.store.cancel_execution_step(&run.id).await?
    };
    if !canceled {
        return Err(AppError::conflict("실행 중이 아닙니다"));
    }
    Ok(Json(json!({
        "ok": true,
        "status": "canceled",
        "id": id,
    })))
}

async fn get_run(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> Result<Json<Value>, AppError> {
    let run = state
        .store
        .get_chip_run(&id)
        .await?
        .ok_or_else(|| AppError::not_found("chip run not found"))?;
    access::require_workspace(&state.store, &user, &run.workspace_id).await?;
    Ok(Json(chip_run_json(&run)?))
}

async fn get_run_logs(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> Result<Json<Value>, AppError> {
    let run = state
        .store
        .get_chip_run(&id)
        .await?
        .ok_or_else(|| AppError::not_found("chip run not found"))?;
    access::require_workspace(&state.store, &user, &run.workspace_id).await?;
    let stored_logs = state.store.list_logs(&run.id).await?;
    let text = if !stored_logs.is_empty() {
        stored_logs
            .into_iter()
            .map(|log| {
                format!(
                    "{}  {:<5}  {}",
                    crate::execution_error::display_timestamp(&log.ts),
                    log.level,
                    log.message
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    } else if run.kind == "load" {
        match state.store.get_load_result(&run.id).await? {
            Some(result) => format!(
                "load succeeded\ndestination: {}\nmode: {}\nloaded rows: {}\nrejected rows: {}\nduration: {} ms\nvalidation: {}",
                result.destination, result.write_mode, result.loaded_rows, result.rejected_rows,
                result.duration_ms, result.validation_status,
            ),
            None => run.error_message.unwrap_or_default(),
        }
    } else if run.kind == "validation" {
        match state.store.chip_run_result_json(&run.id).await? {
            Some(raw) => match serde_json::from_str::<engine::ValidationReport>(&raw) {
                Ok(report) => format!(
                    "validation {}\nsource rows: {}\ntarget rows: {}\nmissing keys: {}\nextra keys: {}\nmismatched rows: {}\nsource duplicate keys: {}\ntarget duplicate keys: {}\nschema matches: {}{}",
                    if report.passed { "passed" } else { "failed" },
                    report.source_rows,
                    report.target_rows,
                    report.missing_keys,
                    report.extra_keys,
                    report.mismatched_rows,
                    report.duplicate_source_keys,
                    report.duplicate_target_keys,
                    report.schema_matches,
                    if report.samples.is_empty() {
                        String::new()
                    } else {
                        format!("\n\nsamples:\n{}", report.samples.join("\n"))
                    },
                ),
                Err(_) => raw,
            },
            None => run.error_message.unwrap_or_default(),
        }
    } else {
        String::new()
    };
    Ok(Json(json!({ "id": id, "text": text })))
}

#[derive(Deserialize)]
struct InputSlotQuery {
    port: Option<String>,
}

async fn get_input_slot(
    State(state): State<AppState>,
    user: CurrentUser,
    Path((workspace_id, chip_id)): Path<(String, String)>,
    Query(query): Query<InputSlotQuery>,
) -> Result<Json<Value>, AppError> {
    Ok(Json(
        crate::planned_input::get_transform_input_slot(
            &state,
            &user,
            &workspace_id,
            &chip_id,
            query.port.as_deref(),
        )
        .await?,
    ))
}

pub async fn run_extract_chip_sync(
    state: &AppState,
    user: &CurrentUser,
    workspace_id: &str,
    chip_id: &str,
) -> Result<(), AppError> {
    let chip = access::require_chip(&state.store, user, chip_id).await?;
    let run = queue_extract_chip_run(state, user, &chip, workspace_id, None, None).await?;
    tokio::time::timeout(Duration::from_secs(120), wait_for_chip_run(state, &run.id))
        .await
        .map_err(|_| AppError::bad("chip run timed out"))?
}

async fn wait_for_chip_run(state: &AppState, run_id: &str) -> Result<(), AppError> {
    loop {
        tokio::time::sleep(Duration::from_millis(200)).await;
        let current = state
            .store
            .get_chip_run(run_id)
            .await?
            .ok_or_else(|| AppError::not_found("chip run not found"))?;
        match current.status.as_str() {
            "succeeded" => return Ok(()),
            "canceled" => return Err(AppError::bad("canceled")),
            "failed" => {
                let message = current
                    .error_message
                    .filter(|value| !value.trim().is_empty())
                    .unwrap_or_else(|| "chip run failed".into());
                return Err(AppError::bad(message));
            }
            "queued" | "running" => {}
            other => {
                return Err(AppError::bad(format!(
                    "unexpected chip run status `{other}`"
                )))
            }
        }
    }
}

pub(crate) async fn chip_json(store: &Store, row: &ChipRow) -> Result<Value, AppError> {
    let binding = store
        .get_chip_binding(&row.id)
        .await
        .map_err(|error| AppError::bad(error.to_string()))?;
    let config_raw = store
        .resolve_chip_config_json(row)
        .await
        .map_err(|error| AppError::bad(error.to_string()))?;
    let config = serde_json::from_str::<Value>(&config_raw)
        .map_err(|error| AppError::bad(format!("stored chip config is invalid: {error}")))?;
    let mut config = config;
    if row.kind == "serve" {
        crate::serve::redact_config(&mut config);
    }
    let workspace_id = store
        .chip_workspace_hint(&row.id)
        .await
        .map_err(|error| AppError::bad(error.to_string()))?;
    Ok(json!({
        "id": row.id,
        "owner_user_id": row.owner_user_id,
        "name": row.name,
        "kind": row.kind,
        "workspace_id": workspace_id,
        "binding": binding.map(|item| json!({
            "ref_kind": item.ref_kind,
            "ref_id": item.ref_id,
        })),
        "config": config,
        "revision": row.revision,
        "active": row.active != 0,
        "created_at": row.created_at,
        "updated_at": row.updated_at,
    }))
}

pub(crate) async fn chip_json_for_workspace(
    store: &Store,
    row: &ChipRow,
    workspace_id: &str,
) -> Result<Value, AppError> {
    let mut value = chip_json(store, row).await?;
    value["output"] = chip_output_json(store, row, workspace_id).await?;

    // A data edge is authoritative for transform/load input. Reflect it in the
    // workspace payload immediately so the canvas never keeps showing a stale
    // fixed dataset until the editor happens to be opened and saved.
    if row.kind == "transform" || row.kind == "load" {
        let incoming = store
            .list_chip_edges(workspace_id)
            .await?
            .into_iter()
            .find(|edge| edge.kind == "data" && edge.to_chip_id == row.id);
        if let Some(edge) = incoming {
            let dataset_id = match store
                .latest_chip_output_for_workspace(workspace_id, &edge.from_chip_id)
                .await?
            {
                Some(id) => id,
                None => format!("contract:{workspace_id}:{}", row.id),
            };
            value["config"]["input_dataset_id"] = json!(dataset_id);
        }
    }

    // For load chips, include input dataset info when available so UI popups can show it.
    if row.kind == "load" {
        // Try to read input_dataset_id from the chip's inline config
        let config_raw = store
            .resolve_chip_config_json(row)
            .await
            .map_err(|error| AppError::bad(error.to_string()))?;
        let config: Value = serde_json::from_str(&config_raw).unwrap_or(json!({}));
        let mut input_info: Option<Value> = None;
        if let Some(id) = config
            .get("input_dataset_id")
            .and_then(Value::as_str)
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
        {
            if let Some(dataset) = store.get_dataset(id).await? {
                input_info = Some(crate::transform::dataset_json_public(store, &dataset));
            } else {
                input_info = Some(json!({ "dataset_id": id, "missing": true }));
            }
        } else {
            // If not inline, check bound load definition (if any)
            if let Some(binding) = store.get_chip_binding(&row.id).await? {
                if binding.ref_kind == "load" {
                    if let Some(def) = store.get_load_definition(&binding.ref_id).await? {
                        // def.spec_json is a JSON string containing input_dataset_id
                        if let Ok(spec_val) = serde_json::from_str::<Value>(&def.spec_json) {
                            if let Some(id) = spec_val
                                .get("input_dataset_id")
                                .and_then(Value::as_str)
                                .map(|s| s.trim())
                                .filter(|s| !s.is_empty())
                            {
                                if let Some(dataset) = store.get_dataset(id).await? {
                                    input_info = Some(crate::transform::dataset_json_public(
                                        store, &dataset,
                                    ));
                                } else {
                                    input_info = Some(json!({ "dataset_id": id, "missing": true }));
                                }
                            }
                        }
                    }
                }
            }
        }
        if let Some(info) = input_info {
            value["input"] = info;
        }
    }

    Ok(value)
}

async fn chip_output_json(
    store: &Store,
    row: &ChipRow,
    workspace_id: &str,
) -> Result<Value, AppError> {
    let config_raw = store
        .resolve_chip_config_json(row)
        .await
        .map_err(|error| AppError::bad(error.to_string()))?;
    let config: Value = serde_json::from_str(&config_raw).unwrap_or(json!({}));
    let delimiter = config
        .get("delimiter")
        .and_then(Value::as_str)
        .unwrap_or(",");
    let output_name = if row.kind == "transform" {
        let bound_transform = match store.get_chip_binding(&row.id).await? {
            Some(binding) if binding.ref_kind == "transform" => {
                store.get_transform(&binding.ref_id).await?
            }
            _ => None,
        };
        match bound_transform {
            Some(transform) => transform.name,
            None => match store.get_transform_for_chip(&row.id).await? {
                Some(transform) => transform.name,
                None => inferred_transform_output_name(store, row, workspace_id)
                    .await?
                    .unwrap_or_else(|| row.name.clone()),
            },
        }
    } else if row.kind == "script" {
        config
            .get("output_filename")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(row.name.as_str())
            .to_string()
    } else {
        row.name.clone()
    };
    let filename = store
        .output_contract_filename(workspace_id, &row.id)
        .await?
        .unwrap_or_else(|| {
            storage::chip_slot::display_filename(&output_name, &row.kind, delimiter)
        });
    if let Some(dataset_id) = store
        .latest_chip_output_for_workspace(workspace_id, &row.id)
        .await?
    {
        let dataset = store
            .get_dataset(&dataset_id)
            .await?
            .ok_or_else(|| AppError::not_found("dataset not found"))?;
        let available = store.resolve(&dataset.stored_path).is_file();
        return Ok(json!({
            "filename": if row.kind == "transform" { filename } else { dataset.filename },
            "available": available,
            "dataset_id": dataset.id,
        }));
    }
    Ok(json!({
        "filename": filename,
        "available": false,
        "dataset_id": Value::Null,
    }))
}

pub(crate) async fn inferred_transform_output_name(
    store: &Store,
    row: &ChipRow,
    workspace_id: &str,
) -> Result<Option<String>, AppError> {
    let source_id = store
        .list_chip_edges(workspace_id)
        .await?
        .into_iter()
        .find(|edge| edge.kind == "data" && edge.to_chip_id == row.id)
        .map(|edge| edge.from_chip_id);
    let Some(source_id) = source_id else {
        return Ok(None);
    };
    let Some(source) = store.get_chip(&source_id).await? else {
        return Ok(None);
    };
    let source_name = if source.kind == "transform" {
        match store.get_chip_binding(&source.id).await? {
            Some(binding) if binding.ref_kind == "transform" => store
                .get_transform(&binding.ref_id)
                .await?
                .map(|transform| transform.name)
                .unwrap_or(source.name),
            _ => source.name,
        }
    } else {
        source.name
    };
    let base = source_name.strip_suffix(".parquet").unwrap_or(&source_name);
    let Some(rest) = base.strip_prefix("transform-") else {
        return Ok(Some(format!("transform-{base}")));
    };
    let mut parts = rest.splitn(2, '-');
    let first = parts.next().unwrap_or("");
    let remainder = parts.next();
    if first.len() == 2 && first.chars().all(|character| character.is_ascii_digit()) {
        if let (Ok(sequence), Some(remainder)) = (first.parse::<u32>(), remainder) {
            return Ok(Some(format!("transform-{:02}-{remainder}", sequence + 1)));
        }
    }
    Ok(Some(format!("transform-02-{rest}")))
}

fn chip_run_json(row: &ChipRunRow) -> Result<Value, AppError> {
    let config_snapshot = serde_json::from_str::<Value>(&row.config_snapshot_json)
        .map_err(|error| AppError::bad(format!("stored chip snapshot is invalid: {error}")))?;
    Ok(json!({
        "id": row.id,
        "execution_id": row.execution_id,
        "execution_source": row.execution_source,
        "chip_id": row.chip_id,
        "workspace_id": row.workspace_id,
        "kind": row.kind,
        "status": if row.status == "canceled" && row.error_code.as_deref() == Some("WORKSPACE_STEP_SKIPPED") { "skipped" } else { &row.status },
        "config_snapshot": config_snapshot,
        "revision_snapshot": row.revision_snapshot,
        "input_dataset_id": row.input_dataset_id,
        "output_dataset_id": row.output_dataset_id,
        "legacy_extract_id": row.legacy_extract_id,
        "legacy_job_id": row.legacy_job_id,
        "error_code": row.error_code,
        "error_message": row.error_message,
        "input_rows": row.input_rows,
        "output_rows": row.output_rows,
        "result": row.result_json.as_deref().and_then(|raw| serde_json::from_str::<Value>(raw).ok()),
        "created_at": row.created_at,
        "started_at": row.started_at,
        "finished_at": row.finished_at,
    }))
}

pub(crate) async fn validate_config(
    store: &Store,
    workspace_id: &str,
    kind: &str,
    config: Value,
) -> Result<Value, AppError> {
    reject_forbidden_config(&config)?;
    match kind {
        "extract" => validate_extract_config(store, config).await,
        "transform" => validate_transform_config(store, workspace_id, config)
            .await
            .and_then(normalized_transform_config),
        "load" if config.as_object().is_some_and(|value| value.is_empty()) => Ok(config),
        "load" => crate::load::validate_load_config(store, config)
            .await
            .and_then(|value| {
                serde_json::to_value(value).map_err(|e| AppError::bad(e.to_string()))
            }),
        "validation" => validate_validation_config(store, workspace_id, config)
            .await
            .and_then(|value| {
                serde_json::to_value(value).map_err(|e| AppError::bad(e.to_string()))
            }),
        "sql" => validate_sql_config(store, config).await,
        "serve" => crate::serve::validate_serve_config(store, None, config, None, false)
            .await
            .map(|(value, _)| value),
        "script" => crate::script::validate_script_config(store, config).await,
        "memo" => validate_memo_config(config),
        _ => Err(AppError::bad(
            "chip kind must be extract, transform, load, validation, sql, serve, script, or memo",
        )),
    }
}

// ponytail: 64KB note ceiling; attachments if a memo outgrows a page.
const MAX_MEMO_TEXT: usize = 64 * 1024;

const MEMO_FONT_SIZES: [u64; 5] = [14, 16, 18, 20, 24];

fn validate_memo_config(config: Value) -> Result<Value, AppError> {
    let text = config
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if text.len() > MAX_MEMO_TEXT {
        return Err(AppError::bad("memo text is too long"));
    }
    let font_size = config
        .get("font_size")
        .and_then(Value::as_u64)
        .filter(|size| MEMO_FONT_SIZES.contains(size))
        .unwrap_or(16);
    let bold = config.get("bold").and_then(Value::as_bool).unwrap_or(false);
    let underline = config
        .get("underline")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    Ok(json!({
        "text": text,
        "font_size": font_size,
        "bold": bold,
        "underline": underline,
    }))
}

pub(crate) async fn validate_sql_config(store: &Store, config: Value) -> Result<Value, AppError> {
    let connection_id = config
        .get("connection_id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    let sql_text = config
        .get("sql_text")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let database = config
        .get("database")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string());
    let schema = config
        .get("schema")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string());
    if connection_id.is_empty() {
        return Err(AppError::bad("connection_id required"));
    }
    let connection = store
        .get_connection(&connection_id)
        .await?
        .ok_or_else(|| AppError::not_found("connection not found"))?;
    if connection.driver == "http" {
        return Err(AppError::bad("http connection cannot run SQL"));
    }
    let sql_text =
        normalize_sql_script(&sql_text).map_err(|error| AppError::bad(error.to_string()))?;
    validate_database(database.as_deref())?;
    validate_database(schema.as_deref())?;
    Ok(json!({
        "connection_id": connection_id,
        "sql_text": sql_text,
        "database": database,
        "schema": schema,
    }))
}

async fn validate_validation_config(
    store: &Store,
    workspace_id: &str,
    config: Value,
) -> Result<ValidationConfig, AppError> {
    let mut config: ValidationConfig =
        serde_json::from_value(config).map_err(|error| AppError::bad(error.to_string()))?;
    config.source_data_file_id = config.source_data_file_id.trim().to_string();
    config.validation_rule_id = config
        .validation_rule_id
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    config.keys = config
        .keys
        .into_iter()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .collect();
    config.columns = config
        .columns
        .into_iter()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .collect();
    if config.source_data_file_id.is_empty()
        && config.keys.is_empty()
        && config.validation_rule_id.is_none()
    {
        return Ok(config);
    }
    if config.keys.is_empty() && config.validation_rule_id.is_none() {
        return Err(AppError::bad("at least one validation key required"));
    }
    if let Some(rule_id) = config.validation_rule_id.as_deref() {
        let rule = store
            .get_validation_rule(rule_id)
            .await?
            .ok_or_else(|| AppError::not_found("validation rule not found"))?;
        if rule.active == 0 {
            return Err(AppError::bad("validation rule is inactive"));
        }
    }
    if !config.source_data_file_id.is_empty() {
        let source = store
            .get_dataset(&config.source_data_file_id)
            .await?
            .ok_or_else(|| AppError::not_found("validation source data file not found"))?;
        if !workspace_id.is_empty() && source.workspace_id != workspace_id {
            return Err(AppError::bad(
                "validation source belongs to another workspace",
            ));
        }
    }
    Ok(config)
}

async fn validate_extract_config(store: &Store, config: Value) -> Result<Value, AppError> {
    let config: ExtractConfig =
        serde_json::from_value(config).map_err(|error| AppError::bad(error.to_string()))?;
    let delimiter = config.delimiter.as_deref().unwrap_or(",").to_string();
    parse_delimiter(&delimiter).map_err(|error| AppError::bad(error.to_string()))?;
    if extract_is_draft(&config) {
        return Ok(json!({
            "connection_id": "",
            "source": { "type": "table", "table": "", "database": null },
            "delimiter": delimiter,
            "header": config.header.unwrap_or(true),
            "add_sequence": config.add_sequence.unwrap_or(false),
        }));
    }
    if config.connection_id.trim().is_empty() {
        return Err(AppError::bad("connection_id required"));
    }
    let connection = store
        .get_connection(&config.connection_id)
        .await?
        .ok_or_else(|| AppError::not_found("connection not found"))?;
    let source = match config.source {
        ExtractSource::Table { table, database } => {
            if connection.driver == "http" {
                return Err(AppError::bad("http connection cannot use table source"));
            }
            parse_table(&table).map_err(|error| AppError::bad(error.to_string()))?;
            validate_database(database.as_deref())?;
            json!({ "type": "table", "table": table.trim(), "database": database })
        }
        ExtractSource::Query { sql, database } => {
            if connection.driver == "http" {
                return Err(AppError::bad("http connection cannot use query source"));
            }
            let sql = normalize_sql(&sql).map_err(|error| AppError::bad(error.to_string()))?;
            if sql_kind(&sql) != SqlKind::Rows {
                return Err(AppError::bad(
                    "extract query needs a result set (SELECT / WITH / SHOW …)",
                ));
            }
            validate_database(database.as_deref())?;
            json!({ "type": "query", "sql": sql, "database": database })
        }
        ExtractSource::Http {
            request_type,
            method,
            path,
            query,
            headers,
            body,
            body_mode,
            form,
            timeout_ms,
            graphql_query,
            graphql_variables,
            graphql_operation_name,
            records_path,
        } => {
            if connection.driver != "http" {
                return Err(AppError::bad("http source needs an http connection"));
            }
            let spec = HttpRequestSpec {
                request_type,
                method,
                path,
                query,
                headers,
                body,
                body_mode,
                form,
                timeout_ms,
                graphql_query,
                graphql_variables,
                graphql_operation_name,
                records_path,
            };
            let raw =
                serde_json::to_string(&spec).map_err(|error| AppError::bad(error.to_string()))?;
            let spec = parse_http_spec(&raw).map_err(|error| AppError::bad(error.to_string()))?;
            json!({
                "type": "http",
                "request_type": spec.request_type,
                "method": spec.method,
                "path": spec.path,
                "query": spec.query,
                "headers": spec.headers,
                "body": spec.body,
                "body_mode": spec.body_mode,
                "form": spec.form,
                "timeout_ms": spec.timeout_ms,
                "graphql_query": spec.graphql_query,
                "graphql_variables": spec.graphql_variables,
                "graphql_operation_name": spec.graphql_operation_name,
                "records_path": spec.records_path,
            })
        }
    };
    Ok(json!({
        "connection_id": config.connection_id,
        "source": source,
        "delimiter": delimiter,
        "header": config.header.unwrap_or(true),
        "add_sequence": config.add_sequence.unwrap_or(false),
    }))
}

async fn validate_transform_config(
    store: &Store,
    workspace_id: &str,
    config: Value,
) -> Result<TransformConfig, AppError> {
    let config: TransformConfig =
        serde_json::from_value(config).map_err(|error| AppError::bad(error.to_string()))?;
    let spec_json =
        serde_json::to_string(&config.spec).map_err(|error| AppError::bad(error.to_string()))?;
    let spec = TransformSpec::parse_json(&spec_json)?;
    if spec.version != 2 && spec.version != 3 {
        return Err(AppError::bad("transform spec must be version 2 or 3"));
    }
    let input_dataset_id = config
        .input_dataset_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    if let Some(dataset_id) = input_dataset_id.as_deref() {
        if !dataset_id.starts_with("contract:") {
            let dataset = store
                .get_dataset(dataset_id)
                .await?
                .ok_or_else(|| AppError::not_found("input dataset not found"))?;
            if dataset.workspace_id != workspace_id {
                return Err(AppError::bad("input dataset belongs to another workspace"));
            }
        }
    }
    Ok(TransformConfig {
        input_dataset_id,
        spec: serde_json::to_value(spec).map_err(|error| AppError::bad(error.to_string()))?,
    })
}

fn normalized_transform_config(config: TransformConfig) -> Result<Value, AppError> {
    Ok(json!({
        "input_dataset_id": config.input_dataset_id,
        "spec": config.spec,
    }))
}

fn extract_is_draft(config: &ExtractConfig) -> bool {
    config.connection_id.trim().is_empty()
        && match &config.source {
            ExtractSource::Table { table, .. } => table.trim().is_empty(),
            ExtractSource::Query { sql, .. } => sql.trim().is_empty(),
            ExtractSource::Http { path, .. } => path.trim().is_empty(),
        }
}

fn validate_database(database: Option<&str>) -> Result<(), AppError> {
    if let Some(database) = database.map(str::trim).filter(|value| !value.is_empty()) {
        parse_ident(database).map_err(|error| AppError::bad(error.to_string()))?;
    }
    Ok(())
}

fn reject_forbidden_config(value: &Value) -> Result<(), AppError> {
    match value {
        Value::Object(object) => {
            for (key, value) in object {
                let normalized = key
                    .chars()
                    .filter(|character| character.is_ascii_alphanumeric())
                    .flat_map(char::to_lowercase)
                    .collect::<String>();
                if matches!(
                    normalized.as_str(),
                    "password" | "passwordcipher" | "outputpath" | "storedpath"
                ) {
                    return Err(AppError::bad(format!(
                        "chip config must not contain `{key}`"
                    )));
                }
                reject_forbidden_config(value)?;
            }
        }
        Value::Array(values) => {
            for value in values {
                reject_forbidden_config(value)?;
            }
        }
        _ => {}
    }
    Ok(())
}

pub(crate) async fn run_one(store: &Store, dispatch: &Notify, run_id: &str) -> Result<(), String> {
    let run = store
        .get_chip_run(run_id)
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| format!("chip run {run_id} missing"))?;
    if run.status == "canceled" {
        return Err("canceled".into());
    }
    if run.status != "queued" {
        return Ok(());
    }
    store
        .append_execution_log(
            run_id,
            "info",
            "started",
            &format!("{} chip started", run.kind),
            None,
        )
        .await
        .map_err(|error| error.to_string())?;
    let work = async {
        match run.kind.as_str() {
            "extract" => run_extract(store, &run).await,
            "transform" => {
                store
                    .set_chip_run_running(run_id)
                    .await
                    .map_err(|error| error.to_string())?;
                run_transform(store, dispatch, &run).await
            }
            "load" => {
                store
                    .set_chip_run_running(run_id)
                    .await
                    .map_err(|error| error.to_string())?;
                run_load(store, &run).await
            }
            "validation" => {
                store
                    .set_chip_run_running(run_id)
                    .await
                    .map_err(|error| error.to_string())?;
                run_validation(store, &run).await
            }
            "sql" => {
                store
                    .set_chip_run_running(run_id)
                    .await
                    .map_err(|error| error.to_string())?;
                run_sql_chip(store, &run).await
            }
            "script" => {
                store
                    .set_chip_run_running(run_id)
                    .await
                    .map_err(|error| error.to_string())?;
                crate::script::run_script_chip(store, &run).await
            }
            "serve" => {
                let config: Value = serde_json::from_str(&run.config_snapshot_json)
                    .map_err(|error| format!("invalid serve config snapshot: {error}"))?;
                crate::serve::parse_serve_config(&config)
                    .map_err(|error| error.message().to_string())?;
                store
                    .set_chip_run_running(run_id)
                    .await
                    .map_err(|error| error.to_string())?;
                let slug = config.get("slug").and_then(Value::as_str).unwrap_or("");
                let result =
                    serde_json::json!({ "slug": slug, "path": format!("/p/{slug}") }).to_string();
                store
                    .set_chip_run_succeeded_with_result(run_id, Some(&result), None)
                    .await
                    .map_err(|error| error.to_string())
            }
            kind => Err(format!("unsupported chip kind {kind}")),
        }
    };
    let result = tokio::select! {
        _ = store.wait_until_step_canceled(run_id) => Err("canceled".into()),
        result = work => result,
    };
    if store.step_is_canceled(run_id).await.unwrap_or(false) {
        return Err("canceled".into());
    }
    match &result {
        Ok(()) => {
            store
                .append_execution_log(
                    run_id,
                    "info",
                    "completed",
                    &format!("{} chip completed", run.kind),
                    None,
                )
                .await
                .map_err(|error| error.to_string())?;
        }
        Err(_) => {}
    }
    result
}

async fn run_sql_chip(store: &Store, run: &ChipRunRow) -> Result<(), String> {
    let config: Value = serde_json::from_str(&run.config_snapshot_json)
        .map_err(|error| format!("invalid SQL config snapshot: {error}"))?;
    let connection_id = config
        .get("connection_id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if connection_id.is_empty() {
        return Err("connection_id required".into());
    }
    let sql_text = config.get("sql_text").and_then(Value::as_str).unwrap_or("");
    let database = config
        .get("database")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let schema = config
        .get("schema")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let base = store
        .live_connection(connection_id)
        .await
        .map_err(|error| error.to_string())?;
    if base.driver == "http" {
        return Err("http connection cannot run SQL".into());
    }
    let live = with_database(&base, database);
    let outcome = run_sql_script(&live, sql_text, 1000, None, schema)
        .await
        .map_err(|error| error.to_string())?;
    store
        .append_execution_log(
            &run.id,
            "info",
            "sql_completed",
            &format!(
                "kind={} schema={} rows={} elapsed_ms={} truncated={}",
                outcome.kind,
                schema.unwrap_or("-"),
                outcome.row_count,
                outcome.elapsed_ms,
                outcome.truncated,
            ),
            None,
        )
        .await
        .map_err(|error| error.to_string())?;
    let result_json = serde_json::json!({
        "kind": outcome.kind,
        "row_count": outcome.row_count,
        "elapsed_ms": outcome.elapsed_ms,
        "truncated": outcome.truncated,
    })
    .to_string();
    store
        .set_chip_run_succeeded_with_result(
            &run.id,
            Some(&result_json),
            Some(outcome.row_count as i64),
        )
        .await
        .map_err(|error| error.to_string())
}

async fn run_validation(store: &Store, run: &ChipRunRow) -> Result<(), String> {
    let mut config: ValidationConfig = serde_json::from_str(&run.config_snapshot_json)
        .map_err(|error| format!("invalid validation config snapshot: {error}"))?;
    if let Some(rule_id) = config.validation_rule_id.as_deref() {
        let rule = store
            .get_validation_rule(rule_id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "validation rule not found".to_string())?;
        if rule.active == 0 {
            return Err("validation rule is inactive".into());
        }
        crate::validation::apply_rule_defaults(
            &mut config.keys,
            &mut config.columns,
            &mut config.compare_row_count,
            &mut config.compare_schema,
            &rule,
        )
        .map_err(|error| error.message().to_string())?;
    }
    if config.keys.iter().all(|key| key.trim().is_empty()) {
        return Err("at least one validation key required".into());
    }
    let source = store
        .get_dataset(&config.source_data_file_id)
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "validation source data file not found".to_string())?;
    let (target, ignore_extra_keys, compare_row_count, compare_schema) =
        if let Some(load_chip_id) = config.target_load_chip_id.as_deref() {
            let loaded =
                materialize_load_target(store, run, load_chip_id, &config.keys, &config.columns)
                    .await?;
            (
                loaded.dataset,
                loaded.ignore_extra_keys,
                config.compare_row_count && !loaded.ignore_extra_keys,
                false,
            )
        } else {
            let target_id = run
                .input_dataset_id
                .as_deref()
                .ok_or_else(|| "validation target input missing".to_string())?;
            let target = store
                .get_dataset(target_id)
                .await
                .map_err(|error| error.to_string())?
                .ok_or_else(|| "validation target data file not found".to_string())?;
            (
                target,
                false,
                config.compare_row_count,
                config.compare_schema,
            )
        };
    let source_path = store.resolve(&source.stored_path);
    let target_path = store.resolve(&target.stored_path);
    let source_read = TransformSpec::identity()
        .with_read(source.delimiter, source.has_header.map(|value| value != 0));
    let target_read = TransformSpec::identity()
        .with_read(target.delimiter, target.has_header.map(|value| value != 0));
    let spec = ValidationSpec {
        keys: config.keys.clone(),
        columns: config.columns.clone(),
        compare_row_count,
        compare_schema,
        ignore_extra_keys,
    };
    let report = tokio::task::spawn_blocking(move || {
        PolarsEngine.validate_files(
            &source_path,
            &target_path,
            &source_read,
            &target_read,
            &spec,
        )
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())?;
    let result_json = serde_json::to_string(&report).map_err(|error| error.to_string())?;
    store
        .append_execution_log(
            &run.id,
            if report.passed { "info" } else { "warn" },
            "validation_completed",
            &format!(
                "passed={} source_rows={} target_rows={} mismatched_rows={}",
                report.passed, report.source_rows, report.target_rows, report.mismatched_rows
            ),
            None,
        )
        .await
        .map_err(|error| error.to_string())?;
    store
        .finish_validation_chip_run(
            &run.id,
            report.passed,
            &result_json,
            report.source_rows as i64,
            report.target_rows as i64,
        )
        .await
        .map_err(|error| error.to_string())?;
    let chip = store
        .get_chip(&run.chip_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "validation chip not found".to_string())?;
    store
        .insert_validation_result(
            &chip.owner_user_id,
            &run.workspace_id,
            config.validation_rule_id.as_deref(),
            Some(&run.id),
            &config.source_data_file_id,
            &target.id,
            report.passed,
            &result_json,
        )
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

struct LoadTargetReadback {
    dataset: storage::DatasetRow,
    ignore_extra_keys: bool,
}

async fn materialize_load_target(
    store: &Store,
    run: &ChipRunRow,
    load_chip_id: &str,
    keys: &[String],
    columns: &[String],
) -> Result<LoadTargetReadback, String> {
    let load_config = load_config_for_validation(store, run, load_chip_id).await?;
    let ignore_extra_keys = matches!(load_config.write_mode.as_str(), "append" | "upsert");
    let rel = format!("staging/validation-{}.csv", run.id);
    let dest = store.resolve(&rel);
    match load_config.destination {
        crate::load::LoadDestination::Database {
            connection_id,
            database,
            table,
        } => {
            let base = store
                .live_connection(&connection_id)
                .await
                .map_err(|error| error.to_string())?;
            let live = with_database(&base, database.as_deref());
            let select_cols = unique_idents(keys, columns);
            let opts = ExtractOptions::default();
            if select_cols.is_empty() {
                extract_table(&live, &table, &dest, &opts, None)
                    .await
                    .map_err(|error| error.to_string())?;
            } else {
                let sql = table_select_sql(&live.driver, &table, &select_cols)
                    .map_err(|error| error.to_string())?;
                extract_query(&live, &sql, &dest, &opts, None)
                    .await
                    .map_err(|error| error.to_string())?;
            }
        }
        crate::load::LoadDestination::File { filename, .. } => {
            let file_rel = format!("loads/{}/{load_chip_id}/{filename}", run.workspace_id);
            let source = store.resolve(&file_rel);
            if !source.is_file() {
                return Err("load destination file is missing".into());
            }
            if let Some(parent) = dest.parent() {
                tokio::fs::create_dir_all(parent)
                    .await
                    .map_err(|error| error.to_string())?;
            }
            tokio::fs::copy(&source, &dest)
                .await
                .map_err(|error| error.to_string())?;
        }
    }
    let size = tokio::fs::metadata(&dest)
        .await
        .ok()
        .and_then(|meta| i64::try_from(meta.len()).ok());
    let dataset = store
        .upsert_dataset(&DatasetUpsert {
            id: uuid::Uuid::new_v4().to_string(),
            kind: "database".into(),
            extract_id: None,
            filename: format!("validation-readback-{}.csv", run.id),
            stored_path: rel,
            size_bytes: size,
            delimiter: Some(",".into()),
            has_header: Some(true),
            row_count: None,
            workspace_id: Some(run.workspace_id.clone()),
        })
        .await
        .map_err(|error| error.to_string())?;
    Ok(LoadTargetReadback {
        dataset,
        ignore_extra_keys,
    })
}

async fn load_config_for_validation(
    store: &Store,
    run: &ChipRunRow,
    load_chip_id: &str,
) -> Result<crate::load::LoadConfig, String> {
    let runs = store
        .list_chip_runs(&run.workspace_id)
        .await
        .map_err(|error| error.to_string())?;
    if let Some(load_run) = runs
        .iter()
        .find(|item| item.execution_id == run.execution_id && item.chip_id == load_chip_id)
    {
        return serde_json::from_str(&load_run.config_snapshot_json)
            .map_err(|error| format!("invalid load config snapshot: {error}"));
    }
    let chip = store
        .get_chip(load_chip_id)
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "load chip not found".to_string())?;
    let raw = store
        .resolve_chip_config_json(&chip)
        .await
        .map_err(|error| error.to_string())?;
    serde_json::from_str(&raw).map_err(|error| format!("invalid load config: {error}"))
}

fn unique_idents(keys: &[String], columns: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    for name in keys.iter().chain(columns) {
        let name = name.trim();
        if name.is_empty() || out.iter().any(|item| item == name) {
            continue;
        }
        out.push(name.to_string());
    }
    out
}

async fn run_load(store: &Store, run: &ChipRunRow) -> Result<(), String> {
    let config: crate::load::LoadConfig = serde_json::from_str(&run.config_snapshot_json)
        .map_err(|error| format!("invalid load config snapshot: {error}"))?;
    let dataset_id = run
        .input_dataset_id
        .as_deref()
        .ok_or_else(|| "load input_dataset_id missing".to_string())?;
    let dataset = store
        .get_dataset(dataset_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "input dataset not found".to_string())?;
    store
        .append_execution_log(
            &run.id,
            "info",
            "load_started",
            &format!(
                "적재를 시작합니다. 파일: {}{}",
                dataset.filename,
                dataset
                    .row_count
                    .map(|rows| format!(", 입력 {rows}행"))
                    .unwrap_or_default()
            ),
            None,
        )
        .await
        .map_err(|error| error.to_string())?;
    log_load_input_quality(store, &run.id, &dataset).await?;
    let result = execute_load_config(
        store,
        &config,
        &dataset,
        &run.workspace_id,
        &run.chip_id,
        &run.id,
    )
    .await?;
    store
        .insert_load_result(
            &run.id,
            &result.destination,
            &config.write_mode,
            dataset.row_count,
            result.loaded_rows,
            result.input_bytes,
            result.duration_ms,
            result.artifact_path.as_deref(),
        )
        .await
        .map_err(|e| e.to_string())?;
    store
        .append_execution_log(
            &run.id,
            "info",
            "load_completed",
            &format!(
                "적재가 완료되었습니다. {}행 → {} ({}ms)",
                result.loaded_rows, result.destination, result.duration_ms
            ),
            None,
        )
        .await
        .map_err(|error| error.to_string())?;
    store
        .set_load_chip_run_succeeded(&run.id)
        .await
        .map_err(|e| e.to_string())
}

const MAX_EMPTY_CELL_LOGS: usize = 100;

#[derive(Debug)]
struct EmptyCellIssue {
    row_number: u64,
    column: String,
}

#[derive(Debug)]
struct InputQuality {
    rows_scanned: u64,
    empty_cells: u64,
    issues: Vec<EmptyCellIssue>,
}

async fn log_load_input_quality(
    store: &Store,
    run_id: &str,
    dataset: &storage::DatasetRow,
) -> Result<(), String> {
    let path = store.resolve(&dataset.stored_path);
    if path
        .extension()
        .and_then(|v| v.to_str())
        .map(|v| v.eq_ignore_ascii_case("parquet"))
        .unwrap_or(false)
    {
        return Ok(());
    }
    let delimiter = dataset.delimiter.as_deref().unwrap_or(",");
    let delimiter = connectors::parse_delimiter(delimiter).map_err(|e| e.to_string())?;
    let has_header = dataset.has_header.unwrap_or(1) != 0;
    let quality =
        tokio::task::spawn_blocking(move || inspect_delimited_input(&path, delimiter, has_header))
            .await
            .map_err(|e| e.to_string())??;
    for issue in &quality.issues {
        let context = serde_json::json!({
            "process": "load",
            "stage": "validate_input",
            "error_code": "LOAD_INPUT_EMPTY_VALUE",
            "row_number": issue.row_number,
            "column": issue.column,
            "retryable": false,
        })
        .to_string();
        store
            .append_execution_log(
                run_id,
                "warn",
                "load_input_empty_value",
                &format!(
                    "입력 데이터 {}번째 행의 '{}' 컬럼이 비어 있습니다.",
                    issue.row_number, issue.column
                ),
                Some(&context),
            )
            .await
            .map_err(|e| e.to_string())?;
    }
    let context = serde_json::json!({
        "process": "load",
        "stage": "validate_input",
        "rows_scanned": quality.rows_scanned,
        "empty_cells": quality.empty_cells,
        "detail_logs": quality.issues.len(),
        "detail_limit": MAX_EMPTY_CELL_LOGS,
        "details_truncated": quality.empty_cells as usize > quality.issues.len(),
    })
    .to_string();
    store
        .append_execution_log(
            run_id,
            if quality.empty_cells == 0 {
                "info"
            } else {
                "warn"
            },
            "load_input_validated",
            &format!(
                "적재 입력 {}개 행을 검사했습니다. 빈 셀: {}개.",
                quality.rows_scanned, quality.empty_cells
            ),
            Some(&context),
        )
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn inspect_delimited_input(
    path: &std::path::Path,
    delimiter: u8,
    has_header: bool,
) -> Result<InputQuality, String> {
    let mut reader = csv::ReaderBuilder::new()
        .delimiter(delimiter)
        .has_headers(has_header)
        .from_path(path)
        .map_err(|e| format!("load input csv open failed: {e}"))?;
    let headers = if has_header {
        reader
            .headers()
            .map_err(|e| format!("load input csv header failed at row 1: {e}"))?
            .iter()
            .enumerate()
            .map(|(index, value)| {
                if value.trim().is_empty() {
                    format!("column_{}", index + 1)
                } else {
                    value.to_string()
                }
            })
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    let mut quality = InputQuality {
        rows_scanned: 0,
        empty_cells: 0,
        issues: Vec::new(),
    };
    for record in reader.records() {
        let record = record.map_err(|e| {
            let row = e
                .position()
                .map(|p| p.record())
                .unwrap_or(quality.rows_scanned + 1);
            format!("load input csv parse failed at row {row}: {e}")
        })?;
        quality.rows_scanned += 1;
        for (index, value) in record.iter().enumerate() {
            if value.trim().is_empty() {
                quality.empty_cells += 1;
                if quality.issues.len() < MAX_EMPTY_CELL_LOGS {
                    quality.issues.push(EmptyCellIssue {
                        row_number: quality.rows_scanned,
                        column: headers
                            .get(index)
                            .cloned()
                            .unwrap_or_else(|| format!("column_{}", index + 1)),
                    });
                }
            }
        }
    }
    Ok(quality)
}

struct LoadProgress {
    store: Store,
    run_id: String,
    total: Option<i64>,
    last_db: Mutex<Instant>,
}

impl LoadProgress {
    fn new(store: Store, run_id: String, total: Option<i64>) -> Self {
        Self {
            store,
            run_id,
            total,
            last_db: Mutex::new(Instant::now() - Duration::from_secs(10)),
        }
    }

    fn report(&self, n: u64) {
        let mut last = match self.last_db.lock() {
            Ok(guard) => guard,
            Err(_) => return,
        };
        if n != 1 && last.elapsed() < Duration::from_secs(2) && n % 10_000 != 0 {
            return;
        }
        *last = Instant::now();
        drop(last);
        let store = self.store.clone();
        let run_id = self.run_id.clone();
        let message = match self.total.filter(|total| *total > 0) {
            Some(total) => format!(
                "{n} / {total}행을 적재했습니다. ({}%)",
                ((n as f64 / total as f64) * 100.0).round() as u64
            ),
            None => format!("{n}개 행을 적재했습니다."),
        };
        let context = serde_json::json!({
            "process": "load",
            "stage": "write_destination",
            "rows_loaded": n,
            "input_rows": self.total,
        })
        .to_string();
        tokio::spawn(async move {
            let _ = store.set_load_progress(&run_id, n as i64).await;
            let _ = store
                .append_execution_log(&run_id, "info", "load_progress", &message, Some(&context))
                .await;
        });
    }
}

pub(crate) struct LoadExecution {
    pub destination: String,
    pub loaded_rows: i64,
    pub input_bytes: Option<i64>,
    pub duration_ms: i64,
    pub artifact_path: Option<String>,
}

pub(crate) async fn execute_load_config(
    store: &Store,
    config: &crate::load::LoadConfig,
    dataset: &storage::DatasetRow,
    workspace_id: &str,
    scope_id: &str,
    run_id: &str,
) -> Result<LoadExecution, String> {
    let input = store.resolve(&dataset.stored_path);
    let input_bytes = std::fs::metadata(&input).ok().map(|m| m.len() as i64);
    let started = Instant::now();
    store
        .append_execution_log(
            run_id,
            "info",
            "load_preparing",
            "입력 파일을 적재용으로 준비합니다.",
            None,
        )
        .await
        .map_err(|error| error.to_string())?;
    let progress = LoadProgress::new(store.clone(), run_id.to_string(), dataset.row_count);
    let (destination, loaded_rows, artifact_path) = match &config.destination {
        crate::load::LoadDestination::Database {
            connection_id,
            database,
            table,
        } => {
            let csv = prepare_load_csv(store, run_id, dataset, Some(LOAD_NULL_MARKER)).await?;
            store
                .append_execution_log(
                    run_id,
                    "info",
                    "load_prepared",
                    "적재 입력을 준비했습니다. 테이블에 쓰기를 시작합니다.",
                    None,
                )
                .await
                .map_err(|error| error.to_string())?;
            let base = store
                .live_connection(connection_id)
                .await
                .map_err(|e| e.to_string())?;
            let live = connectors::with_database(&base, database.as_deref());
            let dest = format!("{}:{}", live.name, table);
            store
                .append_execution_log(
                    run_id,
                    "info",
                    "load_writing",
                    &format!(
                        "대상 {}에 {} 방식으로 적재를 시작합니다.{}",
                        dest,
                        config.write_mode,
                        dataset
                            .row_count
                            .map(|rows| format!(" 입력 {rows}행"))
                            .unwrap_or_default()
                    ),
                    None,
                )
                .await
                .map_err(|error| error.to_string())?;
            let on_progress = |n: u64| progress.report(n);
            let loaded = load_table(
                &live,
                table,
                &csv,
                &config.write_mode,
                &config.conflict_keys,
                Some(LOAD_NULL_MARKER),
                Some(&on_progress),
            )
            .await
            .map_err(|e| e.to_string())? as i64;
            (dest, loaded, None)
        }
        crate::load::LoadDestination::File { format, filename } => {
            store
                .append_execution_log(
                    run_id,
                    "info",
                    "load_writing",
                    &format!("파일 {filename}로 적재를 시작합니다."),
                    None,
                )
                .await
                .map_err(|error| error.to_string())?;
            let rel = format!("loads/{workspace_id}/{scope_id}/{filename}");
            let output = store.resolve(&rel);
            if let Some(parent) = output.parent() {
                tokio::fs::create_dir_all(parent)
                    .await
                    .map_err(|e| e.to_string())?;
            }
            let staging_rel = format!("{rel}.{run_id}.tmp");
            let staging_path = store.resolve(&staging_rel);
            let mut staging = storage::chip_slot::StagingFile::new(staging_path.clone());
            if format == "csv" {
                let csv = prepare_load_csv(store, run_id, dataset, None).await?;
                tokio::fs::copy(csv, staging.path())
                    .await
                    .map_err(|e| e.to_string())?;
            } else if input
                .extension()
                .and_then(|v| v.to_str())
                .map(|v| v.eq_ignore_ascii_case("parquet"))
                .unwrap_or(false)
            {
                tokio::fs::copy(&input, staging.path())
                    .await
                    .map_err(|e| e.to_string())?;
            } else {
                let input = input.clone();
                let staging_path = staging_path.clone();
                let delimiter = dataset.delimiter.clone();
                let header = dataset.has_header.map(|v| v != 0);
                tokio::task::spawn_blocking(move || {
                    PolarsEngine.transform(
                        &input,
                        &staging_path,
                        &TransformSpec::identity().with_read(delimiter, header),
                    )
                })
                .await
                .map_err(|e| e.to_string())?
                .map_err(|e| e.to_string())?;
            }
            storage::chip_slot::publish(staging.path(), &output).map_err(|e| e.to_string())?;
            staging.keep();
            let loaded = dataset.row_count.unwrap_or(0);
            progress.report(loaded as u64);
            (rel.clone(), loaded, Some(rel))
        }
    };
    Ok(LoadExecution {
        destination,
        loaded_rows,
        input_bytes,
        duration_ms: started.elapsed().as_millis() as i64,
        artifact_path,
    })
}

async fn prepare_load_csv(
    store: &Store,
    run_id: &str,
    dataset: &storage::DatasetRow,
    null_value: Option<&'static str>,
) -> Result<std::path::PathBuf, String> {
    let input = store.resolve(&dataset.stored_path);
    let canonical = store.resolve(&format!("staging/load-{run_id}.csv"));
    if let Some(parent) = canonical.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| e.to_string())?;
    }
    if input
        .extension()
        .and_then(|v| v.to_str())
        .map(|v| v.eq_ignore_ascii_case("parquet"))
        .unwrap_or(false)
    {
        let source = input.clone();
        let target = canonical.clone();
        tokio::task::spawn_blocking(move || {
            PolarsEngine::export_csv_with_null_value(&source, &target, null_value)
        })
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    } else if null_value.is_none()
        && dataset.delimiter.as_deref().unwrap_or(",") == ","
        && dataset.has_header.unwrap_or(1) != 0
    {
        return Ok(input);
    } else {
        let parquet = store.resolve(&format!("staging/load-{run_id}.parquet"));
        let source = input.clone();
        let parquet_target = parquet.clone();
        let delimiter = dataset.delimiter.clone();
        let header = dataset.has_header.map(|v| v != 0);
        tokio::task::spawn_blocking(move || {
            PolarsEngine.transform(
                &source,
                &parquet_target,
                &TransformSpec::identity().with_read(delimiter, header),
            )
        })
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
        let target = canonical.clone();
        tokio::task::spawn_blocking(move || {
            PolarsEngine::export_csv_with_null_value(&parquet, &target, null_value)
        })
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    }
    Ok(canonical)
}

async fn run_extract(store: &Store, run: &ChipRunRow) -> Result<(), String> {
    let config: ExtractConfig = serde_json::from_str(&run.config_snapshot_json)
        .map_err(|error| format!("invalid extract config snapshot: {error}"))?;
    let delimiter = config.delimiter.unwrap_or_else(|| ",".into());
    let header = config.header.unwrap_or(true);
    let add_sequence = config.add_sequence.unwrap_or(false);
    let output_filename = config.output_filename.clone();
    let (kind, table, sql, database) = match config.source {
        ExtractSource::Table { table, database } => ("database", table, None, database),
        ExtractSource::Query { sql, database } => ("database", "query".into(), Some(sql), database),
        ExtractSource::Http {
            request_type,
            method,
            path,
            query,
            headers,
            body,
            body_mode,
            form,
            timeout_ms,
            graphql_query,
            graphql_variables,
            graphql_operation_name,
            records_path,
        } => {
            let spec = HttpRequestSpec {
                request_type,
                method,
                path: path.clone(),
                query,
                headers,
                body,
                body_mode,
                form,
                timeout_ms,
                graphql_query,
                graphql_variables,
                graphql_operation_name,
                records_path,
            };
            let raw = serde_json::to_string(&json!({
                "type": "http",
                "request_type": spec.request_type,
                "method": spec.method,
                "path": spec.path,
                "query": spec.query,
                "headers": spec.headers,
                "body": spec.body,
                "body_mode": spec.body_mode,
                "form": spec.form,
                "timeout_ms": spec.timeout_ms,
                "graphql_query": spec.graphql_query,
                "graphql_variables": spec.graphql_variables,
                "graphql_operation_name": spec.graphql_operation_name,
                "records_path": spec.records_path,
            }))
            .map_err(|error| error.to_string())?;
            let table = if path.trim().is_empty() {
                "http".into()
            } else {
                path.trim().trim_matches('/').replace('/', "_")
            };
            ("api", table, Some(raw), None)
        }
    };
    let snapshot = json!({
        "kind": kind,
        "connection_id": config.connection_id,
        "table_name": table,
        "delimiter": delimiter,
        "header": header,
        "add_sequence": add_sequence,
        "sql_text": sql,
        "catalog_database": database,
        "output_filename": output_filename,
    });
    store
        .prepare_extract_chip_run(&run.id, &snapshot.to_string())
        .await
        .map_err(|error| error.to_string())?;
    crate::extract::run(store, &run.id).await
}

async fn run_transform(store: &Store, dispatch: &Notify, run: &ChipRunRow) -> Result<(), String> {
    let config: TransformConfig = serde_json::from_str(&run.config_snapshot_json)
        .map_err(|error| format!("invalid transform config snapshot: {error}"))?;
    let dataset_id = run
        .input_dataset_id
        .as_deref()
        .ok_or_else(|| "transform input_dataset_id missing".to_string())?;
    let dataset = store
        .get_dataset(dataset_id)
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "input dataset not found".to_string())?;
    if !store.resolve(&dataset.stored_path).is_file() {
        return Err("input dataset file missing".into());
    }
    let spec_json = serde_json::to_string(&config.spec).map_err(|error| error.to_string())?;
    let spec = TransformSpec::parse_json(&spec_json).map_err(|error| error.to_string())?;
    let file_delimiter = dataset
        .delimiter
        .clone()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            if run.execution_source != "workspace" {
                return None;
            }
            let path = store.resolve(&dataset.stored_path);
            let bytes = std::fs::read(&path).ok()?;
            sniff_delimiter(&bytes[..bytes.len().min(64 * 1024)])
        });
    let (delimiter, has_header) = transform_read_hints(
        &spec,
        file_delimiter.as_deref(),
        dataset.has_header,
        run.execution_source == "workspace",
    );
    let spec_json = serde_json::to_string(&spec.with_read(delimiter, has_header))
        .map_err(|error| error.to_string())?;
    let transform_id = if run.execution_source == "workspace" {
        store
            .get_execution_step(&run.id)
            .await
            .map_err(|error| error.to_string())?
            .and_then(|step| step.transform_id)
    } else {
        store
            .get_chip_binding(&run.chip_id)
            .await
            .map_err(|error| error.to_string())?
            .filter(|binding| binding.ref_kind == "transform")
            .map(|binding| binding.ref_id)
    }
    .ok_or_else(|| "transform chip has no transform definition".to_string())?;
    let job = store
        .insert_transform_job(
            &dataset.stored_path,
            &spec_json,
            &transform_id,
            &dataset.id,
            &run.workspace_id,
        )
        .await
        .map_err(|error| error.to_string())?;
    store
        .attach_chip_run_job(&run.id, &job.id)
        .await
        .map_err(|error| error.to_string())?;
    dispatch.notify_one();
    Ok(())
}

fn nonempty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

/// Canvas runs follow the file the extract chip wrote. Standalone recipes keep
/// the editor value so a user can correct a bad sniff.
fn transform_read_hints(
    spec: &TransformSpec,
    dataset_delimiter: Option<&str>,
    dataset_header: Option<i64>,
    workspace: bool,
) -> (Option<String>, Option<bool>) {
    let file = nonempty(dataset_delimiter);
    let recipe = nonempty(spec.delimiter());
    let delimiter = if workspace {
        file.or(recipe)
    } else {
        recipe.or(file)
    }
    .map(str::to_string);
    let file_header = dataset_header.map(|value| value != 0);
    let recipe_header = spec.has_header();
    let has_header = if workspace {
        file_header.or(recipe_header)
    } else {
        recipe_header.or(file_header)
    };
    (delimiter, has_header)
}

#[cfg(test)]
mod transform_read_hint_tests {
    use super::*;

    #[test]
    fn workspace_follows_extract_file_not_recipe_comma() {
        let spec = TransformSpec::identity().with_read(Some(",".into()), Some(true));
        let (delimiter, header) = transform_read_hints(&spec, Some("|"), Some(1), true);
        assert_eq!(delimiter.as_deref(), Some("|"));
        assert_eq!(header, Some(true));
    }

    #[test]
    fn standalone_keeps_editor_override() {
        let spec = TransformSpec::identity().with_read(Some("tab".into()), Some(false));
        let (delimiter, header) = transform_read_hints(&spec, Some(","), Some(1), false);
        assert_eq!(delimiter.as_deref(), Some("tab"));
        assert_eq!(header, Some(false));
    }
}
