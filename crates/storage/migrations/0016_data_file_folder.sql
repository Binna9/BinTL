-- no-transaction
-- Catalog files live on a work category. Chip slots still record the canvas
-- so a moved canvas takes its current output with it.
PRAGMA foreign_keys = OFF;

CREATE TABLE data_files_new (
    id TEXT PRIMARY KEY,
    workspace_id TEXT REFERENCES workspaces(id),
    folder_id TEXT REFERENCES workspace_folders(id) ON DELETE SET NULL,
    schema_id TEXT REFERENCES data_schemas(id) ON DELETE SET NULL,
    kind TEXT NOT NULL CHECK (kind IN ('upload', 'database', 'api', 'transform', 'load', 'script')),
    format TEXT NOT NULL,
    filename TEXT NOT NULL,
    stored_path TEXT NOT NULL UNIQUE,
    size_bytes INTEGER,
    row_count INTEGER,
    delimiter TEXT,
    has_header INTEGER CHECK (has_header IN (0, 1)),
    inspected_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
);
INSERT INTO data_files_new (
    id, workspace_id, folder_id, schema_id, kind, format, filename, stored_path,
    size_bytes, row_count, delimiter, has_header, inspected_at, created_at, updated_at, deleted_at
)
SELECT
    d.id,
    CASE
        WHEN d.id IN (
            SELECT current_data_file_id FROM workspace_chip_outputs
            WHERE current_data_file_id IS NOT NULL
        ) THEN d.workspace_id
        WHEN (SELECT w.folder_id FROM workspaces w WHERE w.id = d.workspace_id) IS NOT NULL
            THEN NULL
        ELSE d.workspace_id
    END,
    (SELECT w.folder_id FROM workspaces w WHERE w.id = d.workspace_id),
    d.schema_id, d.kind, d.format, d.filename, d.stored_path,
    d.size_bytes, d.row_count, d.delimiter, d.has_header, d.inspected_at,
    d.created_at, d.updated_at, d.deleted_at
FROM data_files d;
DROP TABLE data_files;
ALTER TABLE data_files_new RENAME TO data_files;
CREATE INDEX idx_data_files_workspace ON data_files(workspace_id, created_at DESC);
CREATE INDEX idx_data_files_folder ON data_files(folder_id, created_at DESC);
CREATE INDEX idx_data_files_schema ON data_files(schema_id);

CREATE TABLE executions_new (
    id TEXT PRIMARY KEY,
    workspace_id TEXT REFERENCES workspaces(id),
    folder_id TEXT REFERENCES workspace_folders(id) ON DELETE SET NULL,
    requested_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    source TEXT NOT NULL CHECK (source IN ('extract_page', 'transform_page', 'load_page', 'chip', 'workspace')),
    trigger_id TEXT,
    status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'canceled')),
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    error_message TEXT
);
INSERT INTO executions_new (
    id, workspace_id, folder_id, requested_by, source, trigger_id, status,
    created_at, started_at, finished_at, error_message
)
SELECT
    id, workspace_id, NULL, requested_by, source, trigger_id, status,
    created_at, started_at, finished_at, error_message
FROM executions;
DROP TRIGGER IF EXISTS trg_execution_step_status;
DROP TABLE executions;
ALTER TABLE executions_new RENAME TO executions;
CREATE INDEX idx_executions_workspace ON executions(workspace_id, created_at DESC);
CREATE INDEX idx_executions_folder ON executions(folder_id, created_at DESC);
CREATE INDEX idx_executions_status ON executions(status, created_at);
CREATE INDEX idx_executions_workspace_source ON executions(workspace_id, source, created_at DESC);

CREATE TRIGGER trg_execution_step_status
AFTER UPDATE OF status ON execution_steps
BEGIN
    UPDATE executions
    SET status = CASE
            WHEN EXISTS (SELECT 1 FROM execution_steps WHERE execution_id = NEW.execution_id AND status = 'failed') THEN 'failed'
            WHEN EXISTS (SELECT 1 FROM execution_steps WHERE execution_id = NEW.execution_id AND status = 'running') THEN 'running'
            WHEN NOT EXISTS (SELECT 1 FROM execution_steps WHERE execution_id = NEW.execution_id AND status IN ('queued', 'running')) THEN 'succeeded'
            ELSE 'queued'
        END,
        started_at = CASE WHEN NEW.status = 'running' THEN COALESCE(started_at, NEW.started_at) ELSE started_at END,
        finished_at = CASE WHEN NEW.status IN ('succeeded', 'failed', 'canceled') THEN NEW.finished_at ELSE finished_at END,
        error_message = CASE WHEN NEW.status = 'failed' THEN NEW.error_message ELSE error_message END
    WHERE id = NEW.execution_id AND source != 'workspace';
END;

PRAGMA foreign_keys = ON;
