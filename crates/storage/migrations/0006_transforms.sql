CREATE TABLE datasets (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('upload', 'database', 'api')),
    extract_id TEXT,
    filename TEXT NOT NULL,
    stored_path TEXT NOT NULL UNIQUE,
    size_bytes INTEGER,
    delimiter TEXT,
    has_header INTEGER,
    columns_json TEXT,
    row_count INTEGER,
    inspected_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE transforms (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    dataset_id TEXT NOT NULL REFERENCES datasets(id),
    spec_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

ALTER TABLE jobs ADD COLUMN kind TEXT NOT NULL DEFAULT 'transform';
ALTER TABLE jobs ADD COLUMN transform_id TEXT;
ALTER TABLE jobs ADD COLUMN dataset_id TEXT;
