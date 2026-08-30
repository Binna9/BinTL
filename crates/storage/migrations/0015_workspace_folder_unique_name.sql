-- Rename any pre-existing sibling duplicates, then enforce uniqueness.
UPDATE workspace_folders
SET name = name || ' (' || substr(id, 1, 8) || ')'
WHERE id IN (
  SELECT id FROM (
    SELECT id,
           row_number() OVER (
             PARTITION BY owner_user_id, ifnull(parent_id, ''), lower(name)
             ORDER BY created_at ASC, id ASC
           ) AS rn
    FROM workspace_folders
  ) ranked
  WHERE rn > 1
);

CREATE UNIQUE INDEX idx_workspace_folders_sibling_name
ON workspace_folders (owner_user_id, ifnull(parent_id, ''), name COLLATE NOCASE);
