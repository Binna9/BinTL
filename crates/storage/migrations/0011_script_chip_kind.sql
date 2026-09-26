-- no-transaction
PRAGMA foreign_keys = OFF;

CREATE TABLE chips_new (
    id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('extract', 'transform', 'load', 'validation', 'sql', 'serve', 'script')),
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
        (kind = 'validation' AND extract_id IS NULL AND transform_id IS NULL AND load_id IS NULL) OR
        (kind = 'sql' AND extract_id IS NULL AND transform_id IS NULL AND load_id IS NULL) OR
        (kind = 'serve' AND extract_id IS NULL AND transform_id IS NULL AND load_id IS NULL) OR
        (kind = 'script' AND extract_id IS NULL AND transform_id IS NULL AND load_id IS NULL)
    )
);
INSERT INTO chips_new SELECT * FROM chips;
DROP TABLE chips;
ALTER TABLE chips_new RENAME TO chips;
CREATE INDEX idx_chips_owner ON chips(owner_user_id, updated_at DESC);
CREATE UNIQUE INDEX uq_chips_owner_name ON chips(owner_user_id, name COLLATE NOCASE);
CREATE INDEX idx_chips_extract ON chips(extract_id);
CREATE INDEX idx_chips_transform ON chips(transform_id);
CREATE INDEX idx_chips_load ON chips(load_id);

CREATE TABLE execution_steps_new (
    id TEXT PRIMARY KEY,
    execution_id TEXT NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
    workspace_chip_id TEXT REFERENCES workspace_chips(id) ON DELETE SET NULL,
    chip_id TEXT REFERENCES chips(id) ON DELETE SET NULL,
    kind TEXT NOT NULL CHECK (kind IN ('extract', 'transform', 'load', 'validation', 'sql', 'serve', 'script')),
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
    dispatch_at TEXT,
    CHECK (
        (kind = 'extract' AND transform_id IS NULL AND load_id IS NULL) OR
        (kind = 'transform' AND extract_id IS NULL AND load_id IS NULL) OR
        (kind = 'load' AND extract_id IS NULL AND transform_id IS NULL) OR
        (kind = 'validation' AND extract_id IS NULL AND transform_id IS NULL AND load_id IS NULL) OR
        (kind = 'sql' AND extract_id IS NULL AND transform_id IS NULL AND load_id IS NULL) OR
        (kind = 'serve' AND extract_id IS NULL AND transform_id IS NULL AND load_id IS NULL) OR
        (kind = 'script' AND extract_id IS NULL AND transform_id IS NULL AND load_id IS NULL)
    )
);
INSERT INTO execution_steps_new SELECT * FROM execution_steps;
DROP TABLE execution_steps;
ALTER TABLE execution_steps_new RENAME TO execution_steps;
CREATE INDEX idx_execution_steps_execution ON execution_steps(execution_id);
CREATE INDEX idx_execution_steps_workspace_chip ON execution_steps(workspace_chip_id, queued_at DESC);
CREATE INDEX idx_execution_steps_status ON execution_steps(status, queued_at);
CREATE INDEX idx_execution_steps_dispatchable ON execution_steps(queued_at) WHERE status = 'queued';

DROP TRIGGER IF EXISTS trg_execution_step_status;
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
