-- Workspace/task execution model. The fixed default ID makes backfills repeatable.
CREATE TABLE workspaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

INSERT INTO workspaces (id, name, description, created_at, updated_at)
VALUES (
    '00000000-0000-0000-0000-000000000001',
    '기본 Workspace',
    '기존 데이터의 기본 작업 공간',
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);

CREATE TABLE task_definitions (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('extract', 'transform', 'load')),
    config_json TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- Create runs before copying datasets so the new provenance foreign key has a
-- parent table throughout the rebuild. This table is empty during migration.
CREATE TABLE task_runs (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES task_definitions(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    kind TEXT NOT NULL CHECK (kind IN ('extract', 'transform', 'load')),
    status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
    config_snapshot_json TEXT NOT NULL,
    revision_snapshot INTEGER NOT NULL CHECK (revision_snapshot > 0),
    -- Dataset is rebuilt below to widen its kind constraint. Keep these as
    -- logical references so the migration can safely replace that table.
    input_dataset_id TEXT,
    output_dataset_id TEXT,
    legacy_extract_id TEXT REFERENCES extracts(id),
    legacy_job_id TEXT REFERENCES jobs(id),
    error_message TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT
);

-- Rebuild datasets because SQLite cannot alter the existing kind CHECK constraint.
-- Rebuild transforms at the same time so its dataset foreign key keeps pointing at
-- the final table instead of a renamed temporary table.
CREATE TABLE datasets__workspace (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('upload', 'database', 'api', 'transform')),
    extract_id TEXT,
    filename TEXT NOT NULL,
    stored_path TEXT NOT NULL UNIQUE,
    size_bytes INTEGER,
    delimiter TEXT,
    has_header INTEGER,
    columns_json TEXT,
    row_count INTEGER,
    inspected_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    workspace_id TEXT NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001'
        REFERENCES workspaces(id),
    producer_task_run_id TEXT REFERENCES task_runs(id)
);

CREATE TABLE transforms__workspace (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    dataset_id TEXT NOT NULL REFERENCES datasets__workspace(id),
    spec_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

INSERT INTO datasets__workspace (
    id, kind, extract_id, filename, stored_path, size_bytes, delimiter, has_header,
    columns_json, row_count, inspected_at, created_at, updated_at, workspace_id,
    producer_task_run_id
)
SELECT
    id, kind, extract_id, filename, stored_path, size_bytes, delimiter, has_header,
    columns_json, row_count, inspected_at, created_at, updated_at,
    '00000000-0000-0000-0000-000000000001', NULL
FROM datasets;

INSERT INTO transforms__workspace (
    id, name, dataset_id, spec_json, created_at, updated_at
)
SELECT id, name, dataset_id, spec_json, created_at, updated_at
FROM transforms;

DROP TABLE transforms;
DROP TABLE datasets;
ALTER TABLE datasets__workspace RENAME TO datasets;
ALTER TABLE transforms__workspace RENAME TO transforms;

CREATE INDEX idx_task_definitions_workspace
    ON task_definitions(workspace_id, updated_at DESC);
CREATE INDEX idx_task_runs_workspace
    ON task_runs(workspace_id, created_at DESC);
CREATE INDEX idx_task_runs_task
    ON task_runs(task_id, created_at DESC);
CREATE UNIQUE INDEX idx_task_runs_extract
    ON task_runs(legacy_extract_id) WHERE legacy_extract_id IS NOT NULL;
CREATE UNIQUE INDEX idx_task_runs_job
    ON task_runs(legacy_job_id) WHERE legacy_job_id IS NOT NULL;
CREATE INDEX idx_datasets_workspace
    ON datasets(workspace_id, created_at DESC);
CREATE INDEX idx_datasets_producer
    ON datasets(producer_task_run_id);
