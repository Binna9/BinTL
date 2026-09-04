pub mod chip_slot;
mod delete_guard;
mod identity;
mod password;
mod process_log;
mod search;
mod secret;

pub use identity::{
    DataScope, PermissionRow, RoleWithPermissions, UserRow, PERM_CONNECTION_WRITE, PERM_USER_MANAGE,
    PERM_WORKSPACE_ALL,
};
pub use process_log::{
    safe_log_id, ProcessLog, LOG_AREAS, LOG_CONNECTIONS, LOG_EXTRACTS, LOG_FILES, LOG_JOBS,
    LOG_QUERY,
};
pub use search::SearchHit;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use chrono::{SecondsFormat, Utc};
use serde::Serialize;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
use sqlx::SqlitePool;
use uuid::Uuid;

#[derive(Debug, thiserror::Error)]
pub enum StorageError {
    #[error(transparent)]
    Sqlx(#[from] sqlx::Error),
    #[error(transparent)]
    Migrate(#[from] sqlx::migrate::MigrateError),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    Invalid(String),
    #[error("{0}")]
    Conflict(String),
}

/// Relative dirs under `data_dir`. Transform inputs live under `extracts/`
/// by source kind; `outputs/` is convert/load results.
pub const REL_UPLOADS: &str = "extracts/uploads";
pub const REL_DATABASES: &str = "extracts/databases";
pub const REL_API: &str = "extracts/api";
pub const REL_OUTPUTS: &str = "outputs";
pub const REL_LOGS: &str = "logs";
pub const REL_STAGING: &str = "staging";
pub const DEFAULT_WORKSPACE_ID: &str = "00000000-0000-0000-0000-000000000001";

const EXTRACT_KINDS: [&str; 3] = ["uploads", "databases", "api"];

#[derive(Clone)]
pub struct Store {
    pub pool: SqlitePool,
    pub data_dir: PathBuf,
    secret_key: [u8; 32],
}

const JOB_COLS: &str = "id, status, source_path, output_path, spec_json, error_message,
        created_at, started_at, finished_at, kind, transform_id, dataset_id, workspace_id";

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct JobRow {
    pub id: String,
    pub status: String,
    pub source_path: String,
    pub output_path: Option<String>,
    pub spec_json: String,
    pub error_message: Option<String>,
    pub created_at: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub kind: String,
    pub transform_id: Option<String>,
    pub dataset_id: Option<String>,
    pub workspace_id: String,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct DatasetRow {
    pub id: String,
    pub kind: String,
    pub extract_id: Option<String>,
    pub filename: String,
    pub stored_path: String,
    pub size_bytes: Option<i64>,
    pub delimiter: Option<String>,
    pub has_header: Option<i64>,
    pub columns_json: Option<String>,
    pub row_count: Option<i64>,
    pub inspected_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub workspace_id: String,
    pub producer_chip_run_id: Option<String>,
    pub table_name: String,
    pub connection_name: String,
    pub status: String,
    pub source_chip_id: Option<String>,
    pub consumer_chip_id: Option<String>,
    pub source_extract_definition_id: Option<String>,
}

const DATASET_COLS: &str = "d.id, d.kind, d.extract_id, d.filename, d.stored_path, d.size_bytes,
        d.delimiter, d.has_header, d.columns_json, d.row_count, d.inspected_at,
        d.created_at, d.updated_at, d.workspace_id, d.producer_chip_run_id,
        d.status, d.source_chip_id, d.consumer_chip_id, d.source_extract_definition_id,
        COALESCE(e.table_name, '') AS table_name,
        COALESCE(c.name, '') AS connection_name";

#[derive(Debug, Clone)]
pub struct DatasetUpsert {
    pub id: String,
    pub kind: String,
    pub extract_id: Option<String>,
    pub filename: String,
    pub stored_path: String,
    pub size_bytes: Option<i64>,
    pub delimiter: Option<String>,
    pub has_header: Option<bool>,
    pub row_count: Option<i64>,
    pub workspace_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct TransformRow {
    pub id: String,
    pub name: String,
    pub dataset_id: String,
    pub spec_json: String,
    pub created_at: String,
    pub updated_at: String,
    pub workspace_id: String,
    pub input_chip_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct WorkspaceRow {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub layout_json: String,
    pub version: i64,
    pub created_at: String,
    pub updated_at: String,
    pub owner_user_id: Option<String>,
    pub folder_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct WorkspaceFolderRow {
    pub id: String,
    pub owner_user_id: String,
    pub parent_id: Option<String>,
    pub name: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct ChipRow {
    pub id: String,
    pub owner_user_id: String,
    pub name: String,
    pub kind: String,
    pub config_json: Option<String>,
    pub revision: i64,
    pub active: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct ExtractDefinitionRow {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub connection_id: String,
    pub source_json: String,
    pub delimiter: String,
    pub header: i64,
    pub add_sequence: i64,
    pub workspace_id: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct ChipBindingRow {
    pub chip_id: String,
    pub ref_kind: String,
    pub ref_id: String,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct ChipRunRow {
    pub id: String,
    pub chip_id: String,
    pub workspace_id: String,
    pub kind: String,
    pub status: String,
    pub config_snapshot_json: String,
    pub revision_snapshot: i64,
    pub input_dataset_id: Option<String>,
    pub output_dataset_id: Option<String>,
    pub legacy_extract_id: Option<String>,
    pub legacy_job_id: Option<String>,
    pub error_message: Option<String>,
    pub created_at: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
}

const WORKSPACE_COLS: &str =
    "id, name, description, layout_json, version, created_at, updated_at, owner_user_id, folder_id";
const FOLDER_COLS: &str = "id, owner_user_id, parent_id, name, created_at, updated_at";

#[derive(Debug, Clone)]
pub struct RegisterExtractChip {
    pub name: String,
    pub owner_user_id: String,
    pub workspace_id: Option<String>,
    pub kind: String,
    pub connection_id: String,
    pub source_json: String,
    pub delimiter: String,
    pub header: bool,
    pub add_sequence: bool,
    pub place_on_workspace: bool,
}

#[derive(Debug, Clone)]
pub struct RegisterTransformChip {
    pub name: String,
    pub owner_user_id: String,
    pub workspace_id: Option<String>,
    pub transform_id: String,
    pub place_on_workspace: bool,
}

#[derive(Debug, Clone)]
pub struct LinkedChipRun {
    pub run_id: String,
    pub chip_id: String,
    pub workspace_id: String,
}

#[derive(Debug, Clone)]
pub struct WorkspaceSaveEdge {
    pub id: String,
    pub from_chip_id: String,
    pub to_chip_id: String,
    pub kind: String,
    pub from_port: String,
    pub to_port: String,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct ChipEdgeRow {
    pub id: String,
    pub workspace_id: String,
    pub from_chip_id: String,
    pub to_chip_id: String,
    pub kind: String,
    pub from_port: String,
    pub to_port: String,
    pub created_at: String,
}

const CHIP_COLS: &str = "id, owner_user_id, name, kind, config_json, revision,
        active, created_at, updated_at";
const CHIP_JOIN_COLS: &str = "c.id, c.owner_user_id, c.name, c.kind, c.config_json, c.revision,
        c.active, c.created_at, c.updated_at";
const EXTRACT_DEFINITION_COLS: &str = "id, name, kind, connection_id, source_json, delimiter,
        header, add_sequence, workspace_id, created_at, updated_at";
const CHIP_RUN_COLS: &str = "id, chip_id, workspace_id, kind, status, config_snapshot_json,
        revision_snapshot, input_dataset_id, output_dataset_id, legacy_extract_id,
        legacy_job_id, error_message, created_at, started_at, finished_at";
const CHIP_EDGE_COLS: &str = "id, workspace_id, from_chip_id, to_chip_id, kind, from_port,
        to_port, created_at";

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct JobLogRow {
    pub id: i64,
    pub job_id: String,
    pub ts: String,
    pub level: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct FileMeta {
    pub id: String,
    pub filename: String,
    pub size: u64,
    pub stored_path: String,
}

#[derive(Debug, Clone)]
pub struct StagedFile {
    pub id: String,
    pub original_filename: String,
    pub path: PathBuf,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct ExtractRow {
    pub id: String,
    pub kind: String,
    pub connection_id: String,
    pub table_name: String,
    pub delimiter: String,
    pub header: i64,
    pub add_sequence: i64,
    pub status: String,
    pub stored_path: Option<String>,
    pub filename: Option<String>,
    pub output_filename: Option<String>,
    pub row_count: Option<i64>,
    pub error_message: Option<String>,
    pub created_at: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub sql_text: Option<String>,
    pub catalog_database: Option<String>,
    pub workspace_id: String,
    pub connection_name: String,
}

const EXTRACT_COLS: &str = "e.id, e.kind, e.connection_id, e.table_name, e.delimiter, e.header,
        e.add_sequence, e.status, e.stored_path, e.filename, e.output_filename, e.row_count,
        e.error_message, e.created_at, e.started_at, e.finished_at, e.sql_text, e.catalog_database,
        e.workspace_id, COALESCE(c.name, '') AS connection_name";

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct ConnectionRow {
    pub id: String,
    pub name: String,
    pub driver: String,
    pub host: String,
    pub port: i64,
    pub database_name: String,
    pub username: String,
    pub ssl: i64,
    pub created_at: String,
}

#[derive(Debug, Clone)]
pub struct LiveConnection {
    pub id: String,
    pub name: String,
    pub driver: String,
    pub host: String,
    pub port: u16,
    pub database: String,
    pub username: String,
    pub password: String,
    pub ssl: bool,
}

#[derive(Debug, Clone)]
pub struct NewConnection {
    pub name: String,
    pub driver: String,
    pub host: String,
    pub port: u16,
    pub database: String,
    pub username: String,
    pub password: String,
    pub ssl: bool,
}

impl Store {
    pub async fn open(
        data_dir: impl Into<PathBuf>,
        session_secret: &str,
    ) -> Result<Self, StorageError> {
        let data_dir = data_dir.into();
        ensure_data_layout(&data_dir).await?;

        let db_path = data_dir.join("etl.db");
        let options = SqliteConnectOptions::new()
            .filename(&db_path)
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .foreign_keys(true);

        let pool = SqlitePoolOptions::new()
            .max_connections(5)
            .connect_with(options)
            .await?;

        sqlx::migrate!("./migrations").run(&pool).await?;
        rewrite_legacy_stored_paths(&pool).await?;
        let store = Self {
            pool,
            data_dir,
            secret_key: secret::key_from_secret(session_secret),
        };
        store.backfill_datasets().await?;
        store.backfill_workspace_revisions().await?;
        store.backfill_chip_bindings().await?;
        Ok(store)
    }

    pub fn uploads_dir(&self) -> PathBuf {
        self.data_dir.join(REL_UPLOADS)
    }

    pub fn outputs_dir(&self) -> PathBuf {
        self.data_dir.join(REL_OUTPUTS)
    }

    pub fn staging_dir(&self) -> PathBuf {
        self.data_dir.join(REL_STAGING)
    }

    pub fn resolve(&self, stored: &str) -> PathBuf {
        let p = Path::new(stored);
        if p.is_absolute() {
            p.to_path_buf()
        } else {
            self.data_dir.join(p)
        }
    }

    pub async fn list_workspaces(&self) -> Result<Vec<WorkspaceRow>, StorageError> {
        self.list_visible_workspaces(None).await
    }

    pub async fn list_visible_workspaces(
        &self,
        scope: Option<&DataScope>,
    ) -> Result<Vec<WorkspaceRow>, StorageError> {
        let mut extra = String::new();
        let mut binds: Vec<String> = Vec::new();
        if let Some(scope) = scope {
            if !scope.admin {
                extra.push_str(" WHERE owner_user_id = ?");
                binds.push(scope.user_id.clone());
            }
        }
        extra.push_str(" ORDER BY updated_at DESC, created_at ASC");
        let sql = format!("SELECT {WORKSPACE_COLS} FROM workspaces{extra}");
        let mut query = sqlx::query_as::<_, WorkspaceRow>(&sql);
        for value in &binds {
            query = query.bind(value);
        }
        Ok(query.fetch_all(&self.pool).await?)
    }

    pub async fn get_workspace(&self, id: &str) -> Result<Option<WorkspaceRow>, StorageError> {
        Ok(sqlx::query_as::<_, WorkspaceRow>(&format!(
            "SELECT {WORKSPACE_COLS} FROM workspaces WHERE id = ?"
        ))
        .bind(id)
        .fetch_optional(&self.pool)
        .await?)
    }

    pub async fn insert_workspace(
        &self,
        name: &str,
        description: Option<&str>,
        owner_user_id: &str,
        folder_id: Option<&str>,
    ) -> Result<WorkspaceRow, StorageError> {
        let name = required_text(name, "workspace name")?;
        if self.get_user(owner_user_id).await?.is_none() {
            return Err(StorageError::NotFound("user not found".into()));
        }
        if let Some(folder_id) = folder_id {
            self.require_folder_access(owner_user_id, false, folder_id)
                .await?;
        }
        let id = Uuid::new_v4().to_string();
        let now = now_rfc3339();
        let mut tx = self.pool.begin().await?;
        sqlx::query(
            "INSERT INTO workspaces
             (id, name, description, layout_json, version, created_at, updated_at, owner_user_id, folder_id)
             VALUES (?, ?, ?, '{}', 1, ?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(name)
        .bind(trimmed_optional(description))
        .bind(&now)
        .bind(&now)
        .bind(owner_user_id)
        .bind(folder_id)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "INSERT INTO workspace_revisions (workspace_id, version, snapshot_json, created_at)
             VALUES (?, 1, ?, ?)",
        )
        .bind(&id)
        .bind(empty_workspace_snapshot())
        .bind(&now)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        search::sync_search_best_effort(self, "workspace", self.sync_search_workspace(&id)).await;
        self.get_workspace(&id)
            .await?
            .ok_or_else(|| StorageError::NotFound("workspace disappeared after insert".into()))
    }

    pub async fn update_workspace(
        &self,
        id: &str,
        name: Option<&str>,
        description: Option<&str>,
        layout_json: Option<&str>,
        folder_id: Option<Option<&str>>,
    ) -> Result<WorkspaceRow, StorageError> {
        let current = self
            .get_workspace(id)
            .await?
            .ok_or_else(|| StorageError::NotFound("workspace not found".into()))?;
        if name.is_none() && description.is_none() && layout_json.is_none() && folder_id.is_none() {
            return Ok(current);
        }
        let name = match name {
            Some(value) => required_text(value, "workspace name")?,
            None => current.name.as_str(),
        };
        let description = description
            .map(str::trim)
            .map(str::to_string)
            .or(current.description);
        let layout_json = match layout_json {
            Some(value) => {
                require_config_json(value)?;
                value
            }
            None => current.layout_json.as_str(),
        };
        let next_folder = match folder_id {
            Some(value) => value.map(str::to_string),
            None => current.folder_id.clone(),
        };
        if let Some(folder) = next_folder.as_deref() {
            let owner = current
                .owner_user_id
                .as_deref()
                .ok_or_else(|| StorageError::Invalid("workspace has no owner".into()))?;
            self.require_folder_access(owner, false, folder).await?;
        }
        sqlx::query(
            "UPDATE workspaces
             SET name = ?, description = ?, layout_json = ?, folder_id = ?, updated_at = ?
             WHERE id = ?",
        )
        .bind(name)
        .bind(description.filter(|value| !value.is_empty()))
        .bind(layout_json)
        .bind(next_folder.as_deref())
        .bind(now_rfc3339())
        .bind(id)
        .execute(&self.pool)
        .await?;
        search::sync_search_best_effort(self, "workspace", self.sync_search_workspace(id)).await;
        self.get_workspace(id)
            .await?
            .ok_or_else(|| StorageError::NotFound("workspace disappeared after update".into()))
    }

    pub async fn delete_workspace(&self, id: &str) -> Result<(), StorageError> {
        if id == DEFAULT_WORKSPACE_ID {
            return Err(StorageError::Invalid(
                "cannot delete the default workspace".into(),
            ));
        }
        let mut tx = self.pool.begin().await?;
        let found: Option<String> = sqlx::query_scalar("SELECT id FROM workspaces WHERE id = ?")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?;
        if found.is_none() {
            return Err(StorageError::NotFound("workspace not found".into()));
        }
        // Catalog extract defs may still point at this workspace (no ON DELETE).
        sqlx::query("UPDATE extract_definitions SET workspace_id = NULL WHERE workspace_id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("UPDATE transforms SET workspace_id = ? WHERE workspace_id = ?")
            .bind(DEFAULT_WORKSPACE_ID)
            .bind(id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("UPDATE extracts SET workspace_id = ? WHERE workspace_id = ?")
            .bind(DEFAULT_WORKSPACE_ID)
            .bind(id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("UPDATE jobs SET workspace_id = ? WHERE workspace_id = ?")
            .bind(DEFAULT_WORKSPACE_ID)
            .bind(id)
            .execute(&mut *tx)
            .await?;
        sqlx::query(
            "UPDATE datasets SET producer_chip_run_id = NULL
             WHERE producer_chip_run_id IN (SELECT id FROM chip_runs WHERE workspace_id = ?)",
        )
        .bind(id)
        .execute(&mut *tx)
        .await?;
        sqlx::query("UPDATE datasets SET workspace_id = ? WHERE workspace_id = ?")
            .bind(DEFAULT_WORKSPACE_ID)
            .bind(id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM chip_edges WHERE workspace_id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM chip_runs WHERE workspace_id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM workspace_chips WHERE workspace_id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM workspace_revisions WHERE workspace_id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        let result = sqlx::query("DELETE FROM workspaces WHERE id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_err(delete_guard::map_delete_sql)?;
        if result.rows_affected() == 0 {
            return Err(StorageError::NotFound("workspace not found".into()));
        }
        tx.commit().await?;
        let _ = self.delete_search_document("workspace", id).await;
        Ok(())
    }

    pub async fn list_visible_folders(
        &self,
        scope: Option<&DataScope>,
    ) -> Result<Vec<WorkspaceFolderRow>, StorageError> {
        let mut extra = String::new();
        let mut binds: Vec<String> = Vec::new();
        if let Some(scope) = scope {
            if !scope.admin {
                extra.push_str(" WHERE owner_user_id = ?");
                binds.push(scope.user_id.clone());
            }
        }
        extra.push_str(" ORDER BY name ASC, created_at ASC");
        let sql = format!("SELECT {FOLDER_COLS} FROM workspace_folders{extra}");
        let mut query = sqlx::query_as::<_, WorkspaceFolderRow>(&sql);
        for value in &binds {
            query = query.bind(value);
        }
        Ok(query.fetch_all(&self.pool).await?)
    }

    pub async fn get_folder(&self, id: &str) -> Result<Option<WorkspaceFolderRow>, StorageError> {
        Ok(sqlx::query_as::<_, WorkspaceFolderRow>(&format!(
            "SELECT {FOLDER_COLS} FROM workspace_folders WHERE id = ?"
        ))
        .bind(id)
        .fetch_optional(&self.pool)
        .await?)
    }

    pub async fn require_folder_access(
        &self,
        user_id: &str,
        admin: bool,
        folder_id: &str,
    ) -> Result<WorkspaceFolderRow, StorageError> {
        let folder = self
            .get_folder(folder_id)
            .await?
            .ok_or_else(|| StorageError::NotFound("folder not found".into()))?;
        if admin || folder.owner_user_id == user_id {
            return Ok(folder);
        }
        Err(StorageError::NotFound("folder not found".into()))
    }

    pub async fn insert_folder(
        &self,
        name: &str,
        owner_user_id: &str,
        parent_id: Option<&str>,
    ) -> Result<WorkspaceFolderRow, StorageError> {
        let name = required_text(name, "folder name")?;
        if self.get_user(owner_user_id).await?.is_none() {
            return Err(StorageError::NotFound("user not found".into()));
        }
        if let Some(parent_id) = parent_id {
            self.require_folder_access(owner_user_id, false, parent_id)
                .await?;
        }
        self.ensure_folder_name_available(owner_user_id, parent_id, name, None)
            .await?;
        let id = Uuid::new_v4().to_string();
        let now = now_rfc3339();
        sqlx::query(
            "INSERT INTO workspace_folders
             (id, owner_user_id, parent_id, name, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(owner_user_id)
        .bind(parent_id)
        .bind(name)
        .bind(&now)
        .bind(&now)
        .execute(&self.pool)
        .await
        .map_err(map_folder_sql)?;
        search::sync_search_best_effort(
            self,
            "workspace_folder",
            self.sync_search_workspace_folder(&id),
        )
        .await;
        self.get_folder(&id)
            .await?
            .ok_or_else(|| StorageError::NotFound("folder disappeared after insert".into()))
    }

    pub async fn update_folder(
        &self,
        id: &str,
        name: Option<&str>,
        parent_id: Option<Option<&str>>,
    ) -> Result<WorkspaceFolderRow, StorageError> {
        let current = self
            .get_folder(id)
            .await?
            .ok_or_else(|| StorageError::NotFound("folder not found".into()))?;
        if name.is_none() && parent_id.is_none() {
            return Ok(current);
        }
        let name = match name {
            Some(value) => required_text(value, "folder name")?,
            None => current.name.as_str(),
        };
        let next_parent = match parent_id {
            Some(value) => value.map(str::to_string),
            None => current.parent_id.clone(),
        };
        if let Some(parent) = next_parent.as_deref() {
            if parent == id {
                return Err(StorageError::Invalid("folder cannot be its own parent".into()));
            }
            self.require_folder_access(&current.owner_user_id, false, parent)
                .await?;
            if self.folder_is_descendant(parent, id).await? {
                return Err(StorageError::Invalid(
                    "cannot move a folder under its descendant".into(),
                ));
            }
        }
        self.ensure_folder_name_available(
            &current.owner_user_id,
            next_parent.as_deref(),
            name,
            Some(id),
        )
        .await?;
        sqlx::query(
            "UPDATE workspace_folders SET name = ?, parent_id = ?, updated_at = ? WHERE id = ?",
        )
        .bind(name)
        .bind(next_parent.as_deref())
        .bind(now_rfc3339())
        .bind(id)
        .execute(&self.pool)
        .await
        .map_err(map_folder_sql)?;
        search::sync_search_best_effort(
            self,
            "workspace_folder",
            self.sync_search_workspace_folder(id),
        )
        .await;
        self.get_folder(id)
            .await?
            .ok_or_else(|| StorageError::NotFound("folder disappeared after update".into()))
    }

    async fn ensure_folder_name_available(
        &self,
        owner_user_id: &str,
        parent_id: Option<&str>,
        name: &str,
        exclude_id: Option<&str>,
    ) -> Result<(), StorageError> {
        let existing = match parent_id {
            Some(parent_id) => {
                sqlx::query_scalar::<_, String>(
                    "SELECT id FROM workspace_folders
                     WHERE owner_user_id = ?
                       AND parent_id = ?
                       AND name = ? COLLATE NOCASE
                     LIMIT 1",
                )
                .bind(owner_user_id)
                .bind(parent_id)
                .bind(name)
                .fetch_optional(&self.pool)
                .await?
            }
            None => {
                sqlx::query_scalar::<_, String>(
                    "SELECT id FROM workspace_folders
                     WHERE owner_user_id = ?
                       AND parent_id IS NULL
                       AND name = ? COLLATE NOCASE
                     LIMIT 1",
                )
                .bind(owner_user_id)
                .bind(name)
                .fetch_optional(&self.pool)
                .await?
            }
        };
        if let Some(existing_id) = existing {
            if exclude_id != Some(existing_id.as_str()) {
                return Err(StorageError::Conflict(
                    "folder name already exists under this parent".into(),
                ));
            }
        }
        Ok(())
    }

    pub async fn delete_folder(&self, id: &str) -> Result<(), StorageError> {
        let result = sqlx::query("DELETE FROM workspace_folders WHERE id = ?")
            .bind(id)
            .execute(&self.pool)
            .await?;
        if result.rows_affected() == 0 {
            return Err(StorageError::NotFound("folder not found".into()));
        }
        let _ = self.delete_search_document("workspace_folder", id).await;
        Ok(())
    }

    async fn folder_is_descendant(&self, candidate: &str, ancestor: &str) -> Result<bool, StorageError> {
        let mut current = Some(candidate.to_string());
        let mut guard = 0;
        while let Some(id) = current {
            if id == ancestor {
                return Ok(true);
            }
            guard += 1;
            if guard > 64 {
                return Err(StorageError::Invalid("folder tree too deep".into()));
            }
            current = self
                .get_folder(&id)
                .await?
                .and_then(|folder| folder.parent_id);
        }
        Ok(false)
    }

    pub async fn save_workspace(
        &self,
        id: &str,
        layout_json: &str,
        chip_ids: &[String],
        edges: &[WorkspaceSaveEdge],
    ) -> Result<(WorkspaceRow, Vec<ChipRow>, Vec<ChipEdgeRow>), StorageError> {
        require_config_json(layout_json)?;
        let current = self
            .get_workspace(id)
            .await?
            .ok_or_else(|| StorageError::NotFound("workspace not found".into()))?;
        let now = now_rfc3339();
        let version = current.version + 1;
        let mut tx = self.pool.begin().await?;
        let mut saved_chips = Vec::with_capacity(chip_ids.len());
        for chip_id in chip_ids {
            let chip_id = required_text(chip_id, "chip id")?;
            let chip = sqlx::query_as::<_, ChipRow>(&format!(
                "SELECT {CHIP_COLS} FROM chips WHERE id = ?"
            ))
            .bind(chip_id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(|| StorageError::NotFound(format!("chip {chip_id} not found")))?;
            saved_chips.push(chip);
        }
        sqlx::query("DELETE FROM workspace_chips WHERE workspace_id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        for chip in &saved_chips {
            sqlx::query(
                "INSERT INTO workspace_chips (workspace_id, chip_id, created_at)
                 VALUES (?, ?, ?)",
            )
            .bind(id)
            .bind(&chip.id)
            .bind(&now)
            .execute(&mut *tx)
            .await?;
        }
        let saved_edges = replace_workspace_edges(&mut tx, id, edges, &saved_chips, &now).await?;
        sqlx::query(
            "UPDATE workspaces SET layout_json = ?, version = ?, updated_at = ? WHERE id = ?",
        )
        .bind(layout_json)
        .bind(version)
        .bind(&now)
        .bind(id)
        .execute(&mut *tx)
        .await?;
        let snapshot = workspace_snapshot_json(layout_json, &saved_chips, &saved_edges)?;
        sqlx::query(
            "INSERT INTO workspace_revisions (workspace_id, version, snapshot_json, created_at)
             VALUES (?, ?, ?, ?)",
        )
        .bind(id)
        .bind(version)
        .bind(&snapshot)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        let workspace = self
            .get_workspace(id)
            .await?
            .ok_or_else(|| StorageError::NotFound("workspace disappeared after save".into()))?;
        Ok((workspace, saved_chips, saved_edges))
    }

    async fn backfill_workspace_revisions(&self) -> Result<(), StorageError> {
        let workspaces = sqlx::query_as::<_, WorkspaceRow>(&format!(
            "SELECT {WORKSPACE_COLS} FROM workspaces ORDER BY created_at ASC"
        ))
        .fetch_all(&self.pool)
        .await?;
        for workspace in workspaces {
            let exists: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM workspace_revisions WHERE workspace_id = ?",
            )
            .bind(&workspace.id)
            .fetch_one(&self.pool)
            .await?;
            if exists > 0 {
                continue;
            }
            let chips = sqlx::query_as::<_, ChipRow>(&format!(
                "SELECT {CHIP_JOIN_COLS} FROM chips c
                 INNER JOIN workspace_chips wc ON wc.chip_id = c.id
                 WHERE wc.workspace_id = ? ORDER BY c.updated_at DESC"
            ))
            .bind(&workspace.id)
            .fetch_all(&self.pool)
            .await?;
            let snapshot = workspace_snapshot_json(&workspace.layout_json, &chips, &[])?;
            sqlx::query(
                "INSERT INTO workspace_revisions (workspace_id, version, snapshot_json, created_at)
                 VALUES (?, ?, ?, ?)",
            )
            .bind(&workspace.id)
            .bind(workspace.version)
            .bind(&snapshot)
            .bind(&workspace.updated_at)
            .execute(&self.pool)
            .await?;
        }
        Ok(())
    }

    pub async fn list_chips(
        &self,
        workspace_id: &str,
    ) -> Result<Vec<ChipRow>, StorageError> {
        self.require_workspace(workspace_id).await?;
        Ok(sqlx::query_as::<_, ChipRow>(&format!(
            "SELECT {CHIP_JOIN_COLS} FROM chips c
             INNER JOIN workspace_chips wc ON wc.chip_id = c.id
             WHERE wc.workspace_id = ? ORDER BY c.updated_at DESC"
        ))
        .bind(workspace_id)
        .fetch_all(&self.pool)
        .await?)
    }

    pub async fn list_owned_chips(
        &self,
        owner_user_id: &str,
    ) -> Result<Vec<ChipRow>, StorageError> {
        Ok(sqlx::query_as::<_, ChipRow>(&format!(
            "SELECT {CHIP_COLS} FROM chips
             WHERE owner_user_id = ? ORDER BY updated_at DESC"
        ))
        .bind(owner_user_id)
        .fetch_all(&self.pool)
        .await?)
    }

    pub async fn get_chip(
        &self,
        id: &str,
    ) -> Result<Option<ChipRow>, StorageError> {
        Ok(sqlx::query_as::<_, ChipRow>(&format!(
            "SELECT {CHIP_COLS} FROM chips WHERE id = ?"
        ))
        .bind(id)
        .fetch_optional(&self.pool)
        .await?)
    }

    pub async fn attach_chip_to_workspace(
        &self,
        workspace_id: &str,
        chip_id: &str,
    ) -> Result<(), StorageError> {
        self.require_workspace(workspace_id).await?;
        self.get_chip(chip_id)
            .await?
            .ok_or_else(|| StorageError::NotFound("chip not found".into()))?;
        let now = now_rfc3339();
        sqlx::query(
            "INSERT INTO workspace_chips (workspace_id, chip_id, created_at)
             VALUES (?, ?, ?)
             ON CONFLICT(workspace_id, chip_id) DO NOTHING",
        )
        .bind(workspace_id)
        .bind(chip_id)
        .bind(&now)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn get_chip_binding(
        &self,
        chip_id: &str,
    ) -> Result<Option<ChipBindingRow>, StorageError> {
        Ok(sqlx::query_as::<_, ChipBindingRow>(
            "SELECT chip_id, ref_kind, ref_id FROM chip_bindings WHERE chip_id = ?",
        )
        .bind(chip_id)
        .fetch_optional(&self.pool)
        .await?)
    }

    pub async fn get_extract_definition(
        &self,
        id: &str,
    ) -> Result<Option<ExtractDefinitionRow>, StorageError> {
        Ok(sqlx::query_as::<_, ExtractDefinitionRow>(&format!(
            "SELECT {EXTRACT_DEFINITION_COLS} FROM extract_definitions WHERE id = ?"
        ))
        .bind(id)
        .fetch_optional(&self.pool)
        .await?)
    }

    pub async fn resolve_chip_config_json(&self, chip: &ChipRow) -> Result<String, StorageError> {
        if let Some(binding) = self.get_chip_binding(&chip.id).await? {
            return self.config_json_for_binding(&binding).await;
        }
        let legacy = chip
            .config_json
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| StorageError::Invalid("chip has no binding or config".into()))?;
        Ok(legacy.to_string())
    }

    async fn config_json_for_binding(
        &self,
        binding: &ChipBindingRow,
    ) -> Result<String, StorageError> {
        match binding.ref_kind.as_str() {
            "extract_definition" => {
                let row = self
                    .get_extract_definition(&binding.ref_id)
                    .await?
                    .ok_or_else(|| StorageError::NotFound("extract definition not found".into()))?;
                let source: serde_json::Value = serde_json::from_str(&row.source_json)
                    .map_err(|error| StorageError::Invalid(error.to_string()))?;
                Ok(serde_json::json!({
                    "connection_id": row.connection_id,
                    "source": source,
                    "delimiter": row.delimiter,
                    "header": row.header != 0,
                })
                .to_string())
            }
            "transform" => {
                let row = self
                    .get_transform(&binding.ref_id)
                    .await?
                    .ok_or_else(|| StorageError::NotFound("transform not found".into()))?;
                let spec: serde_json::Value = serde_json::from_str(&row.spec_json)
                    .map_err(|error| StorageError::Invalid(error.to_string()))?;
                Ok(serde_json::json!({
                    "input_dataset_id": row.dataset_id,
                    "spec": spec,
                })
                .to_string())
            }
            other => Err(StorageError::Invalid(format!("unknown chip binding kind {other}"))),
        }
    }

    pub async fn register_extract_chip(
        &self,
        input: &RegisterExtractChip,
    ) -> Result<ChipRow, StorageError> {
        validate_extract_kind(&input.kind)?;
        let name = required_text(&input.name, "chip name")?;
        if input.place_on_workspace {
            let workspace_id = input
                .workspace_id
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| StorageError::Invalid("workspace_id required".into()))?;
            self.require_workspace(workspace_id).await?;
        } else if let Some(workspace_id) = input.workspace_id.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
            self.require_workspace(workspace_id).await?;
        }
        let _ = self
            .get_connection(&input.connection_id)
            .await?
            .ok_or_else(|| StorageError::NotFound("connection not found".into()))?;
        require_config_json(&input.source_json)?;
        let extract_id = Uuid::new_v4().to_string();
        let chip_id = Uuid::new_v4().to_string();
        let now = now_rfc3339();
        let mut tx = self.pool.begin().await?;
        sqlx::query(
            "INSERT INTO extract_definitions
             (id, name, kind, connection_id, source_json, delimiter, header, add_sequence,
              workspace_id, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&extract_id)
        .bind(name)
        .bind(&input.kind)
        .bind(&input.connection_id)
        .bind(&input.source_json)
        .bind(&input.delimiter)
        .bind(i64::from(input.header))
        .bind(i64::from(input.add_sequence))
        .bind(input.workspace_id.as_deref())
        .bind(&now)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "INSERT INTO chips
             (id, owner_user_id, name, kind, config_json, revision, active, created_at, updated_at)
             VALUES (?, ?, ?, 'extract', NULL, 1, 1, ?, ?)",
        )
        .bind(&chip_id)
        .bind(&input.owner_user_id)
        .bind(name)
        .bind(&now)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "INSERT INTO chip_bindings (chip_id, ref_kind, ref_id)
             VALUES (?, 'extract_definition', ?)",
        )
        .bind(&chip_id)
        .bind(&extract_id)
        .execute(&mut *tx)
        .await?;
        if input.place_on_workspace {
            let workspace_id = input
                .workspace_id
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| StorageError::Invalid("workspace_id required".into()))?;
            sqlx::query(
                "INSERT INTO workspace_chips (workspace_id, chip_id, created_at)
                 VALUES (?, ?, ?)
                 ON CONFLICT(workspace_id, chip_id) DO NOTHING",
            )
            .bind(workspace_id)
            .bind(&chip_id)
            .bind(&now)
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await?;
        search::sync_search_best_effort(self, "chip", self.sync_search_chip(&chip_id)).await;
        self.get_chip(&chip_id)
            .await?
            .ok_or_else(|| StorageError::NotFound("chip disappeared after register".into()))
    }

    pub async fn register_transform_chip(
        &self,
        input: &RegisterTransformChip,
    ) -> Result<ChipRow, StorageError> {
        let name = required_text(&input.name, "chip name")?;
        if input.place_on_workspace {
            let workspace_id = input
                .workspace_id
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| StorageError::Invalid("workspace_id required".into()))?;
            self.require_workspace(workspace_id).await?;
        } else if let Some(workspace_id) = input.workspace_id.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
            self.require_workspace(workspace_id).await?;
        }
        let transform = self
            .get_transform(&input.transform_id)
            .await?
            .ok_or_else(|| StorageError::NotFound("transform not found".into()))?;
        let _ = transform;
        let chip_id = Uuid::new_v4().to_string();
        let now = now_rfc3339();
        let mut tx = self.pool.begin().await?;
        sqlx::query(
            "INSERT INTO chips
             (id, owner_user_id, name, kind, config_json, revision, active, created_at, updated_at)
             VALUES (?, ?, ?, 'transform', NULL, 1, 1, ?, ?)",
        )
        .bind(&chip_id)
        .bind(&input.owner_user_id)
        .bind(name)
        .bind(&now)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "INSERT INTO chip_bindings (chip_id, ref_kind, ref_id)
             VALUES (?, 'transform', ?)",
        )
        .bind(&chip_id)
        .bind(&input.transform_id)
        .execute(&mut *tx)
        .await?;
        if input.place_on_workspace {
            let workspace_id = input
                .workspace_id
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| StorageError::Invalid("workspace_id required".into()))?;
            sqlx::query(
                "INSERT INTO workspace_chips (workspace_id, chip_id, created_at)
                 VALUES (?, ?, ?)
                 ON CONFLICT(workspace_id, chip_id) DO NOTHING",
            )
            .bind(workspace_id)
            .bind(&chip_id)
            .bind(&now)
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await?;
        search::sync_search_best_effort(self, "chip", self.sync_search_chip(&chip_id)).await;
        self.get_chip(&chip_id)
            .await?
            .ok_or_else(|| StorageError::NotFound("chip disappeared after register".into()))
    }

    pub async fn insert_chip(
        &self,
        owner_user_id: &str,
        workspace_id: &str,
        name: &str,
        kind: &str,
        config_json: &str,
    ) -> Result<ChipRow, StorageError> {
        let name = required_text(name, "chip name")?;
        validate_chip_kind(kind)?;
        require_config_json(config_json)?;
        self.require_workspace(workspace_id).await?;
        let id = Uuid::new_v4().to_string();
        let now = now_rfc3339();
        let mut tx = self.pool.begin().await?;
        sqlx::query(
            "INSERT INTO chips
             (id, owner_user_id, name, kind, config_json, revision, active, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?)",
        )
        .bind(&id)
        .bind(owner_user_id)
        .bind(name)
        .bind(kind)
        .bind(config_json)
        .bind(&now)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        search::sync_search_best_effort(self, "chip", self.sync_search_chip(&id)).await;
        self.get_chip(&id)
            .await?
            .ok_or_else(|| StorageError::NotFound("chip disappeared after insert".into()))
    }

    pub async fn update_chip(
        &self,
        id: &str,
        name: Option<&str>,
        kind: Option<&str>,
        config_json: Option<&str>,
        active: Option<bool>,
    ) -> Result<ChipRow, StorageError> {
        let current = self
            .get_chip(id)
            .await?
            .ok_or_else(|| StorageError::NotFound("chip not found".into()))?;
        if name.is_none() && kind.is_none() && config_json.is_none() && active.is_none() {
            return Ok(current);
        }
        let name = match name {
            Some(value) => required_text(value, "chip name")?,
            None => current.name.as_str(),
        };
        let kind = kind.unwrap_or(current.kind.as_str());
        validate_chip_kind(kind)?;
        let config_json = match config_json {
            Some(value) => {
                if self.get_chip_binding(id).await?.is_some() {
                    return Err(StorageError::Invalid(
                        "registered chips update definitions, not inline config".into(),
                    ));
                }
                require_config_json(value)?;
                Some(value.to_string())
            }
            None => current.config_json.clone(),
        };
        let bump = name != current.name
            || kind != current.kind
            || config_json != current.config_json;
        sqlx::query(
            "UPDATE chips
             SET name = ?, kind = ?, config_json = ?, revision = revision + ?,
                 active = ?, updated_at = ?
             WHERE id = ?",
        )
        .bind(name)
        .bind(kind)
        .bind(config_json.as_deref())
        .bind(i64::from(bump))
        .bind(active.map(i64::from).unwrap_or(current.active))
        .bind(now_rfc3339())
        .bind(id)
        .execute(&self.pool)
        .await?;
        search::sync_search_best_effort(self, "chip", self.sync_search_chip(id)).await;
        self.get_chip(id)
            .await?
            .ok_or_else(|| StorageError::NotFound("chip disappeared after update".into()))
    }

    pub async fn delete_chip(&self, id: &str) -> Result<(), StorageError> {
        let mut tx = self.pool.begin().await?;
        let found: Option<String> = sqlx::query_scalar("SELECT id FROM chips WHERE id = ?")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?;
        if found.is_none() {
            return Err(StorageError::NotFound("chip not found".into()));
        }
        sqlx::query(
            "UPDATE datasets SET producer_chip_run_id = NULL
             WHERE producer_chip_run_id IN (SELECT id FROM chip_runs WHERE chip_id = ?)",
        )
        .bind(id)
        .execute(&mut *tx)
        .await?;
        sqlx::query("DELETE FROM chip_edges WHERE from_chip_id = ? OR to_chip_id = ?")
            .bind(id)
            .bind(id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM chip_runs WHERE chip_id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM chips WHERE id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        let _ = self.delete_search_document("chip", id).await;
        Ok(())
    }

    pub async fn create_chip_run(
        &self,
        chip_id: &str,
        workspace_id: &str,
        expected_revision: i64,
        config_snapshot_json: &str,
        input_dataset_id: Option<&str>,
    ) -> Result<ChipRunRow, StorageError> {
        let task = self
            .get_chip(chip_id)
            .await?
            .ok_or_else(|| StorageError::NotFound("chip not found".into()))?;
        if task.active == 0 || task.revision != expected_revision {
            return Err(StorageError::Invalid(
                "chip changed before the run could be queued".into(),
            ));
        }
        let on_workspace: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM workspace_chips WHERE workspace_id = ? AND chip_id = ?",
        )
        .bind(workspace_id)
        .bind(chip_id)
        .fetch_one(&self.pool)
        .await?;
        if on_workspace == 0 {
            return Err(StorageError::Invalid(
                "chip is not placed on this workspace".into(),
            ));
        }
        require_config_json(config_snapshot_json)?;
        if let Some(dataset_id) = input_dataset_id {
            let dataset = self
                .get_dataset(dataset_id)
                .await?
                .ok_or_else(|| StorageError::NotFound("input dataset not found".into()))?;
            if dataset.workspace_id != workspace_id {
                return Err(StorageError::Invalid(
                    "input dataset belongs to another workspace".into(),
                ));
            }
        }
        let id = Uuid::new_v4().to_string();
        let result = sqlx::query(
            "INSERT INTO chip_runs
             (id, chip_id, workspace_id, kind, status, config_snapshot_json,
              revision_snapshot, input_dataset_id, created_at)
             VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(chip_id)
        .bind(workspace_id)
        .bind(&task.kind)
        .bind(config_snapshot_json)
        .bind(expected_revision)
        .bind(input_dataset_id)
        .bind(now_rfc3339())
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 0 {
            return Err(StorageError::Invalid(
                "chip changed before the run could be queued".into(),
            ));
        }
        self.get_chip_run(&id)
            .await?
            .ok_or_else(|| StorageError::NotFound("chip run disappeared after insert".into()))
    }

    pub async fn get_chip_run(&self, id: &str) -> Result<Option<ChipRunRow>, StorageError> {
        Ok(sqlx::query_as::<_, ChipRunRow>(&format!(
            "SELECT {CHIP_RUN_COLS} FROM chip_runs WHERE id = ?"
        ))
        .bind(id)
        .fetch_optional(&self.pool)
        .await?)
    }

    pub async fn list_chip_runs(
        &self,
        workspace_id: &str,
    ) -> Result<Vec<ChipRunRow>, StorageError> {
        self.require_workspace(workspace_id).await?;
        Ok(sqlx::query_as::<_, ChipRunRow>(&format!(
            "SELECT {CHIP_RUN_COLS} FROM chip_runs
             WHERE workspace_id = ? ORDER BY created_at DESC"
        ))
        .bind(workspace_id)
        .fetch_all(&self.pool)
        .await?)
    }

    pub async fn list_chip_edges(
        &self,
        workspace_id: &str,
    ) -> Result<Vec<ChipEdgeRow>, StorageError> {
        self.require_workspace(workspace_id).await?;
        Ok(sqlx::query_as::<_, ChipEdgeRow>(&format!(
            "SELECT {CHIP_EDGE_COLS} FROM chip_edges
             WHERE workspace_id = ? ORDER BY created_at ASC"
        ))
        .bind(workspace_id)
        .fetch_all(&self.pool)
        .await?)
    }

    pub async fn latest_chip_output(
        &self,
        chip_id: &str,
    ) -> Result<Option<String>, StorageError> {
        Ok(sqlx::query_scalar(
            "SELECT output_dataset_id FROM chip_runs
             WHERE chip_id = ? AND status = 'succeeded' AND output_dataset_id IS NOT NULL
             ORDER BY COALESCE(finished_at, created_at) DESC, created_at DESC
             LIMIT 1",
        )
        .bind(chip_id)
        .fetch_optional(&self.pool)
        .await?)
    }

    pub async fn latest_chip_output_for_workspace(
        &self,
        workspace_id: &str,
        chip_id: &str,
    ) -> Result<Option<String>, StorageError> {
        let slot_id: Option<String> = sqlx::query_scalar(
            "SELECT s.dataset_id FROM chip_output_slots s
             INNER JOIN datasets d ON d.id = s.dataset_id
             WHERE s.workspace_id = ? AND s.chip_id = ?
               AND d.status = 'materialized'
               AND d.stored_path IS NOT NULL AND TRIM(d.stored_path) != ''",
        )
        .bind(workspace_id)
        .bind(chip_id)
        .fetch_optional(&self.pool)
        .await?;
        if slot_id.is_some() {
            return Ok(slot_id);
        }
        Ok(sqlx::query_scalar(
            "SELECT output_dataset_id FROM chip_runs
             WHERE chip_id = ? AND workspace_id = ? AND status = 'succeeded'
               AND output_dataset_id IS NOT NULL
             ORDER BY COALESCE(finished_at, created_at) DESC, created_at DESC
             LIMIT 1",
        )
        .bind(chip_id)
        .bind(workspace_id)
        .fetch_optional(&self.pool)
        .await?)
    }

    pub async fn find_planned_input_dataset(
        &self,
        workspace_id: &str,
        consumer_chip_id: &str,
    ) -> Result<Option<DatasetRow>, StorageError> {
        let id: Option<String> = sqlx::query_scalar(
            "SELECT id FROM datasets
             WHERE workspace_id = ? AND consumer_chip_id = ? AND status = 'planned'
             LIMIT 1",
        )
        .bind(workspace_id)
        .bind(consumer_chip_id)
        .fetch_optional(&self.pool)
        .await?;
        match id {
            Some(dataset_id) => self.get_dataset(&dataset_id).await,
            None => Ok(None),
        }
    }

    pub async fn upsert_planned_input_dataset(
        &self,
        workspace_id: &str,
        consumer_chip_id: &str,
        source_chip_id: &str,
        source_extract_definition_id: Option<&str>,
        filename: &str,
        columns_json: &str,
        delimiter: &str,
        header: bool,
    ) -> Result<DatasetRow, StorageError> {
        let now = now_rfc3339();
        if let Some(existing) = self
            .find_planned_input_dataset(workspace_id, consumer_chip_id)
            .await?
        {
            sqlx::query(
                "UPDATE datasets SET
                   source_chip_id = ?,
                   source_extract_definition_id = ?,
                   filename = ?,
                   columns_json = ?,
                   delimiter = ?,
                   has_header = ?,
                   inspected_at = ?,
                   updated_at = ?
                 WHERE id = ?",
            )
            .bind(source_chip_id)
            .bind(source_extract_definition_id)
            .bind(filename)
            .bind(columns_json)
            .bind(delimiter)
            .bind(i64::from(header))
            .bind(&now)
            .bind(&now)
            .bind(&existing.id)
            .execute(&self.pool)
            .await?;
            return self
                .get_dataset(&existing.id)
                .await?
                .ok_or_else(|| StorageError::NotFound("planned dataset missing".into()));
        }
        let id = Uuid::new_v4().to_string();
        let stored_path = format!("__planned__/{id}");
        sqlx::query(
            "INSERT INTO datasets
             (id, kind, extract_id, filename, stored_path, size_bytes, delimiter, has_header,
              columns_json, row_count, inspected_at, created_at, updated_at, workspace_id,
              producer_chip_run_id, status, source_chip_id, consumer_chip_id,
              source_extract_definition_id)
             VALUES (?, 'database', NULL, ?, ?, NULL, ?, ?, ?, NULL, ?, ?, ?, ?, NULL,
                     'planned', ?, ?, ?)",
        )
        .bind(&id)
        .bind(filename)
        .bind(&stored_path)
        .bind(delimiter)
        .bind(i64::from(header))
        .bind(columns_json)
        .bind(&now)
        .bind(&now)
        .bind(&now)
        .bind(workspace_id)
        .bind(source_chip_id)
        .bind(consumer_chip_id)
        .bind(source_extract_definition_id)
        .execute(&self.pool)
        .await?;
        self.get_dataset(&id)
            .await?
            .ok_or_else(|| StorageError::NotFound("planned dataset missing".into()))
    }

    pub async fn linked_chip_run_for_extract(
        &self,
        extract_id: &str,
    ) -> Result<Option<LinkedChipRun>, StorageError> {
        Ok(sqlx::query_as::<_, (String, String, String)>(
            "SELECT id, chip_id, workspace_id FROM chip_runs
             WHERE legacy_extract_id = ? AND status IN ('queued', 'running')",
        )
        .bind(extract_id)
        .fetch_optional(&self.pool)
        .await?
        .map(|(run_id, chip_id, workspace_id)| LinkedChipRun {
            run_id,
            chip_id,
            workspace_id,
        }))
    }

    pub async fn linked_chip_run_for_job(
        &self,
        job_id: &str,
    ) -> Result<Option<LinkedChipRun>, StorageError> {
        Ok(sqlx::query_as::<_, (String, String, String)>(
            "SELECT id, chip_id, workspace_id FROM chip_runs
             WHERE legacy_job_id = ? AND status IN ('queued', 'running')",
        )
        .bind(job_id)
        .fetch_optional(&self.pool)
        .await?
        .map(|(run_id, chip_id, workspace_id)| LinkedChipRun {
            run_id,
            chip_id,
            workspace_id,
        }))
    }

    async fn upsert_chip_output_slot_dataset(
        &self,
        tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
        workspace_id: &str,
        chip_id: &str,
        chip_run_id: &str,
        kind: &str,
        filename: &str,
        stored_path: &str,
        size_bytes: Option<i64>,
        row_count: Option<i64>,
        delimiter: Option<&str>,
        has_header: Option<bool>,
        extract_id: Option<&str>,
    ) -> Result<String, StorageError> {
        let existing: Option<String> = sqlx::query_scalar(
            "SELECT dataset_id FROM chip_output_slots
             WHERE workspace_id = ? AND chip_id = ?",
        )
        .bind(workspace_id)
        .bind(chip_id)
        .fetch_optional(&mut **tx)
        .await?;
        let had_slot = existing.is_some();
        let mut dataset_id = existing.unwrap_or_else(|| Uuid::new_v4().to_string());
        if !had_slot {
            if let Some(path_owner) = sqlx::query_scalar(
                "SELECT id FROM datasets WHERE stored_path = ?",
            )
            .bind(stored_path)
            .fetch_optional(&mut **tx)
            .await? {
                dataset_id = path_owner;
            }
        }
        let now = now_rfc3339();
        let has_header_i64 = has_header.map(i64::from);
        sqlx::query(
            "INSERT INTO datasets
             (id, kind, extract_id, filename, stored_path, size_bytes, delimiter, has_header,
              row_count, created_at, updated_at, workspace_id, producer_chip_run_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               kind = excluded.kind,
               extract_id = excluded.extract_id,
               filename = excluded.filename,
               stored_path = excluded.stored_path,
               size_bytes = excluded.size_bytes,
               delimiter = COALESCE(excluded.delimiter, datasets.delimiter),
               has_header = COALESCE(excluded.has_header, datasets.has_header),
               row_count = COALESCE(excluded.row_count, datasets.row_count),
               workspace_id = excluded.workspace_id,
               producer_chip_run_id = excluded.producer_chip_run_id,
               updated_at = excluded.updated_at",
        )
        .bind(&dataset_id)
        .bind(kind)
        .bind(extract_id)
        .bind(filename)
        .bind(stored_path)
        .bind(size_bytes)
        .bind(delimiter)
        .bind(has_header_i64)
        .bind(row_count)
        .bind(&now)
        .bind(&now)
        .bind(workspace_id)
        .bind(chip_run_id)
        .execute(&mut **tx)
        .await?;
        sqlx::query(
            "INSERT INTO chip_output_slots
             (workspace_id, chip_id, dataset_id, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(workspace_id, chip_id) DO UPDATE SET
               dataset_id = excluded.dataset_id,
               updated_at = excluded.updated_at",
        )
        .bind(workspace_id)
        .bind(chip_id)
        .bind(&dataset_id)
        .bind(&now)
        .bind(&now)
        .execute(&mut **tx)
        .await?;
        Ok(dataset_id)
    }

    pub async fn set_chip_run_running(&self, id: &str) -> Result<(), StorageError> {
        let result = sqlx::query(
            "UPDATE chip_runs SET status = 'running', started_at = ?, error_message = NULL
             WHERE id = ? AND status = 'queued'",
        )
        .bind(now_rfc3339())
        .bind(id)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 0 {
            return Err(StorageError::Invalid(
                "chip run must be queued before starting".into(),
            ));
        }
        Ok(())
    }

    pub async fn attach_chip_run_extract(
        &self,
        id: &str,
        extract_id: &str,
    ) -> Result<(), StorageError> {
        update_running_chip_ref(&self.pool, id, "legacy_extract_id", extract_id).await
    }

    pub async fn attach_chip_run_job(&self, id: &str, job_id: &str) -> Result<(), StorageError> {
        update_running_chip_ref(&self.pool, id, "legacy_job_id", job_id).await
    }

    pub async fn set_chip_run_succeeded(
        &self,
        id: &str,
        output_dataset_id: &str,
    ) -> Result<(), StorageError> {
        let run = self
            .get_chip_run(id)
            .await?
            .ok_or_else(|| StorageError::NotFound("chip run not found".into()))?;
        let dataset = self
            .get_dataset(output_dataset_id)
            .await?
            .ok_or_else(|| StorageError::NotFound("output dataset not found".into()))?;
        if dataset.workspace_id != run.workspace_id
            || dataset.producer_chip_run_id.as_deref() != Some(id)
        {
            return Err(StorageError::Invalid(
                "output dataset provenance does not match chip run".into(),
            ));
        }
        let result = sqlx::query(
            "UPDATE chip_runs
             SET status = 'succeeded', output_dataset_id = ?, error_message = NULL,
                 finished_at = ?
             WHERE id = ? AND status = 'running'",
        )
        .bind(output_dataset_id)
        .bind(now_rfc3339())
        .bind(id)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 0 {
            return Err(StorageError::Invalid(
                "only a running chip run can succeed".into(),
            ));
        }
        Ok(())
    }

    pub async fn set_chip_run_failed(&self, id: &str, error: &str) -> Result<(), StorageError> {
        let result = sqlx::query(
            "UPDATE chip_runs
             SET status = 'failed', error_message = ?, finished_at = ?
             WHERE id = ? AND status IN ('queued', 'running')",
        )
        .bind(error)
        .bind(now_rfc3339())
        .bind(id)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 0 {
            return Err(StorageError::Invalid(
                "only a queued or running chip run can fail".into(),
            ));
        }
        Ok(())
    }

    async fn require_workspace(&self, id: &str) -> Result<(), StorageError> {
        if self.get_workspace(id).await?.is_none() {
            return Err(StorageError::NotFound("workspace not found".into()));
        }
        Ok(())
    }

    pub async fn save_upload(
        &self,
        filename: &str,
        bytes: &[u8],
        delimiter: Option<&str>,
        has_header: Option<bool>,
        workspace_id: &str,
    ) -> Result<FileMeta, StorageError> {
        self.require_workspace(workspace_id).await?;
        let id = Uuid::new_v4().to_string();
        let filename = safe_filename(filename);
        let rel = upload_rel(&id, &filename);
        let dest = self.data_dir.join(&rel);
        if let Some(parent) = dest.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        tokio::fs::write(&dest, bytes).await?;
        if let Err(error) = self
            .upsert_dataset(&DatasetUpsert {
                id: id.clone(),
                kind: "upload".into(),
                extract_id: None,
                filename: filename.clone(),
                stored_path: rel.clone(),
                size_bytes: Some(bytes.len() as i64),
                delimiter: delimiter.map(str::to_string),
                has_header,
                row_count: None,
                workspace_id: Some(workspace_id.to_string()),
            })
            .await
        {
            let _ = tokio::fs::remove_dir_all(self.uploads_dir().join(&id)).await;
            return Err(error);
        }
        search::sync_search_best_effort(self, "dataset", self.sync_search_dataset(&id)).await;
        Ok(FileMeta {
            id,
            filename,
            size: bytes.len() as u64,
            stored_path: rel,
        })
    }

    pub async fn stage_spreadsheet(
        &self,
        original_filename: &str,
        bytes: &[u8],
    ) -> Result<StagedFile, StorageError> {
        let id = Uuid::new_v4().to_string();
        let original_filename = safe_filename(original_filename);
        let dir = self.staging_dir().join(&id);
        let path = dir.join(&original_filename);
        tokio::fs::create_dir_all(&dir).await?;
        if let Err(error) = tokio::fs::write(&path, bytes).await {
            let _ = tokio::fs::remove_dir_all(&dir).await;
            return Err(error.into());
        }
        Ok(StagedFile {
            id,
            original_filename,
            path,
        })
    }

    pub async fn staged_file(&self, id: &str) -> Result<StagedFile, StorageError> {
        validate_uuid(id, "staging_id")?;
        let dir = self.staging_dir().join(id);
        let mut entries = tokio::fs::read_dir(&dir)
            .await
            .map_err(|error| match error.kind() {
                std::io::ErrorKind::NotFound => {
                    StorageError::NotFound("staging file not found".into())
                }
                _ => error.into(),
            })?;
        let mut staged = None;
        while let Some(entry) = entries.next_entry().await? {
            if !entry.file_type().await?.is_file() || staged.is_some() {
                return Err(StorageError::Invalid("invalid staging directory".into()));
            }
            staged = Some(StagedFile {
                id: id.to_string(),
                original_filename: entry.file_name().to_string_lossy().into_owned(),
                path: entry.path(),
            });
        }
        staged.ok_or_else(|| StorageError::NotFound("staging file not found".into()))
    }

    pub async fn delete_stage(&self, id: &str) -> Result<(), StorageError> {
        validate_uuid(id, "staging_id")?;
        let dir = self.staging_dir().join(id);
        tokio::fs::remove_dir_all(dir)
            .await
            .map_err(|error| match error.kind() {
                std::io::ErrorKind::NotFound => {
                    StorageError::NotFound("staging file not found".into())
                }
                _ => error.into(),
            })
    }

    pub async fn list_uploads(&self, scope: Option<&DataScope>) -> Result<Vec<FileMeta>, StorageError> {
        let rows = self.list_datasets(scope).await?;
        Ok(rows
            .into_iter()
            .filter(|row| row.kind == "upload")
            .map(|row| FileMeta {
                id: row.id,
                filename: row.filename,
                size: row.size_bytes.unwrap_or(0) as u64,
                stored_path: row.stored_path,
            })
            .collect())
    }

    async fn list_upload_dirs(&self) -> Result<Vec<FileMeta>, StorageError> {
        let mut out = Vec::new();
        let root = self.uploads_dir();
        let mut dirs = match tokio::fs::read_dir(&root).await {
            Ok(d) => d,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(out),
            Err(e) => return Err(e.into()),
        };
        while let Some(entry) = dirs.next_entry().await? {
            if !entry.file_type().await?.is_dir() {
                continue;
            }
            let id = entry.file_name().to_string_lossy().into_owned();
            if Uuid::parse_str(&id).is_err() {
                continue;
            }
            let mut files = tokio::fs::read_dir(entry.path()).await?;
            while let Some(file) = files.next_entry().await? {
                if !file.file_type().await?.is_file() {
                    continue;
                }
                let filename = file.file_name().to_string_lossy().into_owned();
                let size = file.metadata().await?.len();
                out.push(FileMeta {
                    id: id.clone(),
                    filename,
                    size,
                    stored_path: upload_rel(&id, &file.file_name().to_string_lossy()),
                });
            }
        }
        out.sort_by(|a, b| b.id.cmp(&a.id));
        Ok(out)
    }

    async fn first_upload_file(&self, id: &str) -> Result<(String, PathBuf, u64), StorageError> {
        validate_uuid(id, "file_id")?;
        let dir = self.uploads_dir().join(id);
        let mut files = tokio::fs::read_dir(&dir)
            .await
            .map_err(|error| match error.kind() {
                std::io::ErrorKind::NotFound => {
                    StorageError::NotFound(format!("file {id} not found"))
                }
                _ => error.into(),
            })?;
        while let Some(file) = files.next_entry().await? {
            if file.file_type().await?.is_file() {
                let filename = file.file_name().to_string_lossy().into_owned();
                let size = file.metadata().await?.len();
                return Ok((filename, file.path(), size));
            }
        }
        Err(StorageError::NotFound(format!("file {id} not found")))
    }

    pub async fn get_upload(&self, id: &str) -> Result<FileMeta, StorageError> {
        let (filename, _, size) = self.first_upload_file(id).await?;
        Ok(FileMeta {
            id: id.to_string(),
            filename: filename.clone(),
            size,
            stored_path: upload_rel(id, &filename),
        })
    }

    pub async fn upload_path(&self, id: &str) -> Result<PathBuf, StorageError> {
        let (_, path, _) = self.first_upload_file(id).await?;
        Ok(path)
    }

    pub async fn delete_upload(&self, id: &str) -> Result<(), StorageError> {
        validate_uuid(id, "file_id")?;
        let dataset_ids = self.dataset_ids_for_upload(id).await?;
        let dir = self.uploads_dir().join(id);
        let dir_exists = dir.is_dir();
        if dataset_ids.is_empty() && !dir_exists {
            return Err(StorageError::NotFound(format!("file {id} not found")));
        }
        delete_guard::ensure_datasets_deletable_by_chips(&self.pool, &dataset_ids).await?;

        let prefix = format!("{REL_UPLOADS}/{id}/%");
        let mut tx = self.pool.begin().await?;
        let transform_ids =
            delete_guard::delete_transforms_for_datasets(&mut tx, &dataset_ids).await?;
        let deleted = sqlx::query("DELETE FROM datasets WHERE id = ? OR stored_path LIKE ?")
            .bind(id)
            .bind(&prefix)
            .execute(&mut *tx)
            .await
            .map_err(delete_guard::map_delete_sql)?;
        tx.commit().await?;
        if !dir_exists && deleted.rows_affected() == 0 && transform_ids.is_empty() {
            return Err(StorageError::NotFound(format!("file {id} not found")));
        }
        for transform_id in &transform_ids {
            let _ = self.delete_search_document("transform", transform_id).await;
        }
        for dataset_id in &dataset_ids {
            let _ = self.delete_search_document("dataset", dataset_id).await;
        }
        if dir_exists {
            match tokio::fs::remove_dir_all(&dir).await {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
        Ok(())
    }

    async fn dataset_ids_for_upload(&self, id: &str) -> Result<Vec<String>, StorageError> {
        let prefix = format!("{REL_UPLOADS}/{id}/%");
        Ok(sqlx::query_scalar(
            "SELECT id FROM datasets WHERE id = ? OR stored_path LIKE ?",
        )
        .bind(id)
        .bind(&prefix)
        .fetch_all(&self.pool)
        .await?)
    }

    async fn dataset_ids_for_extract(&self, id: &str) -> Result<Vec<String>, StorageError> {
        Ok(sqlx::query_scalar("SELECT id FROM datasets WHERE id = ? OR extract_id = ?")
            .bind(id)
            .bind(id)
            .fetch_all(&self.pool)
            .await?)
    }

    pub async fn source_for_file_id(&self, file_id: &str) -> Result<String, StorageError> {
        if Uuid::parse_str(file_id).is_err() {
            return Err(StorageError::Invalid("invalid file_id".into()));
        }
        let dir = self.uploads_dir().join(file_id);
        let mut files = tokio::fs::read_dir(&dir)
            .await
            .map_err(|_| StorageError::NotFound(format!("file {file_id} not found")))?;
        while let Some(file) = files.next_entry().await? {
            if file.file_type().await?.is_file() {
                let name = file.file_name().to_string_lossy().into_owned();
                return Ok(upload_rel(file_id, &name));
            }
        }
        Err(StorageError::NotFound(format!("file {file_id} not found")))
    }

    pub async fn insert_job(
        &self,
        source_path: &str,
        spec_json: &str,
        workspace_id: &str,
    ) -> Result<JobRow, StorageError> {
        self.require_workspace(workspace_id).await?;
        let id = Uuid::new_v4().to_string();
        let created_at = now_rfc3339();
        sqlx::query(
            "INSERT INTO jobs (id, status, source_path, spec_json, created_at, workspace_id)
             VALUES (?, 'queued', ?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(source_path)
        .bind(spec_json)
        .bind(&created_at)
        .bind(workspace_id)
        .execute(&self.pool)
        .await?;
        self.get_job(&id)
            .await?
            .ok_or_else(|| StorageError::NotFound("job disappeared after insert".into()))
    }

    pub async fn insert_transform_job(
        &self,
        source_path: &str,
        spec_json: &str,
        transform_id: &str,
        dataset_id: &str,
        workspace_id: &str,
    ) -> Result<JobRow, StorageError> {
        self.require_workspace(workspace_id).await?;
        let id = Uuid::new_v4().to_string();
        let created_at = now_rfc3339();
        sqlx::query(
            "INSERT INTO jobs
             (id, status, source_path, spec_json, created_at, kind, transform_id, dataset_id, workspace_id)
             VALUES (?, 'queued', ?, ?, ?, 'transform', ?, ?, ?)",
        )
        .bind(&id)
        .bind(source_path)
        .bind(spec_json)
        .bind(&created_at)
        .bind(transform_id)
        .bind(dataset_id)
        .bind(workspace_id)
        .execute(&self.pool)
        .await?;
        self.get_job(&id)
            .await?
            .ok_or_else(|| StorageError::NotFound("job disappeared after insert".into()))
    }

    pub async fn get_job(&self, id: &str) -> Result<Option<JobRow>, StorageError> {
        let row = sqlx::query_as::<_, JobRow>(&format!("SELECT {JOB_COLS} FROM jobs WHERE id = ?"))
            .bind(id)
            .fetch_optional(&self.pool)
            .await?;
        Ok(row)
    }

    pub async fn list_jobs(
        &self,
        limit: i64,
        scope: Option<&DataScope>,
    ) -> Result<Vec<JobRow>, StorageError> {
        let (extra, binds) = match scope {
            Some(scope) => Self::workspace_scope_sql(scope, "workspace_id"),
            None => (String::new(), Vec::new()),
        };
        let sql = format!(
            "SELECT {JOB_COLS} FROM jobs WHERE 1=1 {extra} ORDER BY created_at DESC LIMIT ?"
        );
        let mut query = sqlx::query_as::<_, JobRow>(&sql);
        for value in &binds {
            query = query.bind(value);
        }
        let rows = query.bind(limit).fetch_all(&self.pool).await?;
        Ok(rows)
    }

    pub async fn set_job_running(&self, id: &str, output_path: &str) -> Result<(), StorageError> {
        sqlx::query(
            "UPDATE jobs SET status = ?, started_at = ?, output_path = ?, error_message = NULL
             WHERE id = ?",
        )
        .bind("running")
        .bind(now_rfc3339())
        .bind(output_path)
        .bind(id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn set_job_succeeded(&self, id: &str) -> Result<(), StorageError> {
        sqlx::query("UPDATE jobs SET status = ?, finished_at = ? WHERE id = ?")
            .bind("succeeded")
            .bind(now_rfc3339())
            .bind(id)
            .execute(&self.pool)
            .await?;
        let job = self
            .get_job(id)
            .await?
            .ok_or_else(|| StorageError::NotFound("job not found".into()))?;
        if let Some(stored_path) = job
            .output_path
            .as_deref()
            .filter(|path| !path.is_empty())
        {
            let abs = self.resolve(stored_path);
            if abs.is_file() {
                let filename = abs
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("result.parquet")
                    .to_string();
                let size = tokio::fs::metadata(&abs).await.ok().map(|meta| meta.len() as i64);
                self.upsert_dataset(&DatasetUpsert {
                    id: job.id.clone(),
                    kind: "transform".into(),
                    extract_id: None,
                    filename,
                    stored_path: stored_path.to_string(),
                    size_bytes: size,
                    delimiter: None,
                    has_header: None,
                    row_count: None,
                    workspace_id: Some(job.workspace_id),
                })
                .await?;
            }
        }
        Ok(())
    }

    pub async fn set_job_failed(&self, id: &str, error: &str) -> Result<(), StorageError> {
        sqlx::query("UPDATE jobs SET status = ?, finished_at = ?, error_message = ? WHERE id = ?")
            .bind("failed")
            .bind(now_rfc3339())
            .bind(error)
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn append_log(
        &self,
        job_id: &str,
        level: &str,
        message: &str,
    ) -> Result<(), StorageError> {
        sqlx::query("INSERT INTO job_logs (job_id, ts, level, message) VALUES (?, ?, ?, ?)")
            .bind(job_id)
            .bind(now_rfc3339())
            .bind(level)
            .bind(message)
            .execute(&self.pool)
            .await?;
        if let Ok(log) = ProcessLog::create(&self.data_dir, LOG_JOBS, job_id) {
            log.write(level, "job", message);
        }
        Ok(())
    }

    pub async fn read_process_log(&self, area: &str, id: &str) -> Result<String, StorageError> {
        if !LOG_AREAS.contains(&area) || !safe_log_id(id) {
            return Err(StorageError::Invalid("invalid log path".into()));
        }
        let path = ProcessLog::file(&self.data_dir, area, id);
        match tokio::fs::read_to_string(path).await {
            Ok(text) => Ok(text),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
            Err(err) => Err(err.into()),
        }
    }

    pub async fn list_logs(&self, job_id: &str) -> Result<Vec<JobLogRow>, StorageError> {
        let rows = sqlx::query_as::<_, JobLogRow>(
            "SELECT id, job_id, ts, level, message FROM job_logs
             WHERE job_id = ? ORDER BY id ASC",
        )
        .bind(job_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows)
    }

    pub async fn insert_connection(
        &self,
        new: NewConnection,
    ) -> Result<ConnectionRow, StorageError> {
        let driver = new.driver.to_ascii_lowercase();
        if !supported_driver(&driver) {
            return Err(StorageError::Invalid(
                "driver must be postgres, redshift, cockroach, mysql, mariadb, mssql, or sqlite"
                    .into(),
            ));
        }
        if new.name.trim().is_empty() {
            return Err(StorageError::Invalid("name required".into()));
        }
        if driver == "sqlite" {
            if new.database.trim().is_empty() && new.host.trim().is_empty() {
                return Err(StorageError::Invalid(
                    "sqlite needs a file path in database".into(),
                ));
            }
        } else if new.host.trim().is_empty() || new.database.trim().is_empty() {
            return Err(StorageError::Invalid("host and database required".into()));
        }
        let id = Uuid::new_v4().to_string();
        let created_at = now_rfc3339();
        let cipher = secret::encrypt(&self.secret_key, &new.password)?;
        sqlx::query(
            "INSERT INTO connections
             (id, name, driver, host, port, database_name, username, password_cipher, ssl, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(new.name.trim())
        .bind(&driver)
        .bind(new.host.trim())
        .bind(new.port as i64)
        .bind(new.database.trim())
        .bind(new.username.trim())
        .bind(&cipher)
        .bind(i64::from(new.ssl))
        .bind(&created_at)
        .execute(&self.pool)
        .await?;
        search::sync_search_best_effort(self, "connection", self.sync_search_connection(&id)).await;
        self.get_connection(&id)
            .await?
            .ok_or_else(|| StorageError::NotFound("connection disappeared after insert".into()))
    }

    pub async fn update_connection(
        &self,
        id: &str,
        new: NewConnection,
    ) -> Result<ConnectionRow, StorageError> {
        if self.get_connection(id).await?.is_none() {
            return Err(StorageError::NotFound("connection not found".into()));
        }
        let driver = new.driver.to_ascii_lowercase();
        if !supported_driver(&driver) {
            return Err(StorageError::Invalid(
                "driver must be postgres, redshift, cockroach, mysql, mariadb, mssql, or sqlite"
                    .into(),
            ));
        }
        if new.name.trim().is_empty() {
            return Err(StorageError::Invalid("name required".into()));
        }
        if driver == "sqlite" {
            if new.database.trim().is_empty() && new.host.trim().is_empty() {
                return Err(StorageError::Invalid(
                    "sqlite needs a file path in database".into(),
                ));
            }
        } else if new.host.trim().is_empty() || new.database.trim().is_empty() {
            return Err(StorageError::Invalid("host and database required".into()));
        }

        if new.password.is_empty() {
            sqlx::query(
                "UPDATE connections
                 SET name = ?, driver = ?, host = ?, port = ?, database_name = ?, username = ?, ssl = ?
                 WHERE id = ?",
            )
            .bind(new.name.trim())
            .bind(&driver)
            .bind(new.host.trim())
            .bind(new.port as i64)
            .bind(new.database.trim())
            .bind(new.username.trim())
            .bind(i64::from(new.ssl))
            .bind(id)
            .execute(&self.pool)
            .await?;
        } else {
            let cipher = secret::encrypt(&self.secret_key, &new.password)?;
            sqlx::query(
                "UPDATE connections
                 SET name = ?, driver = ?, host = ?, port = ?, database_name = ?, username = ?, password_cipher = ?, ssl = ?
                 WHERE id = ?",
            )
            .bind(new.name.trim())
            .bind(&driver)
            .bind(new.host.trim())
            .bind(new.port as i64)
            .bind(new.database.trim())
            .bind(new.username.trim())
            .bind(&cipher)
            .bind(i64::from(new.ssl))
            .bind(id)
            .execute(&self.pool)
            .await?;
        }

        search::sync_search_best_effort(self, "connection", self.sync_search_connection(id)).await;
        self.get_connection(id)
            .await?
            .ok_or_else(|| StorageError::NotFound("connection disappeared after update".into()))
    }

    pub async fn get_connection(&self, id: &str) -> Result<Option<ConnectionRow>, StorageError> {
        let row = sqlx::query_as::<_, ConnectionRow>(
            "SELECT id, name, driver, host, port, database_name, username, ssl, created_at
             FROM connections WHERE id = ?",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row)
    }

    pub async fn list_connections(&self) -> Result<Vec<ConnectionRow>, StorageError> {
        let rows = sqlx::query_as::<_, ConnectionRow>(
            "SELECT id, name, driver, host, port, database_name, username, ssl, created_at
             FROM connections ORDER BY created_at DESC",
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(rows)
    }

    pub async fn delete_connection(&self, id: &str) -> Result<(), StorageError> {
        delete_guard::ensure_connection_deletable(&self.pool, id).await?;
        let res = sqlx::query("DELETE FROM connections WHERE id = ?")
            .bind(id)
            .execute(&self.pool)
            .await
            .map_err(delete_guard::map_delete_sql)?;
        if res.rows_affected() == 0 {
            return Err(StorageError::NotFound("connection not found".into()));
        }
        let _ = self.delete_search_document("connection", id).await;
        Ok(())
    }

    pub fn extracts_dir(&self) -> PathBuf {
        self.data_dir.join("extracts")
    }

    pub async fn insert_extract(
        &self,
        kind: &str,
        connection_id: &str,
        table_name: &str,
        delimiter: &str,
        header: bool,
        add_sequence: bool,
        sql_text: Option<&str>,
        catalog_database: Option<&str>,
        workspace_id: &str,
        output_filename: Option<&str>,
    ) -> Result<ExtractRow, StorageError> {
        let kind = validate_extract_kind(kind)?;
        self.require_workspace(workspace_id).await?;
        let _ = self
            .get_connection(connection_id)
            .await?
            .ok_or_else(|| StorageError::NotFound("connection not found".into()))?;
        let id = Uuid::new_v4().to_string();
        let created_at = now_rfc3339();
        sqlx::query(
            "INSERT INTO extracts
             (id, kind, connection_id, table_name, delimiter, header, add_sequence, status, created_at,
              sql_text, catalog_database, workspace_id, output_filename)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(kind)
        .bind(connection_id)
        .bind(table_name)
        .bind(delimiter)
        .bind(i64::from(header))
        .bind(i64::from(add_sequence))
        .bind(&created_at)
        .bind(sql_text)
        .bind(catalog_database)
        .bind(workspace_id)
        .bind(output_filename)
        .execute(&self.pool)
        .await?;
        search::sync_search_best_effort(self, "extract", self.sync_search_extract(&id)).await;
        self.get_extract(&id)
            .await?
            .ok_or_else(|| StorageError::NotFound("extract disappeared after insert".into()))
    }

    pub async fn get_extract(&self, id: &str) -> Result<Option<ExtractRow>, StorageError> {
        let row = sqlx::query_as::<_, ExtractRow>(&format!(
            "SELECT {EXTRACT_COLS} FROM extracts e
             LEFT JOIN connections c ON c.id = e.connection_id
             WHERE e.id = ?"
        ))
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row)
    }

    pub async fn list_extracts(
        &self,
        limit: i64,
        scope: Option<&DataScope>,
    ) -> Result<Vec<ExtractRow>, StorageError> {
        let (extra, binds) = match scope {
            Some(scope) => Self::workspace_scope_sql(scope, "e.workspace_id"),
            None => (String::new(), Vec::new()),
        };
        let sql = format!(
            "SELECT {EXTRACT_COLS} FROM extracts e
             LEFT JOIN connections c ON c.id = e.connection_id
             WHERE 1=1 {extra}
             ORDER BY e.created_at DESC LIMIT ?"
        );
        let mut query = sqlx::query_as::<_, ExtractRow>(&sql);
        for value in &binds {
            query = query.bind(value);
        }
        let rows = query.bind(limit).fetch_all(&self.pool).await?;
        Ok(rows)
    }

    pub async fn delete_extract(&self, id: &str) -> Result<(), StorageError> {
        let row = self
            .get_extract(id)
            .await?
            .ok_or_else(|| StorageError::NotFound("extract not found".into()))?;

        let dataset_ids = self.dataset_ids_for_extract(id).await?;
        delete_guard::ensure_datasets_deletable_by_chips(&self.pool, &dataset_ids).await?;

        let mut tx = self.pool.begin().await?;
        let transform_ids =
            delete_guard::delete_transforms_for_datasets(&mut tx, &dataset_ids).await?;
        sqlx::query("UPDATE chip_runs SET legacy_extract_id = NULL WHERE legacy_extract_id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM datasets WHERE id = ? OR extract_id = ?")
            .bind(id)
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_err(delete_guard::map_delete_sql)?;
        let deleted = sqlx::query("DELETE FROM extracts WHERE id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        if deleted.rows_affected() == 0 {
            return Err(StorageError::NotFound("extract not found".into()));
        }
        tx.commit().await?;
        for transform_id in &transform_ids {
            let _ = self.delete_search_document("transform", transform_id).await;
        }
        for dataset_id in &dataset_ids {
            let _ = self.delete_search_document("dataset", dataset_id).await;
        }

        let mut dirs = Vec::new();
        if let Some(rel) = row.stored_path.as_deref() {
            let path = self.resolve(rel);
            if let Some(parent) = path.parent() {
                dirs.push(parent.to_path_buf());
            }
        }
        dirs.push(self.data_dir.join(REL_DATABASES).join(id));
        dirs.push(self.data_dir.join(REL_API).join(id));
        let mut seen = HashSet::new();
        for dir in dirs {
            if !seen.insert(dir.clone()) {
                continue;
            }
            match tokio::fs::remove_dir_all(&dir).await {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }

        let _ = self.delete_search_document("extract", id).await;
        Ok(())
    }

    pub async fn set_extract_running(&self, id: &str) -> Result<(), StorageError> {
        sqlx::query(
            "UPDATE extracts SET status = ?, started_at = ?, error_message = NULL WHERE id = ?",
        )
        .bind("running")
        .bind(now_rfc3339())
        .bind(id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn set_extract_succeeded(
        &self,
        id: &str,
        stored_path: &str,
        filename: &str,
        row_count: i64,
    ) -> Result<(), StorageError> {
        let row = self
            .get_extract(id)
            .await?
            .ok_or_else(|| StorageError::NotFound("extract not found".into()))?;
        let size = tokio::fs::metadata(self.resolve(stored_path))
            .await
            .ok()
            .map(|metadata| metadata.len() as i64);
        let linked_run = sqlx::query_as::<_, (String, String, String)>(
            "SELECT id, chip_id, workspace_id FROM chip_runs
             WHERE legacy_extract_id = ? AND status = 'running'",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;
        let now = now_rfc3339();
        let mut tx = self.pool.begin().await?;
        sqlx::query(
            "UPDATE extracts
             SET status = ?, finished_at = ?, stored_path = ?, filename = ?, row_count = ?,
                 error_message = NULL
             WHERE id = ?",
        )
        .bind("succeeded")
        .bind(&now)
        .bind(stored_path)
        .bind(filename)
        .bind(row_count)
        .bind(id)
        .execute(&mut *tx)
        .await?;

        let mut dataset_sync_id = id.to_string();
        if let Some((run_id, chip_id, workspace_id)) = &linked_run {
            let chip_name = self
                .get_chip(chip_id)
                .await?
                .map(|chip| chip.name)
                .unwrap_or_else(|| filename.to_string());
            let display_name =
                chip_slot::display_filename(&chip_name, "extract", &row.delimiter);
            dataset_sync_id = self
                .upsert_chip_output_slot_dataset(
                    &mut tx,
                    workspace_id,
                    chip_id,
                    run_id,
                    &row.kind,
                    &display_name,
                    stored_path,
                    size,
                    Some(row_count),
                    Some(row.delimiter.as_str()),
                    Some(row.header != 0),
                    Some(id),
                )
                .await?;
            let result = sqlx::query(
                "UPDATE chip_runs
                 SET status = 'succeeded', output_dataset_id = ?, error_message = NULL,
                     finished_at = ?
                 WHERE id = ? AND status = 'running'",
            )
            .bind(&dataset_sync_id)
            .bind(&now)
            .bind(run_id)
            .execute(&mut *tx)
            .await?;
            if result.rows_affected() == 0 {
                return Err(StorageError::Invalid(
                    "linked chip run is not running".into(),
                ));
            }
        } else {
            sqlx::query(
                "INSERT INTO datasets
                 (id, kind, extract_id, filename, stored_path, size_bytes, delimiter, has_header,
                  row_count, created_at, updated_at, workspace_id)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(id) DO UPDATE SET
                   kind = excluded.kind,
                   extract_id = excluded.extract_id,
                   filename = excluded.filename,
                   stored_path = excluded.stored_path,
                   size_bytes = excluded.size_bytes,
                   delimiter = excluded.delimiter,
                   has_header = excluded.has_header,
                   row_count = excluded.row_count,
                   workspace_id = excluded.workspace_id,
                   updated_at = excluded.updated_at",
            )
            .bind(id)
            .bind(&row.kind)
            .bind(id)
            .bind(filename)
            .bind(stored_path)
            .bind(size)
            .bind(&row.delimiter)
            .bind(row.header)
            .bind(row_count)
            .bind(&now)
            .bind(&now)
            .bind(&row.workspace_id)
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await?;
        search::sync_search_best_effort(self, "extract", self.sync_search_extract(id)).await;
        search::sync_search_best_effort(
            self,
            "dataset",
            self.sync_search_dataset(&dataset_sync_id),
        )
        .await;
        Ok(())
    }

    pub async fn set_extract_progress(&self, id: &str, row_count: i64) -> Result<(), StorageError> {
        sqlx::query("UPDATE extracts SET row_count = ? WHERE id = ? AND status = 'running'")
            .bind(row_count)
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn set_extract_failed(&self, id: &str, error: &str) -> Result<(), StorageError> {
        let now = now_rfc3339();
        let mut tx = self.pool.begin().await?;
        sqlx::query(
            "UPDATE extracts SET status = ?, finished_at = ?, error_message = ? WHERE id = ?",
        )
        .bind("failed")
        .bind(&now)
        .bind(error)
        .bind(id)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "UPDATE chip_runs
             SET status = 'failed', error_message = ?, finished_at = ?
             WHERE legacy_extract_id = ? AND status IN ('queued', 'running')",
        )
        .bind(error)
        .bind(&now)
        .bind(id)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn upsert_dataset(&self, row: &DatasetUpsert) -> Result<DatasetRow, StorageError> {
        if !matches!(
            row.kind.as_str(),
            "upload" | "database" | "api" | "transform"
        ) {
            return Err(StorageError::Invalid(
                "dataset kind must be upload, database, api, or transform".into(),
            ));
        }
        if let Some(existing) = self.get_dataset_by_stored_path(&row.stored_path).await? {
            if existing.id != row.id {
                return self.merge_dataset_metadata(&existing.id, row).await;
            }
        }
        let now = now_rfc3339();
        let has_header = row.has_header.map(i64::from);
        sqlx::query(
            "INSERT INTO datasets
             (id, kind, extract_id, filename, stored_path, size_bytes, delimiter, has_header,
              row_count, created_at, updated_at, workspace_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               kind = excluded.kind,
               extract_id = excluded.extract_id,
               filename = excluded.filename,
               stored_path = excluded.stored_path,
               size_bytes = excluded.size_bytes,
               delimiter = COALESCE(excluded.delimiter, datasets.delimiter),
               has_header = COALESCE(excluded.has_header, datasets.has_header),
               row_count = COALESCE(excluded.row_count, datasets.row_count),
               workspace_id = COALESCE(excluded.workspace_id, datasets.workspace_id),
               updated_at = excluded.updated_at",
        )
        .bind(&row.id)
        .bind(&row.kind)
        .bind(&row.extract_id)
        .bind(&row.filename)
        .bind(&row.stored_path)
        .bind(row.size_bytes)
        .bind(&row.delimiter)
        .bind(has_header)
        .bind(row.row_count)
        .bind(&now)
        .bind(&now)
        .bind(row.workspace_id.as_deref().unwrap_or(DEFAULT_WORKSPACE_ID))
        .execute(&self.pool)
        .await?;
        self.get_dataset(&row.id)
            .await?
            .ok_or_else(|| StorageError::NotFound("dataset disappeared after upsert".into()))
    }

    pub async fn delete_transform_dataset(&self, id: &str) -> Result<(), StorageError> {
        let row = self
            .get_dataset(id)
            .await?
            .ok_or_else(|| StorageError::NotFound("dataset not found".into()))?;
        if row.kind != "transform" {
            return Err(StorageError::Invalid(
                "only transform datasets can be deleted here".into(),
            ));
        }
        delete_guard::ensure_datasets_deletable(&self.pool, &[id.to_string()]).await?;

        let path = self.resolve(&row.stored_path);
        let outputs_root = self.data_dir.join(REL_OUTPUTS);
        let mut tx = self.pool.begin().await?;
        sqlx::query("UPDATE chip_runs SET output_dataset_id = NULL WHERE output_dataset_id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        let deleted = sqlx::query("DELETE FROM datasets WHERE id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_err(delete_guard::map_delete_sql)?;
        if deleted.rows_affected() == 0 {
            return Err(StorageError::NotFound("dataset not found".into()));
        }
        tx.commit().await?;

        if let Some(parent) = path.parent() {
            let remove = if parent == outputs_root {
                tokio::fs::remove_file(&path).await
            } else if parent.starts_with(&self.data_dir) {
                tokio::fs::remove_dir_all(parent).await
            } else {
                Ok(())
            };
            match remove {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
        let _ = self.delete_search_document("dataset", id).await;
        Ok(())
    }

    pub async fn set_dataset_provenance(
        &self,
        dataset_id: &str,
        workspace_id: &str,
        producer_chip_run_id: &str,
    ) -> Result<(), StorageError> {
        self.require_workspace(workspace_id).await?;
        let run = self
            .get_chip_run(producer_chip_run_id)
            .await?
            .ok_or_else(|| StorageError::NotFound("producer chip run not found".into()))?;
        if run.workspace_id != workspace_id {
            return Err(StorageError::Invalid(
                "dataset and producer chip run workspace mismatch".into(),
            ));
        }
        let result = sqlx::query(
            "UPDATE datasets
             SET workspace_id = ?, producer_chip_run_id = ?, updated_at = ?
             WHERE id = ?",
        )
        .bind(workspace_id)
        .bind(producer_chip_run_id)
        .bind(now_rfc3339())
        .bind(dataset_id)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 0 {
            return Err(StorageError::NotFound("dataset not found".into()));
        }
        Ok(())
    }

    pub async fn complete_chip_run_for_job(
        &self,
        job_id: &str,
        stored_path: &str,
    ) -> Result<Option<String>, StorageError> {
        let run = sqlx::query_as::<_, ChipRunRow>(&format!(
            "SELECT {CHIP_RUN_COLS} FROM chip_runs WHERE legacy_job_id = ?"
        ))
        .bind(job_id)
        .fetch_optional(&self.pool)
        .await?;
        let Some(run) = run else {
            self.set_job_succeeded(job_id).await?;
            return Ok(None);
        };
        if run.status != "running" {
            return Err(StorageError::Invalid(
                "linked chip run is not running".into(),
            ));
        }
        let chip_name = self
            .get_chip(&run.chip_id)
            .await?
            .map(|chip| chip.name)
            .unwrap_or_else(|| "result".into());
        let display_name = chip_slot::display_filename(&chip_name, "transform", ",");
        let size = tokio::fs::metadata(self.resolve(stored_path)).await?.len() as i64;
        let now = now_rfc3339();
        let mut tx = self.pool.begin().await?;
        let job_result = sqlx::query(
            "UPDATE jobs SET status = 'succeeded', finished_at = ?, error_message = NULL
             WHERE id = ? AND status = 'running'",
        )
        .bind(&now)
        .bind(job_id)
        .execute(&mut *tx)
        .await?;
        if job_result.rows_affected() == 0 {
            return Err(StorageError::Invalid(
                "linked job is not running".into(),
            ));
        }
        let dataset_id = self
            .upsert_chip_output_slot_dataset(
                &mut tx,
                &run.workspace_id,
                &run.chip_id,
                &run.id,
                "transform",
                &display_name,
                stored_path,
                Some(size),
                None,
                None,
                None,
                None,
            )
            .await?;
        let result = sqlx::query(
            "UPDATE chip_runs
             SET status = 'succeeded', output_dataset_id = ?, error_message = NULL,
                 finished_at = ?
             WHERE id = ? AND status = 'running'",
        )
        .bind(&dataset_id)
        .bind(&now)
        .bind(&run.id)
        .execute(&mut *tx)
        .await?;
        if result.rows_affected() == 0 {
            return Err(StorageError::Invalid(
                "only a running chip run can succeed".into(),
            ));
        }
        tx.commit().await?;
        search::sync_search_best_effort(self, "dataset", self.sync_search_dataset(&dataset_id))
            .await;
        Ok(Some(dataset_id))
    }

    pub async fn fail_chip_run_for_job(
        &self,
        job_id: &str,
        error: &str,
    ) -> Result<(), StorageError> {
        let now = now_rfc3339();
        let mut tx = self.pool.begin().await?;
        sqlx::query(
            "UPDATE jobs SET status = 'failed', finished_at = ?, error_message = ? WHERE id = ?",
        )
        .bind(&now)
        .bind(error)
        .bind(job_id)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "UPDATE chip_runs
             SET status = 'failed', error_message = ?, finished_at = ?
             WHERE legacy_job_id = ? AND status IN ('queued', 'running')",
        )
        .bind(error)
        .bind(&now)
        .bind(job_id)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn update_dataset_inspect(
        &self,
        id: &str,
        columns_json: &str,
        row_count: Option<i64>,
        delimiter: Option<&str>,
        has_header: Option<bool>,
        size_bytes: Option<i64>,
    ) -> Result<DatasetRow, StorageError> {
        let now = now_rfc3339();
        let res = sqlx::query(
            "UPDATE datasets
             SET columns_json = ?,
                 row_count = COALESCE(?, row_count),
                 delimiter = COALESCE(?, delimiter),
                 has_header = COALESCE(?, has_header),
                 size_bytes = COALESCE(?, size_bytes),
                 inspected_at = ?,
                 updated_at = ?
             WHERE id = ?",
        )
        .bind(columns_json)
        .bind(row_count)
        .bind(delimiter)
        .bind(has_header.map(i64::from))
        .bind(size_bytes)
        .bind(&now)
        .bind(&now)
        .bind(id)
        .execute(&self.pool)
        .await?;
        if res.rows_affected() == 0 {
            return Err(StorageError::NotFound("dataset not found".into()));
        }
        self.get_dataset(id)
            .await?
            .ok_or_else(|| StorageError::NotFound("dataset disappeared after inspect".into()))
    }

    fn dataset_select() -> String {
        format!(
            "SELECT {DATASET_COLS}
             FROM datasets d
             LEFT JOIN extracts e ON e.id = COALESCE(d.extract_id, CASE WHEN d.kind = 'database' THEN d.id END)
             LEFT JOIN connections c ON c.id = e.connection_id"
        )
    }

    pub async fn get_dataset(&self, id: &str) -> Result<Option<DatasetRow>, StorageError> {
        let sql = format!("{} WHERE d.id = ?", Self::dataset_select());
        let row = sqlx::query_as::<_, DatasetRow>(&sql)
            .bind(id)
            .fetch_optional(&self.pool)
            .await?;
        Ok(row)
    }

    async fn get_dataset_by_stored_path(
        &self,
        stored_path: &str,
    ) -> Result<Option<DatasetRow>, StorageError> {
        let path = stored_path.trim();
        if path.is_empty() {
            return Ok(None);
        }
        let sql = format!("{} WHERE d.stored_path = ?", Self::dataset_select());
        let row = sqlx::query_as::<_, DatasetRow>(&sql)
            .bind(path)
            .fetch_optional(&self.pool)
            .await?;
        Ok(row)
    }

    async fn merge_dataset_metadata(
        &self,
        id: &str,
        row: &DatasetUpsert,
    ) -> Result<DatasetRow, StorageError> {
        let now = now_rfc3339();
        let has_header = row.has_header.map(i64::from);
        sqlx::query(
            "UPDATE datasets SET
               kind = ?,
               extract_id = COALESCE(?, extract_id),
               filename = ?,
               size_bytes = COALESCE(?, size_bytes),
               delimiter = COALESCE(?, delimiter),
               has_header = COALESCE(?, has_header),
               row_count = COALESCE(?, row_count),
               workspace_id = COALESCE(?, workspace_id),
               updated_at = ?
             WHERE id = ?",
        )
        .bind(&row.kind)
        .bind(&row.extract_id)
        .bind(&row.filename)
        .bind(row.size_bytes)
        .bind(&row.delimiter)
        .bind(has_header)
        .bind(row.row_count)
        .bind(row.workspace_id.as_deref().unwrap_or(DEFAULT_WORKSPACE_ID))
        .bind(&now)
        .bind(id)
        .execute(&self.pool)
        .await?;
        self.get_dataset(id)
            .await?
            .ok_or_else(|| StorageError::NotFound("dataset disappeared after merge".into()))
    }

    pub async fn list_datasets(&self, scope: Option<&DataScope>) -> Result<Vec<DatasetRow>, StorageError> {
        let (extra, binds) = match scope {
            Some(scope) => Self::workspace_scope_sql(scope, "d.workspace_id"),
            None => (String::new(), Vec::new()),
        };
        let sql = format!(
            "{} WHERE 1=1 {extra} ORDER BY d.created_at DESC",
            Self::dataset_select()
        );
        let mut query = sqlx::query_as::<_, DatasetRow>(&sql);
        for value in &binds {
            query = query.bind(value);
        }
        Ok(query.fetch_all(&self.pool).await?)
    }

    pub async fn insert_transform(
        &self,
        name: &str,
        dataset_id: &str,
        spec_json: &str,
        input_chip_id: Option<&str>,
    ) -> Result<TransformRow, StorageError> {
        let name = name.trim();
        if name.is_empty() {
            return Err(StorageError::Invalid("name required".into()));
        }
        let dataset = self
            .get_dataset(dataset_id)
            .await?
            .ok_or_else(|| StorageError::NotFound("dataset not found".into()))?;
        let id = Uuid::new_v4().to_string();
        let now = now_rfc3339();
        sqlx::query(
            "INSERT INTO transforms
             (id, name, dataset_id, spec_json, created_at, updated_at, workspace_id, input_chip_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(name)
        .bind(dataset_id)
        .bind(spec_json)
        .bind(&now)
        .bind(&now)
        .bind(&dataset.workspace_id)
        .bind(input_chip_id)
        .execute(&self.pool)
        .await?;
        search::sync_search_best_effort(self, "transform", self.sync_search_transform(&id)).await;
        if let Some(chip_id) = input_chip_id.map(str::trim).filter(|value| !value.is_empty()) {
            self.bind_chip_to_transform(chip_id, &id).await?;
        }
        self.get_transform(&id)
            .await?
            .ok_or_else(|| StorageError::NotFound("transform disappeared after insert".into()))
    }

    pub async fn update_transform(
        &self,
        id: &str,
        name: Option<&str>,
        dataset_id: Option<&str>,
        spec_json: Option<&str>,
        input_chip_id: Option<Option<&str>>,
    ) -> Result<TransformRow, StorageError> {
        let current = self
            .get_transform(id)
            .await?
            .ok_or_else(|| StorageError::NotFound("transform not found".into()))?;
        let name = name
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(current.name.as_str());
        let dataset_id = dataset_id.unwrap_or(current.dataset_id.as_str());
        let spec_json = spec_json.unwrap_or(current.spec_json.as_str());
        let input_chip_id = match input_chip_id {
            Some(value) => value.map(str::to_string),
            None => current.input_chip_id.clone(),
        };
        let _ = self
            .get_dataset(dataset_id)
            .await?
            .ok_or_else(|| StorageError::NotFound("dataset not found".into()))?;
        let now = now_rfc3339();
        sqlx::query(
            "UPDATE transforms SET name = ?, dataset_id = ?, spec_json = ?, updated_at = ?,
             input_chip_id = ? WHERE id = ?",
        )
        .bind(name)
        .bind(dataset_id)
        .bind(spec_json)
        .bind(&now)
        .bind(&input_chip_id)
        .bind(id)
        .execute(&self.pool)
        .await?;
        search::sync_search_best_effort(self, "transform", self.sync_search_transform(id)).await;
        if let Some(chip_id) = input_chip_id.as_deref().filter(|value| !value.is_empty()) {
            self.bind_chip_to_transform(chip_id, id).await?;
        }
        self.get_transform(id)
            .await?
            .ok_or_else(|| StorageError::NotFound("transform disappeared after update".into()))
    }

    pub async fn bind_chip_to_transform(
        &self,
        chip_id: &str,
        transform_id: &str,
    ) -> Result<(), StorageError> {
        let chip = self
            .get_chip(chip_id)
            .await?
            .ok_or_else(|| StorageError::NotFound("chip not found".into()))?;
        if chip.kind != "transform" {
            return Err(StorageError::Invalid(
                "only transform chips can bind a transform definition".into(),
            ));
        }
        let _ = self
            .get_transform(transform_id)
            .await?
            .ok_or_else(|| StorageError::NotFound("transform not found".into()))?;
        let now = now_rfc3339();
        let mut tx = self.pool.begin().await?;
        sqlx::query("DELETE FROM chip_bindings WHERE chip_id = ?")
            .bind(chip_id)
            .execute(&mut *tx)
            .await?;
        sqlx::query(
            "INSERT INTO chip_bindings (chip_id, ref_kind, ref_id) VALUES (?, 'transform', ?)",
        )
        .bind(chip_id)
        .bind(transform_id)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "UPDATE chips SET config_json = NULL, revision = revision + 1, updated_at = ?
             WHERE id = ?",
        )
        .bind(&now)
        .bind(chip_id)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        search::sync_search_best_effort(self, "chip", self.sync_search_chip(chip_id)).await;
        Ok(())
    }

    pub async fn get_transform(&self, id: &str) -> Result<Option<TransformRow>, StorageError> {
        let row = sqlx::query_as::<_, TransformRow>(
            "SELECT id, name, dataset_id, spec_json, created_at, updated_at, workspace_id, input_chip_id
             FROM transforms WHERE id = ?",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row)
    }

    pub async fn delete_transform(&self, id: &str) -> Result<(), StorageError> {
        delete_guard::ensure_transform_deletable(&self.pool, id).await?;
        let deleted = sqlx::query("DELETE FROM transforms WHERE id = ?")
            .bind(id)
            .execute(&self.pool)
            .await
            .map_err(delete_guard::map_delete_sql)?;
        if deleted.rows_affected() == 0 {
            return Err(StorageError::NotFound("transform not found".into()));
        }
        let _ = self.delete_search_document("transform", id).await;
        Ok(())
    }

    pub async fn list_transforms(&self, scope: Option<&DataScope>) -> Result<Vec<TransformRow>, StorageError> {
        let (extra, binds) = match scope {
            Some(scope) => Self::workspace_scope_sql(scope, "workspace_id"),
            None => (String::new(), Vec::new()),
        };
        let sql = format!(
            "SELECT id, name, dataset_id, spec_json, created_at, updated_at, workspace_id, input_chip_id
             FROM transforms WHERE 1=1 {extra} ORDER BY updated_at DESC"
        );
        let mut query = sqlx::query_as::<_, TransformRow>(&sql);
        for value in &binds {
            query = query.bind(value);
        }
        Ok(query.fetch_all(&self.pool).await?)
    }

    pub async fn backfill_datasets(&self) -> Result<(), StorageError> {
        let extracts = sqlx::query_as::<_, ExtractBackfillRow>(
            "SELECT id, delimiter, header, stored_path, filename, row_count
             FROM extracts
             WHERE status = 'succeeded' AND stored_path IS NOT NULL AND filename IS NOT NULL",
        )
        .fetch_all(&self.pool)
        .await?;
        for row in extracts {
            let stored_path = row.stored_path.unwrap_or_default();
            let filename = row.filename.unwrap_or_default();
            if stored_path.is_empty() || filename.is_empty() {
                continue;
            }
            let abs = self.resolve(&stored_path);
            if !abs.is_file() {
                continue;
            }
            let size = tokio::fs::metadata(&abs).await.ok().map(|m| m.len() as i64);
            self.upsert_dataset(&DatasetUpsert {
                id: row.id.clone(),
                kind: "database".into(),
                extract_id: Some(row.id),
                filename,
                stored_path,
                size_bytes: size,
                delimiter: Some(row.delimiter),
                has_header: Some(row.header != 0),
                row_count: row.row_count,
                workspace_id: None,
            })
            .await?;
        }

        let uploads = self.list_upload_dirs().await?;
        for file in uploads {
            self.upsert_dataset(&DatasetUpsert {
                id: file.id,
                kind: "upload".into(),
                extract_id: None,
                filename: file.filename,
                stored_path: file.stored_path,
                size_bytes: Some(file.size as i64),
                delimiter: None,
                has_header: None,
                row_count: None,
                workspace_id: None,
            })
            .await?;
        }

        let jobs = sqlx::query_as::<_, JobRow>(&format!(
            "SELECT {JOB_COLS} FROM jobs
             WHERE status = 'succeeded' AND kind = 'transform' AND output_path IS NOT NULL"
        ))
        .fetch_all(&self.pool)
        .await?;
        for job in jobs {
            let Some(stored_path) = job.output_path.filter(|path| !path.is_empty()) else {
                continue;
            };
            let linked: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM chip_runs WHERE legacy_job_id = ?",
            )
            .bind(&job.id)
            .fetch_one(&self.pool)
            .await?;
            if linked > 0 {
                continue;
            }
            let abs = self.resolve(&stored_path);
            if !abs.is_file() {
                continue;
            }
            let filename = abs
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("result.parquet")
                .to_string();
            let size = tokio::fs::metadata(&abs).await.ok().map(|meta| meta.len() as i64);
            self.upsert_dataset(&DatasetUpsert {
                id: job.id,
                kind: "transform".into(),
                extract_id: None,
                filename,
                stored_path,
                size_bytes: size,
                delimiter: None,
                has_header: None,
                row_count: None,
                workspace_id: Some(job.workspace_id),
            })
            .await?;
        }
        Ok(())
    }

    pub fn extract_file_rel(
        kind: &str,
        id: &str,
        table: &str,
        delimiter: &str,
    ) -> Result<(String, String), StorageError> {
        let ext = chip_slot::extract_ext(delimiter);
        let filename = format!("{}.{}", safe_filename(&table.replace('.', "_")), ext);
        let rel = extract_rel(kind, id, &filename)?;
        Ok((filename, rel))
    }

    pub fn extract_named_rel(kind: &str, id: &str, filename: &str) -> Result<String, StorageError> {
        extract_rel(kind, id, &safe_filename(filename))
    }

    pub async fn live_connection(&self, id: &str) -> Result<LiveConnection, StorageError> {
        let row = sqlx::query_as::<_, ConnectionSecretRow>(
            "SELECT id, name, driver, host, port, database_name, username, password_cipher, ssl
             FROM connections WHERE id = ?",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(|| StorageError::NotFound("connection not found".into()))?;
        let password = secret::decrypt(&self.secret_key, &row.password_cipher)?;
        Ok(LiveConnection {
            id: row.id,
            name: row.name,
            driver: row.driver,
            host: row.host,
            port: u16::try_from(row.port).unwrap_or(0),
            database: row.database_name,
            username: row.username,
            password,
            ssl: row.ssl != 0,
        })
    }

    pub async fn backfill_chip_bindings(&self) -> Result<(), StorageError> {
        let chips = sqlx::query_as::<_, ChipRow>(&format!(
            "SELECT {CHIP_COLS} FROM chips
             WHERE config_json IS NOT NULL AND TRIM(config_json) != ''
             AND id NOT IN (SELECT chip_id FROM chip_bindings)"
        ))
        .fetch_all(&self.pool)
        .await?;
        for chip in chips {
            let Some(raw) = chip.config_json.as_deref() else {
                continue;
            };
            let value: serde_json::Value = match serde_json::from_str(raw) {
                Ok(value) => value,
                Err(_) => continue,
            };
            let binding = match chip.kind.as_str() {
                "extract" => {
                    let connection_id = value
                        .get("connection_id")
                        .and_then(|item| item.as_str())
                        .unwrap_or("")
                        .trim();
                    if connection_id.is_empty() {
                        continue;
                    }
                    let source = value.get("source").cloned().unwrap_or_else(|| {
                        serde_json::json!({ "type": "table", "table": "", "database": null })
                    });
                    let delimiter = value
                        .get("delimiter")
                        .and_then(|item| item.as_str())
                        .unwrap_or(",");
                    let header = value
                        .get("header")
                        .and_then(|item| item.as_bool())
                        .unwrap_or(true);
                    let workspace_id = sqlx::query_scalar::<_, String>(
                        "SELECT workspace_id FROM workspace_chips WHERE chip_id = ? LIMIT 1",
                    )
                    .bind(&chip.id)
                    .fetch_optional(&self.pool)
                    .await?
                    .unwrap_or_else(|| DEFAULT_WORKSPACE_ID.to_string());
                    let extract_id = Uuid::new_v4().to_string();
                    let now = now_rfc3339();
                    let source_json = serde_json::to_string(&source)
                        .map_err(|error| StorageError::Invalid(error.to_string()))?;
                    sqlx::query(
                        "INSERT INTO extract_definitions
                         (id, name, kind, connection_id, source_json, delimiter, header,
                          add_sequence, workspace_id, created_at, updated_at)
                         VALUES (?, ?, 'database', ?, ?, ?, ?, 0, ?, ?, ?)",
                    )
                    .bind(&extract_id)
                    .bind(&chip.name)
                    .bind(connection_id)
                    .bind(&source_json)
                    .bind(delimiter)
                    .bind(i64::from(header))
                    .bind(&workspace_id)
                    .bind(&now)
                    .bind(&now)
                    .execute(&self.pool)
                    .await?;
                    ("extract_definition", extract_id)
                }
                "transform" => {
                    let spec = value.get("spec").cloned().unwrap_or_else(|| {
                        serde_json::json!({ "version": 2, "steps": [], "sink": "parquet" })
                    });
                    let dataset_id = value
                        .get("input_dataset_id")
                        .and_then(|item| item.as_str())
                        .unwrap_or("")
                        .trim();
                    if dataset_id.is_empty() {
                        continue;
                    }
                    let spec_json = serde_json::to_string(&spec)
                        .map_err(|error| StorageError::Invalid(error.to_string()))?;
                    let transform = self
                        .insert_transform(&chip.name, dataset_id, &spec_json, None)
                        .await?;
                    ("transform", transform.id)
                }
                _ => continue,
            };
            sqlx::query(
                "INSERT OR IGNORE INTO chip_bindings (chip_id, ref_kind, ref_id)
                 VALUES (?, ?, ?)",
            )
            .bind(&chip.id)
            .bind(binding.0)
            .bind(&binding.1)
            .execute(&self.pool)
            .await?;
            sqlx::query("UPDATE chips SET config_json = NULL WHERE id = ?")
                .bind(&chip.id)
                .execute(&self.pool)
                .await?;
        }
        Ok(())
    }

    pub async fn chip_workspace_hint(
        &self,
        chip_id: &str,
    ) -> Result<Option<String>, StorageError> {
        Ok(sqlx::query_scalar(
            "SELECT workspace_id FROM workspace_chips WHERE chip_id = ? LIMIT 1",
        )
        .bind(chip_id)
        .fetch_optional(&self.pool)
        .await?)
    }

    pub async fn bump_definition_revision(&self, chip_id: &str) -> Result<(), StorageError> {
        sqlx::query(
            "UPDATE chips SET revision = revision + 1, updated_at = ? WHERE id = ?",
        )
        .bind(now_rfc3339())
        .bind(chip_id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }
}

#[derive(sqlx::FromRow)]
struct ExtractBackfillRow {
    id: String,
    delimiter: String,
    header: i64,
    stored_path: Option<String>,
    filename: Option<String>,
    row_count: Option<i64>,
}

#[derive(sqlx::FromRow)]
struct ConnectionSecretRow {
    id: String,
    name: String,
    driver: String,
    host: String,
    port: i64,
    database_name: String,
    username: String,
    password_cipher: String,
    ssl: i64,
}

pub fn upload_rel(id: &str, filename: &str) -> String {
    format!("{REL_UPLOADS}/{id}/{filename}")
}

pub fn database_rel(id: &str, filename: &str) -> String {
    format!("{REL_DATABASES}/{id}/{filename}")
}

pub fn api_rel(id: &str, filename: &str) -> String {
    format!("{REL_API}/{id}/{filename}")
}

pub fn extract_rel(kind: &str, id: &str, filename: &str) -> Result<String, StorageError> {
    match kind {
        "database" => Ok(database_rel(id, filename)),
        "api" => Ok(api_rel(id, filename)),
        _ => Err(StorageError::Invalid(
            "extract kind must be database or api".into(),
        )),
    }
}

pub fn job_db_extract_rel(job_id: &str) -> String {
    database_rel(job_id, "extract.csv")
}

async fn ensure_data_layout(data_dir: &Path) -> Result<(), StorageError> {
    tokio::fs::create_dir_all(data_dir.join(REL_OUTPUTS)).await?;
    tokio::fs::create_dir_all(data_dir.join(REL_STAGING)).await?;
    for kind in EXTRACT_KINDS {
        tokio::fs::create_dir_all(data_dir.join("extracts").join(kind)).await?;
    }
    for area in LOG_AREAS {
        tokio::fs::create_dir_all(data_dir.join(REL_LOGS).join(area)).await?;
    }
    migrate_legacy_extract_dirs(data_dir).await?;
    Ok(())
}

/// Move `data/uploads/` and leftover `data/extracts/{uuid}/` into the kinded tree.
async fn migrate_legacy_extract_dirs(data_dir: &Path) -> Result<(), StorageError> {
    let extracts = data_dir.join("extracts");
    let databases = extracts.join("databases");
    let uploads_new = extracts.join("uploads");

    if extracts.is_dir() {
        let mut rd = tokio::fs::read_dir(&extracts).await?;
        while let Some(entry) = rd.next_entry().await? {
            if !entry.file_type().await?.is_dir() {
                continue;
            }
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if matches!(name_str.as_ref(), "uploads" | "databases" | "api") {
                continue;
            }
            let dest = databases.join(&name);
            if dest.exists() {
                continue;
            }
            tokio::fs::rename(entry.path(), dest).await?;
        }
    }

    let uploads_old = data_dir.join("uploads");
    if uploads_old.is_dir() {
        let mut rd = tokio::fs::read_dir(&uploads_old).await?;
        while let Some(entry) = rd.next_entry().await? {
            let dest = uploads_new.join(entry.file_name());
            if dest.exists() {
                continue;
            }
            tokio::fs::rename(entry.path(), dest).await?;
        }
        let _ = tokio::fs::remove_dir(&uploads_old).await;
    }
    Ok(())
}

async fn rewrite_legacy_stored_paths(pool: &SqlitePool) -> Result<(), StorageError> {
    sqlx::query(
        "UPDATE extracts
         SET stored_path = 'extracts/databases/' || substr(stored_path, 10)
         WHERE stored_path LIKE 'extracts/%'
           AND stored_path NOT LIKE 'extracts/uploads/%'
           AND stored_path NOT LIKE 'extracts/databases/%'
           AND stored_path NOT LIKE 'extracts/api/%'",
    )
    .execute(pool)
    .await?;
    sqlx::query(
        "UPDATE jobs
         SET source_path = 'extracts/uploads/' || substr(source_path, 9)
         WHERE source_path LIKE 'uploads/%'",
    )
    .execute(pool)
    .await?;
    sqlx::query(
        "UPDATE jobs
         SET source_path = 'extracts/databases/' || substr(source_path, 10)
         WHERE source_path LIKE 'extracts/%'
           AND source_path NOT LIKE 'extracts/uploads/%'
           AND source_path NOT LIKE 'extracts/databases/%'
           AND source_path NOT LIKE 'extracts/api/%'",
    )
    .execute(pool)
    .await?;
    Ok(())
}

async fn update_running_chip_ref(
    pool: &SqlitePool,
    id: &str,
    column: &str,
    value: &str,
) -> Result<(), StorageError> {
    let sql = match column {
        "legacy_extract_id" => {
            "UPDATE chip_runs SET legacy_extract_id = ? WHERE id = ? AND status = 'running'"
        }
        "legacy_job_id" => {
            "UPDATE chip_runs SET legacy_job_id = ? WHERE id = ? AND status = 'running'"
        }
        _ => {
            return Err(StorageError::Invalid(
                "invalid legacy chip reference".into(),
            ))
        }
    };
    let result = sqlx::query(sql).bind(value).bind(id).execute(pool).await?;
    if result.rows_affected() == 0 {
        return Err(StorageError::Invalid(
            "legacy reference requires a running chip run".into(),
        ));
    }
    Ok(())
}

fn required_text<'a>(value: &'a str, field: &str) -> Result<&'a str, StorageError> {
    let value = value.trim();
    if value.is_empty() {
        return Err(StorageError::Invalid(format!("{field} required")));
    }
    Ok(value)
}

fn map_folder_sql(error: sqlx::Error) -> StorageError {
    if let sqlx::Error::Database(db) = &error {
        if db.is_unique_violation() {
            return StorageError::Conflict(
                "folder name already exists under this parent".into(),
            );
        }
    }
    error.into()
}

fn trimmed_optional(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

fn validate_chip_kind(kind: &str) -> Result<(), StorageError> {
    if !matches!(kind, "extract" | "transform" | "load") {
        return Err(StorageError::Invalid(
            "chip kind must be extract, transform, or load".into(),
        ));
    }
    Ok(())
}

fn validate_extract_kind(kind: &str) -> Result<&str, StorageError> {
    match kind {
        "database" | "api" => Ok(kind),
        _ => Err(StorageError::Invalid(
            "extract kind must be database or api".into(),
        )),
    }
}

fn require_config_json(config_json: &str) -> Result<(), StorageError> {
    let value: serde_json::Value = serde_json::from_str(config_json)
        .map_err(|error| StorageError::Invalid(format!("invalid chip config JSON: {error}")))?;
    if !value.is_object() {
        return Err(StorageError::Invalid(
            "chip config must be a JSON object".into(),
        ));
    }
    reject_sensitive_config(&value)?;
    Ok(())
}

pub(crate) fn empty_workspace_snapshot() -> &'static str {
    r#"{"layout":{},"chips":[],"edges":[]}"#
}

fn workspace_snapshot_json(
    layout_json: &str,
    chips: &[ChipRow],
    edges: &[ChipEdgeRow],
) -> Result<String, StorageError> {
    let layout: serde_json::Value = serde_json::from_str(layout_json)
        .unwrap_or_else(|_| serde_json::json!({}));
    let chips = chips
        .iter()
        .map(|chip| {
            let config: serde_json::Value = chip
                .config_json
                .as_deref()
                .and_then(|raw| serde_json::from_str(raw).ok())
                .unwrap_or_else(|| serde_json::json!({}));
            serde_json::json!({
                "id": chip.id,
                "name": chip.name,
                "kind": chip.kind,
                "config": config,
                "revision": chip.revision,
                "active": chip.active != 0,
            })
        })
        .collect::<Vec<_>>();
    let edges = edges
        .iter()
        .map(|edge| {
            serde_json::json!({
                "id": edge.id,
                "from_chip_id": edge.from_chip_id,
                "to_chip_id": edge.to_chip_id,
                "kind": edge.kind,
                "from_port": edge.from_port,
                "to_port": edge.to_port,
            })
        })
        .collect::<Vec<_>>();
    serde_json::to_string(&serde_json::json!({
        "layout": layout,
        "chips": chips,
        "edges": edges,
    }))
    .map_err(|error| StorageError::Invalid(error.to_string()))
}

async fn replace_workspace_edges(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    workspace_id: &str,
    edges: &[WorkspaceSaveEdge],
    chips: &[ChipRow],
    now: &str,
) -> Result<Vec<ChipEdgeRow>, StorageError> {
    let chips_by_id = chips
        .iter()
        .map(|chip| (chip.id.as_str(), chip))
        .collect::<HashMap<_, _>>();
    let mut seen = HashSet::new();
    let mut pairs = Vec::with_capacity(edges.len());
    for edge in edges {
        let from_id = required_text(&edge.from_chip_id, "from_chip_id")?;
        let to_id = required_text(&edge.to_chip_id, "to_chip_id")?;
        if from_id == to_id {
            return Err(StorageError::Invalid(
                "chip edge cannot connect a chip to itself".into(),
            ));
        }
        let from = chips_by_id.get(from_id).ok_or_else(|| {
            StorageError::Invalid("chip edge must start from a chip in this workspace".into())
        })?;
        let to = chips_by_id.get(to_id).ok_or_else(|| {
            StorageError::Invalid("chip edge must end at a chip in this workspace".into())
        })?;
        validate_edge_kind(&edge.kind, from.kind.as_str(), to.kind.as_str())?;
        let from_port = {
            let value = edge.from_port.trim();
            if value.is_empty() {
                "out".to_string()
            } else {
                value.to_string()
            }
        };
        let to_port = {
            let value = edge.to_port.trim();
            if value.is_empty() {
                "in".to_string()
            } else {
                value.to_string()
            }
        };
        let key = (from_id.to_string(), to_id.to_string(), edge.kind.clone());
        if !seen.insert(key) {
            return Err(StorageError::Invalid(
                "duplicate chip edge".into(),
            ));
        }
        let id = if edge.id.trim().is_empty() {
            Uuid::new_v4().to_string()
        } else {
            validate_uuid(&edge.id, "edge id")?;
            edge.id.clone()
        };
        pairs.push((
            id,
            from_id.to_string(),
            to_id.to_string(),
            edge.kind.clone(),
            from_port,
            to_port,
        ));
    }
    if edges_have_cycle(
        pairs
            .iter()
            .map(|(_, from, to, _, _, _)| (from.as_str(), to.as_str())),
    ) {
        return Err(StorageError::Invalid("chip edges cannot form a cycle".into()));
    }
    sqlx::query("DELETE FROM chip_edges WHERE workspace_id = ?")
        .bind(workspace_id)
        .execute(&mut **tx)
        .await?;
    for (id, from_id, to_id, kind, from_port, to_port) in &pairs {
        sqlx::query(
            "INSERT INTO chip_edges
             (id, workspace_id, from_chip_id, to_chip_id, kind, from_port, to_port, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(id)
        .bind(workspace_id)
        .bind(from_id)
        .bind(to_id)
        .bind(kind)
        .bind(from_port)
        .bind(to_port)
        .bind(now)
        .execute(&mut **tx)
        .await?;
    }
    Ok(sqlx::query_as::<_, ChipEdgeRow>(&format!(
        "SELECT {CHIP_EDGE_COLS} FROM chip_edges
         WHERE workspace_id = ? ORDER BY created_at ASC"
    ))
    .bind(workspace_id)
    .fetch_all(&mut **tx)
    .await?)
}

fn validate_edge_kind(kind: &str, from_kind: &str, to_kind: &str) -> Result<(), StorageError> {
    match kind {
        "data" => {
            if !matches!(from_kind, "extract" | "transform") {
                return Err(StorageError::Invalid(
                    "data edges must start from extract or transform".into(),
                ));
            }
            if !matches!(to_kind, "transform" | "load") {
                return Err(StorageError::Invalid(
                    "data edges must end at transform or load".into(),
                ));
            }
            Ok(())
        }
        "on_success" | "on_error" | "always" => Ok(()),
        _ => Err(StorageError::Invalid(
            "chip edge kind must be data, on_success, on_error, or always".into(),
        )),
    }
}

fn edges_have_cycle<'a, I>(edges: I) -> bool
where
    I: IntoIterator<Item = (&'a str, &'a str)>,
{
    let mut graph: HashMap<&str, Vec<&str>> = HashMap::new();
    for (from, to) in edges {
        graph.entry(from).or_default().push(to);
        graph.entry(to).or_default();
    }
    let mut state = HashMap::new();
    fn visit<'a>(
        node: &'a str,
        graph: &HashMap<&'a str, Vec<&'a str>>,
        state: &mut HashMap<&'a str, u8>,
    ) -> bool {
        match state.get(node).copied() {
            Some(1) => return true,
            Some(2) => return false,
            _ => {}
        }
        state.insert(node, 1);
        if let Some(next) = graph.get(node) {
            for child in next {
                if visit(child, graph, state) {
                    return true;
                }
            }
        }
        state.insert(node, 2);
        false
    }
    graph.keys().copied().any(|node| visit(node, &graph, &mut state))
}

fn reject_sensitive_config(value: &serde_json::Value) -> Result<(), StorageError> {
    match value {
        serde_json::Value::Object(object) => {
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
                    return Err(StorageError::Invalid(format!(
                        "chip config must not contain `{key}`"
                    )));
                }
                reject_sensitive_config(value)?;
            }
        }
        serde_json::Value::Array(values) => {
            for value in values {
                reject_sensitive_config(value)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn supported_driver(driver: &str) -> bool {
    matches!(
        driver,
        "postgres" | "redshift" | "cockroach" | "mysql" | "mariadb" | "mssql" | "sqlite"
    )
}

fn validate_uuid(id: &str, field: &str) -> Result<(), StorageError> {
    Uuid::parse_str(id)
        .map(|_| ())
        .map_err(|_| StorageError::Invalid(format!("invalid {field}")))
}

pub fn now_rfc3339() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub fn resolve_upload_filename(original: &str, requested: Option<&str>) -> String {
    let source = requested
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .unwrap_or(original);
    let mut name = safe_filename(source);
    let orig_ext = Path::new(original)
        .extension()
        .and_then(|ext| ext.to_str())
        .filter(|ext| !ext.is_empty());
    if Path::new(&name).extension().is_none() {
        if let Some(ext) = orig_ext {
            name = safe_filename(&format!("{name}.{ext}"));
        }
    }
    name
}

pub(crate) fn safe_filename(name: &str) -> String {
    let base = Path::new(name)
        .file_name()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty() && *s != "." && *s != "..")
        .unwrap_or("upload.bin");
    let cleaned: String = base
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
                '_'
            } else {
                c
            }
        })
        .collect::<String>()
        .trim_matches(|c: char| c == ' ' || c == '.')
        .to_string();
    if cleaned.is_empty() {
        "upload.bin".into()
    } else {
        cleaned
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn test_store() -> (PathBuf, Store, UserRow) {
        let root = std::env::temp_dir().join(format!("bintl-storage-test-{}", Uuid::new_v4()));
        let store = Store::open(&root, "test-session-secret").await.unwrap();
        let admin = store.ensure_bootstrap("admin", "admin").await.unwrap();
        (root, store, admin)
    }

    #[test]
    fn extract_paths_are_kinded() {
        assert_eq!(
            upload_rel("abc", "sales.csv"),
            "extracts/uploads/abc/sales.csv"
        );
        let (name, rel) = Store::extract_file_rel("database", "abc", "public.users", ",").unwrap();
        assert_eq!(name, "public_users.csv");
        assert_eq!(rel, "extracts/databases/abc/public_users.csv");
        assert_eq!(
            job_db_extract_rel("job-1"),
            "extracts/databases/job-1/extract.csv"
        );
        let (_, tsv) = Store::extract_file_rel("database", "id", "t", "tab").unwrap();
        assert_eq!(tsv, "extracts/databases/id/t.tsv");
        let (_, api) = Store::extract_file_rel("api", "id", "orders", ",").unwrap();
        assert_eq!(api, "extracts/api/id/orders.csv");
    }

    #[test]
    fn upload_filename_uses_requested_name() {
        assert_eq!(resolve_upload_filename("a.csv", Some("sales")), "sales.csv");
        assert_eq!(
            resolve_upload_filename("a.csv", Some("매출자료.csv")),
            "매출자료.csv"
        );
        assert_eq!(resolve_upload_filename("a.csv", Some("  ")), "a.csv");
        assert_eq!(resolve_upload_filename("a.csv", Some("../x.csv")), "x.csv");
    }

    #[test]
    fn staging_ids_must_be_uuids() {
        assert!(validate_uuid(&Uuid::new_v4().to_string(), "staging_id").is_ok());
        assert!(validate_uuid("../escape", "staging_id").is_err());
    }

    #[tokio::test]
    async fn stages_reads_and_deletes_a_spreadsheet() {
        let (root, store, _) = test_store().await;
        let staged = store
            .stage_spreadsheet("../report.xlsx", b"spreadsheet")
            .await
            .unwrap();
        assert_eq!(staged.original_filename, "report.xlsx");
        assert_eq!(
            store
                .staged_file(&staged.id)
                .await
                .unwrap()
                .original_filename,
            "report.xlsx"
        );
        store.delete_stage(&staged.id).await.unwrap();
        assert!(matches!(
            store.staged_file(&staged.id).await,
            Err(StorageError::NotFound(_))
        ));
        store.pool.close().await;
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn upsert_dataset_reuses_existing_stored_path() {
        let (root, store, admin) = test_store().await;
        let home = store
            .list_visible_workspaces(Some(&DataScope::for_user(&admin)))
            .await
            .unwrap()
            .into_iter()
            .next()
            .unwrap()
            .id;
        let path = "chip_outputs/test-workspace/test-chip/current.csv";
        let canonical = store
            .upsert_dataset(&DatasetUpsert {
                id: "canonical-dataset".into(),
                kind: "transform".into(),
                extract_id: None,
                filename: "current.csv".into(),
                stored_path: path.into(),
                size_bytes: Some(12),
                delimiter: None,
                has_header: None,
                row_count: Some(1),
                workspace_id: Some(home.clone()),
            })
            .await
            .unwrap();
        let merged = store
            .upsert_dataset(&DatasetUpsert {
                id: "legacy-extract-id".into(),
                kind: "database".into(),
                extract_id: Some("legacy-extract-id".into()),
                filename: "current.csv".into(),
                stored_path: path.into(),
                size_bytes: Some(12),
                delimiter: Some(",".into()),
                has_header: Some(true),
                row_count: Some(1),
                workspace_id: None,
            })
            .await
            .unwrap();
        assert_eq!(merged.id, canonical.id);
        assert!(store.get_dataset("legacy-extract-id").await.unwrap().is_none());
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM datasets WHERE stored_path = ?")
            .bind(path)
            .fetch_one(&store.pool)
            .await
            .unwrap();
        assert_eq!(count, 1);
        store.pool.close().await;
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn deletes_upload_directory_and_dataset() {
        let (root, store, admin) = test_store().await;
        let home = store
            .list_visible_workspaces(Some(&DataScope::for_user(&admin)))
            .await
            .unwrap()
            .into_iter()
            .next()
            .unwrap()
            .id;
        let meta = store
            .save_upload(
                "sales.csv",
                b"name,amount\na,1\n",
                Some(","),
                Some(true),
                &home,
            )
            .await
            .unwrap();
        let dir = store.uploads_dir().join(&meta.id);
        assert!(dir.is_dir());
        assert!(store.get_dataset(&meta.id).await.unwrap().is_some());
        store.delete_upload(&meta.id).await.unwrap();
        assert!(!dir.exists());
        assert!(store.get_dataset(&meta.id).await.unwrap().is_none());
        store.pool.close().await;
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn chip_runs_keep_definition_snapshot_and_transition_once() {
        let (root, store, admin) = test_store().await;
        let workspace = store
            .insert_workspace("Sales", Some("daily imports"), &admin.id, None)
            .await
            .unwrap();
        let task = store
            .insert_chip(
                &admin.id,
                &workspace.id,
                "Users",
                "extract",
                r#"{"connection_id":"c","source":{"type":"table","table":"users"}}"#,
            )
            .await
            .unwrap();
        store
            .attach_chip_to_workspace(&workspace.id, &task.id)
            .await
            .unwrap();
        let config_raw = store.resolve_chip_config_json(&task).await.unwrap();
        let run = store
            .create_chip_run(
                &task.id,
                &workspace.id,
                task.revision,
                &config_raw,
                None,
            )
            .await
            .unwrap();
        store
            .update_chip(
                &task.id,
                None,
                None,
                Some(r#"{"connection_id":"c","source":{"type":"table","table":"customers"}}"#),
                None,
            )
            .await
            .unwrap();

        assert_eq!(run.revision_snapshot, 1);
        assert!(run.config_snapshot_json.contains("\"users\""));
        store.set_chip_run_running(&run.id).await.unwrap();
        assert!(store.set_chip_run_running(&run.id).await.is_err());
        store.set_chip_run_failed(&run.id, "stopped").await.unwrap();
        assert_eq!(
            store.get_chip_run(&run.id).await.unwrap().unwrap().status,
            "failed"
        );

        store.pool.close().await;
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn save_workspace_stores_chip_edges_and_rejects_cycles() {
        let (root, store, admin) = test_store().await;
        let workspace = store
            .insert_workspace("Flow", None, &admin.id, None)
            .await
            .unwrap();
        let extract = store
            .insert_chip(
                &admin.id,
                &workspace.id,
                "Users",
                "extract",
                r#"{"connection_id":"c","source":{"type":"table","table":"users"}}"#,
            )
            .await
            .unwrap();
        let transform = store
            .insert_chip(
                &admin.id,
                &workspace.id,
                "Clean",
                "transform",
                r#"{"spec":{"version":2,"steps":[],"sink":"parquet"}}"#,
            )
            .await
            .unwrap();
        let (_, chips, edges) = store
            .save_workspace(
                &workspace.id,
                r#"{"nodes":{}}"#,
                &[extract.id.clone(), transform.id.clone()],
                &[WorkspaceSaveEdge {
                    id: Uuid::new_v4().to_string(),
                    from_chip_id: extract.id.clone(),
                    to_chip_id: transform.id.clone(),
                    kind: "data".into(),
                    from_port: "out".into(),
                    to_port: "in".into(),
                }],
            )
            .await
            .unwrap();
        assert_eq!(chips.len(), 2);
        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0].kind, "data");

        let cycle = store
            .save_workspace(
                &workspace.id,
                r#"{"nodes":{}}"#,
                &[extract.id.clone(), transform.id.clone()],
                &[
                    WorkspaceSaveEdge {
                        id: String::new(),
                        from_chip_id: extract.id.clone(),
                        to_chip_id: transform.id.clone(),
                        kind: "data".into(),
                        from_port: String::new(),
                        to_port: String::new(),
                    },
                    WorkspaceSaveEdge {
                        id: String::new(),
                        from_chip_id: transform.id.clone(),
                        to_chip_id: extract.id.clone(),
                        kind: "always".into(),
                        from_port: String::new(),
                        to_port: String::new(),
                    },
                ],
            )
            .await;
        assert!(cycle.is_err());

        store.pool.close().await;
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn users_own_workspaces_and_uploads() {
        let (root, store, admin) = test_store().await;
        let analyst = store
            .create_user("lee", "이서연", "secret12", &["analyst".into()])
            .await
            .unwrap();
        let admin_scope = DataScope::for_user(&admin);
        let analyst_scope = DataScope::for_user(&analyst);
        let admin_home = store
            .list_visible_workspaces(Some(&admin_scope))
            .await
            .unwrap()
            .into_iter()
            .find(|workspace| workspace.owner_user_id.as_deref() == Some(admin.id.as_str()))
            .unwrap()
            .id;
        let analyst_home = store
            .list_visible_workspaces(Some(&analyst_scope))
            .await
            .unwrap()
            .into_iter()
            .find(|workspace| workspace.owner_user_id.as_deref() == Some(analyst.id.as_str()))
            .unwrap()
            .id;

        store
            .save_upload("a.csv", b"x,y\n1,2\n", Some(","), Some(true), &admin_home)
            .await
            .unwrap();
        store
            .save_upload("b.csv", b"x,y\n3,4\n", Some(","), Some(true), &analyst_home)
            .await
            .unwrap();

        let admin_files = store
            .list_uploads(Some(&admin_scope))
            .await
            .unwrap();
        let analyst_files = store
            .list_uploads(Some(&analyst_scope))
            .await
            .unwrap();
        assert!(admin_files.iter().any(|file| file.filename == "a.csv"));
        assert!(admin_files.iter().any(|file| file.filename == "b.csv"));
        assert_eq!(analyst_files.len(), 1);
        assert_eq!(analyst_files[0].filename, "b.csv");

        let analyst_workspaces = store
            .list_visible_workspaces(Some(&analyst_scope))
            .await
            .unwrap();
        assert!(analyst_workspaces
            .iter()
            .all(|workspace| workspace.owner_user_id.as_deref() == Some(&analyst.id)));
        assert!(!analyst_workspaces.is_empty());

        assert!(store
            .require_workspace_access(&analyst.id, false, &admin_home)
            .await
            .is_err());

        let folder = store
            .insert_folder("국가사업", &analyst.id, None)
            .await
            .unwrap();
        let child = store
            .insert_folder("내 워크스페이스", &analyst.id, Some(&folder.id))
            .await
            .unwrap();
        let nested = store
            .insert_workspace("WS-1", None, &analyst.id, Some(&child.id))
            .await
            .unwrap();
        assert_eq!(nested.folder_id.as_deref(), Some(child.id.as_str()));
        assert!(store
            .insert_folder("국가사업", &analyst.id, None)
            .await
            .is_err());
        assert!(store
            .insert_folder("내 워크스페이스", &analyst.id, Some(&folder.id))
            .await
            .is_err());
        let sibling = store
            .insert_folder("내 워크스페이스", &analyst.id, None)
            .await
            .unwrap();
        assert!(sibling.parent_id.is_none());
        assert!(store
            .update_folder(&folder.id, None, Some(Some(&child.id)))
            .await
            .is_err());
        let demote = vec!["analyst".to_string()];
        assert!(store
            .update_user(&admin.id, None, None, Some(demote.as_slice()), None)
            .await
            .is_err());

        store.pool.close().await;
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn delete_workspace_clears_extract_definition_fk() {
        let (root, store, admin) = test_store().await;
        let ws = store
            .insert_workspace("delete-me", None, &admin.id, None)
            .await
            .unwrap();
        let conn = store
            .insert_connection(NewConnection {
                name: "fk-test".into(),
                driver: "sqlite".into(),
                host: String::new(),
                port: 0,
                database: ":memory:".into(),
                username: String::new(),
                password: String::new(),
                ssl: false,
            })
            .await
            .unwrap();
        let extract_id = Uuid::new_v4().to_string();
        let now = now_rfc3339();
        sqlx::query(
            "INSERT INTO extract_definitions
             (id, name, kind, connection_id, source_json, delimiter, header, add_sequence,
              workspace_id, created_at, updated_at)
             VALUES (?, 'def', 'database', ?, '{}', ',', 1, 0, ?, ?, ?)",
        )
        .bind(&extract_id)
        .bind(&conn.id)
        .bind(&ws.id)
        .bind(&now)
        .bind(&now)
        .execute(&store.pool)
        .await
        .unwrap();

        store.delete_workspace(&ws.id).await.unwrap();
        let left: Option<String> = sqlx::query_scalar(
            "SELECT workspace_id FROM extract_definitions WHERE id = ?",
        )
        .bind(&extract_id)
        .fetch_one(&store.pool)
        .await
        .unwrap();
        assert!(left.is_none());
        assert!(store.get_workspace(&ws.id).await.unwrap().is_none());

        store.pool.close().await;
        let _ = std::fs::remove_dir_all(root);
    }
}
