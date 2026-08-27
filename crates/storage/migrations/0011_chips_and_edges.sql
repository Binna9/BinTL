DROP INDEX IF EXISTS idx_task_definitions_workspace;
DROP INDEX IF EXISTS idx_task_runs_workspace;
DROP INDEX IF EXISTS idx_task_runs_task;
DROP INDEX IF EXISTS idx_task_runs_extract;
DROP INDEX IF EXISTS idx_task_runs_job;
DROP INDEX IF EXISTS idx_datasets_producer;

ALTER TABLE task_definitions RENAME TO chips;
ALTER TABLE task_runs RENAME TO chip_runs;
ALTER TABLE chip_runs RENAME COLUMN task_id TO chip_id;
ALTER TABLE datasets RENAME COLUMN producer_task_run_id TO producer_chip_run_id;

CREATE INDEX idx_chips_workspace ON chips(workspace_id, updated_at DESC);
CREATE INDEX idx_chip_runs_workspace ON chip_runs(workspace_id, created_at DESC);
CREATE INDEX idx_chip_runs_chip ON chip_runs(chip_id, created_at DESC);
CREATE UNIQUE INDEX idx_chip_runs_extract
    ON chip_runs(legacy_extract_id) WHERE legacy_extract_id IS NOT NULL;
CREATE UNIQUE INDEX idx_chip_runs_job
    ON chip_runs(legacy_job_id) WHERE legacy_job_id IS NOT NULL;
CREATE INDEX idx_datasets_producer ON datasets(producer_chip_run_id);

CREATE TABLE chip_edges (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    from_chip_id TEXT NOT NULL REFERENCES chips(id),
    to_chip_id TEXT NOT NULL REFERENCES chips(id),
    kind TEXT NOT NULL CHECK (kind IN ('data', 'then', 'on_error')),
    from_port TEXT NOT NULL DEFAULT 'out',
    to_port TEXT NOT NULL DEFAULT 'in',
    created_at TEXT NOT NULL,
    CHECK (from_chip_id != to_chip_id)
);

CREATE UNIQUE INDEX idx_chip_edges_pair_kind
    ON chip_edges(workspace_id, from_chip_id, to_chip_id, kind);
CREATE INDEX idx_chip_edges_workspace ON chip_edges(workspace_id);
CREATE INDEX idx_chip_edges_from ON chip_edges(from_chip_id);
CREATE INDEX idx_chip_edges_to ON chip_edges(to_chip_id);
