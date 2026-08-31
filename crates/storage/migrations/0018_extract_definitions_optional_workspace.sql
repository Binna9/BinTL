-- Catalog extract definitions are not tied to a workspace until placed on a canvas.

CREATE TABLE extract_definitions__optional_ws (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'database' CHECK (kind IN ('database', 'api')),
    connection_id TEXT NOT NULL REFERENCES connections(id),
    source_json TEXT NOT NULL,
    delimiter TEXT NOT NULL DEFAULT ',',
    header INTEGER NOT NULL DEFAULT 1 CHECK (header IN (0, 1)),
    add_sequence INTEGER NOT NULL DEFAULT 0 CHECK (add_sequence IN (0, 1)),
    workspace_id TEXT REFERENCES workspaces(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

INSERT INTO extract_definitions__optional_ws
SELECT id, name, kind, connection_id, source_json, delimiter, header, add_sequence, workspace_id, created_at, updated_at
FROM extract_definitions;

DROP TABLE extract_definitions;

ALTER TABLE extract_definitions__optional_ws RENAME TO extract_definitions;

CREATE INDEX idx_extract_definitions_workspace
    ON extract_definitions(workspace_id, updated_at DESC);
