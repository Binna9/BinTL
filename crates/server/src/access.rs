use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use storage::{
    ChipRow, DatasetRow, DataScope, ExtractRow, JobRow, TransformRow, UserRow, WorkspaceFolderRow,
    WorkspaceRow,
};

use crate::error::AppError;
use crate::state::AppState;

#[derive(Clone, Debug)]
pub struct CurrentUser(pub UserRow);

impl CurrentUser {
    pub fn id(&self) -> &str {
        &self.0.id
    }

    pub fn can_manage_users(&self) -> bool {
        self.0.can_manage_users()
    }

    pub fn can_write_connections(&self) -> bool {
        self.0.can_write_connections()
    }

    pub fn can_see_all_workspaces(&self) -> bool {
        self.0.can_see_all_workspaces()
    }

    pub fn scope(&self, workspace_id: Option<String>) -> DataScope {
        DataScope::for_user(&self.0).workspace(workspace_id)
    }
}

impl FromRequestParts<AppState> for CurrentUser {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, _state: &AppState) -> Result<Self, Self::Rejection> {
        parts
            .extensions
            .get::<CurrentUser>()
            .cloned()
            .ok_or_else(AppError::unauthorized)
    }
}

pub fn require_admin(user: &CurrentUser) -> Result<(), AppError> {
    if user.can_manage_users() {
        Ok(())
    } else {
        Err(AppError::forbidden())
    }
}

pub fn require_connection_write(user: &CurrentUser) -> Result<(), AppError> {
    if user.can_write_connections() {
        Ok(())
    } else {
        Err(AppError::forbidden())
    }
}

pub async fn require_workspace(
    store: &storage::Store,
    user: &CurrentUser,
    workspace_id: &str,
) -> Result<WorkspaceRow, AppError> {
    Ok(store
        .require_workspace_access(user.id(), user.can_see_all_workspaces(), workspace_id)
        .await?)
}

pub async fn write_workspace(
    store: &storage::Store,
    user: &CurrentUser,
    requested: Option<String>,
) -> Result<String, AppError> {
    Ok(store
        .resolve_write_workspace(&user.scope(requested))
        .await?)
}

pub async fn require_folder(
    store: &storage::Store,
    user: &CurrentUser,
    folder_id: &str,
) -> Result<WorkspaceFolderRow, AppError> {
    Ok(store
        .require_folder_access(user.id(), user.can_see_all_workspaces(), folder_id)
        .await?)
}

pub async fn require_dataset(
    store: &storage::Store,
    user: &CurrentUser,
    id: &str,
) -> Result<DatasetRow, AppError> {
    let row = store
        .get_dataset(id)
        .await?
        .ok_or_else(|| AppError::not_found("dataset not found"))?;
    require_workspace(store, user, &row.workspace_id).await?;
    Ok(row)
}

pub async fn require_extract(
    store: &storage::Store,
    user: &CurrentUser,
    id: &str,
) -> Result<ExtractRow, AppError> {
    let row = store
        .get_extract(id)
        .await?
        .ok_or_else(|| AppError::not_found("extract not found"))?;
    require_workspace(store, user, &row.workspace_id).await?;
    Ok(row)
}

pub async fn require_job(
    store: &storage::Store,
    user: &CurrentUser,
    id: &str,
) -> Result<JobRow, AppError> {
    let row = store
        .get_job(id)
        .await?
        .ok_or_else(|| AppError::not_found("job not found"))?;
    require_workspace(store, user, &row.workspace_id).await?;
    Ok(row)
}

pub async fn require_transform(
    store: &storage::Store,
    user: &CurrentUser,
    id: &str,
) -> Result<TransformRow, AppError> {
    let row = store
        .get_transform(id)
        .await?
        .ok_or_else(|| AppError::not_found("transform not found"))?;
    require_workspace(store, user, &row.workspace_id).await?;
    Ok(row)
}

pub async fn require_chip(
    store: &storage::Store,
    user: &CurrentUser,
    id: &str,
) -> Result<ChipRow, AppError> {
    let row = store
        .get_chip(id)
        .await?
        .ok_or_else(|| AppError::not_found("chip not found"))?;
    if !user.scope(None).admin && row.owner_user_id != user.id() {
        return Err(AppError::not_found("chip not found"));
    }
    Ok(row)
}
