mod chip_definition_repo;
mod chip_run_repo;
pub mod chip_slot;
mod connection_repo;
mod dataset_repo;
mod delete_guard;
mod execution_repo;
mod extract_repo;
mod file_repo;
mod identity;
mod http_auth;
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

pub use identity::{
    DataScope, PermissionRow, RoleWithPermissions, UserRow, PERM_CONNECTION_WRITE,
    PERM_USER_MANAGE, PERM_WORKSPACE_ALL,
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
        let store = Self {
            pool,
            data_dir,
            secret_key: secret::key_from_secret(session_secret),
        };
        store.backfill_workspace_revisions().await?;
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
        let p = Path::new(stored);
        if p.is_absolute() {
            p.to_path_buf()
        } else {
            self.data_dir.join(p)
        }
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
            http_auth: row.http_auth_json.as_deref().map(serde_json::from_str).transpose()
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
    tokio::fs::create_dir_all(data_dir.join(REL_STAGING)).await?;
    for kind in EXTRACT_KINDS {
        tokio::fs::create_dir_all(data_dir.join("extract_runs").join(kind)).await?;
    }
    for area in LOG_AREAS {
        tokio::fs::create_dir_all(data_dir.join(REL_LOGS).join(area)).await?;
    }
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
    if !matches!(kind, "extract" | "transform" | "load" | "validation") {
        return Err(StorageError::Invalid(
            "chip kind must be extract, transform, load, or validation".into(),
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
        validate_edge_kind(&edge.kind, from.kind.as_str(), to.kind.as_str())?;
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
        let key = (from_id.to_string(), to_id.to_string(), edge.kind.clone());
        if !seen.insert(key) {
            return Err(StorageError::Invalid("duplicate chip edge".into()));
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

fn validate_edge_kind(kind: &str, from_kind: &str, to_kind: &str) -> Result<(), StorageError> {
    match kind {
        "data" => {
            if !matches!(from_kind, "extract" | "transform") {
                return Err(StorageError::Invalid(
                    "data edges must start from extract or transform".into(),
                ));
            }
            if !matches!(to_kind, "transform" | "load" | "validation") {
                return Err(StorageError::Invalid(
                    "data edges must end at transform, load, or validation".into(),
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
        "postgres" | "redshift" | "cockroach" | "mysql" | "mariadb" | "mssql" | "sqlite" | "http"
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
        let admin = store.ensure_bootstrap("admin", "admin").await.unwrap();
        (root, store, admin)
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

        store.delete_chip(&chip.id).await.unwrap();

        assert!(store.get_chip(&chip.id).await.unwrap().is_none());
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
            )
            .await
            .unwrap();
        assert_eq!(chips.len(), 2);
        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0].kind, "data");

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
            )
            .await;
        assert!(cycle.is_err());

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

        store.delete_workspace(&ws.id).await.unwrap();
        let left: String = sqlx::query_scalar("SELECT id FROM extracts WHERE id = ?")
            .bind(&extract_id)
            .fetch_one(&store.pool)
            .await
            .unwrap();
        assert_eq!(left, extract_id);
        assert!(store.get_workspace(&ws.id).await.unwrap().is_none());

        store.pool.close().await;
        let _ = std::fs::remove_dir_all(root);
    }
}
