-- Earlier output-slot upserts could leave the reused data_files row soft-deleted.
-- A workspace output slot is authoritative: its current file must be visible.
UPDATE data_files
SET deleted_at = NULL,
    updated_at = COALESCE(updated_at, created_at)
WHERE deleted_at IS NOT NULL
  AND id IN (
    SELECT current_data_file_id
    FROM workspace_chip_outputs
    WHERE current_data_file_id IS NOT NULL
  );
