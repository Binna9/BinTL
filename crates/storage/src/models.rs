use std::path::PathBuf;

use serde::Serialize;
use sqlx::SqlitePool;

#[derive(Clone)]
pub struct Store {
    pub pool: SqlitePool,
    pub data_dir: PathBuf,
    pub(crate) secret_key: [u8; 32],
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct ExecutionRow {
    pub id: String,
    pub workspace_id: String,
    pub requested_by: Option<String>,
    pub source: String,
    pub trigger_id: Option<String>,
    pub status: String,
    pub created_at: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub error_message: Option<String>,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct ExecutionStepRow {
    pub id: String,
    pub execution_id: String,
    pub workspace_chip_id: Option<String>,
    pub chip_id: Option<String>,
    pub kind: String,
    pub extract_id: Option<String>,
    pub transform_id: Option<String>,
    pub load_id: Option<String>,
    pub definition_revision: i64,
    pub definition_snapshot_json: String,
    pub source_path: Option<String>,
    pub output_path: Option<String>,
    pub status: String,
    pub input_rows: Option<i64>,
    pub output_rows: Option<i64>,
    pub rejected_rows: Option<i64>,
    pub input_bytes: Option<i64>,
    pub output_bytes: Option<i64>,
    pub result_json: Option<String>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    pub queued_at: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct DataFileRow {
    pub id: String,
    pub workspace_id: String,
    pub schema_id: Option<String>,
    pub kind: String,
    pub format: String,
    pub filename: String,
    pub stored_path: String,
    pub size_bytes: Option<i64>,
    pub row_count: Option<i64>,
    pub delimiter: Option<String>,
    pub has_header: Option<i64>,
    pub created_at: String,
    pub updated_at: String,
    pub deleted_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct DataSchemaRow {
    pub id: String,
    pub fingerprint: String,
    pub columns_json: String,
    pub created_at: String,
}

#[derive(Debug, Clone)]
pub struct NewExecutionStep<'a> {
    pub workspace_id: &'a str,
    pub requested_by: Option<&'a str>,
    pub source: &'a str,
    pub trigger_id: Option<&'a str>,
    pub workspace_chip_id: Option<&'a str>,
    pub chip_id: Option<&'a str>,
    pub kind: &'a str,
    pub definition_id: &'a str,
    pub definition_revision: i64,
    pub definition_snapshot_json: &'a str,
    pub source_path: Option<&'a str>,
}

pub(crate) const JOB_COLS: &str = "s.id, s.status, COALESCE(s.source_path, '') AS source_path,
        s.output_path, s.definition_snapshot_json AS spec_json, s.error_message,
        s.queued_at AS created_at, s.started_at, s.finished_at, s.kind, s.transform_id,
        (SELECT i.data_file_id FROM execution_inputs i WHERE i.execution_step_id = s.id ORDER BY i.ordinal LIMIT 1) AS dataset_id,
        e.workspace_id";

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

pub(crate) const DATASET_COLS: &str = "d.id, d.kind,
        NULL AS extract_id, d.filename, d.stored_path, d.size_bytes,
        d.delimiter, d.has_header, s.columns_json, d.row_count, d.inspected_at,
        d.created_at, d.updated_at, d.workspace_id,
        (SELECT eo.execution_step_id FROM execution_outputs eo
         WHERE eo.data_file_id = d.id LIMIT 1) AS producer_chip_run_id,
        'materialized' AS status, NULL AS source_chip_id, NULL AS consumer_chip_id,
        NULL AS source_extract_definition_id,
        '' AS table_name, '' AS connection_name";

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
pub struct LoadDefinitionRow {
    pub id: String,
    pub owner_user_id: String,
    pub name: String,
    pub destination_type: String,
    pub spec_json: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct LoadResultRow {
    pub chip_run_id: String,
    pub destination: String,
    pub write_mode: String,
    pub input_rows: Option<i64>,
    pub loaded_rows: i64,
    pub rejected_rows: i64,
    pub input_bytes: Option<i64>,
    pub duration_ms: i64,
    pub artifact_path: Option<String>,
    pub validation_status: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct ValidationRuleRow {
    pub id: String,
    pub owner_user_id: String,
    pub name: String,
    pub description: String,
    pub keys_json: String,
    pub columns_json: String,
    pub compare_row_count: i64,
    pub compare_schema: i64,
    pub active: i64,
    pub revision: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct ValidationResultRow {
    pub id: String,
    pub owner_user_id: String,
    pub workspace_id: String,
    pub validation_rule_id: Option<String>,
    pub execution_step_id: Option<String>,
    pub source_data_file_id: String,
    pub target_data_file_id: String,
    pub passed: i64,
    pub report_json: String,
    pub created_at: String,
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
    "id, name, description, viewport_json AS layout_json, version, created_at, updated_at, owner_user_id, folder_id";
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
pub struct RegisterLoadChip {
    pub name: String,
    pub owner_user_id: String,
    pub workspace_id: Option<String>,
    pub load_definition_id: String,
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

pub(crate) const CHIP_COLS: &str = "id, owner_user_id, name, kind,
        COALESCE(CASE kind
          WHEN 'extract' THEN (SELECT json_object('connection_id', e.connection_id,
            'source', json(e.source_json), 'delimiter', e.delimiter,
            'header', e.has_header != 0) FROM extracts e WHERE e.id = chips.extract_id)
          WHEN 'transform' THEN (SELECT json_object('input_dataset_id', t.default_input_file_id,
            'spec', json(t.spec_json)) FROM transforms t WHERE t.id = chips.transform_id)
          WHEN 'load' THEN (SELECT json_object('input_dataset_id', l.default_input_file_id,
            'destination', json(l.destination_json), 'write_mode', l.write_mode,
            'conflict_keys', json(l.conflict_keys_json)) FROM loads l WHERE l.id = chips.load_id)
        END, config_json) AS config_json,
        COALESCE((SELECT revision FROM extracts e WHERE e.id = chips.extract_id),
                 (SELECT revision FROM transforms t WHERE t.id = chips.transform_id),
                 (SELECT revision FROM loads l WHERE l.id = chips.load_id), revision, 1) AS revision,
        active, created_at, updated_at";
pub(crate) const CHIP_JOIN_COLS: &str = "c.id, c.owner_user_id, c.name, c.kind,
        COALESCE(CASE c.kind
          WHEN 'extract' THEN (SELECT json_object('connection_id', e.connection_id,
            'source', json(e.source_json), 'delimiter', e.delimiter,
            'header', e.has_header != 0) FROM extracts e WHERE e.id = c.extract_id)
          WHEN 'transform' THEN (SELECT json_object('input_dataset_id', t.default_input_file_id,
            'spec', json(t.spec_json)) FROM transforms t WHERE t.id = c.transform_id)
          WHEN 'load' THEN (SELECT json_object('input_dataset_id', l.default_input_file_id,
            'destination', json(l.destination_json), 'write_mode', l.write_mode,
            'conflict_keys', json(l.conflict_keys_json)) FROM loads l WHERE l.id = c.load_id)
        END, c.config_json) AS config_json,
        COALESCE((SELECT revision FROM extracts e WHERE e.id = c.extract_id),
                 (SELECT revision FROM transforms t WHERE t.id = c.transform_id),
                 (SELECT revision FROM loads l WHERE l.id = c.load_id), c.revision, 1) AS revision,
        c.active, c.created_at, c.updated_at";
pub(crate) const CHIP_RUN_COLS: &str =
    "s.id, s.chip_id, e.workspace_id, s.kind, s.status,
        s.definition_snapshot_json AS config_snapshot_json,
        s.definition_revision AS revision_snapshot,
        (SELECT i.data_file_id FROM execution_inputs i WHERE i.execution_step_id = s.id ORDER BY i.ordinal LIMIT 1) AS input_dataset_id,
        (SELECT o.data_file_id FROM execution_outputs o WHERE o.execution_step_id = s.id LIMIT 1) AS output_dataset_id,
        CASE WHEN s.kind = 'extract' THEN s.id END AS legacy_extract_id,
        CASE WHEN s.kind = 'transform' THEN s.id END AS legacy_job_id,
        s.error_message, s.queued_at AS created_at, s.started_at, s.finished_at";

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
    "s.id, json_extract(s.definition_snapshot_json, '$.kind') AS kind,
        json_extract(s.definition_snapshot_json, '$.connection_id') AS connection_id,
        json_extract(s.definition_snapshot_json, '$.table_name') AS table_name,
        COALESCE(json_extract(s.definition_snapshot_json, '$.delimiter'), ',') AS delimiter,
        COALESCE(json_extract(s.definition_snapshot_json, '$.header'), 1) AS header,
        COALESCE(json_extract(s.definition_snapshot_json, '$.add_sequence'), 0) AS add_sequence,
        s.status, s.output_path AS stored_path,
        json_extract(s.result_json, '$.filename') AS filename,
        json_extract(s.definition_snapshot_json, '$.output_filename') AS output_filename,
        s.output_rows AS row_count, s.error_message, s.queued_at AS created_at,
        s.started_at, s.finished_at, json_extract(s.definition_snapshot_json, '$.sql_text') AS sql_text,
        json_extract(s.definition_snapshot_json, '$.catalog_database') AS catalog_database,
        x.workspace_id, COALESCE(c.name, '') AS connection_name";

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
