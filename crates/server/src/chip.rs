use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use connectors::{
    load_table, normalize_sql, parse_delimiter, parse_http_spec, parse_ident, parse_table, sql_kind, HttpKv,
    HttpRequestSpec, SqlKind,
};
use engine::{Engine, PolarsEngine, TransformSpec};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;
use storage::{ChipRow, ChipRunRow, RegisterExtractChip, RegisterLoadChip, RegisterTransformChip, Store};
use tokio::sync::{mpsc, Semaphore};

use crate::access::{self, CurrentUser};
use crate::error::AppError;
use crate::state::AppState;

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
        .route("/api/workspaces/{id}/runs", get(list_runs))
        .route("/api/chip-runs/{id}", get(get_run))
        .route("/api/chip-runs/{id}/logs", get(get_run_logs))
        .route(
            "/api/workspaces/{id}/chips/{chip_id}/input-slot",
            get(get_input_slot),
        )
}

pub fn spawn_worker(
    store: Store,
    mut chip_rx: mpsc::Receiver<String>,
    job_tx: mpsc::Sender<String>,
    semaphore: Arc<Semaphore>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        while let Some(run_id) = chip_rx.recv().await {
            let permit = match semaphore.clone().acquire_owned().await {
                Ok(permit) => permit,
                Err(_) => break,
            };
            let store = store.clone();
            let job_tx = job_tx.clone();
            tokio::spawn(async move {
                let _permit = permit;
                if let Err(error) = run_one(&store, &job_tx, &run_id).await {
                    tracing::error!(run_id, %error, "chip run failed");
                    let _ = store.set_chip_run_failed(&run_id, &error).await;
                }
            });
        }
    })
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
                    add_sequence: false,
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
            let load_definition_id = body.load_definition_id.as_deref().map(str::trim)
                .filter(|value| !value.is_empty()).ok_or_else(|| AppError::bad("load_definition_id required"))?;
            crate::load::require_load(&state.store, &user, load_definition_id).await?;
            state.store.register_load_chip(&RegisterLoadChip {
                name: name.to_string(), owner_user_id: user.id().to_string(),
                workspace_id: body.workspace_id.clone(), load_definition_id: load_definition_id.to_string(),
                place_on_workspace: body.place_on_workspace,
            }).await?
        }
        _ => return Err(AppError::bad("chip kind must be extract, transform, or load")),
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
            if let Err(error) = queue_chip_run(&state, &user, &chip, workspace_id, None).await {
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
    let config = validate_config(&state.store, &workspace_id, &body.kind, body.config).await?;
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
    Ok((
        StatusCode::CREATED,
        Json(chip_json(&state.store, &chip).await?),
    ))
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
    if body.name.is_none() && body.kind.is_none() && body.config.is_none() && body.active.is_none()
    {
        return Ok(Json(chip_json(&state.store, &current).await?));
    }
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
            .map_err(|error| AppError::bad(error.to_string()))?
            .ok_or_else(|| AppError::bad("chip is not placed on a workspace"))?;
        let config = validate_config(&state.store, &workspace_id, kind, raw_config).await?;
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
    Ok(Json(chip_json(&state.store, &chip).await?))
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
) -> Result<ChipRunRow, AppError> {
    match chip.kind.as_str() {
        "extract" => queue_extract_chip_run(state, user, chip, workspace_id, requested_input).await,
        "transform" => {
            queue_transform_chip_run(state, user, chip, workspace_id, requested_input).await
        }
        "load" => queue_load_chip_run(state, user, chip, workspace_id, requested_input).await,
        _ => {
            access::require_workspace(&state.store, user, workspace_id).await?;
            if chip.active == 0 {
                return Err(AppError::conflict("chip is inactive"));
            }
            Err(AppError::bad("unsupported chip kind"))
        }
    }
}

async fn queue_load_chip_run(
    state: &AppState, user: &CurrentUser, chip: &ChipRow, workspace_id: &str,
    requested_input: Option<String>,
) -> Result<ChipRunRow, AppError> {
    access::require_workspace(&state.store, user, workspace_id).await?;
    if chip.active == 0 { return Err(AppError::conflict("chip is inactive")); }
    let config_raw = state.store.resolve_chip_config_json(chip).await
        .map_err(|error| AppError::bad(error.to_string()))?;
    let value: Value = serde_json::from_str(&config_raw).map_err(|e| AppError::bad(e.to_string()))?;
    reject_forbidden_config(&value)?;
    crate::load::validate_load_config(&state.store, value).await?;
    let dataset_id = crate::planned_input::resolve_materialized_transform_input(
        state, user, workspace_id, &chip.id, requested_input, None,
    ).await?;
    let dataset = state.store.get_dataset(&dataset_id).await?
        .ok_or_else(|| AppError::not_found("input dataset not found"))?;
    if !state.store.resolve(&dataset.stored_path).is_file() { return Err(AppError::not_found("input dataset file missing")); }
    enqueue_chip_run(state, chip, workspace_id, &config_raw, Some(&dataset_id)).await
}

async fn queue_extract_chip_run(
    state: &AppState,
    user: &CurrentUser,
    chip: &ChipRow,
    workspace_id: &str,
    requested_input: Option<String>,
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
    enqueue_chip_run(state, chip, workspace_id, &config_raw, None).await
}

async fn queue_transform_chip_run(
    state: &AppState,
    user: &CurrentUser,
    chip: &ChipRow,
    workspace_id: &str,
    requested_input: Option<String>,
) -> Result<ChipRunRow, AppError> {
    access::require_workspace(&state.store, user, workspace_id).await?;
    if chip.active == 0 {
        return Err(AppError::conflict("chip is inactive"));
    }
    if chip.kind != "transform" {
        return Err(AppError::bad("expected transform chip"));
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
    enqueue_chip_run(state, chip, workspace_id, &config_raw, Some(&dataset_id)).await
}

async fn enqueue_chip_run(
    state: &AppState,
    chip: &ChipRow,
    workspace_id: &str,
    config_raw: &str,
    input_dataset_id: Option<&str>,
) -> Result<ChipRunRow, AppError> {
    let run = state
        .store
        .create_chip_run(
            &chip.id,
            workspace_id,
            chip.revision,
            config_raw,
            input_dataset_id,
        )
        .await?;
    if state.chip_tx.try_send(run.id.clone()).is_err() {
        let _ = state
            .store
            .set_chip_run_failed(&run.id, "chip queue full")
            .await;
        return Err(AppError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "chip queue full",
        ));
    }
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
    )
    .await?;
    Ok(Json(json!({
        "ok": true,
        "id": run.id,
        "status": "queued",
        "run": chip_run_json(&run)?,
    })))
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
    Ok(Json(json!({ "runs": runs })))
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
    let text = if let Some(extract_id) = run.legacy_extract_id {
        state
            .store
            .read_process_log(storage::LOG_EXTRACTS, &extract_id)
            .await?
    } else if let Some(job_id) = run.legacy_job_id {
        state
            .store
            .list_logs(&job_id)
            .await?
            .into_iter()
            .map(|log| format!("{}  {:<5}  {}", log.ts, log.level, log.message))
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
    } else {
        String::new()
    };
    Ok(Json(json!({ "id": id, "text": text })))
}

async fn get_input_slot(
    State(state): State<AppState>,
    user: CurrentUser,
    Path((workspace_id, chip_id)): Path<(String, String)>,
) -> Result<Json<Value>, AppError> {
    Ok(Json(
        crate::planned_input::get_transform_input_slot(&state, &user, &workspace_id, &chip_id)
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
    let run = queue_extract_chip_run(state, user, &chip, workspace_id, None).await?;
    wait_for_chip_run(state, &run.id).await
}

async fn wait_for_chip_run(state: &AppState, run_id: &str) -> Result<(), AppError> {
    for _ in 0..600 {
        tokio::time::sleep(Duration::from_millis(200)).await;
        let current = state
            .store
            .get_chip_run(run_id)
            .await?
            .ok_or_else(|| AppError::not_found("chip run not found"))?;
        match current.status.as_str() {
            "succeeded" => return Ok(()),
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
    Err(AppError::bad("chip run timed out"))
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
    Ok(json!({
        "id": row.id,
        "owner_user_id": row.owner_user_id,
        "name": row.name,
        "kind": row.kind,
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

async fn chip_json_for_workspace(
    store: &Store,
    row: &ChipRow,
    workspace_id: &str,
) -> Result<Value, AppError> {
    let mut value = chip_json(store, row).await?;
    value["output"] = chip_output_json(store, row, workspace_id).await?;
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
    } else {
        row.name.clone()
    };
    let filename = storage::chip_slot::display_filename(&output_name, &row.kind, delimiter);
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
    let Some(source_id) = source_id else { return Ok(None) };
    let Some(source) = store.get_chip(&source_id).await? else { return Ok(None) };
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
        "chip_id": row.chip_id,
        "workspace_id": row.workspace_id,
        "kind": row.kind,
        "status": row.status,
        "config_snapshot": config_snapshot,
        "revision_snapshot": row.revision_snapshot,
        "input_dataset_id": row.input_dataset_id,
        "output_dataset_id": row.output_dataset_id,
        "legacy_extract_id": row.legacy_extract_id,
        "legacy_job_id": row.legacy_job_id,
        "error_message": row.error_message,
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
        "load" => crate::load::validate_load_config(store, config).await
            .and_then(|value| serde_json::to_value(value).map_err(|e| AppError::bad(e.to_string()))),
        _ => Err(AppError::bad(
            "chip kind must be extract, transform, or load",
        )),
    }
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
        let dataset = store
            .get_dataset(dataset_id)
            .await?
            .ok_or_else(|| AppError::not_found("input dataset not found"))?;
        if dataset.workspace_id != workspace_id {
            return Err(AppError::bad("input dataset belongs to another workspace"));
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

async fn run_one(store: &Store, job_tx: &mpsc::Sender<String>, run_id: &str) -> Result<(), String> {
    let run = store
        .get_chip_run(run_id)
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| format!("chip run {run_id} missing"))?;
    if run.status != "queued" {
        return Ok(());
    }
    store
        .set_chip_run_running(run_id)
        .await
        .map_err(|error| error.to_string())?;
    match run.kind.as_str() {
        "extract" => run_extract(store, &run).await,
        "transform" => run_transform(store, job_tx, &run).await,
        "load" => run_load(store, &run).await,
        kind => Err(format!("unsupported chip kind {kind}")),
    }
}

async fn run_load(store: &Store, run: &ChipRunRow) -> Result<(), String> {
    let config: crate::load::LoadConfig = serde_json::from_str(&run.config_snapshot_json)
        .map_err(|error| format!("invalid load config snapshot: {error}"))?;
    let dataset_id = run.input_dataset_id.as_deref().ok_or_else(|| "load input_dataset_id missing".to_string())?;
    let dataset = store.get_dataset(dataset_id).await.map_err(|e| e.to_string())?
        .ok_or_else(|| "input dataset not found".to_string())?;
    let input = store.resolve(&dataset.stored_path);
    let input_bytes = std::fs::metadata(&input).ok().map(|m| m.len() as i64);
    let started = std::time::Instant::now();

    let (destination, loaded_rows, artifact_path) = match config.destination {
        crate::load::LoadDestination::Database { connection_id, database, table } => {
            let csv = prepare_load_csv(store, run, &dataset).await?;
            let base = store.live_connection(&connection_id).await.map_err(|e| e.to_string())?;
            let live = connectors::with_database(&base, database.as_deref());
            let loaded = load_table(&live, &table, &csv, &config.write_mode, &config.conflict_keys).await.map_err(|e| e.to_string())? as i64;
            (format!("{}:{}", live.name, table), loaded, None)
        }
        crate::load::LoadDestination::File { format, filename } => {
            let rel = format!("loads/{}/{}/{}", run.workspace_id, run.chip_id, filename);
            let output = store.resolve(&rel);
            if let Some(parent) = output.parent() { tokio::fs::create_dir_all(parent).await.map_err(|e| e.to_string())?; }
            if format == "csv" {
                let csv = prepare_load_csv(store, run, &dataset).await?;
                tokio::fs::copy(csv, &output).await.map_err(|e| e.to_string())?;
            } else if input.extension().and_then(|v| v.to_str()).map(|v| v.eq_ignore_ascii_case("parquet")).unwrap_or(false) {
                tokio::fs::copy(&input, &output).await.map_err(|e| e.to_string())?;
            } else {
                let input = input.clone();
                let output = output.clone();
                let delimiter = dataset.delimiter.clone();
                let header = dataset.has_header.map(|v| v != 0);
                tokio::task::spawn_blocking(move || PolarsEngine.transform(&input, &output, &TransformSpec::identity().with_read(delimiter, header)))
                    .await.map_err(|e| e.to_string())?.map_err(|e| e.to_string())?;
            }
            (rel.clone(), dataset.row_count.unwrap_or(0), Some(rel))
        }
    };
    store.insert_load_result(&run.id, &destination, &config.write_mode, dataset.row_count, loaded_rows,
        input_bytes, started.elapsed().as_millis() as i64, artifact_path.as_deref()).await.map_err(|e| e.to_string())?;
    store.set_load_chip_run_succeeded(&run.id).await.map_err(|e| e.to_string())
}

async fn prepare_load_csv(store: &Store, run: &ChipRunRow, dataset: &storage::DatasetRow) -> Result<std::path::PathBuf, String> {
    let input = store.resolve(&dataset.stored_path);
    let canonical = store.resolve(&format!("staging/load-{}.csv", run.id));
    if let Some(parent) = canonical.parent() { tokio::fs::create_dir_all(parent).await.map_err(|e| e.to_string())?; }
    if input.extension().and_then(|v| v.to_str()).map(|v| v.eq_ignore_ascii_case("parquet")).unwrap_or(false) {
        let source = input.clone();
        let target = canonical.clone();
        tokio::task::spawn_blocking(move || PolarsEngine::export_csv(&source, &target))
            .await.map_err(|e| e.to_string())?.map_err(|e| e.to_string())?;
    } else if dataset.delimiter.as_deref().unwrap_or(",") == "," && dataset.has_header.unwrap_or(1) != 0 {
        return Ok(input);
    } else {
        let parquet = store.resolve(&format!("staging/load-{}.parquet", run.id));
        let source = input.clone();
        let parquet_target = parquet.clone();
        let delimiter = dataset.delimiter.clone();
        let header = dataset.has_header.map(|v| v != 0);
        tokio::task::spawn_blocking(move || PolarsEngine.transform(&source, &parquet_target, &TransformSpec::identity().with_read(delimiter, header)))
            .await.map_err(|e| e.to_string())?.map_err(|e| e.to_string())?;
        let target = canonical.clone();
        tokio::task::spawn_blocking(move || PolarsEngine::export_csv(&parquet, &target))
            .await.map_err(|e| e.to_string())?.map_err(|e| e.to_string())?;
    }
    Ok(canonical)
}

async fn run_extract(store: &Store, run: &ChipRunRow) -> Result<(), String> {
    let config: ExtractConfig = serde_json::from_str(&run.config_snapshot_json)
        .map_err(|error| format!("invalid extract config snapshot: {error}"))?;
    let delimiter = config.delimiter.unwrap_or_else(|| ",".into());
    let header = config.header.unwrap_or(true);
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
    let extract = store
        .insert_extract(
            kind,
            &config.connection_id,
            &table,
            &delimiter,
            header,
            false,
            sql.as_deref(),
            database.as_deref(),
            &run.workspace_id,
            None,
        )
        .await
        .map_err(|error| error.to_string())?;
    store
        .attach_chip_run_extract(&run.id, &extract.id)
        .await
        .map_err(|error| error.to_string())?;
    crate::extract::run(store, &extract.id).await
}

async fn run_transform(
    store: &Store,
    job_tx: &mpsc::Sender<String>,
    run: &ChipRunRow,
) -> Result<(), String> {
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
    let delimiter = spec
        .delimiter()
        .map(str::to_string)
        .or(dataset.delimiter.clone());
    let has_header = spec
        .has_header()
        .or_else(|| dataset.has_header.map(|value| value != 0));
    let spec_json = serde_json::to_string(&spec.with_read(delimiter, has_header))
        .map_err(|error| error.to_string())?;
    let job = store
        .insert_transform_job(
            &dataset.stored_path,
            &spec_json,
            &run.chip_id,
            &dataset.id,
            &run.workspace_id,
        )
        .await
        .map_err(|error| error.to_string())?;
    store
        .attach_chip_run_job(&run.id, &job.id)
        .await
        .map_err(|error| error.to_string())?;
    if job_tx.try_send(job.id.clone()).is_err() {
        let error = "job queue full";
        let _ = store.fail_chip_run_for_job(&job.id, error).await;
        return Err(error.into());
    }
    Ok(())
}
