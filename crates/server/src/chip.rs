use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use connectors::{normalize_sql, parse_delimiter, parse_ident, parse_table, sql_kind, SqlKind};
use engine::TransformSpec;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use storage::{ChipRow, ChipRunRow, RegisterExtractChip, RegisterTransformChip, Store};
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
            let source_json = serde_json::to_string(&source)
                .map_err(|error| AppError::bad(error.to_string()))?;
            state
                .store
                .register_extract_chip(&RegisterExtractChip {
                    name: name.to_string(),
                    owner_user_id: user.id().to_string(),
                    workspace_id: body.workspace_id.clone(),
                    kind: "database".into(),
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
        _ => return Err(AppError::bad("chip kind must be extract or transform")),
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
            if let Err(error) =
                queue_chip_run(&state, &user, &chip, workspace_id, None).await
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
    let chips = state
        .store
        .list_chips(&workspace_id)
        .await?;
    let mut out = Vec::with_capacity(chips.len());
    for chip in &chips {
        out.push(chip_json(&state.store, chip).await?);
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
        .insert_chip(user.id(), &workspace_id, &body.name, &body.kind, &config_json)
        .await?;
    Ok((StatusCode::CREATED, Json(chip_json(&state.store, &chip).await?)))
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
                let raw = state.store.resolve_chip_config_json(&current).await.map_err(|error| {
                    AppError::bad(error.to_string())
                })?;
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
        let config =
            validate_config(&state.store, &workspace_id, kind, raw_config).await?;
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
    access::require_workspace(&state.store, user, workspace_id).await?;
    if chip.active == 0 {
        return Err(AppError::conflict("chip is inactive"));
    }
    if chip.kind == "load" {
        return Err(AppError::bad("load chips are not supported"));
    }
    let config_raw = state
        .store
        .resolve_chip_config_json(chip)
        .await
        .map_err(|error| AppError::bad(error.to_string()))?;
    let config: Value = serde_json::from_str(&config_raw)
        .map_err(|error| AppError::bad(format!("stored chip config is invalid: {error}")))?;
    reject_forbidden_config(&config)?;

    let input_dataset_id = match chip.kind.as_str() {
        "extract" => {
            if requested_input.is_some() {
                return Err(AppError::bad(
                    "extract chips do not accept input_dataset_id",
                ));
            }
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
            None
        }
        "transform" => {
            let config =
                validate_transform_config(&state.store, workspace_id, config).await?;
            let dataset_id = resolve_transform_input(
                &state.store,
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
            Some(dataset_id)
        }
        _ => return Err(AppError::bad("unsupported chip kind")),
    };

    let run = state
        .store
        .create_chip_run(
            &chip.id,
            workspace_id,
            chip.revision,
            &config_raw,
            input_dataset_id.as_deref(),
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
    } else {
        String::new()
    };
    Ok(Json(json!({ "id": id, "text": text })))
}

async fn resolve_transform_input(
    store: &Store,
    workspace_id: &str,
    chip_id: &str,
    requested: Option<String>,
    config_input: Option<String>,
) -> Result<String, AppError> {
    if let Some(dataset_id) = requested {
        return Ok(dataset_id);
    }
    let incoming = store
        .list_chip_edges(workspace_id)
        .await?
        .into_iter()
        .filter(|edge| edge.to_chip_id == chip_id && edge.kind == "data")
        .collect::<Vec<_>>();
    if incoming.len() > 1 {
        return Err(AppError::bad(
            "multiple data edges into a chip are not supported",
        ));
    }
    if let Some(edge) = incoming.first() {
        return store
            .latest_chip_output_for_workspace(workspace_id, &edge.from_chip_id)
            .await?
            .ok_or_else(|| {
                AppError::bad("upstream chip has no succeeded output dataset")
            });
    }
    config_input.ok_or_else(|| AppError::bad("transform input_dataset_id required"))
}

pub(crate) async fn chip_json(store: &Store, row: &ChipRow) -> Result<Value, AppError> {
    let binding = store.get_chip_binding(&row.id).await.map_err(|error| {
        AppError::bad(error.to_string())
    })?;
    let config_raw = store.resolve_chip_config_json(row).await.map_err(|error| {
        AppError::bad(error.to_string())
    })?;
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
        "load" => Err(AppError::bad("load chips are not supported")),
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
    let _ = store
        .get_connection(&config.connection_id)
        .await?
        .ok_or_else(|| AppError::not_found("connection not found"))?;
    let source = match config.source {
        ExtractSource::Table { table, database } => {
            parse_table(&table).map_err(|error| AppError::bad(error.to_string()))?;
            validate_database(database.as_deref())?;
            json!({ "type": "table", "table": table.trim(), "database": database })
        }
        ExtractSource::Query { sql, database } => {
            let sql = normalize_sql(&sql).map_err(|error| AppError::bad(error.to_string()))?;
            if sql_kind(&sql) != SqlKind::Rows {
                return Err(AppError::bad(
                    "extract query needs a result set (SELECT / WITH / SHOW …)",
                ));
            }
            validate_database(database.as_deref())?;
            json!({ "type": "query", "sql": sql, "database": database })
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
    if spec.version != 2 {
        return Err(AppError::bad("transform spec must be version 2"));
    }
    if let Some(dataset_id) = config.input_dataset_id.as_deref() {
        let dataset = store
            .get_dataset(dataset_id)
            .await?
            .ok_or_else(|| AppError::not_found("input dataset not found"))?;
        if dataset.workspace_id != workspace_id {
            return Err(AppError::bad("input dataset belongs to another workspace"));
        }
    }
    Ok(TransformConfig {
        input_dataset_id: config.input_dataset_id,
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
        "load" => Err("load chips are not supported".into()),
        kind => Err(format!("unsupported chip kind {kind}")),
    }
}

async fn run_extract(store: &Store, run: &ChipRunRow) -> Result<(), String> {
    let config: ExtractConfig = serde_json::from_str(&run.config_snapshot_json)
        .map_err(|error| format!("invalid extract config snapshot: {error}"))?;
    let delimiter = config.delimiter.unwrap_or_else(|| ",".into());
    let header = config.header.unwrap_or(true);
    let (table, sql, database) = match config.source {
        ExtractSource::Table { table, database } => (table, None, database),
        ExtractSource::Query { sql, database } => ("query".into(), Some(sql), database),
    };
    let extract = store
        .insert_extract(
            "database",
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
