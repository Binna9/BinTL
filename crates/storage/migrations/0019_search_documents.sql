CREATE TABLE search_documents (
    id            TEXT PRIMARY KEY,
    entity_type   TEXT NOT NULL,
    entity_id     TEXT NOT NULL,
    title         TEXT NOT NULL,
    subtitle      TEXT NOT NULL DEFAULT '',
    keywords      TEXT NOT NULL DEFAULT '',
    route         TEXT NOT NULL,
    scope         TEXT NOT NULL CHECK (scope IN ('global', 'workspace', 'user')),
    workspace_id  TEXT,
    owner_user_id TEXT,
    updated_at    TEXT NOT NULL,
    UNIQUE (entity_type, entity_id)
);

CREATE INDEX idx_search_documents_updated ON search_documents(updated_at DESC);
CREATE INDEX idx_search_documents_scope ON search_documents(scope, owner_user_id, workspace_id);

-- workspace folders
INSERT INTO search_documents (
    id, entity_type, entity_id, title, subtitle, keywords, route, scope, workspace_id, owner_user_id, updated_at
)
SELECT
    'workspace_folder:' || f.id,
    'workspace_folder',
    f.id,
    f.name,
    '작업구분',
    lower(f.name),
    '/workspace',
    'user',
    NULL,
    f.owner_user_id,
    f.updated_at
FROM workspace_folders f;

-- workspaces
INSERT INTO search_documents (
    id, entity_type, entity_id, title, subtitle, keywords, route, scope, workspace_id, owner_user_id, updated_at
)
SELECT
    'workspace:' || w.id,
    'workspace',
    w.id,
    w.name,
    '워크스페이스',
    lower(trim(coalesce(w.name, '') || ' ' || coalesce(w.description, ''))),
    '/workspace/' || w.id,
    'workspace',
    w.id,
    w.owner_user_id,
    w.updated_at
FROM workspaces w;

-- chips
INSERT INTO search_documents (
    id, entity_type, entity_id, title, subtitle, keywords, route, scope, workspace_id, owner_user_id, updated_at
)
SELECT
    'chip:' || c.id,
    'chip',
    c.id,
    c.name,
    CASE c.kind
        WHEN 'extract' THEN '칩 · 추출'
        WHEN 'transform' THEN '칩 · 변환'
        ELSE '칩 · 적재'
    END,
    lower(trim(c.name || ' ' || c.kind)),
    '/chips',
    'user',
    NULL,
    c.owner_user_id,
    c.updated_at
FROM chips c;

-- datasets
INSERT INTO search_documents (
    id, entity_type, entity_id, title, subtitle, keywords, route, scope, workspace_id, owner_user_id, updated_at
)
SELECT
    'dataset:' || d.id,
    'dataset',
    d.id,
    d.filename,
    CASE d.kind
        WHEN 'upload' THEN '파일 · 업로드'
        WHEN 'database' THEN '파일 · DB 추출'
        WHEN 'api' THEN '파일 · API'
        WHEN 'transform' THEN '파일 · 변환'
        ELSE '파일'
    END,
    lower(trim(coalesce(d.filename, '') || ' ' || coalesce(d.stored_path, '') || ' ' || coalesce(d.kind, ''))),
    CASE WHEN d.kind = 'upload' THEN '/files' ELSE '/transform/clean' END,
    'workspace',
    d.workspace_id,
    NULL,
    d.updated_at
FROM datasets d;

-- connections
INSERT INTO search_documents (
    id, entity_type, entity_id, title, subtitle, keywords, route, scope, workspace_id, owner_user_id, updated_at
)
SELECT
    'connection:' || c.id,
    'connection',
    c.id,
    c.name,
    '커넥션 · ' || c.driver,
    lower(trim(
        coalesce(c.name, '') || ' ' ||
        coalesce(c.driver, '') || ' ' ||
        coalesce(c.host, '') || ' ' ||
        coalesce(c.database_name, '') || ' ' ||
        coalesce(c.username, '')
    )),
    '/connections',
    'global',
    NULL,
    NULL,
    c.created_at
FROM connections c;

-- extracts
INSERT INTO search_documents (
    id, entity_type, entity_id, title, subtitle, keywords, route, scope, workspace_id, owner_user_id, updated_at
)
SELECT
    'extract:' || e.id,
    'extract',
    e.id,
    coalesce(nullif(trim(e.filename), ''), nullif(trim(e.table_name), ''), 'extract'),
    '추출 파일',
    lower(trim(
        coalesce(e.filename, '') || ' ' ||
        coalesce(e.table_name, '') || ' ' ||
        coalesce(e.sql_text, '') || ' ' ||
        coalesce(e.kind, '')
    )),
    '/extracts',
    'workspace',
    e.workspace_id,
    NULL,
    coalesce(e.finished_at, e.created_at)
FROM extracts e;

-- transforms
INSERT INTO search_documents (
    id, entity_type, entity_id, title, subtitle, keywords, route, scope, workspace_id, owner_user_id, updated_at
)
SELECT
    'transform:' || t.id,
    'transform',
    t.id,
    t.name,
    '변환 정의',
    lower(trim(coalesce(t.name, '') || ' ' || coalesce(d.filename, ''))),
    '/transform/clean/' || t.id,
    'workspace',
    t.workspace_id,
    NULL,
    t.updated_at
FROM transforms t
LEFT JOIN datasets d ON d.id = t.dataset_id;
