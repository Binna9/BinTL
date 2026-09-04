pub mod chip_slot;
mod chip_definition_repo;
mod chip_run_repo;
mod connection_repo;
mod dataset_repo;
mod delete_guard;
mod extract_repo;
mod file_repo;
mod identity;
mod job_repo;
mod models;
mod password;
mod process_log;
mod search;
mod secret;
mod transform_repo;
mod workspace_repo;

pub use identity::{
    DataScope, PermissionRow, RoleWithPermissions, UserRow, PERM_CONNECTION_WRITE, PERM_USER_MANAGE,
    PERM_WORKSPACE_ALL,
};
pub use models::*;
pub use process_log::{
    safe_log_id, ProcessLog, LOG_AREAS, LOG_CONNECTIONS, LOG_EXTRACTS, LOG_FILES, LOG_JOBS,
    LOG_QUERY,
};
pub use search::SearchHit;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use chrono::{SecondsFormat, Utc};
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
use sqlx::SqlitePool;
use uuid::Uuid;

use models::{CHIP_COLS, CHIP_EDGE_COLS, JOB_COLS};

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
        "postgres"
            | "redshift"
            | "cockroach"
            | "mysql"
            | "mariadb"
            | "mssql"
            | "sqlite"
            | "http"
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
