use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use storage::UserRow;

use crate::access::{require_admin, CurrentUser};
use crate::error::AppError;
use crate::state::AppState;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/me", get(me))
        .route("/api/users", get(list_users).post(create_user))
        .route("/api/users/{id}", axum::routing::patch(update_user))
        .route("/api/roles", get(list_roles))
        .route("/api/permissions", get(list_permissions))
}

#[derive(Deserialize)]
struct CreateUserBody {
    userid: String,
    username: String,
    password: String,
    #[serde(default)]
    roles: Vec<String>,
}

#[derive(Deserialize)]
struct PatchUserBody {
    username: Option<String>,
    password: Option<String>,
    roles: Option<Vec<String>>,
    active: Option<bool>,
}

pub fn user_json(row: &UserRow) -> Value {
    json!({
        "id": row.id,
        "userid": row.userid,
        "username": row.username,
        "active": row.active != 0,
        "roles": row.roles,
        "permissions": row.permissions,
        "created_at": row.created_at,
        "updated_at": row.updated_at,
    })
}

async fn me(user: CurrentUser) -> Json<Value> {
    Json(user_json(&user.0))
}

async fn list_users(
    State(state): State<AppState>,
    user: CurrentUser,
) -> Result<Json<Value>, AppError> {
    require_admin(&user)?;
    let users = state
        .store
        .list_users()
        .await?
        .iter()
        .map(user_json)
        .collect::<Vec<_>>();
    Ok(Json(json!({ "users": users })))
}

async fn create_user(
    State(state): State<AppState>,
    user: CurrentUser,
    Json(body): Json<CreateUserBody>,
) -> Result<(StatusCode, Json<Value>), AppError> {
    require_admin(&user)?;
    let roles = if body.roles.is_empty() {
        vec!["analyst".into()]
    } else {
        body.roles
    };
    let created = state
        .store
        .create_user(&body.userid, &body.username, &body.password, &roles)
        .await?;
    Ok((StatusCode::CREATED, Json(user_json(&created))))
}

async fn update_user(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
    Json(body): Json<PatchUserBody>,
) -> Result<Json<Value>, AppError> {
    require_admin(&user)?;
    let updated = state
        .store
        .update_user(
            &id,
            body.username.as_deref(),
            body.password.as_deref(),
            body.roles.as_deref(),
            body.active,
        )
        .await?;
    Ok(Json(user_json(&updated)))
}

async fn list_roles(
    State(state): State<AppState>,
    _user: CurrentUser,
) -> Result<Json<Value>, AppError> {
    let roles = state.store.list_roles().await?;
    Ok(Json(json!({ "roles": roles })))
}

async fn list_permissions(
    State(state): State<AppState>,
    _user: CurrentUser,
) -> Result<Json<Value>, AppError> {
    let permissions = state.store.list_permissions().await?;
    Ok(Json(json!({ "permissions": permissions })))
}
