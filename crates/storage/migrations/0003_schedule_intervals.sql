DROP INDEX IF EXISTS idx_workspace_schedules_due;
DROP INDEX IF EXISTS idx_workspace_schedules_workspace;
ALTER TABLE workspace_schedules RENAME TO workspace_schedules_legacy;

CREATE TABLE workspace_schedules (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    schedule_type TEXT NOT NULL DEFAULT 'interval' CHECK (schedule_type = 'interval'),
    interval_value INTEGER NOT NULL DEFAULT 1 CHECK (interval_value >= 1),
    interval_unit TEXT NOT NULL CHECK (interval_unit IN ('second', 'minute', 'hour', 'day', 'month', 'year')),
    second INTEGER,
    hour INTEGER,
    minute INTEGER,
    day_of_month INTEGER,
    month_of_year INTEGER,
    timezone TEXT NOT NULL DEFAULT 'Asia/Seoul',
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    next_run_at TEXT NOT NULL,
    last_run_at TEXT,
    last_status TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (second IS NULL OR second BETWEEN 0 AND 59),
    CHECK (hour IS NULL OR hour BETWEEN 0 AND 23),
    CHECK (minute IS NULL OR minute BETWEEN 0 AND 59),
    CHECK (day_of_month IS NULL OR day_of_month BETWEEN 1 AND 31),
    CHECK (month_of_year IS NULL OR month_of_year BETWEEN 1 AND 12)
);

INSERT INTO workspace_schedules
    (id, workspace_id, owner_user_id, name, schedule_type, interval_value, interval_unit,
     second, hour, minute, day_of_month, month_of_year, timezone, enabled, next_run_at,
     last_run_at, last_status, created_at, updated_at)
SELECT id, workspace_id, owner_user_id, name, 'interval',
       CASE WHEN schedule_type = 'interval' THEN MAX(COALESCE(interval_seconds, 1), 1) ELSE 1 END,
       CASE schedule_type WHEN 'daily' THEN 'day' WHEN 'monthly' THEN 'month' ELSE 'second' END,
       0, hour, minute, day_of_month, NULL, timezone, enabled, next_run_at,
       last_run_at, last_status, created_at, updated_at
FROM workspace_schedules_legacy;

DROP TABLE workspace_schedules_legacy;
CREATE INDEX idx_workspace_schedules_due ON workspace_schedules(enabled, next_run_at);
CREATE INDEX idx_workspace_schedules_workspace ON workspace_schedules(workspace_id, updated_at DESC);
