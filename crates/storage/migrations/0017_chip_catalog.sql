-- Chip catalog: definitions live in extract_definitions / transforms; chips bind via chip_bindings.
-- Workspaces reference chips through workspace_chips (M:N).

CREATE TABLE extract_definitions (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'database' CHECK (kind IN ('database', 'api')),
    connection_id TEXT NOT NULL REFERENCES connections(id),
    source_json TEXT NOT NULL,
    delimiter TEXT NOT NULL DEFAULT ',',
    header INTEGER NOT NULL DEFAULT 1 CHECK (header IN (0, 1)),
    add_sequence INTEGER NOT NULL DEFAULT 0 CHECK (add_sequence IN (0, 1)),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX idx_extract_definitions_workspace
    ON extract_definitions(workspace_id, updated_at DESC);

CREATE TEMP TABLE _workspace_chip_backfill AS
SELECT workspace_id, id AS chip_id, updated_at AS created_at
FROM chips
WHERE workspace_id IS NOT NULL AND TRIM(workspace_id) != '';

CREATE TABLE chips__catalog (
    id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('extract', 'transform', 'load')),
    config_json TEXT,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

INSERT INTO chips__catalog (
    id, owner_user_id, name, kind, config_json, revision, active, created_at, updated_at
)
SELECT
    c.id,
    COALESCE(w.owner_user_id, (SELECT id FROM users ORDER BY created_at ASC LIMIT 1)),
    c.name,
    c.kind,
    c.config_json,
    c.revision,
    c.active,
    c.created_at,
    c.updated_at
FROM chips c
LEFT JOIN workspaces w ON w.id = c.workspace_id;

DROP TABLE chips;
ALTER TABLE chips__catalog RENAME TO chips;

CREATE INDEX idx_chips_owner ON chips(owner_user_id, updated_at DESC);

CREATE TABLE chip_bindings (
    chip_id TEXT PRIMARY KEY REFERENCES chips(id) ON DELETE CASCADE,
    ref_kind TEXT NOT NULL CHECK (ref_kind IN ('extract_definition', 'transform')),
    ref_id TEXT NOT NULL
);

CREATE INDEX idx_chip_bindings_ref ON chip_bindings(ref_kind, ref_id);

CREATE TABLE workspace_chips (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    chip_id TEXT NOT NULL REFERENCES chips(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, chip_id)
);

CREATE INDEX idx_workspace_chips_chip ON workspace_chips(chip_id);

INSERT INTO workspace_chips (workspace_id, chip_id, created_at)
SELECT workspace_id, chip_id, created_at FROM _workspace_chip_backfill;

DROP TABLE _workspace_chip_backfill;
