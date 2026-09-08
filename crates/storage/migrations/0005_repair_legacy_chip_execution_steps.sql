-- Some older canvas extract runs only recorded the chip id on executions.trigger_id.
-- Repair their step identity so file cleanup and run-history queries classify them as
-- canvas runs instead of standalone extraction-page runs.
UPDATE execution_steps
SET chip_id = (
  SELECT executions.trigger_id
  FROM executions
  WHERE executions.id = execution_steps.execution_id
)
WHERE chip_id IS NULL
  AND EXISTS (
    SELECT 1
    FROM executions
    INNER JOIN chips ON chips.id = executions.trigger_id
    WHERE executions.id = execution_steps.execution_id
      AND executions.source = 'chip'
      AND executions.trigger_id IS NOT NULL
  );

UPDATE execution_steps
SET workspace_chip_id = (
  SELECT workspace_chips.id
  FROM executions
  INNER JOIN workspace_chips
    ON workspace_chips.workspace_id = executions.workspace_id
   AND workspace_chips.chip_id = execution_steps.chip_id
  WHERE executions.id = execution_steps.execution_id
  LIMIT 1
)
WHERE workspace_chip_id IS NULL
  AND chip_id IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM executions
    INNER JOIN workspace_chips
      ON workspace_chips.workspace_id = executions.workspace_id
     AND workspace_chips.chip_id = execution_steps.chip_id
    WHERE executions.id = execution_steps.execution_id
  );
