CREATE TABLE workspace_folders (
    id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL REFERENCES users(id),
    parent_id TEXT REFERENCES workspace_folders(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX idx_workspace_folders_owner ON workspace_folders(owner_user_id);
CREATE INDEX idx_workspace_folders_parent ON workspace_folders(parent_id);

ALTER TABLE workspaces ADD COLUMN folder_id TEXT REFERENCES workspace_folders(id) ON DELETE SET NULL;
CREATE INDEX idx_workspaces_folder ON workspaces(folder_id);

DROP INDEX IF EXISTS idx_workspaces_one_home;

UPDATE workspaces SET kind = 'project' WHERE kind != 'project';

ALTER TABLE workspaces DROP COLUMN kind;
ALTER TABLE users DROP COLUMN home_workspace_id;
