DELETE FROM workspace_chips
WHERE rowid NOT IN (
    SELECT MIN(rowid) FROM workspace_chips GROUP BY workspace_id, chip_id
);

CREATE UNIQUE INDEX uq_workspace_chips_placement
    ON workspace_chips(workspace_id, chip_id);

DELETE FROM workspace_schedules
WHERE rowid NOT IN (
    SELECT MIN(rowid) FROM workspace_schedules GROUP BY lower(trim(name))
);

CREATE UNIQUE INDEX uq_workspace_schedules_name
    ON workspace_schedules(lower(trim(name)));
