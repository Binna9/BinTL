CREATE TABLE workspace_schedules (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    schedule_type TEXT NOT NULL CHECK (schedule_type IN ('interval', 'daily', 'monthly')),
    interval_seconds INTEGER,
    hour INTEGER,
    minute INTEGER,
    day_of_month INTEGER,
    timezone TEXT NOT NULL DEFAULT 'Asia/Seoul',
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    next_run_at TEXT NOT NULL,
    last_run_at TEXT,
    last_status TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (interval_seconds IS NULL OR interval_seconds >= 1),
    CHECK (hour IS NULL OR hour BETWEEN 0 AND 23),
    CHECK (minute IS NULL OR minute BETWEEN 0 AND 59),
    CHECK (day_of_month IS NULL OR day_of_month BETWEEN 1 AND 31)
);
CREATE INDEX idx_workspace_schedules_due ON workspace_schedules(enabled, next_run_at);
CREATE INDEX idx_workspace_schedules_workspace ON workspace_schedules(workspace_id, updated_at DESC);
