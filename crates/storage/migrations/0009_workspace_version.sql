ALTER TABLE workspaces ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0);

CREATE TABLE workspace_revisions (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    version INTEGER NOT NULL CHECK (version > 0),
    snapshot_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, version)
);
