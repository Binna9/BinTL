use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use connectors::{normalize_sql, parse_delimiter, parse_ident, parse_table, sql_kind, SqlKind};
use engine::TransformSpec;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use storage::{Store, TaskDefinitionRow, TaskRunRow};
use tokio::sync::{mpsc, Semaphore};

use crate::error::AppError;
use crate::state::AppState;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/api/workspaces/{id}/tasks",
            get(list_tasks).post(create_task),
        )
        .route(
            "/api/tasks/{id}",
            get(get_task).patch(update_task).delete(delete_task),
        )
        .route("/api/tasks/{id}/run", post(run_task))
        .route("/api/workspaces/{id}/runs", get(list_runs))
        .route("/api/task-runs/{id}", get(get_run))
        .route("/api/task-runs/{id}/logs", get(get_run_logs))
}

pub fn spawn_worker(
    store: Store,
    mut task_rx: mpsc::Receiver<String>,
    job_tx: mpsc::Sender<String>,
    semaphore: Arc<Semaphore>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        while let Some(run_id) = task_rx.recv().await {
            let permit = match semaphore.clone().acquire_owned().await {
                Ok(permit) => permit,
                Err(_) => break,
            };
            let store = store.clone();
            let job_tx = job_tx.clone();
            tokio::spawn(async move {
                let _permit = permit;
                if let Err(error) = run_one(&store, &job_tx, &run_id).await {
                    tracing::error!(run_id, %error, "task run failed");
                    let _ = store.set_task_run_failed(&run_id, &error).await;
                }
            });
        }
    })
}

#[derive(Deserialize)]
struct CreateTaskBody {
    name: String,
    kind: String,
    config: Value,
}

#[derive(Deserialize)]
struct PatchTaskBody {
    name: Option<String>,
    kind: Option<String>,
    config: Option<Value>,
    active: Option<bool>,
}

#[derive(Deserialize)]
struct RunTaskBody {
    #[serde(default)]
    input_dataset_id: Option<String>,
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

async fn list_tasks(
    State(state): State<AppState>,
    Path(workspace_id): Path<String>,
) -> Result<Json<Value>, AppError> {
    let tasks = state
        .store
        .list_task_definitions(&workspace_id)
        .await?
        .iter()
        .map(task_json)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Json(json!({ "tasks": tasks })))
}

async fn create_task(
    State(state): State<AppState>,
    Path(workspace_id): Path<String>,
    Json(body): Json<CreateTaskBody>,
) -> Result<(StatusCode, Json<Value>), AppError> {
    let config = validate_config(&state.store, &workspace_id, &body.kind, body.config).await?;
    let config_json =
        serde_json::to_string(&config).map_err(|error| AppError::bad(error.to_string()))?;
    let task = state
        .store
        .insert_task_definition(&workspace_id, &body.name, &body.kind, &config_json)
        .await?;
    Ok((StatusCode::CREATED, Json(task_json(&task)?)))
}

async fn get_task(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, AppError> {
    let task = require_task(&state.store, &id).await?;
    Ok(Json(task_json(&task)?))
}

async fn update_task(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<PatchTaskBody>,
) -> Result<Json<Value>, AppError> {
    let current = require_task(&state.store, &id).await?;
    if body.name.is_none() && body.kind.is_none() && body.config.is_none() && body.active.is_none()
    {
        return Ok(Json(task_json(&current)?));
    }
    let config_json = if body.kind.is_some() || body.config.is_some() {
        let kind = body.kind.as_deref().unwrap_or(current.kind.as_str());
        let raw_config = match body.config.as_ref() {
            Some(config) => config.clone(),
            None => serde_json::from_str(&current.config_json).map_err(|error| {
                AppError::bad(format!("stored task config is invalid: {error}"))
            })?,
        };
        let config = validate_config(&state.store, &current.workspace_id, kind, raw_config).await?;
        Some(serde_json::to_string(&config).map_err(|error| AppError::bad(error.to_string()))?)
    } else {
        None
    };
    let task = state
        .store
        .update_task_definition(
            &id,
            body.name.as_deref(),
            body.kind.as_deref(),
            config_json.as_deref(),
            body.active,
        )
        .await?;
    Ok(Json(task_json(&task)?))
}

async fn delete_task(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, AppError> {
    let _task = require_task(&state.store, &id).await?;
    state.store.delete_task_definition(&id).await?;
    Ok(Json(json!({ "ok": true })))
}

async fn run_task(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<RunTaskBody>,
) -> Result<Json<Value>, AppError> {
    let task = require_task(&state.store, &id).await?;
    if task.active == 0 {
        return Err(AppError::conflict("task is inactive"));
    }
    if task.kind == "load" {
        return Err(AppError::bad("load tasks are not supported"));
    }
    let config: Value = serde_json::from_str(&task.config_json)
        .map_err(|error| AppError::bad(format!("stored task config is invalid: {error}")))?;
    reject_forbidden_config(&config)?;

    let input_dataset_id = match task.kind.as_str() {
        "extract" => {
            if body.input_dataset_id.is_some() {
                return Err(AppError::bad(
                    "extract tasks do not accept input_dataset_id",
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
                return Err(AppError::bad("configure the extract task before running"));
            }
            None
        }
        "transform" => {
            let config =
                validate_transform_config(&state.store, &task.workspace_id, config).await?;
            let dataset_id = body
                .input_dataset_id
                .or(config.input_dataset_id)
                .ok_or_else(|| AppError::bad("transform input_dataset_id required"))?;
            let dataset = state
                .store
                .get_dataset(&dataset_id)
                .await?
                .ok_or_else(|| AppError::not_found("input dataset not found"))?;
            if dataset.workspace_id != task.workspace_id {
                return Err(AppError::bad("input dataset belongs to another workspace"));
            }
            if !state.store.resolve(&dataset.stored_path).is_file() {
                return Err(AppError::not_found("input dataset file missing"));
            }
            Some(dataset_id)
        }
        _ => return Err(AppError::bad("unsupported task kind")),
    };

    let run = state
        .store
        .create_task_run(&task.id, task.revision, input_dataset_id.as_deref())
        .await?;
    if state.task_tx.try_send(run.id.clone()).is_err() {
        let _ = state
            .store
            .set_task_run_failed(&run.id, "task queue full")
            .await;
        return Err(AppError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "task queue full",
        ));
    }
    Ok(Json(json!({
        "ok": true,
        "id": run.id,
        "status": "queued",
        "run": task_run_json(&run)?,
    })))
}

async fn list_runs(
    State(state): State<AppState>,
    Path(workspace_id): Path<String>,
) -> Result<Json<Value>, AppError> {
    let runs = state
        .store
        .list_task_runs(&workspace_id)
        .await?
        .iter()
        .map(task_run_json)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Json(json!({ "runs": runs })))
}

async fn get_run(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, AppError> {
    let run = state
        .store
        .get_task_run(&id)
        .await?
        .ok_or_else(|| AppError::not_found("task run not found"))?;
    Ok(Json(task_run_json(&run)?))
}

async fn get_run_logs(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, AppError> {
    let run = state
        .store
        .get_task_run(&id)
        .await?
        .ok_or_else(|| AppError::not_found("task run not found"))?;
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

async fn require_task(store: &Store, id: &str) -> Result<TaskDefinitionRow, AppError> {
    store
        .get_task_definition(id)
        .await?
        .ok_or_else(|| AppError::not_found("task not found"))
}

pub(crate) fn task_json(row: &TaskDefinitionRow) -> Result<Value, AppError> {
    let config = serde_json::from_str::<Value>(&row.config_json)
        .map_err(|error| AppError::bad(format!("stored task config is invalid: {error}")))?;
    Ok(json!({
        "id": row.id,
        "workspace_id": row.workspace_id,
        "name": row.name,
        "kind": row.kind,
        "config": config,
        "revision": row.revision,
        "active": row.active != 0,
        "created_at": row.created_at,
        "updated_at": row.updated_at,
    }))
}

fn task_run_json(row: &TaskRunRow) -> Result<Value, AppError> {
    let config_snapshot = serde_json::from_str::<Value>(&row.config_snapshot_json)
        .map_err(|error| AppError::bad(format!("stored task snapshot is invalid: {error}")))?;
    Ok(json!({
        "id": row.id,
        "task_id": row.task_id,
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
        "load" => Err(AppError::bad("load tasks are not supported")),
        _ => Err(AppError::bad(
            "task kind must be extract, transform, or load",
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
                        "task config must not contain `{key}`"
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
        .get_task_run(run_id)
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| format!("task run {run_id} missing"))?;
    if run.status != "queued" {
        return Ok(());
    }
    store
        .set_task_run_running(run_id)
        .await
        .map_err(|error| error.to_string())?;
    match run.kind.as_str() {
        "extract" => run_extract(store, &run).await,
        "transform" => run_transform(store, job_tx, &run).await,
        "load" => Err("load tasks are not supported".into()),
        kind => Err(format!("unsupported task kind {kind}")),
    }
}

async fn run_extract(store: &Store, run: &TaskRunRow) -> Result<(), String> {
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
            &config.connection_id,
            &table,
            &delimiter,
            header,
            false,
            sql.as_deref(),
            database.as_deref(),
        )
        .await
        .map_err(|error| error.to_string())?;
    store
        .attach_task_run_extract(&run.id, &extract.id)
        .await
        .map_err(|error| error.to_string())?;
    crate::extract::run(store, &extract.id).await
}

async fn run_transform(
    store: &Store,
    job_tx: &mpsc::Sender<String>,
    run: &TaskRunRow,
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
        .insert_transform_job(&dataset.stored_path, &spec_json, &run.task_id, &dataset.id)
        .await
        .map_err(|error| error.to_string())?;
    store
        .attach_task_run_job(&run.id, &job.id)
        .await
        .map_err(|error| error.to_string())?;
    if job_tx.try_send(job.id.clone()).is_err() {
        let error = "job queue full";
        let _ = store.fail_task_run_for_job(&job.id, error).await;
        return Err(error.into());
    }
    Ok(())
}
