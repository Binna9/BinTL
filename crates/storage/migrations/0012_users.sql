CREATE TABLE users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL COLLATE NOCASE,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'operator', 'analyst', 'viewer')),
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    home_workspace_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_users_username ON users(username);

ALTER TABLE workspaces ADD COLUMN owner_user_id TEXT REFERENCES users(id);
ALTER TABLE workspaces ADD COLUMN kind TEXT NOT NULL DEFAULT 'project';

CREATE INDEX idx_workspaces_owner ON workspaces(owner_user_id);
CREATE UNIQUE INDEX idx_workspaces_one_home
    ON workspaces(owner_user_id)
    WHERE kind = 'home' AND owner_user_id IS NOT NULL;

ALTER TABLE extracts ADD COLUMN workspace_id TEXT NOT NULL
    DEFAULT '00000000-0000-0000-0000-000000000001';
ALTER TABLE jobs ADD COLUMN workspace_id TEXT NOT NULL
    DEFAULT '00000000-0000-0000-0000-000000000001';
ALTER TABLE transforms ADD COLUMN workspace_id TEXT NOT NULL
    DEFAULT '00000000-0000-0000-0000-000000000001';

CREATE INDEX idx_extracts_workspace ON extracts(workspace_id, created_at DESC);
CREATE INDEX idx_jobs_workspace ON jobs(workspace_id, created_at DESC);
CREATE INDEX idx_transforms_workspace ON transforms(workspace_id, updated_at DESC);
