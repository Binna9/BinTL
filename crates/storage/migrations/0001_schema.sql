PRAGMA foreign_keys = ON;

CREATE TABLE users (
    id TEXT PRIMARY KEY,
    userid TEXT NOT NULL COLLATE NOCASE UNIQUE,
    username TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    avatar_path TEXT,
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE roles (
    id TEXT PRIMARY KEY,
    code TEXT NOT NULL COLLATE NOCASE UNIQUE,
    name TEXT NOT NULL,
    description TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE permissions (
    id TEXT PRIMARY KEY,
    code TEXT NOT NULL COLLATE NOCASE UNIQUE,
    name TEXT NOT NULL,
    description TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE user_roles (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    PRIMARY KEY (user_id, role_id)
);
CREATE INDEX idx_user_roles_role ON user_roles(role_id);

CREATE TABLE role_permissions (
    role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    permission_id TEXT NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    PRIMARY KEY (role_id, permission_id)
);
CREATE INDEX idx_role_permissions_permission ON role_permissions(permission_id);

CREATE TABLE connections (
    id TEXT PRIMARY KEY,
    owner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    driver TEXT NOT NULL,
    host TEXT NOT NULL,
    port INTEGER NOT NULL,
    database_name TEXT NOT NULL,
    username TEXT NOT NULL,
    password_cipher TEXT NOT NULL,
    ssl INTEGER NOT NULL DEFAULT 0 CHECK (ssl IN (0, 1)),
    options_json TEXT NOT NULL DEFAULT '{}',
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

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
CREATE UNIQUE INDEX idx_workspace_folders_sibling_name
    ON workspace_folders(owner_user_id, ifnull(parent_id, ''), name COLLATE NOCASE);

CREATE TABLE workspaces (
    id TEXT PRIMARY KEY,
    owner_user_id TEXT REFERENCES users(id),
    folder_id TEXT REFERENCES workspace_folders(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    description TEXT,
    viewport_json TEXT NOT NULL DEFAULT '{}',
    version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX idx_workspaces_owner ON workspaces(owner_user_id);
CREATE INDEX idx_workspaces_folder ON workspaces(folder_id);

CREATE TABLE extracts (
    id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    source_type TEXT NOT NULL CHECK (source_type IN ('database', 'api')),
    connection_id TEXT NOT NULL REFERENCES connections(id),
    source_json TEXT NOT NULL,
    output_format TEXT NOT NULL DEFAULT 'csv',
    output_filename TEXT NOT NULL,
    delimiter TEXT,
    has_header INTEGER CHECK (has_header IN (0, 1)),
    add_sequence INTEGER NOT NULL DEFAULT 0 CHECK (add_sequence IN (0, 1)),
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX idx_extracts_owner ON extracts(owner_user_id, updated_at DESC);
CREATE INDEX idx_extracts_connection ON extracts(connection_id);

CREATE TABLE data_schemas (
    id TEXT PRIMARY KEY,
    fingerprint TEXT NOT NULL UNIQUE,
    columns_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE data_files (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    schema_id TEXT REFERENCES data_schemas(id) ON DELETE SET NULL,
    kind TEXT NOT NULL CHECK (kind IN ('upload', 'database', 'api', 'transform', 'load')),
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
CREATE INDEX idx_data_files_workspace ON data_files(workspace_id, created_at DESC);
CREATE INDEX idx_data_files_schema ON data_files(schema_id);

CREATE TABLE transforms (
    id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    default_input_file_id TEXT REFERENCES data_files(id) ON DELETE SET NULL,
    spec_json TEXT NOT NULL,
    output_format TEXT NOT NULL DEFAULT 'parquet',
    output_filename_template TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX idx_transforms_owner ON transforms(owner_user_id, updated_at DESC);
CREATE INDEX idx_transforms_default_input ON transforms(default_input_file_id);

CREATE TABLE loads (
    id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    default_input_file_id TEXT REFERENCES data_files(id) ON DELETE SET NULL,
    destination_type TEXT NOT NULL CHECK (destination_type IN ('database', 'file')),
    connection_id TEXT REFERENCES connections(id),
    destination_json TEXT NOT NULL,
    write_mode TEXT NOT NULL CHECK (write_mode IN ('append', 'truncate', 'replace', 'recreate', 'upsert')),
    batch_size INTEGER NOT NULL DEFAULT 5000 CHECK (batch_size > 0),
    conflict_keys_json TEXT NOT NULL DEFAULT '[]',
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK ((destination_type = 'database' AND connection_id IS NOT NULL) OR destination_type = 'file')
);
CREATE INDEX idx_loads_owner ON loads(owner_user_id, updated_at DESC);
CREATE INDEX idx_loads_connection ON loads(connection_id);
CREATE INDEX idx_loads_default_input ON loads(default_input_file_id);

CREATE TABLE validation_rules (
    id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    keys_json TEXT NOT NULL DEFAULT '[]',
    columns_json TEXT NOT NULL DEFAULT '[]',
    compare_row_count INTEGER NOT NULL DEFAULT 1 CHECK (compare_row_count IN (0, 1)),
    compare_schema INTEGER NOT NULL DEFAULT 1 CHECK (compare_schema IN (0, 1)),
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX idx_validation_rules_owner ON validation_rules(owner_user_id, updated_at DESC);

CREATE TABLE chips (
    id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('extract', 'transform', 'load', 'validation')),
    extract_id TEXT REFERENCES extracts(id) ON DELETE RESTRICT,
    transform_id TEXT REFERENCES transforms(id) ON DELETE RESTRICT,
    load_id TEXT REFERENCES loads(id) ON DELETE RESTRICT,
    config_json TEXT,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (
        (kind = 'extract' AND transform_id IS NULL AND load_id IS NULL) OR
        (kind = 'transform' AND extract_id IS NULL AND load_id IS NULL) OR
        (kind = 'load' AND extract_id IS NULL AND transform_id IS NULL) OR
        (kind = 'validation' AND extract_id IS NULL AND transform_id IS NULL AND load_id IS NULL)
    )
);
CREATE INDEX idx_chips_owner ON chips(owner_user_id, updated_at DESC);
CREATE UNIQUE INDEX uq_chips_owner_name ON chips(owner_user_id, name COLLATE NOCASE);
CREATE INDEX idx_chips_extract ON chips(extract_id);
CREATE INDEX idx_chips_transform ON chips(transform_id);
CREATE INDEX idx_chips_load ON chips(load_id);

CREATE TABLE workspace_chips (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    chip_id TEXT NOT NULL REFERENCES chips(id) ON DELETE CASCADE,
    x REAL NOT NULL DEFAULT 0,
    y REAL NOT NULL DEFAULT 0,
    width REAL,
    height REAL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX idx_workspace_chips_workspace ON workspace_chips(workspace_id);
CREATE INDEX idx_workspace_chips_chip ON workspace_chips(chip_id);

CREATE TABLE workspace_edges (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    from_workspace_chip_id TEXT NOT NULL REFERENCES workspace_chips(id) ON DELETE CASCADE,
    from_port TEXT NOT NULL DEFAULT 'out',
    to_workspace_chip_id TEXT NOT NULL REFERENCES workspace_chips(id) ON DELETE CASCADE,
    to_port TEXT NOT NULL DEFAULT 'in',
    kind TEXT NOT NULL CHECK (kind IN ('data', 'on_success', 'on_error', 'always')),
    created_at TEXT NOT NULL,
    CHECK (from_workspace_chip_id != to_workspace_chip_id),
    UNIQUE (workspace_id, from_workspace_chip_id, to_workspace_chip_id, kind, from_port, to_port)
);
CREATE INDEX idx_workspace_edges_from ON workspace_edges(workspace_id, from_workspace_chip_id);
CREATE INDEX idx_workspace_edges_to ON workspace_edges(workspace_id, to_workspace_chip_id);

CREATE TABLE workspace_revisions (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    version INTEGER NOT NULL CHECK (version > 0),
    snapshot_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, version)
);

CREATE TABLE workspace_chip_outputs (
    workspace_chip_id TEXT NOT NULL REFERENCES workspace_chips(id) ON DELETE CASCADE,
    port_name TEXT NOT NULL DEFAULT 'out',
    schema_id TEXT REFERENCES data_schemas(id) ON DELETE SET NULL,
    current_data_file_id TEXT REFERENCES data_files(id) ON DELETE SET NULL,
    expected_filename TEXT NOT NULL,
    definition_revision INTEGER NOT NULL DEFAULT 1 CHECK (definition_revision > 0),
    updated_at TEXT NOT NULL,
    PRIMARY KEY (workspace_chip_id, port_name)
);
CREATE INDEX idx_workspace_chip_outputs_file ON workspace_chip_outputs(current_data_file_id);

CREATE TABLE executions (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    requested_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    source TEXT NOT NULL CHECK (source IN ('extract_page', 'transform_page', 'load_page', 'chip', 'workspace')),
    trigger_id TEXT,
    status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'canceled')),
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    error_message TEXT
);
CREATE INDEX idx_executions_workspace ON executions(workspace_id, created_at DESC);
CREATE INDEX idx_executions_status ON executions(status, created_at);

CREATE TABLE execution_steps (
    id TEXT PRIMARY KEY,
    execution_id TEXT NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
    workspace_chip_id TEXT REFERENCES workspace_chips(id) ON DELETE SET NULL,
    chip_id TEXT REFERENCES chips(id) ON DELETE SET NULL,
    kind TEXT NOT NULL CHECK (kind IN ('extract', 'transform', 'load', 'validation')),
    extract_id TEXT REFERENCES extracts(id) ON DELETE SET NULL,
    transform_id TEXT REFERENCES transforms(id) ON DELETE SET NULL,
    load_id TEXT REFERENCES loads(id) ON DELETE SET NULL,
    definition_revision INTEGER NOT NULL CHECK (definition_revision > 0),
    definition_snapshot_json TEXT NOT NULL,
    source_path TEXT,
    output_path TEXT,
    status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'canceled')),
    input_rows INTEGER,
    output_rows INTEGER,
    rejected_rows INTEGER,
    input_bytes INTEGER,
    output_bytes INTEGER,
    result_json TEXT,
    error_code TEXT,
    error_message TEXT,
    queued_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    CHECK (
        (kind = 'extract' AND transform_id IS NULL AND load_id IS NULL) OR
        (kind = 'transform' AND extract_id IS NULL AND load_id IS NULL) OR
        (kind = 'load' AND extract_id IS NULL AND transform_id IS NULL) OR
        (kind = 'validation' AND extract_id IS NULL AND transform_id IS NULL AND load_id IS NULL)
    )
);
CREATE INDEX idx_execution_steps_execution ON execution_steps(execution_id);
CREATE INDEX idx_execution_steps_workspace_chip ON execution_steps(workspace_chip_id, queued_at DESC);
CREATE INDEX idx_execution_steps_status ON execution_steps(status, queued_at);

CREATE TABLE validation_results (
    id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL REFERENCES users(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    validation_rule_id TEXT REFERENCES validation_rules(id) ON DELETE SET NULL,
    execution_step_id TEXT REFERENCES execution_steps(id) ON DELETE CASCADE,
    source_data_file_id TEXT NOT NULL REFERENCES data_files(id) ON DELETE RESTRICT,
    target_data_file_id TEXT NOT NULL REFERENCES data_files(id) ON DELETE RESTRICT,
    passed INTEGER NOT NULL CHECK (passed IN (0, 1)),
    report_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX idx_validation_results_workspace ON validation_results(workspace_id, created_at DESC);
CREATE INDEX idx_validation_results_rule ON validation_results(validation_rule_id, created_at DESC);
CREATE UNIQUE INDEX idx_validation_results_step ON validation_results(execution_step_id) WHERE execution_step_id IS NOT NULL;

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
    WHERE id = NEW.execution_id;
END;

CREATE TABLE execution_inputs (
    execution_step_id TEXT NOT NULL REFERENCES execution_steps(id) ON DELETE CASCADE,
    port_name TEXT NOT NULL,
    data_file_id TEXT NOT NULL REFERENCES data_files(id) ON DELETE RESTRICT,
    ordinal INTEGER NOT NULL DEFAULT 0 CHECK (ordinal >= 0),
    PRIMARY KEY (execution_step_id, port_name, ordinal)
);
CREATE INDEX idx_execution_inputs_file ON execution_inputs(data_file_id);

CREATE TABLE execution_outputs (
    execution_step_id TEXT NOT NULL REFERENCES execution_steps(id) ON DELETE CASCADE,
    port_name TEXT NOT NULL,
    data_file_id TEXT NOT NULL REFERENCES data_files(id) ON DELETE RESTRICT,
    PRIMARY KEY (execution_step_id, port_name)
);
CREATE INDEX idx_execution_outputs_file ON execution_outputs(data_file_id);

CREATE TABLE execution_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    execution_step_id TEXT NOT NULL REFERENCES execution_steps(id) ON DELETE CASCADE,
    sequence INTEGER NOT NULL CHECK (sequence > 0),
    level TEXT NOT NULL,
    event_type TEXT NOT NULL DEFAULT 'message',
    message TEXT NOT NULL,
    context_json TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (execution_step_id, sequence)
);
CREATE INDEX idx_execution_logs_step ON execution_logs(execution_step_id, sequence);

CREATE TABLE search_documents (
    id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL CHECK (entity_type IN ('workspace_folder', 'workspace', 'chip', 'connection', 'extract', 'transform', 'load', 'data_file')),
    entity_id TEXT NOT NULL,
    title TEXT NOT NULL,
    subtitle TEXT NOT NULL DEFAULT '',
    keywords TEXT NOT NULL DEFAULT '',
    route TEXT NOT NULL,
    scope TEXT NOT NULL CHECK (scope IN ('global', 'workspace', 'user')),
    workspace_id TEXT,
    owner_user_id TEXT,
    updated_at TEXT NOT NULL,
    UNIQUE (entity_type, entity_id)
);
CREATE INDEX idx_search_documents_updated ON search_documents(updated_at DESC);
CREATE INDEX idx_search_documents_scope ON search_documents(scope, owner_user_id, workspace_id);

CREATE TABLE search_recent_queries (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    query TEXT NOT NULL,
    searched_at TEXT NOT NULL,
    UNIQUE (user_id, query COLLATE NOCASE)
);
CREATE INDEX idx_search_recent_user_time ON search_recent_queries(user_id, searched_at DESC);

INSERT INTO roles (id, code, name, description, created_at, updated_at) VALUES
 ('00000000-0000-0000-0000-0000000000a1','admin','관리자','전체 관리','2026-08-27T00:00:00Z','2026-08-27T00:00:00Z'),
 ('00000000-0000-0000-0000-0000000000a2','operator','운영자','작업 및 커넥션 관리','2026-08-27T00:00:00Z','2026-08-27T00:00:00Z'),
 ('00000000-0000-0000-0000-0000000000a3','analyst','분석가','추출 및 변환 작업','2026-08-27T00:00:00Z','2026-08-27T00:00:00Z'),
 ('00000000-0000-0000-0000-0000000000a4','viewer','조회 전용','데이터 조회','2026-08-27T00:00:00Z','2026-08-27T00:00:00Z');

INSERT INTO permissions (id, code, name, description, created_at, updated_at) VALUES
 ('00000000-0000-0000-0000-0000000000b1','USER_MANAGE','사용자 관리','사용자 추가·수정','2026-08-27T00:00:00Z','2026-08-27T00:00:00Z'),
 ('00000000-0000-0000-0000-0000000000b2','CONNECTION_WRITE','커넥션 쓰기','커넥션 등록·수정','2026-08-27T00:00:00Z','2026-08-27T00:00:00Z'),
 ('00000000-0000-0000-0000-0000000000b3','WORKSPACE_ALL','전체 작업 공간','모든 작업 공간 조회·수정','2026-08-27T00:00:00Z','2026-08-27T00:00:00Z'),
 ('00000000-0000-0000-0000-0000000000b4','WORKSPACE_OWN','자기 작업 공간','소유 작업 공간 조회·수정','2026-08-27T00:00:00Z','2026-08-27T00:00:00Z'),
 ('00000000-0000-0000-0000-0000000000b5','EXTRACT_RUN','추출 실행','추출 실행','2026-08-27T00:00:00Z','2026-08-27T00:00:00Z'),
 ('00000000-0000-0000-0000-0000000000b6','TRANSFORM_RUN','변환 실행','변환 실행','2026-08-27T00:00:00Z','2026-08-27T00:00:00Z'),
 ('00000000-0000-0000-0000-0000000000b7','DATASET_READ','데이터 파일 조회','데이터 파일 조회','2026-08-27T00:00:00Z','2026-08-27T00:00:00Z');

INSERT INTO role_permissions (role_id, permission_id, created_at)
SELECT r.id, p.id, '2026-08-27T00:00:00Z'
FROM roles r CROSS JOIN permissions p
WHERE r.code = 'admin'
   OR (r.code = 'operator' AND p.code IN ('CONNECTION_WRITE','WORKSPACE_OWN','EXTRACT_RUN','TRANSFORM_RUN','DATASET_READ'))
   OR (r.code = 'analyst' AND p.code IN ('WORKSPACE_OWN','EXTRACT_RUN','TRANSFORM_RUN','DATASET_READ'))
   OR (r.code = 'viewer' AND p.code IN ('WORKSPACE_OWN','DATASET_READ'));

INSERT INTO workspaces
    (id, owner_user_id, folder_id, name, description, viewport_json, version, created_at, updated_at)
VALUES
    ('00000000-0000-0000-0000-000000000001', NULL, NULL, '기본 Workspace', NULL, '{}', 1,
     strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
