DROP INDEX IF EXISTS uq_chips_owner_name;
CREATE UNIQUE INDEX uq_chips_owner_name ON chips(owner_user_id, name COLLATE NOCASE)
WHERE kind != 'memo';
