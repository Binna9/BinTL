CREATE TABLE extracts (
    id TEXT PRIMARY KEY,
    connection_id TEXT NOT NULL,
    table_name TEXT NOT NULL,
    delimiter TEXT NOT NULL,
    header INTEGER NOT NULL,
    status TEXT NOT NULL,
    stored_path TEXT,
    filename TEXT,
    row_count INTEGER,
    error_message TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT
);
