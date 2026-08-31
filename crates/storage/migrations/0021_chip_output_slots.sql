-- Stable workspace artifact slot per placed chip (re-run overwrites).
CREATE TABLE chip_output_slots (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  chip_id TEXT NOT NULL REFERENCES chips(id) ON DELETE CASCADE,
  dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, chip_id),
  UNIQUE (dataset_id)
);

CREATE INDEX idx_chip_output_slots_dataset ON chip_output_slots(dataset_id);

-- Optional user-chosen name for one-off DB exports (not chip runs).
ALTER TABLE extracts ADD COLUMN output_filename TEXT;
