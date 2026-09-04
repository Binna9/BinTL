use std::path::PathBuf;

use serde::Serialize;
use sqlx::SqlitePool;

#[derive(Clone)]
pub struct Store {
    pub pool: SqlitePool,
    pub data_dir: PathBuf,
    pub(crate) secret_key: [u8; 32],
}

pub(crate) const JOB_COLS: &str = "id, status, source_path, output_path, spec_json, error_message,
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

pub(crate) const DATASET_COLS: &str =
    "d.id, d.kind, d.extract_id, d.filename, d.stored_path, d.size_bytes,
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

pub(crate) const WORKSPACE_COLS: &str =
    "id, name, description, layout_json, version, created_at, updated_at, owner_user_id, folder_id";
pub(crate) const FOLDER_COLS: &str = "id, owner_user_id, parent_id, name, created_at, updated_at";

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

pub(crate) const CHIP_COLS: &str = "id, owner_user_id, name, kind, config_json, revision,
        active, created_at, updated_at";
pub(crate) const CHIP_JOIN_COLS: &str =
    "c.id, c.owner_user_id, c.name, c.kind, c.config_json, c.revision,
        c.active, c.created_at, c.updated_at";
pub(crate) const EXTRACT_DEFINITION_COLS: &str =
    "id, name, kind, connection_id, source_json, delimiter,
        header, add_sequence, workspace_id, created_at, updated_at";
pub(crate) const CHIP_RUN_COLS: &str =
    "id, chip_id, workspace_id, kind, status, config_snapshot_json,
        revision_snapshot, input_dataset_id, output_dataset_id, legacy_extract_id,
        legacy_job_id, error_message, created_at, started_at, finished_at";
pub(crate) const CHIP_EDGE_COLS: &str =
    "id, workspace_id, from_chip_id, to_chip_id, kind, from_port,
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

pub(crate) const EXTRACT_COLS: &str =
    "e.id, e.kind, e.connection_id, e.table_name, e.delimiter, e.header,
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
