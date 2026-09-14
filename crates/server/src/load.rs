use axum::extract::{Path, State};
use axum::routing::get;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use storage::LoadDefinitionRow;

use crate::access::{self, CurrentUser};
use crate::error::AppError;
use crate::state::AppState;

#[derive(Debug, Clone, Deserialize, Serialize)]
pub(crate) struct LoadConfig {
    #[serde(default)]
    pub input_dataset_id: Option<String>,
    pub destination: LoadDestination,
    #[serde(default = "default_write_mode")]
    pub write_mode: String,
    #[serde(default)]
    pub conflict_keys: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(crate) enum LoadDestination {
    Database {
        connection_id: String,
        #[serde(default)]
        database: Option<String>,
        table: String,
    },
    File {
        format: String,
        filename: String,
    },
}

fn default_write_mode() -> String {
    "append".into()
}

#[derive(Deserialize)]
struct SaveLoadBody {
    name: String,
    spec: Value,
    #[serde(default)]
    input_chip_id: Option<String>,
}

#[derive(Deserialize)]
struct RunLoadBody {
    spec: Value,
    #[serde(default)]
    load_id: Option<String>,
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/loads", get(list_loads).post(create_load))
        .route("/api/loads/run", axum::routing::post(run_load))
        .route(
            "/api/loads/{id}",
            get(get_load).put(update_load).delete(delete_load),
        )
        .route("/api/loads/{id}/last-run", get(last_load_run))
}

async fn run_load(
    State(state): State<AppState>,
    user: CurrentUser,
    Json(body): Json<RunLoadBody>,
) -> Result<Json<Value>, AppError> {
    access::require_etl_run(&user)?;
    let config = validate_load_config(&state.store, body.spec).await?;
    let dataset_id = config
        .input_dataset_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::bad("input_dataset_id required"))?;
    let dataset = crate::access::require_dataset(&state.store, &user, dataset_id).await?;
    if dataset.status != "materialized" || !state.store.resolve(&dataset.stored_path).is_file() {
        return Err(AppError::bad("input dataset is not materialized"));
    }
    let snapshot = serde_json::to_string(&config).map_err(|e| AppError::bad(e.to_string()))?;
    let step = state
        .store
        .create_standalone_load_step(
            &dataset.workspace_id,
            Some(user.id()),
            &snapshot,
            &dataset.id,
            body.load_id.as_deref(),
        )
        .await?;
    let run_id = step.id;
    state.wake();
    wait_for_load_step(&state, &run_id).await?;
    let result = state
        .store
        .get_load_result(&run_id)
        .await?
        .ok_or_else(|| AppError::bad("load result missing"))?;
    Ok(Json(json!({
        "ok": true,
        "run_id": run_id,
        "destination": result.destination,
        "write_mode": result.write_mode,
        "input_rows": result.input_rows,
        "loaded_rows": result.loaded_rows,
        "input_bytes": result.input_bytes,
        "duration_ms": result.duration_ms,
        "artifact_path": result.artifact_path,
    })))
}

async fn wait_for_load_step(state: &AppState, run_id: &str) -> Result<(), AppError> {
    loop {
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        let step = state
            .store
            .get_execution_step(run_id)
            .await?
            .ok_or_else(|| AppError::not_found("load run not found"))?;
        match step.status.as_str() {
            "succeeded" => return Ok(()),
            "canceled" => return Err(AppError::bad("canceled")),
            "failed" => {
                return Err(AppError::bad(
                    step.error_message
                        .filter(|value| !value.trim().is_empty())
                        .unwrap_or_else(|| "load failed".into()),
                ));
            }
            "queued" | "running" => {}
            other => {
                return Err(AppError::bad(format!(
                    "unexpected load status `{other}`"
                )))
            }
        }
    }
}

pub(crate) async fn run_queued(store: &storage::Store, id: &str) -> Result<(), String> {
    let step = store
        .get_execution_step(id)
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| format!("load {id} missing"))?;
    if step.status == "canceled" {
        return Err("canceled".into());
    }
    if step.status != "queued" {
        return Ok(());
    }
    let config: LoadConfig = serde_json::from_str(&step.definition_snapshot_json)
        .map_err(|error| format!("invalid load snapshot: {error}"))?;
    let dataset_id = config
        .input_dataset_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "input_dataset_id required".to_string())?;
    let dataset = store
        .get_dataset(dataset_id)
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "input dataset not found".to_string())?;
    let execution = store
        .get_execution(&step.execution_id)
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "load execution missing".to_string())?;
    store
        .set_execution_step_running(id, None)
        .await
        .map_err(|error| error.to_string())?;
    if store.step_is_canceled(id).await.unwrap_or(false) {
        return Err("canceled".into());
    }
    let scope_id = format!("standalone/{id}");
    let result = match crate::chip::execute_load_config(
        store,
        &config,
        &dataset,
        &execution.workspace_id,
        &scope_id,
        id,
    )
    .await
    {
        Ok(result) => result,
        Err(error) => {
            if error != "canceled" {
                let _ = store
                    .finish_execution_step(id, "failed", None, Some(&error))
                    .await;
            }
            return Err(error);
        }
    };
    store
        .insert_load_result(
            id,
            &result.destination,
            &config.write_mode,
            dataset.row_count,
            result.loaded_rows,
            result.input_bytes,
            result.duration_ms,
            result.artifact_path.as_deref(),
        )
        .await
        .map_err(|error| error.to_string())?;
    store
        .finish_execution_step(id, "succeeded", None, None)
        .await
        .map_err(|error| error.to_string())?;
    Ok(())
}

async fn last_load_run(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> Result<Json<Value>, AppError> {
    let load = require_load(&state.store, &user, &id).await?;
    match state
        .store
        .latest_load_result_for_definition(&load.id)
        .await?
    {
        Some(row) => Ok(Json(json!({
            "run": {
                "run_id": row.chip_run_id,
                "destination": row.destination,
                "write_mode": row.write_mode,
                "input_rows": row.input_rows,
                "loaded_rows": row.loaded_rows,
                "duration_ms": row.duration_ms,
                "finished_at": row.created_at,
            }
        }))),
        None => Ok(Json(json!({ "run": null }))),
    }
}

fn is_planned_input_contract(dataset_id: &str) -> bool {
    dataset_id.starts_with("contract:")
}

pub(crate) async fn validate_load_config(
    store: &storage::Store,
    value: Value,
) -> Result<LoadConfig, AppError> {
    let config: LoadConfig =
        serde_json::from_value(value).map_err(|e| AppError::bad(e.to_string()))?;
    if !matches!(
        config.write_mode.as_str(),
        "append" | "truncate" | "upsert" | "recreate" | "replace"
    ) {
        return Err(AppError::bad("unsupported write_mode"));
    }
    if config.write_mode == "upsert" && config.conflict_keys.is_empty() {
        return Err(AppError::bad("upsert requires at least one conflict key"));
    }
    for key in &config.conflict_keys {
        connectors::parse_ident(key).map_err(|e| AppError::bad(e.to_string()))?;
    }
    if let Some(dataset_id) = config
        .input_dataset_id
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        if !is_planned_input_contract(dataset_id) {
            store
                .get_dataset(dataset_id)
                .await?
                .ok_or_else(|| AppError::not_found("input dataset not found"))?;
        }
    }
    match &config.destination {
        LoadDestination::Database {
            connection_id,
            database,
            table,
        } => {
            let connection = store
                .get_connection(connection_id)
                .await?
                .ok_or_else(|| AppError::not_found("connection not found"))?;
            if connection.driver == "http" {
                return Err(AppError::bad(
                    "http connection cannot be a database load target",
                ));
            }
            connectors::parse_table(table).map_err(|e| AppError::bad(e.to_string()))?;
            if let Some(database) = database.as_deref().filter(|value| !value.trim().is_empty()) {
                connectors::parse_ident(database).map_err(|e| AppError::bad(e.to_string()))?;
            }
        }
        LoadDestination::File { format, filename } => {
            if !matches!(format.as_str(), "csv" | "parquet") {
                return Err(AppError::bad("file format must be csv or parquet"));
            }
            let trimmed = filename.trim();
            if trimmed.is_empty()
                || trimmed.contains('/')
                || trimmed.contains('\\')
                || matches!(trimmed, "." | "..")
            {
                return Err(AppError::bad("invalid output filename"));
            }
            if !matches!(config.write_mode.as_str(), "replace" | "recreate") {
                return Err(AppError::bad("file loads use replace mode"));
            }
        }
    }
    Ok(config)
}

fn load_json(row: &LoadDefinitionRow) -> Result<Value, AppError> {
    let spec: Value =
        serde_json::from_str(&row.spec_json).map_err(|e| AppError::bad(e.to_string()))?;
    Ok(
        json!({ "id": row.id, "owner_user_id": row.owner_user_id, "name": row.name,
        "destination_type": row.destination_type, "spec": spec,
        "created_at": row.created_at, "updated_at": row.updated_at }),
    )
}

#[cfg(test)]
mod tests {
    use super::is_planned_input_contract;

    #[test]
    fn planned_input_contracts_are_detected() {
        assert!(is_planned_input_contract("contract:workspace:test-chip"));
        assert!(!is_planned_input_contract("dataset-123"));
        assert!(!is_planned_input_contract(""));
    }
}

async fn list_loads(
    State(state): State<AppState>,
    user: CurrentUser,
) -> Result<Json<Value>, AppError> {
    let rows = state
        .store
        .list_load_definitions(user.id(), user.can_see_all_workspaces())
        .await?;
    Ok(Json(
        json!({ "loads": rows.iter().map(load_json).collect::<Result<Vec<_>, _>>()? }),
    ))
}

async fn get_load(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> Result<Json<Value>, AppError> {
    Ok(Json(load_json(
        &require_load(&state.store, &user, &id).await?,
    )?))
}

async fn create_load(
    State(state): State<AppState>,
    user: CurrentUser,
    Json(body): Json<SaveLoadBody>,
) -> Result<Json<Value>, AppError> {
    let input_chip_id =
        validate_input_chip(&state.store, &user, body.input_chip_id.as_deref()).await?;
    let config = validate_load_config(&state.store, body.spec).await?;
    let kind = if matches!(config.destination, LoadDestination::Database { .. }) {
        "database"
    } else {
        "file"
    };
    let raw = serde_json::to_string(&config).map_err(|e| AppError::bad(e.to_string()))?;
    let row = state
        .store
        .insert_load_definition(user.id(), &body.name, kind, &raw)
        .await?;
    if let Some(chip_id) = input_chip_id {
        state.store.bind_chip_to_load(&chip_id, &row.id).await?;
    }
    Ok(Json(load_json(&row)?))
}

async fn update_load(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
    Json(body): Json<SaveLoadBody>,
) -> Result<Json<Value>, AppError> {
    require_load(&state.store, &user, &id).await?;
    let input_chip_id =
        validate_input_chip(&state.store, &user, body.input_chip_id.as_deref()).await?;
    let config = validate_load_config(&state.store, body.spec).await?;
    let kind = if matches!(config.destination, LoadDestination::Database { .. }) {
        "database"
    } else {
        "file"
    };
    let raw = serde_json::to_string(&config).map_err(|e| AppError::bad(e.to_string()))?;
    let row = state
        .store
        .update_load_definition(&id, &body.name, kind, &raw)
        .await?;
    if let Some(chip_id) = input_chip_id {
        state.store.bind_chip_to_load(&chip_id, &row.id).await?;
    }
    Ok(Json(load_json(&row)?))
}

async fn validate_input_chip(
    store: &storage::Store,
    user: &CurrentUser,
    chip_id: Option<&str>,
) -> Result<Option<String>, AppError> {
    let Some(chip_id) = chip_id.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let chip = crate::access::require_chip(store, user, chip_id).await?;
    if chip.kind != "load" {
        return Err(AppError::bad("input_chip_id must reference a load chip"));
    }
    Ok(Some(chip_id.to_string()))
}

async fn delete_load(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> Result<Json<Value>, AppError> {
    require_load(&state.store, &user, &id).await?;
    state.store.delete_load_definition(&id).await?;
    Ok(Json(json!({ "ok": true })))
}

pub(crate) async fn require_load(
    store: &storage::Store,
    user: &CurrentUser,
    id: &str,
) -> Result<LoadDefinitionRow, AppError> {
    let row = store
        .get_load_definition(id)
        .await?
        .ok_or_else(|| AppError::not_found("load definition not found"))?;
    if !user.can_see_all_workspaces() && row.owner_user_id != user.id() {
        return Err(AppError::not_found("load definition not found"));
    }
    Ok(row)
}
