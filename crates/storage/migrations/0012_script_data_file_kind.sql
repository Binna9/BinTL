-- no-transaction
PRAGMA foreign_keys = OFF;

CREATE TABLE data_files_new (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
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
INSERT INTO data_files_new SELECT * FROM data_files;
DROP TABLE data_files;
ALTER TABLE data_files_new RENAME TO data_files;
CREATE INDEX idx_data_files_workspace ON data_files(workspace_id, created_at DESC);
CREATE INDEX idx_data_files_schema ON data_files(schema_id);

PRAGMA foreign_keys = ON;
