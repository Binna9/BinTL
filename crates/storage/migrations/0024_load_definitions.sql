CREATE TABLE load_definitions (
    id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    destination_type TEXT NOT NULL CHECK (destination_type IN ('database', 'file')),
    spec_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX idx_load_definitions_owner
    ON load_definitions(owner_user_id, updated_at DESC);

CREATE TABLE load_results (
    chip_run_id TEXT PRIMARY KEY REFERENCES chip_runs(id) ON DELETE CASCADE,
    destination TEXT NOT NULL,
    write_mode TEXT NOT NULL,
    input_rows INTEGER,
    loaded_rows INTEGER NOT NULL DEFAULT 0,
    rejected_rows INTEGER NOT NULL DEFAULT 0,
    input_bytes INTEGER,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    artifact_path TEXT,
    validation_status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL
);

CREATE TABLE chip_bindings__load (
    chip_id TEXT PRIMARY KEY REFERENCES chips(id) ON DELETE CASCADE,
    ref_kind TEXT NOT NULL CHECK (ref_kind IN ('extract_definition', 'transform', 'load_definition')),
    ref_id TEXT NOT NULL
);

INSERT INTO chip_bindings__load (chip_id, ref_kind, ref_id)
SELECT chip_id, ref_kind, ref_id FROM chip_bindings;

DROP TABLE chip_bindings;
ALTER TABLE chip_bindings__load RENAME TO chip_bindings;
CREATE INDEX idx_chip_bindings_ref ON chip_bindings(ref_kind, ref_id);
