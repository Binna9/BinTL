-- Planned input datasets: schema slots for transform design before extract runs.
-- status=planned rows have no real file; stored_path uses a unique placeholder.

ALTER TABLE datasets ADD COLUMN status TEXT NOT NULL DEFAULT 'materialized';
ALTER TABLE datasets ADD COLUMN source_chip_id TEXT;
ALTER TABLE datasets ADD COLUMN consumer_chip_id TEXT;
ALTER TABLE datasets ADD COLUMN source_extract_definition_id TEXT;

ALTER TABLE transforms ADD COLUMN input_chip_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_datasets_planned_consumer
  ON datasets(workspace_id, consumer_chip_id)
  WHERE status = 'planned' AND consumer_chip_id IS NOT NULL;
