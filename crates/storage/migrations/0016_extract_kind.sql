-- Extract source kind: database | api (disk: extracts/databases, extracts/api).
ALTER TABLE extracts ADD COLUMN kind TEXT NOT NULL DEFAULT 'database';

UPDATE extracts
SET kind = 'api'
WHERE stored_path LIKE 'extracts/api/%';
