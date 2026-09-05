use axum::extract::{Path, State};
use axum::routing::get;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use storage::LoadDefinitionRow;

use crate::access::CurrentUser;
use crate::error::AppError;
use crate::state::AppState;

#[derive(Debug, Clone, Deserialize, Serialize)]
pub(crate) struct LoadConfig {
    pub destination: LoadDestination,
    #[serde(default = "default_write_mode")]
    pub write_mode: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(crate) enum LoadDestination {
    Database { connection_id: String, table: String },
    File { format: String, filename: String },
}

fn default_write_mode() -> String { "append".into() }

#[derive(Deserialize)]
struct SaveLoadBody { name: String, spec: Value }

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/loads", get(list_loads).post(create_load))
        .route("/api/loads/{id}", get(get_load).put(update_load).delete(delete_load))
}

pub(crate) async fn validate_load_config(store: &storage::Store, value: Value) -> Result<LoadConfig, AppError> {
    let config: LoadConfig = serde_json::from_value(value).map_err(|e| AppError::bad(e.to_string()))?;
    if !matches!(config.write_mode.as_str(), "append" | "replace") {
        return Err(AppError::bad("write_mode must be append or replace"));
    }
    match &config.destination {
        LoadDestination::Database { connection_id, table } => {
            let connection = store.get_connection(connection_id).await?
                .ok_or_else(|| AppError::not_found("connection not found"))?;
            if connection.driver == "http" { return Err(AppError::bad("http connection cannot be a database load target")); }
            connectors::parse_table(table).map_err(|e| AppError::bad(e.to_string()))?;
        }
        LoadDestination::File { format, filename } => {
            if !matches!(format.as_str(), "csv" | "parquet") { return Err(AppError::bad("file format must be csv or parquet")); }
            let trimmed = filename.trim();
            if trimmed.is_empty() || trimmed.contains('/') || trimmed.contains('\\') || matches!(trimmed, "." | "..") {
                return Err(AppError::bad("invalid output filename"));
            }
            if config.write_mode != "replace" { return Err(AppError::bad("file loads use replace mode")); }
        }
    }
    Ok(config)
}

fn load_json(row: &LoadDefinitionRow) -> Result<Value, AppError> {
    let spec: Value = serde_json::from_str(&row.spec_json).map_err(|e| AppError::bad(e.to_string()))?;
    Ok(json!({ "id": row.id, "owner_user_id": row.owner_user_id, "name": row.name,
        "destination_type": row.destination_type, "spec": spec,
        "created_at": row.created_at, "updated_at": row.updated_at }))
}

async fn list_loads(State(state): State<AppState>, user: CurrentUser) -> Result<Json<Value>, AppError> {
    let rows = state.store.list_load_definitions(user.id(), user.can_see_all_workspaces()).await?;
    Ok(Json(json!({ "loads": rows.iter().map(load_json).collect::<Result<Vec<_>, _>>()? })))
}

async fn get_load(State(state): State<AppState>, user: CurrentUser, Path(id): Path<String>) -> Result<Json<Value>, AppError> {
    Ok(Json(load_json(&require_load(&state.store, &user, &id).await?)?))
}

async fn create_load(State(state): State<AppState>, user: CurrentUser, Json(body): Json<SaveLoadBody>) -> Result<Json<Value>, AppError> {
    let config = validate_load_config(&state.store, body.spec).await?;
    let kind = if matches!(config.destination, LoadDestination::Database { .. }) { "database" } else { "file" };
    let raw = serde_json::to_string(&config).map_err(|e| AppError::bad(e.to_string()))?;
    Ok(Json(load_json(&state.store.insert_load_definition(user.id(), &body.name, kind, &raw).await?)?))
}

async fn update_load(State(state): State<AppState>, user: CurrentUser, Path(id): Path<String>, Json(body): Json<SaveLoadBody>) -> Result<Json<Value>, AppError> {
    require_load(&state.store, &user, &id).await?;
    let config = validate_load_config(&state.store, body.spec).await?;
    let kind = if matches!(config.destination, LoadDestination::Database { .. }) { "database" } else { "file" };
    let raw = serde_json::to_string(&config).map_err(|e| AppError::bad(e.to_string()))?;
    Ok(Json(load_json(&state.store.update_load_definition(&id, &body.name, kind, &raw).await?)?))
}

async fn delete_load(State(state): State<AppState>, user: CurrentUser, Path(id): Path<String>) -> Result<Json<Value>, AppError> {
    require_load(&state.store, &user, &id).await?;
    state.store.delete_load_definition(&id).await?;
    Ok(Json(json!({ "ok": true })))
}

pub(crate) async fn require_load(store: &storage::Store, user: &CurrentUser, id: &str) -> Result<LoadDefinitionRow, AppError> {
    let row = store.get_load_definition(id).await?.ok_or_else(|| AppError::not_found("load definition not found"))?;
    if !user.can_see_all_workspaces() && row.owner_user_id != user.id() { return Err(AppError::not_found("load definition not found")); }
    Ok(row)
}
