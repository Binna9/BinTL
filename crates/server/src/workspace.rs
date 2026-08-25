use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::AppError;
use crate::state::AppState;
use crate::task::validate_config;
use storage::{WorkspaceRow, WorkspaceSaveTask};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/api/workspaces",
            get(list_workspaces).post(create_workspace),
        )
        .route(
            "/api/workspaces/{id}",
            get(get_workspace).patch(update_workspace),
        )
        .route("/api/workspaces/{id}/save", axum::routing::put(save_workspace))
}

#[derive(Deserialize)]
struct CreateWorkspaceBody {
    name: String,
    #[serde(default)]
    description: Option<String>,
}

#[derive(Deserialize)]
struct SaveWorkspaceBody {
    layout: Value,
    #[serde(default)]
    tasks: Vec<SaveWorkspaceTaskBody>,
}

#[derive(Deserialize)]
struct SaveWorkspaceTaskBody {
    id: String,
    name: String,
    kind: String,
    config: Value,
}

#[derive(Deserialize)]
struct PatchWorkspaceBody {
    name: Option<String>,
    description: Option<String>,
    layout: Option<Value>,
}

async fn list_workspaces(State(state): State<AppState>) -> Result<Json<Value>, AppError> {
    let workspaces = state
        .store
        .list_workspaces()
        .await?
        .iter()
        .map(workspace_json)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Json(json!({ "workspaces": workspaces })))
}

async fn create_workspace(
    State(state): State<AppState>,
    Json(body): Json<CreateWorkspaceBody>,
) -> Result<(StatusCode, Json<Value>), AppError> {
    let workspace = state
        .store
        .insert_workspace(&body.name, body.description.as_deref())
        .await?;
    Ok((StatusCode::CREATED, Json(workspace_json(&workspace)?)))
}

async fn get_workspace(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, AppError> {
    let workspace = state
        .store
        .get_workspace(&id)
        .await?
        .ok_or_else(|| AppError::not_found("workspace not found"))?;
    Ok(Json(workspace_json(&workspace)?))
}

async fn update_workspace(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<PatchWorkspaceBody>,
) -> Result<Json<Value>, AppError> {
    let layout_json = body
        .layout
        .as_ref()
        .map(|layout| {
            if !layout.is_object() {
                return Err(AppError::bad("layout must be an object"));
            }
            serde_json::to_string(layout).map_err(|error| AppError::bad(error.to_string()))
        })
        .transpose()?;
    let workspace = state
        .store
        .update_workspace(
            &id,
            body.name.as_deref(),
            body.description.as_deref(),
            layout_json.as_deref(),
        )
        .await?;
    Ok(Json(workspace_json(&workspace)?))
}

async fn save_workspace(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<SaveWorkspaceBody>,
) -> Result<Json<Value>, AppError> {
    if !body.layout.is_object() {
        return Err(AppError::bad("layout must be an object"));
    }
    let layout_json =
        serde_json::to_string(&body.layout).map_err(|error| AppError::bad(error.to_string()))?;
    let mut tasks = Vec::with_capacity(body.tasks.len());
    for task in body.tasks {
        if task.id.trim().is_empty() {
            return Err(AppError::bad("task id required"));
        }
        let config =
            validate_config(&state.store, &id, &task.kind, task.config).await?;
        let config_json =
            serde_json::to_string(&config).map_err(|error| AppError::bad(error.to_string()))?;
        tasks.push(WorkspaceSaveTask {
            id: task.id,
            name: task.name,
            kind: task.kind,
            config_json,
        });
    }
    let (workspace, saved) = state
        .store
        .save_workspace(&id, &layout_json, &tasks)
        .await?;
    let tasks = saved
        .iter()
        .map(crate::task::task_json)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Json(json!({
        "workspace": workspace_json(&workspace)?,
        "tasks": tasks,
    })))
}

fn workspace_json(row: &WorkspaceRow) -> Result<Value, AppError> {
    let layout = serde_json::from_str::<Value>(&row.layout_json)
        .unwrap_or_else(|_| json!({}));
    Ok(json!({
        "id": row.id,
        "name": row.name,
        "description": row.description,
        "layout": layout,
        "version": row.version,
        "created_at": row.created_at,
        "updated_at": row.updated_at,
    }))
}
