-- Replace `then` with on_success / always. Keep data + on_error.
-- Existing `then` edges were order-only (no dataset) → migrate to `always`.

CREATE TABLE chip_edges__kinds (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    from_chip_id TEXT NOT NULL REFERENCES chips(id),
    to_chip_id TEXT NOT NULL REFERENCES chips(id),
    kind TEXT NOT NULL CHECK (kind IN ('data', 'on_success', 'on_error', 'always')),
    from_port TEXT NOT NULL DEFAULT 'out',
    to_port TEXT NOT NULL DEFAULT 'in',
    created_at TEXT NOT NULL,
    CHECK (from_chip_id != to_chip_id)
);

INSERT INTO chip_edges__kinds (
    id, workspace_id, from_chip_id, to_chip_id, kind, from_port, to_port, created_at
)
SELECT
    id,
    workspace_id,
    from_chip_id,
    to_chip_id,
    CASE kind WHEN 'then' THEN 'always' ELSE kind END,
    from_port,
    to_port,
    created_at
FROM chip_edges;

DROP TABLE chip_edges;
ALTER TABLE chip_edges__kinds RENAME TO chip_edges;

CREATE UNIQUE INDEX idx_chip_edges_unique
    ON chip_edges(workspace_id, from_chip_id, to_chip_id, kind);
CREATE INDEX idx_chip_edges_workspace ON chip_edges(workspace_id);
