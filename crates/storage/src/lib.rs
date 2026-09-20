mod chip_copy;
mod chip_definition_repo;
mod chip_run_repo;
pub mod chip_slot;
mod connection_repo;
mod dataset_repo;
mod delete_guard;
mod execution_repo;
mod extract_repo;
mod file_repo;
mod http_auth;
mod identity;
mod user_images;
pub use http_auth::HttpAuthConfig;
mod job_repo;
mod load_repo;
mod models;
mod password;
mod process_log;
mod schedule_repo;
mod search;
mod secret;
mod transform_repo;
mod validation_repo;
mod workspace_repo;

pub use chip_copy::next_copy_slug;
pub use identity::{
    DataScope, PermissionRow, RoleWithPermissions, UserRow, PERM_CONNECTION_WRITE,
    PERM_EXTRACT_RUN, PERM_TRANSFORM_RUN, PERM_USER_MANAGE, PERM_WORKSPACE_ALL,
};
pub use models::*;
pub use process_log::{clean_process_logs, safe_log_id, ProcessLog, LOG_AREAS, LOG_QUERY};
pub use search::SearchHit;
pub use user_images::DEFAULT_USER_IMAGE_REL;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::Duration;

use chrono::{SecondsFormat, Utc};
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
use sqlx::{ConnectOptions, Connection, SqlitePool};
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

/// Relative dirs under `data_dir`. Transform inputs live under `extract_runs/`
/// by source kind; `outputs/` is convert/load results.
pub const REL_UPLOADS: &str = "extract_runs/uploads";
pub const REL_DATABASES: &str = "extract_runs/databases";
pub const REL_API: &str = "extract_runs/api";
pub const REL_OUTPUTS: &str = "outputs";
pub const REL_LOGS: &str = "logs";
pub const REL_STAGING: &str = "staging";
pub const REL_USER_IMAGES: &str = "user_images";
pub const DEFAULT_WORKSPACE_ID: &str = "00000000-0000-0000-0000-000000000001";
pub const EXECUTION_CANCELED: &str = "EXECUTION_CANCELED";
pub const EXECUTION_CANCELED_MESSAGE: &str = "실행이 취소되었습니다.";

const EXTRACT_KINDS: [&str; 3] = ["uploads", "databases", "api"];

impl Store {
    pub async fn open(
        data_dir: impl Into<PathBuf>,
        encryption_secret: &str,
    ) -> Result<Self, StorageError> {
        let data_dir = data_dir.into();
        ensure_data_layout(&data_dir).await?;

        let db_path = data_dir.join("etl.db");
        // sqlx's SQLite migrator always begins a transaction, so a migration's
        // PRAGMA foreign_keys=OFF is a no-op. DROP TABLE chips then CASCADE-wipes
        // workspace placements. Disable FKs on the migrate connection itself.
        {
            let migrate_options = SqliteConnectOptions::new()
                .filename(&db_path)
                .create_if_missing(true)
                .journal_mode(SqliteJournalMode::Wal)
                .busy_timeout(Duration::from_secs(5))
                .foreign_keys(false);
            let mut conn = migrate_options.connect().await?;
            sqlx::migrate!("./migrations").run(&mut conn).await?;
            conn.close().await?;
        }
        let options = SqliteConnectOptions::new()
            .filename(&db_path)
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .busy_timeout(Duration::from_secs(5))
            .foreign_keys(true);

        let pool = SqlitePoolOptions::new()
            .max_connections(5)
            .connect_with(options)
            .await?;
        let store = Self {
            pool,
            data_dir,
            secret_key: secret::key_from_secret(encryption_secret),
        };
        store.ensure_bootstrap().await?;
        store.backfill_workspace_revisions().await?;
        store.repair_canvas_from_revisions().await?;
        if let Err(error) = store.reconcile_search_documents().await {
            // Search is a derived index. A repair failure must not prevent the
            // authoritative application data from opening.
            tracing::warn!(%error, "search index reconciliation failed");
        }
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
        self.data_dir.join(contained_rel(stored))
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
            "SELECT id, name, driver, host, port, database_name, username, password_cipher, ssl, json_extract(options_json, '$.http_auth') AS http_auth_json
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
            http_auth: row
                .http_auth_json
                .as_deref()
                .map(serde_json::from_str)
                .transpose()
                .map_err(|_| StorageError::Invalid("invalid saved HTTP auth settings".into()))?,
            ssl: row.ssl != 0,
        })
    }

    pub async fn chip_workspace_hint(&self, chip_id: &str) -> Result<Option<String>, StorageError> {
        Ok(
            sqlx::query_scalar(
                "SELECT workspace_id FROM workspace_chips WHERE chip_id = ? LIMIT 1",
            )
            .bind(chip_id)
            .fetch_optional(&self.pool)
            .await?,
        )
    }

    pub async fn bump_definition_revision(&self, chip_id: &str) -> Result<(), StorageError> {
        sqlx::query("UPDATE chips SET revision = revision + 1, updated_at = ? WHERE id = ?")
            .bind(now_rfc3339())
            .bind(chip_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }
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
    http_auth_json: Option<String>,
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
    tokio::fs::create_dir_all(data_dir.join(chip_slot::REL_CHIP_OUTPUTS)).await?;
    tokio::fs::create_dir_all(data_dir.join(REL_STAGING)).await?;
    for kind in EXTRACT_KINDS {
        tokio::fs::create_dir_all(data_dir.join("extract_runs").join(kind)).await?;
    }
    for area in LOG_AREAS {
        tokio::fs::create_dir_all(data_dir.join(REL_LOGS).join(area)).await?;
    }
    process_log::clean_process_logs(data_dir).await?;
    tokio::fs::create_dir_all(data_dir.join(REL_USER_IMAGES)).await?;
    user_images::ensure_default_user_image(data_dir).await?;
    migrate_legacy_extract_dirs(data_dir).await?;
    Ok(())
}

/// Move `data/uploads/` and leftover `data/extract_runs/{uuid}/` into the kinded tree.
async fn migrate_legacy_extract_dirs(data_dir: &Path) -> Result<(), StorageError> {
    let extract_runs = data_dir.join("extract_runs");
    let databases = extract_runs.join("databases");
    let uploads_new = extract_runs.join("uploads");

    if extract_runs.is_dir() {
        let mut rd = tokio::fs::read_dir(&extract_runs).await?;
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

async fn link_child_step(pool: &SqlitePool, id: &str, value: &str) -> Result<(), StorageError> {
    let result = sqlx::query(
        "UPDATE execution_steps
        SET result_json=json_set(COALESCE(result_json, '{}'), '$.child_step_id', ?)
        WHERE id=? AND status='running'",
    )
    .bind(value)
    .bind(id)
    .execute(pool)
    .await?;
    if result.rows_affected() == 0 {
        return Err(StorageError::Invalid(
            "child execution link requires a running chip step".into(),
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
            return StorageError::Conflict("folder name already exists under this parent".into());
        }
    }
    error.into()
}

fn trimmed_optional(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

fn validate_chip_kind(kind: &str) -> Result<(), StorageError> {
    if !matches!(
        kind,
        "extract" | "transform" | "load" | "validation" | "sql" | "serve" | "script" | "memo"
    ) {
        return Err(StorageError::Invalid(
            "chip kind must be extract, transform, load, validation, sql, serve, script, or memo"
                .into(),
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

fn require_json_string_array(raw: &str, field: &str) -> Result<(), StorageError> {
    serde_json::from_str::<Vec<String>>(raw).map_err(|error| {
        StorageError::Invalid(format!("{field} must be a JSON string array: {error}"))
    })?;
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
    let layout: serde_json::Value =
        serde_json::from_str(layout_json).unwrap_or_else(|_| serde_json::json!({}));
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
        validate_edge_kind(
            &edge.kind,
            from.kind.as_str(),
            to.kind.as_str(),
            edge.to_port.trim(),
        )?;
        let from_port = {
            let value = edge.from_port.trim();
            if value.is_empty() {
                "out".to_string()
            } else {
                value.to_string()
            }
        };
        let mut to_port = {
            let value = edge.to_port.trim();
            if value.is_empty() {
                "in".to_string()
            } else {
                value.to_string()
            }
        };
        if edge.kind == "data" && to.kind == "validation" && from.kind == "load" {
            to_port = "target".into();
        }
        if edge.kind == "data" && to.kind == "validation" {
            if !matches!(to_port.as_str(), "source" | "target") {
                let source_used = pairs.iter().any(|(_, _, target, edge_kind, _, port)| {
                    target == to_id && edge_kind == "data" && port == "source"
                });
                to_port = if source_used { "target" } else { "source" }.into();
            }
            if pairs.iter().any(|(_, _, target, edge_kind, _, port)| {
                target == to_id && edge_kind == "data" && port == &to_port
            }) {
                return Err(StorageError::Invalid(format!(
                    "validation {to_port} input is already connected"
                )));
            }
        }
        let slot = match edge.kind.as_str() {
            "on_success" | "on_error" | "always" => "control",
            other => other,
        };
        let key = (from_id.to_string(), to_id.to_string(), slot.to_string());
        if !seen.insert(key) {
            return Err(StorageError::Invalid(if slot == "control" {
                "only one of on_success, on_error, or always is allowed between two chips".into()
            } else {
                "duplicate chip edge".into()
            }));
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
        return Err(StorageError::Invalid(
            "chip edges cannot form a cycle".into(),
        ));
    }
    validate_edge_graph(&pairs, &chips_by_id)?;
    sqlx::query("DELETE FROM workspace_edges WHERE workspace_id = ?")
        .bind(workspace_id)
        .execute(&mut **tx)
        .await?;
    for (id, from_id, to_id, kind, from_port, to_port) in &pairs {
        sqlx::query(
            "INSERT INTO workspace_edges
             (id, workspace_id, from_workspace_chip_id, to_workspace_chip_id, kind, from_port, to_port, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(id)
        .bind(workspace_id)
        .bind(workspace_repo::workspace_chip_id(workspace_id, from_id))
        .bind(workspace_repo::workspace_chip_id(workspace_id, to_id))
        .bind(kind)
        .bind(from_port)
        .bind(to_port)
        .bind(now)
        .execute(&mut **tx)
        .await?;
    }
    Ok(sqlx::query_as::<_, ChipEdgeRow>(&format!(
        "SELECT we.id, we.workspace_id, from_wc.chip_id AS from_chip_id,
                to_wc.chip_id AS to_chip_id, we.kind, we.from_port, we.to_port, we.created_at
         FROM workspace_edges we
         JOIN workspace_chips from_wc ON from_wc.id = we.from_workspace_chip_id
         JOIN workspace_chips to_wc ON to_wc.id = we.to_workspace_chip_id
         WHERE we.workspace_id = ? ORDER BY we.created_at ASC"
    ))
    .bind(workspace_id)
    .fetch_all(&mut **tx)
    .await?)
}

fn validate_edge_kind(
    kind: &str,
    from_kind: &str,
    to_kind: &str,
    to_port: &str,
) -> Result<(), StorageError> {
    match kind {
        "data" => {
            if from_kind == "load" {
                if to_kind != "validation" || to_port == "source" {
                    return Err(StorageError::Invalid(
                        "load chips can only be the validation TARGET".into(),
                    ));
                }
                return Ok(());
            }
            if !matches!(from_kind, "extract" | "transform" | "script") {
                return Err(StorageError::Invalid(
                    "data edges must start from extract, transform, or script".into(),
                ));
            }
            if !matches!(
                to_kind,
                "transform" | "load" | "validation" | "serve" | "script"
            ) {
                return Err(StorageError::Invalid(
                    "data edges must end at transform, load, validation, serve, or script".into(),
                ));
            }
            Ok(())
        }
        "on_success" | "on_error" | "always" => {
            if !control_kinds_allowed(from_kind, to_kind) {
                return Err(StorageError::Invalid(
                    "control edges cannot connect these chip kinds".into(),
                ));
            }
            Ok(())
        }
        _ => Err(StorageError::Invalid(
            "chip edge kind must be data, on_success, on_error, or always".into(),
        )),
    }
}

fn control_kinds_allowed(from_kind: &str, to_kind: &str) -> bool {
    if from_kind == "memo" || to_kind == "memo" {
        return false;
    }
    match from_kind {
        "load" => matches!(to_kind, "load" | "validation" | "sql"),
        "validation" | "serve" => to_kind == "sql",
        _ if to_kind == "extract" => matches!(from_kind, "extract" | "sql"),
        _ => true,
    }
}

type EdgePair = (String, String, String, String, String, String);

fn flow_kind(kind: &str) -> bool {
    matches!(kind, "data" | "on_success" | "always")
}

fn has_data_pair(pairs: &[EdgePair], from: &str, to: &str) -> bool {
    pairs.iter().any(|(_, edge_from, edge_to, kind, _, _)| {
        kind == "data" && edge_from == from && edge_to == to
    })
}

fn indirect_path_exists(pairs: &[EdgePair], from: &str, to: &str, skip_id: &str) -> bool {
    let mut graph: HashMap<&str, Vec<&str>> = HashMap::new();
    for (id, edge_from, edge_to, kind, _, _) in pairs {
        if id == skip_id || !flow_kind(kind) {
            continue;
        }
        graph
            .entry(edge_from.as_str())
            .or_default()
            .push(edge_to.as_str());
    }
    let mut seen = HashSet::new();
    seen.insert(from);
    let mut queue = Vec::new();
    for next in graph.get(from).into_iter().flatten().copied() {
        if next == to {
            continue;
        }
        if seen.insert(next) {
            queue.push(next);
        }
    }
    while let Some(current) = queue.pop() {
        for next in graph.get(current).into_iter().flatten().copied() {
            if next == to {
                return true;
            }
            if seen.insert(next) {
                queue.push(next);
            }
        }
    }
    false
}

fn data_depends_on(pairs: &[EdgePair], node: &str, ancestor: &str) -> bool {
    fn walk<'a>(
        pairs: &'a [EdgePair],
        node: &'a str,
        ancestor: &str,
        seen: &mut HashSet<&'a str>,
    ) -> bool {
        if !seen.insert(node) {
            return false;
        }
        for (_, from, to, kind, _, _) in pairs {
            if kind != "data" || to != node {
                continue;
            }
            if from == ancestor || walk(pairs, from, ancestor, seen) {
                return true;
            }
        }
        false
    }
    walk(pairs, node, ancestor, &mut HashSet::new())
}

fn validate_edge_graph(
    pairs: &[EdgePair],
    chips_by_id: &HashMap<&str, &ChipRow>,
) -> Result<(), StorageError> {
    let mut incoming: HashMap<&str, Vec<&str>> = HashMap::new();
    for (_, from, to, kind, _, _) in pairs {
        if kind != "data" {
            continue;
        }
        incoming.entry(to.as_str()).or_default().push(from.as_str());
    }
    for (to_id, sources) in &incoming {
        let to_kind = chips_by_id
            .get(to_id)
            .map(|chip| chip.kind.as_str())
            .unwrap_or("");
        if to_kind == "validation" {
            if sources.len() > 2 {
                return Err(StorageError::Invalid("too many data inputs".into()));
            }
            let unique = sources.iter().copied().collect::<HashSet<_>>();
            if unique.len() != sources.len() {
                return Err(StorageError::Invalid("duplicate chip edge".into()));
            }
        } else if to_kind == "script" {
            // Keep in sync with server::script::MAX_SCRIPT_INPUTS.
            if sources.len() > 8 {
                return Err(StorageError::Invalid("too many data inputs".into()));
            }
        } else if sources.len() > 1 {
            return Err(StorageError::Invalid("too many data inputs".into()));
        }
    }
    for (id, from, to, kind, _, _) in pairs {
        if kind == "on_error" {
            if data_depends_on(pairs, to, from) {
                return Err(StorageError::Invalid(
                    "on_error cannot target a chip that uses that chip's data".into(),
                ));
            }
            continue;
        }
        if !indirect_path_exists(pairs, from, to, id) {
            continue;
        }
        let to_kind = chips_by_id
            .get(to.as_str())
            .map(|chip| chip.kind.as_str())
            .unwrap_or("");
        let allowed = (kind == "data" && to_kind == "validation")
            || (kind != "data" && has_data_pair(pairs, from, to));
        if !allowed {
            return Err(StorageError::Invalid(
                "chip edge skips an existing path".into(),
            ));
        }
    }
    Ok(())
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
    graph
        .keys()
        .copied()
        .any(|node| visit(node, &graph, &mut state))
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
            | "oracle"
            | "tibero"
            | "http"
    )
}

fn validate_uuid(id: &str, field: &str) -> Result<(), StorageError> {
    Uuid::parse_str(id)
        .map(|_| ())
        .map_err(|_| StorageError::Invalid(format!("invalid {field}")))
}

fn contained_rel(stored: &str) -> PathBuf {
    let rel: PathBuf = Path::new(stored)
        .components()
        .filter_map(|component| match component {
            std::path::Component::Normal(name) => Some(name),
            _ => None,
        })
        .collect();
    if rel.as_os_str().is_empty() {
        PathBuf::from("upload.bin")
    } else {
        rel
    }
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

/// Creates a CSV output name from an identifier instead of treating dots in it
/// (for example `public.orders`) as a file extension.
pub fn csv_output_filename(identifier: &str) -> String {
    let name = safe_filename(identifier.trim());
    if name.is_empty() {
        return "extract.csv".into();
    }
    if name.to_ascii_lowercase().ends_with(".csv") {
        name
    } else {
        safe_filename(&format!("{name}.csv"))
    }
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
        let admin = store.ensure_bootstrap().await.unwrap();
        (root, store, admin)
    }

    #[tokio::test]
    async fn user_images_live_under_user_id() {
        let (root, store, admin) = test_store().await;
        assert!(root.join("user_images/default-image").is_file());
        let rel = store
            .save_user_avatar_data_url(
                &admin.id,
                "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
            )
            .await
            .unwrap();
        assert_eq!(rel, format!("user_images/{}/avatar.png", admin.id));
        assert!(store.resolve(&rel).is_file());
        store.pool.close().await;
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn open_seeds_admin_when_users_empty() {
        let root = std::env::temp_dir().join(format!("bintl-bootstrap-{}", Uuid::new_v4()));
        let store = Store::open(&root, "test-session-secret").await.unwrap();
        let user = store
            .authenticate(Store::BOOTSTRAP_USERID, "admin")
            .await
            .unwrap()
            .expect("empty sqlite must insert admin");
        assert_eq!(user.userid, Store::BOOTSTRAP_USERID);
        assert!(user.roles.iter().any(|role| role == "admin"));
        store.pool.close().await;
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn extract_paths_are_kinded() {
        assert_eq!(
            upload_rel("abc", "sales.csv"),
            "extract_runs/uploads/abc/sales.csv"
        );
        let (name, rel) = Store::extract_file_rel("database", "abc", "public.users", ",").unwrap();
        assert_eq!(name, "public_users.csv");
        assert_eq!(rel, "extract_runs/databases/abc/public_users.csv");
        assert_eq!(
            job_db_extract_rel("job-1"),
            "extract_runs/databases/job-1/extract.csv"
        );
        let (_, tsv) = Store::extract_file_rel("database", "id", "t", "tab").unwrap();
        assert_eq!(tsv, "extract_runs/databases/id/t.tsv");
        let (_, api) = Store::extract_file_rel("api", "id", "orders", ",").unwrap();
        assert_eq!(api, "extract_runs/api/id/orders.csv");
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
    fn csv_output_filename_keeps_dotted_identifiers() {
        assert_eq!(csv_output_filename("public.orders"), "public.orders.csv");
        assert_eq!(csv_output_filename("orders.csv"), "orders.csv");
    }

    #[test]
    fn resolve_stays_inside_data_dir() {
        assert_eq!(contained_rel("/etc/passwd"), PathBuf::from("etc/passwd"));
        assert_eq!(contained_rel("../escape.csv"), PathBuf::from("escape.csv"));
        assert_eq!(
            contained_rel("chip_outputs/ws/chip/out.csv"),
            PathBuf::from("chip_outputs/ws/chip/out.csv")
        );
        assert_eq!(contained_rel(".."), PathBuf::from("upload.bin"));
    }

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
        let _ = std::fs::remove_dir_all(root);
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
        assert!(store
            .get_dataset("legacy-extract-id")
            .await
            .unwrap()
            .is_none());
        let count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM data_files WHERE stored_path = ?")
                .bind(path)
                .fetch_one(&store.pool)
                .await
                .unwrap();
        assert_eq!(count, 1);
        store.pool.close().await;
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn delete_transform_dataset_does_not_wipe_chip_output_dir() {
        let (root, store, admin) = test_store().await;
        let home = store
            .list_visible_workspaces(Some(&DataScope::for_user(&admin)))
            .await
            .unwrap()
            .into_iter()
            .next()
            .unwrap()
            .id;
        let stored = "chip_outputs/ws/chip/current.parquet";
        let path = store.resolve(stored);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"dataset").unwrap();
        let sibling = path.with_file_name("keep.parquet");
        std::fs::write(&sibling, b"keep").unwrap();
        let row = store
            .upsert_dataset(&DatasetUpsert {
                id: "transform-file".into(),
                kind: "transform".into(),
                extract_id: None,
                filename: "current.parquet".into(),
                stored_path: stored.into(),
                size_bytes: Some(7),
                delimiter: None,
                has_header: None,
                row_count: Some(1),
                workspace_id: Some(home),
            })
            .await
            .unwrap();
        store.delete_transform_dataset(&row.id).await.unwrap();
        assert!(!path.exists());
        assert!(sibling.exists());
        store.pool.close().await;
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn standalone_job_uses_transform_name_as_output_filename() {
        let (root, store, admin) = test_store().await;
        let home = store
            .list_visible_workspaces(Some(&DataScope::for_user(&admin)))
            .await
            .unwrap()
            .into_iter()
            .next()
            .unwrap()
            .id;
        let input = store
            .upsert_dataset(&DatasetUpsert {
                id: Uuid::new_v4().to_string(),
                kind: "database".into(),
                extract_id: None,
                filename: "SYS.DR$UDEF_PREFERENCE.csv".into(),
                stored_path: format!("extract_runs/databases/{}/source.csv", Uuid::new_v4()),
                size_bytes: Some(8),
                delimiter: Some(",".into()),
                has_header: Some(true),
                row_count: Some(1),
                workspace_id: Some(home.clone()),
            })
            .await
            .unwrap();
        let transform = store
            .insert_transform(
                "transform-SYS.DR$UDEF_PREFERENCE.csv",
                &input.id,
                r#"{"version":2,"steps":[],"sink":"parquet"}"#,
                None,
            )
            .await
            .unwrap();
        let job = store
            .insert_transform_job(&input.stored_path, "{}", &transform.id, &input.id, &home)
            .await
            .unwrap();
        let rel = format!("outputs/{}/result.parquet", job.id);
        let abs = store.resolve(&rel);
        std::fs::create_dir_all(abs.parent().unwrap()).unwrap();
        std::fs::write(&abs, b"parquet").unwrap();
        store.set_job_running(&job.id, &rel).await.unwrap();
        store.set_job_succeeded(&job.id, Some(12)).await.unwrap();
        let dataset = store.get_dataset(&job.id).await.unwrap().unwrap();
        assert_eq!(dataset.filename, "transform-SYS.DR$UDEF_PREFERENCE.csv");
        assert_eq!(dataset.row_count, Some(12));
        let listed = store.list_jobs(20, None).await.unwrap();
        let listed = listed.iter().find(|row| row.id == job.id).unwrap();
        assert_eq!(
            listed.filename.as_deref(),
            Some("transform-SYS.DR$UDEF_PREFERENCE.csv")
        );
        assert_eq!(listed.row_count, Some(12));
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
            .create_chip_run(&task.id, &workspace.id, task.revision, &config_raw, None)
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
        let step = store.get_execution_step(&run.id).await.unwrap().unwrap();
        assert_eq!(
            store
                .get_execution(&step.execution_id)
                .await
                .unwrap()
                .unwrap()
                .status,
            "failed"
        );

        store.pool.close().await;
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn chip_names_are_unique_per_owner_across_etl_kinds() {
        let (root, store, admin) = test_store().await;
        let workspace = store
            .insert_workspace("Names", None, &admin.id, None)
            .await
            .unwrap();
        store
            .insert_chip(&admin.id, &workspace.id, "Daily ETL", "extract", "{}")
            .await
            .unwrap();

        let duplicate = store
            .insert_chip(&admin.id, &workspace.id, "  daily etl  ", "load", "{}")
            .await
            .unwrap_err();
        assert!(matches!(duplicate, StorageError::Conflict(_)));

        store.pool.close().await;
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn unlinking_memo_from_canvas_deletes_the_chip() {
        let (root, store, admin) = test_store().await;
        let workspace = store
            .insert_workspace("Memo drop", None, &admin.id, None)
            .await
            .unwrap();
        let chip = store
            .insert_chip(&admin.id, &workspace.id, "메모-01", "memo", r#"{"text":"hi"}"#)
            .await
            .unwrap();
        store
            .save_workspace(
                &workspace.id,
                &format!(r#"{{"nodes":{{"{}":{{"x":10,"y":20}}}}}}"#, chip.id),
                &[chip.id.clone()],
                &[],
                None,
            )
            .await
            .unwrap();
        assert!(store.get_chip(&chip.id).await.unwrap().is_some());

        store
            .save_workspace(&workspace.id, r#"{"nodes":{}}"#, &[], &[], Some(2))
            .await
            .unwrap();
        assert!(store.get_chip(&chip.id).await.unwrap().is_none());
        let leftover: (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM chips WHERE id = ? OR name = '메모-01'")
                .bind(&chip.id)
                .fetch_one(&store.pool)
                .await
                .unwrap();
        assert_eq!(leftover.0, 0);

        store.pool.close().await;
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn memo_names_can_repeat_across_workspaces() {
        let (root, store, admin) = test_store().await;
        let first = store
            .insert_workspace("First", None, &admin.id, None)
            .await
            .unwrap();
        let second = store
            .insert_workspace("Second", None, &admin.id, None)
            .await
            .unwrap();
        let memo = store
            .insert_chip(&admin.id, &first.id, "메모-01", "memo", r#"{"text":"a"}"#)
            .await
            .unwrap();
        store
            .save_workspace(
                &first.id,
                &format!(r#"{{"nodes":{{"{}":{{"x":10,"y":20}}}}}}"#, memo.id),
                &[memo.id.clone()],
                &[],
                None,
            )
            .await
            .unwrap();

        let other = store
            .insert_chip(&admin.id, &second.id, "메모-01", "memo", r#"{"text":"b"}"#)
            .await
            .unwrap();
        assert_eq!(other.name, "메모-01");
        assert_ne!(other.id, memo.id);

        let same_workspace = store
            .insert_chip(&admin.id, &first.id, "메모-01", "memo", r#"{"text":"c"}"#)
            .await
            .unwrap_err();
        assert!(matches!(same_workspace, StorageError::Conflict(_)));

        store.pool.close().await;
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn leftover_unplaced_memo_is_purged_and_name_can_be_reused() {
        let (root, store, admin) = test_store().await;
        let workspace = store
            .insert_workspace("Memo leftover", None, &admin.id, None)
            .await
            .unwrap();
        store
            .insert_chip(&admin.id, &workspace.id, "메모-01", "memo", r#"{"text":"old"}"#)
            .await
            .unwrap();

        let catalog = store.list_owned_chips(&admin.id).await.unwrap();
        assert!(catalog.iter().all(|chip| chip.kind != "memo"));
        let leftover: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM chips WHERE name = '메모-01'")
            .fetch_one(&store.pool)
            .await
            .unwrap();
        assert_eq!(leftover.0, 0);

        let created = store
            .insert_chip(&admin.id, &workspace.id, "메모-01", "memo", r#"{"text":"new"}"#)
            .await
            .unwrap();
        assert_eq!(created.name, "메모-01");

        store.pool.close().await;
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn memo_chip_kind_is_allowed() {
        let (root, store, admin) = test_store().await;
        let workspace = store
            .insert_workspace("Memo", None, &admin.id, None)
            .await
            .unwrap();
        let chip = store
            .insert_chip(&admin.id, &workspace.id, "Note", "memo", r#"{"text":"hi"}"#)
            .await
            .unwrap();
        assert_eq!(chip.kind, "memo");
        store.pool.close().await;
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn deleting_registered_chip_removes_orphan_definition_but_keeps_run_history() {
        let (root, store, admin) = test_store().await;
        let workspace = store
            .insert_workspace("Delete chip", None, &admin.id, None)
            .await
            .unwrap();
        let connection = store
            .insert_connection(NewConnection {
                http_auth: None,
                name: "delete-chip-connection".into(),
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
        let chip = store
            .register_extract_chip(&RegisterExtractChip {
                name: "Delete extract".into(),
                owner_user_id: admin.id.clone(),
                workspace_id: Some(workspace.id.clone()),
                kind: "database".into(),
                connection_id: connection.id,
                source_json: r#"{"type":"query","sql":"SELECT 1"}"#.into(),
                delimiter: ",".into(),
                header: true,
                add_sequence: false,
                output_filename: Some("delete.csv".into()),
                place_on_workspace: true,
            })
            .await
            .unwrap();
        let definition_id = store
            .get_chip_binding(&chip.id)
            .await
            .unwrap()
            .unwrap()
            .ref_id;
        let run = store
            .create_chip_run(
                &chip.id,
                &workspace.id,
                chip.revision,
                r#"{"source":{"type":"query","sql":"SELECT 1"}}"#,
                None,
            )
            .await
            .unwrap();
        let placed_before: (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM workspace_chips WHERE chip_id = ?")
                .bind(&chip.id)
                .fetch_one(&store.pool)
                .await
                .unwrap();
        assert!(placed_before.0 > 0);

        store.delete_chip(&chip.id).await.unwrap();

        assert!(store.get_chip(&chip.id).await.unwrap().is_none());
        let canvas_placements: (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM workspace_chips WHERE chip_id = ?")
                .bind(&chip.id)
                .fetch_one(&store.pool)
                .await
                .unwrap();
        assert_eq!(canvas_placements.0, 0);
        assert!(store
            .get_extract_definition(&definition_id)
            .await
            .unwrap()
            .is_none());
        let historical: (Option<String>, String) = sqlx::query_as(
            "SELECT chip_id, definition_snapshot_json FROM execution_steps WHERE id = ?",
        )
        .bind(&run.id)
        .fetch_one(&store.pool)
        .await
        .unwrap();
        assert!(historical.0.is_none());
        assert!(historical.1.contains("SELECT 1"));

        store.pool.close().await;
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn repair_canvas_restores_placements_wiped_by_chip_table_rebuild() {
        let (root, store, admin) = test_store().await;
        let workspace = store
            .insert_workspace("Repair", None, &admin.id, None)
            .await
            .unwrap();
        let extract = store
            .insert_chip(
                &admin.id,
                &workspace.id,
                "Src",
                "extract",
                r#"{"connection_id":"c","source":{"type":"table","table":"users"}}"#,
            )
            .await
            .unwrap();
        let transform = store
            .insert_chip(
                &admin.id,
                &workspace.id,
                "Out",
                "transform",
                r#"{"spec":{"version":2,"steps":[],"sink":"parquet"}}"#,
            )
            .await
            .unwrap();
        store
            .save_workspace(
                &workspace.id,
                &format!(
                    r#"{{"nodes":{{"{}":{{"x":10,"y":20}},"{}":{{"x":30,"y":40}}}}}}"#,
                    extract.id, transform.id
                ),
                &[extract.id.clone(), transform.id.clone()],
                &[WorkspaceSaveEdge {
                    id: Uuid::new_v4().to_string(),
                    from_chip_id: extract.id.clone(),
                    to_chip_id: transform.id.clone(),
                    kind: "data".into(),
                    from_port: "right".into(),
                    to_port: "left".into(),
                }],
                None,
            )
            .await
            .unwrap();
        sqlx::query("DELETE FROM workspace_chips WHERE workspace_id = ?")
            .bind(&workspace.id)
            .execute(&store.pool)
            .await
            .unwrap();
        assert!(store.list_chips(&workspace.id).await.unwrap().is_empty());
        store.repair_canvas_from_revisions().await.unwrap();
        let restored = store.list_chips(&workspace.id).await.unwrap();
        assert_eq!(restored.len(), 2);
        let edges = store.list_chip_edges(&workspace.id).await.unwrap();
        assert_eq!(edges.len(), 1);
        let placed: (f64, f64) = sqlx::query_as(
            "SELECT x, y FROM workspace_chips WHERE workspace_id = ? AND chip_id = ?",
        )
        .bind(&workspace.id)
        .bind(&extract.id)
        .fetch_one(&store.pool)
        .await
        .unwrap();
        assert_eq!(placed, (10.0, 20.0));
        store.pool.close().await;
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn rebuilding_chips_with_fk_disabled_keeps_workspace_placements() {
        let (root, store, admin) = test_store().await;
        let workspace = store
            .insert_workspace("Keep", None, &admin.id, None)
            .await
            .unwrap();
        let extract = store
            .insert_chip(
                &admin.id,
                &workspace.id,
                "Keep extract",
                "extract",
                r#"{"connection_id":"c","source":{"type":"table","table":"users"}}"#,
            )
            .await
            .unwrap();
        store
            .save_workspace(
                &workspace.id,
                r#"{"nodes":{}}"#,
                &[extract.id.clone()],
                &[],
                None,
            )
            .await
            .unwrap();
        store.pool.close().await;
        let db_path = root.join("etl.db");
        let mut conn = SqliteConnectOptions::new()
            .filename(&db_path)
            .foreign_keys(false)
            .connect()
            .await
            .unwrap();
        let mut tx = conn.begin().await.unwrap();
        sqlx::query(
            "CREATE TABLE chips_new (
                id TEXT PRIMARY KEY,
                owner_user_id TEXT,
                name TEXT,
                kind TEXT,
                extract_id TEXT,
                transform_id TEXT,
                load_id TEXT,
                config_json TEXT,
                revision INTEGER,
                active INTEGER,
                created_at TEXT,
                updated_at TEXT
             )",
        )
        .execute(&mut *tx)
        .await
        .unwrap();
        sqlx::query("INSERT INTO chips_new SELECT * FROM chips")
            .execute(&mut *tx)
            .await
            .unwrap();
        sqlx::query("DROP TABLE chips")
            .execute(&mut *tx)
            .await
            .unwrap();
        sqlx::query("ALTER TABLE chips_new RENAME TO chips")
            .execute(&mut *tx)
            .await
            .unwrap();
        tx.commit().await.unwrap();
        conn.close().await.unwrap();
        let pool = SqlitePoolOptions::new()
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(&db_path)
                    .foreign_keys(true),
            )
            .await
            .unwrap();
        let count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM workspace_chips WHERE chip_id = ?")
                .bind(&extract.id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(count, 1);
        pool.close().await;
        let _ = std::fs::remove_dir_all(root);
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
                    from_port: "right".into(),
                    to_port: "left".into(),
                }],
                None,
            )
            .await
            .unwrap();
        assert_eq!(chips.len(), 2);
        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0].kind, "data");

        let mixed_control = store
            .save_workspace(
                &workspace.id,
                r#"{"nodes":{}}"#,
                &[extract.id.clone(), transform.id.clone()],
                &[
                    WorkspaceSaveEdge {
                        id: String::new(),
                        from_chip_id: extract.id.clone(),
                        to_chip_id: transform.id.clone(),
                        kind: "on_success".into(),
                        from_port: String::new(),
                        to_port: String::new(),
                    },
                    WorkspaceSaveEdge {
                        id: String::new(),
                        from_chip_id: extract.id.clone(),
                        to_chip_id: transform.id.clone(),
                        kind: "on_error".into(),
                        from_port: String::new(),
                        to_port: String::new(),
                    },
                ],
                None,
            )
            .await;
        assert!(
            mixed_control.is_err(),
            "one pair cannot hold both success and failure control edges"
        );

        let placement_id = workspace_repo::workspace_chip_id(&workspace.id, &extract.id);
        sqlx::query(
            "INSERT INTO workspace_chip_outputs
            (workspace_chip_id, port_name, expected_filename, definition_revision, updated_at)
            VALUES (?, 'out', 'users.csv', 1, ?)
            ON CONFLICT(workspace_chip_id, port_name) DO UPDATE SET
            expected_filename=excluded.expected_filename, updated_at=excluded.updated_at",
        )
        .bind(&placement_id)
        .bind(now_rfc3339())
        .execute(&store.pool)
        .await
        .unwrap();
        let planned = store
            .find_planned_input_dataset(&workspace.id, &transform.id)
            .await
            .unwrap()
            .expect("visual edge sides must resolve the logical output contract");
        assert_eq!(planned.filename, "users.csv");
        store
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
                None,
            )
            .await
            .unwrap();
        let expected: String = sqlx::query_scalar(
            "SELECT expected_filename FROM workspace_chip_outputs WHERE workspace_chip_id=? AND port_name='out'")
            .bind(&placement_id).fetch_one(&store.pool).await.unwrap();
        assert_eq!(expected, "users.csv");

        let validation = store
            .insert_chip(&admin.id, &workspace.id, "Compare", "validation", "{}")
            .await
            .unwrap();
        let (_, _, validation_edges) = store
            .save_workspace(
                &workspace.id,
                r#"{"nodes":{}}"#,
                &[
                    extract.id.clone(),
                    transform.id.clone(),
                    validation.id.clone(),
                ],
                &[
                    WorkspaceSaveEdge {
                        id: String::new(),
                        from_chip_id: extract.id.clone(),
                        to_chip_id: validation.id.clone(),
                        kind: "data".into(),
                        from_port: "out".into(),
                        to_port: "source".into(),
                    },
                    WorkspaceSaveEdge {
                        id: String::new(),
                        from_chip_id: transform.id.clone(),
                        to_chip_id: validation.id.clone(),
                        kind: "data".into(),
                        from_port: "out".into(),
                        to_port: "target".into(),
                    },
                ],
                None,
            )
            .await
            .unwrap();
        assert_eq!(validation_edges.len(), 2);
        assert!(validation_edges.iter().any(|edge| edge.to_port == "source"));
        assert!(validation_edges.iter().any(|edge| edge.to_port == "target"));

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
                None,
            )
            .await;
        assert!(cycle.is_err());

        let load = store
            .insert_chip(
                &admin.id,
                &workspace.id,
                "Dest",
                "load",
                r#"{"connection_id":"c","table":"users"}"#,
            )
            .await
            .unwrap();
        let shortcut = store
            .save_workspace(
                &workspace.id,
                r#"{"nodes":{}}"#,
                &[extract.id.clone(), transform.id.clone(), load.id.clone()],
                &[
                    WorkspaceSaveEdge {
                        id: String::new(),
                        from_chip_id: extract.id.clone(),
                        to_chip_id: transform.id.clone(),
                        kind: "data".into(),
                        from_port: "out".into(),
                        to_port: "in".into(),
                    },
                    WorkspaceSaveEdge {
                        id: String::new(),
                        from_chip_id: transform.id.clone(),
                        to_chip_id: load.id.clone(),
                        kind: "data".into(),
                        from_port: "out".into(),
                        to_port: "in".into(),
                    },
                    WorkspaceSaveEdge {
                        id: String::new(),
                        from_chip_id: extract.id.clone(),
                        to_chip_id: load.id.clone(),
                        kind: "on_success".into(),
                        from_port: String::new(),
                        to_port: String::new(),
                    },
                ],
                None,
            )
            .await;
        assert!(shortcut.is_err(), "extract→load must not skip transform");

        let reverse = store
            .save_workspace(
                &workspace.id,
                r#"{"nodes":{}}"#,
                &[extract.id.clone(), load.id.clone()],
                &[WorkspaceSaveEdge {
                    id: String::new(),
                    from_chip_id: load.id.clone(),
                    to_chip_id: extract.id.clone(),
                    kind: "on_success".into(),
                    from_port: String::new(),
                    to_port: String::new(),
                }],
                None,
            )
            .await;
        assert!(reverse.is_err(), "load cannot sequence extract");

        let error_into_consumer = store
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
                        from_port: "out".into(),
                        to_port: "in".into(),
                    },
                    WorkspaceSaveEdge {
                        id: String::new(),
                        from_chip_id: extract.id.clone(),
                        to_chip_id: transform.id.clone(),
                        kind: "on_error".into(),
                        from_port: String::new(),
                        to_port: String::new(),
                    },
                ],
                None,
            )
            .await;
        assert!(
            error_into_consumer.is_err(),
            "on_error cannot target a data consumer"
        );

        store
            .save_workspace(
                &workspace.id,
                r#"{"nodes":{}}"#,
                &[
                    extract.id.clone(),
                    transform.id.clone(),
                    load.id.clone(),
                    validation.id.clone(),
                ],
                &[
                    WorkspaceSaveEdge {
                        id: String::new(),
                        from_chip_id: extract.id.clone(),
                        to_chip_id: transform.id.clone(),
                        kind: "data".into(),
                        from_port: "out".into(),
                        to_port: "in".into(),
                    },
                    WorkspaceSaveEdge {
                        id: String::new(),
                        from_chip_id: transform.id.clone(),
                        to_chip_id: load.id.clone(),
                        kind: "data".into(),
                        from_port: "out".into(),
                        to_port: "in".into(),
                    },
                    WorkspaceSaveEdge {
                        id: String::new(),
                        from_chip_id: extract.id.clone(),
                        to_chip_id: validation.id.clone(),
                        kind: "data".into(),
                        from_port: "out".into(),
                        to_port: "source".into(),
                    },
                    WorkspaceSaveEdge {
                        id: String::new(),
                        from_chip_id: transform.id.clone(),
                        to_chip_id: validation.id.clone(),
                        kind: "data".into(),
                        from_port: "out".into(),
                        to_port: "target".into(),
                    },
                    WorkspaceSaveEdge {
                        id: String::new(),
                        from_chip_id: extract.id.clone(),
                        to_chip_id: transform.id.clone(),
                        kind: "on_success".into(),
                        from_port: String::new(),
                        to_port: String::new(),
                    },
                    WorkspaceSaveEdge {
                        id: String::new(),
                        from_chip_id: transform.id.clone(),
                        to_chip_id: load.id.clone(),
                        kind: "on_success".into(),
                        from_port: String::new(),
                        to_port: String::new(),
                    },
                    WorkspaceSaveEdge {
                        id: String::new(),
                        from_chip_id: extract.id.clone(),
                        to_chip_id: validation.id.clone(),
                        kind: "on_success".into(),
                        from_port: String::new(),
                        to_port: String::new(),
                    },
                    WorkspaceSaveEdge {
                        id: String::new(),
                        from_chip_id: transform.id.clone(),
                        to_chip_id: validation.id.clone(),
                        kind: "on_success".into(),
                        from_port: String::new(),
                        to_port: String::new(),
                    },
                ],
                None,
            )
            .await
            .expect("validation may take extract+transform even when they are already chained");

        let stale = store
            .save_workspace(
                &workspace.id,
                r#"{"nodes":{}}"#,
                &[extract.id.clone(), transform.id.clone()],
                &[],
                Some(1),
            )
            .await;
        assert!(matches!(stale, Err(StorageError::Conflict(_))));

        let stranger = store
            .create_user("kim", "김하나", "secret12", &["analyst".into()])
            .await
            .unwrap();
        let foreign = store
            .insert_workspace("Other", None, &stranger.id, None)
            .await
            .unwrap();
        let foreign_chip = store
            .insert_chip(&stranger.id, &foreign.id, "Stolen", "extract", "{}")
            .await
            .unwrap();
        let stolen = store
            .save_workspace(
                &workspace.id,
                r#"{"nodes":{}}"#,
                &[extract.id.clone(), foreign_chip.id],
                &[],
                None,
            )
            .await;
        assert!(matches!(stolen, Err(StorageError::Invalid(_))));

        store.pool.close().await;
        let _ = std::fs::remove_dir_all(root);
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

        let admin_files = store.list_uploads(Some(&admin_scope)).await.unwrap();
        let analyst_files = store.list_uploads(Some(&analyst_scope)).await.unwrap();
        assert!(admin_files.iter().any(|file| file.filename == "a.csv"));
        assert!(admin_files.iter().any(|file| file.filename == "b.csv"));
        assert_eq!(analyst_files.len(), 1);
        assert_eq!(analyst_files[0].filename, "b.csv");
        assert_eq!(analyst_files[0].workspace_id, analyst_home);

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
    async fn transform_definition_accepts_workspace_input_contract_without_fake_file() {
        let (root, store, admin) = test_store().await;
        let workspace = store
            .insert_workspace("Contract flow", None, &admin.id, None)
            .await
            .unwrap();
        let source = store
            .insert_chip(&admin.id, &workspace.id, "Source", "extract", "{}")
            .await
            .unwrap();
        let consumer = store
            .insert_chip(&admin.id, &workspace.id, "Transform", "transform", "{}")
            .await
            .unwrap();
        store
            .save_workspace(
                &workspace.id,
                r#"{"nodes":{}}"#,
                &[source.id.clone(), consumer.id.clone()],
                &[WorkspaceSaveEdge {
                    id: Uuid::new_v4().to_string(),
                    from_chip_id: source.id.clone(),
                    to_chip_id: consumer.id.clone(),
                    kind: "data".into(),
                    from_port: "out".into(),
                    to_port: "in".into(),
                }],
                None,
            )
            .await
            .unwrap();
        let contract = store
            .upsert_planned_input_dataset(
                &workspace.id,
                &consumer.id,
                &source.id,
                None,
                "database",
                "source.csv",
                r#"[{"name":"id","dtype":"Int64"}]"#,
                ",",
                true,
            )
            .await
            .unwrap();
        assert!(contract.id.starts_with("contract:"));
        let transform = store
            .insert_transform(
                "Clean",
                &contract.id,
                r#"{"version":2,"steps":[],"sink":"parquet"}"#,
                Some(&consumer.id),
            )
            .await
            .unwrap();
        assert_eq!(transform.dataset_id, contract.id);
        let stored: Option<String> =
            sqlx::query_scalar("SELECT default_input_file_id FROM transforms WHERE id=?")
                .bind(&transform.id)
                .fetch_one(&store.pool)
                .await
                .unwrap();
        assert!(stored.is_none());
        let fake_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM data_files WHERE stored_path LIKE '__planned__/%'",
        )
        .fetch_one(&store.pool)
        .await
        .unwrap();
        assert_eq!(fake_count, 0);
        store.pool.close().await;
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn delete_workspace_keeps_independent_extract_definition() {
        let (root, store, admin) = test_store().await;
        let ws = store
            .insert_workspace("delete-me", None, &admin.id, None)
            .await
            .unwrap();
        let conn = store
            .insert_connection(NewConnection {
                http_auth: None,
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
            "INSERT INTO extracts
             (id, owner_user_id, name, source_type, connection_id, source_json, output_format,
              output_filename, delimiter, has_header, add_sequence, revision, active, created_at, updated_at)
             VALUES (?, ?, 'def', 'database', ?, '{}', 'csv', 'def.csv', ',', 1, 0, 1, 1, ?, ?)",
        )
        .bind(&extract_id)
        .bind(&admin.id)
        .bind(&conn.id)
        .bind(&now)
        .bind(&now)
        .execute(&store.pool)
        .await
        .unwrap();

        let upload = store
            .save_upload("keep-out.csv", b"a,b\n1,2\n", Some(","), Some(true), &ws.id)
            .await
            .unwrap();
        store.delete_workspace(&ws.id).await.unwrap();
        let left: String = sqlx::query_scalar("SELECT id FROM extracts WHERE id = ?")
            .bind(&extract_id)
            .fetch_one(&store.pool)
            .await
            .unwrap();
        assert_eq!(left, extract_id);
        let def = store
            .get_extract_definition(&extract_id)
            .await
            .unwrap()
            .unwrap();
        assert!(def.workspace_id.is_empty());
        assert!(store.get_workspace(&ws.id).await.unwrap().is_none());
        assert!(store.get_dataset(&upload.id).await.unwrap().is_none());
        assert!(!store.resolve(&upload.stored_path).exists());
        let moved: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM data_files WHERE workspace_id = ? OR id = ?")
                .bind(DEFAULT_WORKSPACE_ID)
                .bind(&upload.id)
                .fetch_one(&store.pool)
                .await
                .unwrap();
        assert_eq!(moved, 0);
        let search_left: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM search_documents WHERE workspace_id = ?")
                .bind(&ws.id)
                .fetch_one(&store.pool)
                .await
                .unwrap();
        assert_eq!(search_left, 0);

        store.pool.close().await;
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn paste_chips_clones_definitions_internal_edges_and_skips_outputs() {
        let (root, store, admin) = test_store().await;
        let source = store
            .insert_workspace("Copy src", None, &admin.id, None)
            .await
            .unwrap();
        let target = store
            .insert_workspace("Copy dest", None, &admin.id, None)
            .await
            .unwrap();
        let connection = store
            .insert_connection(NewConnection {
                http_auth: None,
                name: "copy-connection".into(),
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
        let extract = store
            .register_extract_chip(&RegisterExtractChip {
                name: "Users".into(),
                owner_user_id: admin.id.clone(),
                workspace_id: Some(source.id.clone()),
                kind: "database".into(),
                connection_id: connection.id,
                source_json: r#"{"type":"query","sql":"SELECT 1"}"#.into(),
                delimiter: ",".into(),
                header: true,
                add_sequence: false,
                output_filename: Some("users.csv".into()),
                place_on_workspace: true,
            })
            .await
            .unwrap();
        let transform = store
            .insert_chip(
                &admin.id,
                &source.id,
                "Clean",
                "transform",
                r#"{"spec":{"version":2,"steps":[],"sink":"parquet"}}"#,
            )
            .await
            .unwrap();
        let leftover = store
            .insert_chip(
                &admin.id,
                &source.id,
                "Skip me",
                "sql",
                r#"{"sql":"SELECT 1"}"#,
            )
            .await
            .unwrap();
        let source_version = store
            .get_workspace(&source.id)
            .await
            .unwrap()
            .unwrap()
            .version;
        store
            .save_workspace(
                &source.id,
                &format!(
                    r#"{{"nodes":{{"{}":{{"x":10,"y":20}},"{}":{{"x":110,"y":20}},"{}":{{"x":210,"y":20}}}}}}"#,
                    extract.id, transform.id, leftover.id
                ),
                &[
                    extract.id.clone(),
                    transform.id.clone(),
                    leftover.id.clone(),
                ],
                &[
                    WorkspaceSaveEdge {
                        id: Uuid::new_v4().to_string(),
                        from_chip_id: extract.id.clone(),
                        to_chip_id: transform.id.clone(),
                        kind: "data".into(),
                        from_port: "right".into(),
                        to_port: "left".into(),
                    },
                    WorkspaceSaveEdge {
                        id: Uuid::new_v4().to_string(),
                        from_chip_id: leftover.id.clone(),
                        to_chip_id: transform.id.clone(),
                        kind: "on_success".into(),
                        from_port: "right".into(),
                        to_port: "left".into(),
                    },
                ],
                Some(source_version),
            )
            .await
            .unwrap();
        let extract_binding = store.get_chip_binding(&extract.id).await.unwrap().unwrap();
        let target_version = store
            .get_workspace(&target.id)
            .await
            .unwrap()
            .unwrap()
            .version;
        let pasted = store
            .paste_chips(
                &target.id,
                ChipPasteInput {
                    source_workspace_id: source.id.clone(),
                    chip_ids: vec![extract.id.clone(), transform.id.clone()],
                    origin_x: 40.0,
                    origin_y: 80.0,
                    expected_version: target_version,
                    serve_configs: Default::default(),
                },
            )
            .await
            .unwrap();
        assert_eq!(pasted.chips.len(), 2);
        let copied_extract = pasted
            .chips
            .iter()
            .find(|chip| chip.kind == "extract")
            .unwrap();
        let copied_transform = pasted
            .chips
            .iter()
            .find(|chip| chip.kind == "transform")
            .unwrap();
        assert_eq!(copied_extract.name, "Users copy");
        assert_eq!(copied_transform.name, "Clean copy");
        assert_ne!(copied_extract.id, extract.id);
        let copied_binding = store
            .get_chip_binding(&copied_extract.id)
            .await
            .unwrap()
            .unwrap();
        assert_ne!(copied_binding.ref_id, extract_binding.ref_id);
        assert_eq!(pasted.edges.len(), 1);
        assert_eq!(pasted.edges[0].from_chip_id, copied_extract.id);
        assert_eq!(pasted.edges[0].to_chip_id, copied_transform.id);
        assert_eq!(pasted.edges[0].kind, "data");
        let placed: (f64, f64) = sqlx::query_as(
            "SELECT x, y FROM workspace_chips WHERE workspace_id = ? AND chip_id = ?",
        )
        .bind(&target.id)
        .bind(&copied_extract.id)
        .fetch_one(&store.pool)
        .await
        .unwrap();
        assert_eq!(placed, (40.0, 80.0));
        let output_files: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM data_files WHERE workspace_id = ?")
                .bind(&target.id)
                .fetch_one(&store.pool)
                .await
                .unwrap();
        assert_eq!(output_files, 0);
        let source_chips = store.list_chips(&source.id).await.unwrap();
        assert_eq!(source_chips.len(), 3);

        store.pool.close().await;
        let _ = std::fs::remove_dir_all(root);
    }
}
