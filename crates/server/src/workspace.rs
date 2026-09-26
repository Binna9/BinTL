use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

use crate::access::{self, CurrentUser};
use crate::error::AppError;
use crate::state::AppState;
use storage::{ChipEdgeRow, ChipPasteInput, WorkspaceFolderRow, WorkspaceRow, WorkspaceSaveEdge};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/api/workspaces",
            get(list_workspaces).post(create_workspace),
        )
        .route(
            "/api/workspaces/{id}",
            get(get_workspace)
                .patch(update_workspace)
                .delete(delete_workspace),
        )
        .route(
            "/api/workspaces/{id}/save",
            axum::routing::put(save_workspace),
        )
        .route(
            "/api/workspaces/{id}/paste-chips",
            axum::routing::post(paste_chips),
        )
        .route(
            "/api/workspace-folders",
            get(list_folders).post(create_folder),
        )
        .route(
            "/api/workspace-folders/{id}",
            axum::routing::patch(update_folder).delete(delete_folder),
        )
}

#[derive(Deserialize)]
struct CreateWorkspaceBody {
    name: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    folder_id: Option<String>,
}

#[derive(Deserialize)]
struct SaveWorkspaceBody {
    layout: Value,
    version: i64,
    #[serde(default)]
    chips: Vec<String>,
    #[serde(default)]
    edges: Vec<SaveWorkspaceEdgeBody>,
}

#[derive(Deserialize)]
struct SaveWorkspaceEdgeBody {
    #[serde(default)]
    id: String,
    from_chip_id: String,
    to_chip_id: String,
    kind: String,
    #[serde(default)]
    from_port: String,
    #[serde(default)]
    to_port: String,
}

#[derive(Deserialize)]
struct PasteChipsBody {
    source_workspace_id: String,
    chip_ids: Vec<String>,
    origin: PasteOrigin,
    version: i64,
}

#[derive(Deserialize)]
struct PasteOrigin {
    x: f64,
    y: f64,
}

#[derive(Deserialize)]
struct PatchWorkspaceBody {
    name: Option<String>,
    description: Option<String>,
    layout: Option<Value>,
    #[serde(default)]
    folder_id: Option<Option<String>>,
}

#[derive(Deserialize)]
struct CreateFolderBody {
    name: String,
    #[serde(default)]
    parent_id: Option<String>,
}

#[derive(Deserialize)]
struct PatchFolderBody {
    name: Option<String>,
    #[serde(default)]
    parent_id: Option<Option<String>>,
}

async fn list_workspaces(
    State(state): State<AppState>,
    user: CurrentUser,
) -> Result<Json<Value>, AppError> {
    let workspaces = state
        .store
        .list_visible_workspaces(Some(&user.scope(None)))
        .await?
        .iter()
        .map(|workspace| workspace_json(workspace, None))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Json(json!({ "workspaces": workspaces })))
}

async fn create_workspace(
    State(state): State<AppState>,
    user: CurrentUser,
    Json(body): Json<CreateWorkspaceBody>,
) -> Result<(StatusCode, Json<Value>), AppError> {
    if let Some(folder_id) = body.folder_id.as_deref() {
        access::require_folder(&state.store, &user, folder_id).await?;
    }
    let workspace = state
        .store
        .insert_workspace(
            &body.name,
            body.description.as_deref(),
            user.id(),
            body.folder_id.as_deref(),
        )
        .await?;
    Ok((StatusCode::CREATED, Json(workspace_json(&workspace, None)?)))
}

async fn get_workspace(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> Result<Json<Value>, AppError> {
    let workspace = access::require_workspace(&state.store, &user, &id).await?;
    let edges = state.store.list_chip_edges(&id).await?;
    Ok(Json(workspace_json(&workspace, Some(&edges))?))
}

async fn update_workspace(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
    Json(body): Json<PatchWorkspaceBody>,
) -> Result<Json<Value>, AppError> {
    access::require_workspace(&state.store, &user, &id).await?;
    if let Some(Some(folder_id)) = body.folder_id.as_ref() {
        access::require_folder(&state.store, &user, folder_id).await?;
    }
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
            body.folder_id.as_ref().map(|value| value.as_deref()),
        )
        .await?;
    Ok(Json(workspace_json(&workspace, None)?))
}

async fn delete_workspace(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> Result<Json<Value>, AppError> {
    access::require_workspace(&state.store, &user, &id).await?;
    state.store.delete_workspace(&id).await?;
    Ok(Json(json!({ "ok": true })))
}

async fn save_workspace(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
    Json(body): Json<SaveWorkspaceBody>,
) -> Result<Json<Value>, AppError> {
    access::require_workspace(&state.store, &user, &id).await?;
    if !body.layout.is_object() {
        return Err(AppError::bad("layout must be an object"));
    }
    let layout_json =
        serde_json::to_string(&body.layout).map_err(|error| AppError::bad(error.to_string()))?;
    let mut chip_ids = Vec::with_capacity(body.chips.len());
    for chip_id in body.chips {
        let chip_id = chip_id.trim().to_string();
        if chip_id.is_empty() {
            continue;
        }
        let _chip = access::require_chip(&state.store, &user, &chip_id).await?;
        chip_ids.push(chip_id);
    }
    let mut edges = Vec::with_capacity(body.edges.len());
    for edge in body.edges {
        if edge.from_chip_id.trim().is_empty() || edge.to_chip_id.trim().is_empty() {
            return Err(AppError::bad("chip edge endpoints required"));
        }
        edges.push(WorkspaceSaveEdge {
            id: edge.id,
            from_chip_id: edge.from_chip_id,
            to_chip_id: edge.to_chip_id,
            kind: edge.kind,
            from_port: edge.from_port,
            to_port: edge.to_port,
        });
    }
    let (workspace, saved, saved_edges) = state
        .store
        .save_workspace(&id, &layout_json, &chip_ids, &edges, Some(body.version))
        .await?;
    crate::planned_input::sync_workspace_planned_inputs(&state, &id).await?;
    let mut chips = Vec::with_capacity(saved.len());
    for chip in &saved {
        chips.push(crate::chip::chip_json_for_workspace(&state.store, chip, &id).await?);
    }
    let edges = saved_edges.iter().map(edge_json).collect::<Vec<_>>();
    Ok(Json(json!({
        "workspace": workspace_json(&workspace, Some(saved_edges.as_slice()))?,
        "chips": chips,
        "edges": edges,
    })))
}

async fn paste_chips(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
    Json(body): Json<PasteChipsBody>,
) -> Result<Json<Value>, AppError> {
    access::require_workspace(&state.store, &user, &id).await?;
    access::require_workspace(&state.store, &user, &body.source_workspace_id).await?;
    let mut chip_ids = Vec::with_capacity(body.chip_ids.len());
    for chip_id in &body.chip_ids {
        let chip_id = chip_id.trim();
        if chip_id.is_empty() {
            continue;
        }
        let _chip = access::require_chip(&state.store, &user, chip_id).await?;
        chip_ids.push(chip_id.to_string());
    }
    if chip_ids.is_empty() {
        return Err(AppError::bad("chip ids required"));
    }
    let mut serve_configs = HashMap::new();
    let mut revealed_keys = HashMap::new();
    let mut reserved_slugs = reserved_serve_slugs(&state).await?;
    for chip_id in &chip_ids {
        let chip = state
            .store
            .get_chip(chip_id)
            .await?
            .ok_or_else(|| AppError::not_found("chip not found"))?;
        if chip.kind != "serve" {
            continue;
        }
        let raw = state.store.resolve_chip_config_json(&chip).await?;
        let existing: Value =
            serde_json::from_str(&raw).map_err(|error| AppError::bad(error.to_string()))?;
        let base = existing
            .get("slug")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        let slug = storage::next_copy_slug(base, &reserved_slugs);
        reserved_slugs.insert(slug.clone());
        let key = crate::serve::generate_api_key();
        let (config, revealed) = crate::serve::validate_serve_config(
            &state.store,
            None,
            json!({
                "slug": slug,
                "api_key": key,
                "freshness": existing.get("freshness").cloned().unwrap_or(json!("slot")),
            }),
            None,
            false,
        )
        .await?;
        serve_configs.insert(
            chip_id.clone(),
            serde_json::to_string(&config).map_err(|error| AppError::bad(error.to_string()))?,
        );
        if let Some(key) = revealed {
            revealed_keys.insert(chip_id.clone(), key);
        }
    }
    let pasted = state
        .store
        .paste_chips(
            &id,
            ChipPasteInput {
                source_workspace_id: body.source_workspace_id,
                chip_ids,
                origin_x: body.origin.x,
                origin_y: body.origin.y,
                expected_version: body.version,
                serve_configs,
            },
        )
        .await?;
    crate::planned_input::sync_workspace_planned_inputs(&state, &id).await?;
    let mut chips = Vec::with_capacity(pasted.chips.len());
    for chip in &pasted.chips {
        let mut payload = crate::chip::chip_json_for_workspace(&state.store, chip, &id).await?;
        if let Some(source_id) = pasted
            .id_map
            .iter()
            .find_map(|(source, copied)| (copied == &chip.id).then_some(source.as_str()))
        {
            if let Some(key) = revealed_keys.get(source_id) {
                payload["api_key"] = json!(key);
            }
        }
        chips.push(payload);
    }
    let edges = pasted.edges.iter().map(edge_json).collect::<Vec<_>>();
    Ok(Json(json!({
        "workspace": workspace_json(&pasted.workspace, Some(pasted.edges.as_slice()))?,
        "chips": chips,
        "edges": edges,
        "id_map": pasted.id_map,
    })))
}

async fn reserved_serve_slugs(state: &AppState) -> Result<HashSet<String>, AppError> {
    let mut taken = HashSet::new();
    for (_, raw) in state.store.list_serve_chip_configs().await? {
        let Some(raw) = raw else {
            continue;
        };
        let Ok(config) = serde_json::from_str::<Value>(&raw) else {
            continue;
        };
        let slug = config
            .get("slug")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        if !slug.is_empty() {
            taken.insert(slug.to_string());
        }
    }
    Ok(taken)
}

async fn list_folders(
    State(state): State<AppState>,
    user: CurrentUser,
) -> Result<Json<Value>, AppError> {
    let folders = state
        .store
        .list_visible_folders(Some(&user.scope(None)))
        .await?
        .iter()
        .map(folder_json)
        .collect::<Vec<_>>();
    Ok(Json(json!({ "folders": folders })))
}

async fn create_folder(
    State(state): State<AppState>,
    user: CurrentUser,
    Json(body): Json<CreateFolderBody>,
) -> Result<(StatusCode, Json<Value>), AppError> {
    if let Some(parent_id) = body.parent_id.as_deref() {
        access::require_folder(&state.store, &user, parent_id).await?;
    }
    let folder = state
        .store
        .insert_folder(&body.name, user.id(), body.parent_id.as_deref())
        .await?;
    Ok((StatusCode::CREATED, Json(folder_json(&folder))))
}

async fn update_folder(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
    Json(body): Json<PatchFolderBody>,
) -> Result<Json<Value>, AppError> {
    access::require_folder(&state.store, &user, &id).await?;
    if let Some(Some(parent_id)) = body.parent_id.as_ref() {
        access::require_folder(&state.store, &user, parent_id).await?;
    }
    let folder = state
        .store
        .update_folder(
            &id,
            body.name.as_deref(),
            body.parent_id.as_ref().map(|value| value.as_deref()),
        )
        .await?;
    Ok(Json(folder_json(&folder)))
}

async fn delete_folder(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> Result<Json<Value>, AppError> {
    access::require_folder(&state.store, &user, &id).await?;
    state.store.delete_folder(&id).await?;
    Ok(Json(json!({ "ok": true })))
}

fn workspace_json(row: &WorkspaceRow, edges: Option<&[ChipEdgeRow]>) -> Result<Value, AppError> {
    let layout = serde_json::from_str::<Value>(&row.layout_json).unwrap_or_else(|_| json!({}));
    Ok(json!({
        "id": row.id,
        "name": row.name,
        "description": row.description,
        "layout": layout,
        "version": row.version,
        "created_at": row.created_at,
        "updated_at": row.updated_at,
        "owner_user_id": row.owner_user_id,
        "folder_id": row.folder_id,
        "edges": edges.unwrap_or(&[]).iter().map(edge_json).collect::<Vec<_>>(),
    }))
}

fn folder_json(row: &WorkspaceFolderRow) -> Value {
    json!({
        "id": row.id,
        "owner_user_id": row.owner_user_id,
        "parent_id": row.parent_id,
        "name": row.name,
        "created_at": row.created_at,
        "updated_at": row.updated_at,
    })
}

fn edge_json(row: &ChipEdgeRow) -> Value {
    json!({
        "id": row.id,
        "workspace_id": row.workspace_id,
        "from_chip_id": row.from_chip_id,
        "to_chip_id": row.to_chip_id,
        "kind": row.kind,
        "from_port": row.from_port,
        "to_port": row.to_port,
        "created_at": row.created_at,
    })
}
