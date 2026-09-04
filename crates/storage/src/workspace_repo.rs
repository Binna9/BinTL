use crate::models::*;
use crate::*;

impl Store {
    pub async fn list_workspaces(&self) -> Result<Vec<WorkspaceRow>, StorageError> {
        self.list_visible_workspaces(None).await
    }

    pub async fn list_visible_workspaces(
        &self,
        scope: Option<&DataScope>,
    ) -> Result<Vec<WorkspaceRow>, StorageError> {
        let mut extra = String::new();
        let mut binds: Vec<String> = Vec::new();
        if let Some(scope) = scope {
            if !scope.admin {
                extra.push_str(" WHERE owner_user_id = ?");
                binds.push(scope.user_id.clone());
            }
        }
        extra.push_str(" ORDER BY updated_at DESC, created_at ASC");
        let sql = format!("SELECT {WORKSPACE_COLS} FROM workspaces{extra}");
        let mut query = sqlx::query_as::<_, WorkspaceRow>(&sql);
        for value in &binds {
            query = query.bind(value);
        }
        Ok(query.fetch_all(&self.pool).await?)
    }

    pub async fn get_workspace(&self, id: &str) -> Result<Option<WorkspaceRow>, StorageError> {
        Ok(sqlx::query_as::<_, WorkspaceRow>(&format!(
            "SELECT {WORKSPACE_COLS} FROM workspaces WHERE id = ?"
        ))
        .bind(id)
        .fetch_optional(&self.pool)
        .await?)
    }

    pub async fn insert_workspace(
        &self,
        name: &str,
        description: Option<&str>,
        owner_user_id: &str,
        folder_id: Option<&str>,
    ) -> Result<WorkspaceRow, StorageError> {
        let name = required_text(name, "workspace name")?;
        if self.get_user(owner_user_id).await?.is_none() {
            return Err(StorageError::NotFound("user not found".into()));
        }
        if let Some(folder_id) = folder_id {
            self.require_folder_access(owner_user_id, false, folder_id)
                .await?;
        }
        let id = Uuid::new_v4().to_string();
        let now = now_rfc3339();
        let mut tx = self.pool.begin().await?;
        sqlx::query(
            "INSERT INTO workspaces
             (id, name, description, layout_json, version, created_at, updated_at, owner_user_id, folder_id)
             VALUES (?, ?, ?, '{}', 1, ?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(name)
        .bind(trimmed_optional(description))
        .bind(&now)
        .bind(&now)
        .bind(owner_user_id)
        .bind(folder_id)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "INSERT INTO workspace_revisions (workspace_id, version, snapshot_json, created_at)
             VALUES (?, 1, ?, ?)",
        )
        .bind(&id)
        .bind(empty_workspace_snapshot())
        .bind(&now)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        search::sync_search_best_effort(self, "workspace", self.sync_search_workspace(&id)).await;
        self.get_workspace(&id)
            .await?
            .ok_or_else(|| StorageError::NotFound("workspace disappeared after insert".into()))
    }

    pub async fn update_workspace(
        &self,
        id: &str,
        name: Option<&str>,
        description: Option<&str>,
        layout_json: Option<&str>,
        folder_id: Option<Option<&str>>,
    ) -> Result<WorkspaceRow, StorageError> {
        let current = self
            .get_workspace(id)
            .await?
            .ok_or_else(|| StorageError::NotFound("workspace not found".into()))?;
        if name.is_none() && description.is_none() && layout_json.is_none() && folder_id.is_none() {
            return Ok(current);
        }
        let name = match name {
            Some(value) => required_text(value, "workspace name")?,
            None => current.name.as_str(),
        };
        let description = description
            .map(str::trim)
            .map(str::to_string)
            .or(current.description);
        let layout_json = match layout_json {
            Some(value) => {
                require_config_json(value)?;
                value
            }
            None => current.layout_json.as_str(),
        };
        let next_folder = match folder_id {
            Some(value) => value.map(str::to_string),
            None => current.folder_id.clone(),
        };
        if let Some(folder) = next_folder.as_deref() {
            let owner = current
                .owner_user_id
                .as_deref()
                .ok_or_else(|| StorageError::Invalid("workspace has no owner".into()))?;
            self.require_folder_access(owner, false, folder).await?;
        }
        sqlx::query(
            "UPDATE workspaces
             SET name = ?, description = ?, layout_json = ?, folder_id = ?, updated_at = ?
             WHERE id = ?",
        )
        .bind(name)
        .bind(description.filter(|value| !value.is_empty()))
        .bind(layout_json)
        .bind(next_folder.as_deref())
        .bind(now_rfc3339())
        .bind(id)
        .execute(&self.pool)
        .await?;
        search::sync_search_best_effort(self, "workspace", self.sync_search_workspace(id)).await;
        self.get_workspace(id)
            .await?
            .ok_or_else(|| StorageError::NotFound("workspace disappeared after update".into()))
    }

    pub async fn delete_workspace(&self, id: &str) -> Result<(), StorageError> {
        if id == DEFAULT_WORKSPACE_ID {
            return Err(StorageError::Invalid(
                "cannot delete the default workspace".into(),
            ));
        }
        let mut tx = self.pool.begin().await?;
        let found: Option<String> = sqlx::query_scalar("SELECT id FROM workspaces WHERE id = ?")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?;
        if found.is_none() {
            return Err(StorageError::NotFound("workspace not found".into()));
        }
        // Catalog extract defs may still point at this workspace (no ON DELETE).
        sqlx::query("UPDATE extract_definitions SET workspace_id = NULL WHERE workspace_id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("UPDATE transforms SET workspace_id = ? WHERE workspace_id = ?")
            .bind(DEFAULT_WORKSPACE_ID)
            .bind(id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("UPDATE extracts SET workspace_id = ? WHERE workspace_id = ?")
            .bind(DEFAULT_WORKSPACE_ID)
            .bind(id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("UPDATE jobs SET workspace_id = ? WHERE workspace_id = ?")
            .bind(DEFAULT_WORKSPACE_ID)
            .bind(id)
            .execute(&mut *tx)
            .await?;
        sqlx::query(
            "UPDATE datasets SET producer_chip_run_id = NULL
             WHERE producer_chip_run_id IN (SELECT id FROM chip_runs WHERE workspace_id = ?)",
        )
        .bind(id)
        .execute(&mut *tx)
        .await?;
        sqlx::query("UPDATE datasets SET workspace_id = ? WHERE workspace_id = ?")
            .bind(DEFAULT_WORKSPACE_ID)
            .bind(id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM chip_edges WHERE workspace_id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM chip_runs WHERE workspace_id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM workspace_chips WHERE workspace_id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM workspace_revisions WHERE workspace_id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        let result = sqlx::query("DELETE FROM workspaces WHERE id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_err(delete_guard::map_delete_sql)?;
        if result.rows_affected() == 0 {
            return Err(StorageError::NotFound("workspace not found".into()));
        }
        tx.commit().await?;
        let _ = self.delete_search_document("workspace", id).await;
        Ok(())
    }

    pub async fn list_visible_folders(
        &self,
        scope: Option<&DataScope>,
    ) -> Result<Vec<WorkspaceFolderRow>, StorageError> {
        let mut extra = String::new();
        let mut binds: Vec<String> = Vec::new();
        if let Some(scope) = scope {
            if !scope.admin {
                extra.push_str(" WHERE owner_user_id = ?");
                binds.push(scope.user_id.clone());
            }
        }
        extra.push_str(" ORDER BY name ASC, created_at ASC");
        let sql = format!("SELECT {FOLDER_COLS} FROM workspace_folders{extra}");
        let mut query = sqlx::query_as::<_, WorkspaceFolderRow>(&sql);
        for value in &binds {
            query = query.bind(value);
        }
        Ok(query.fetch_all(&self.pool).await?)
    }

    pub async fn get_folder(&self, id: &str) -> Result<Option<WorkspaceFolderRow>, StorageError> {
        Ok(sqlx::query_as::<_, WorkspaceFolderRow>(&format!(
            "SELECT {FOLDER_COLS} FROM workspace_folders WHERE id = ?"
        ))
        .bind(id)
        .fetch_optional(&self.pool)
        .await?)
    }

    pub async fn require_folder_access(
        &self,
        user_id: &str,
        admin: bool,
        folder_id: &str,
    ) -> Result<WorkspaceFolderRow, StorageError> {
        let folder = self
            .get_folder(folder_id)
            .await?
            .ok_or_else(|| StorageError::NotFound("folder not found".into()))?;
        if admin || folder.owner_user_id == user_id {
            return Ok(folder);
        }
        Err(StorageError::NotFound("folder not found".into()))
    }

    pub async fn insert_folder(
        &self,
        name: &str,
        owner_user_id: &str,
        parent_id: Option<&str>,
    ) -> Result<WorkspaceFolderRow, StorageError> {
        let name = required_text(name, "folder name")?;
        if self.get_user(owner_user_id).await?.is_none() {
            return Err(StorageError::NotFound("user not found".into()));
        }
        if let Some(parent_id) = parent_id {
            self.require_folder_access(owner_user_id, false, parent_id)
                .await?;
        }
        self.ensure_folder_name_available(owner_user_id, parent_id, name, None)
            .await?;
        let id = Uuid::new_v4().to_string();
        let now = now_rfc3339();
        sqlx::query(
            "INSERT INTO workspace_folders
             (id, owner_user_id, parent_id, name, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(owner_user_id)
        .bind(parent_id)
        .bind(name)
        .bind(&now)
        .bind(&now)
        .execute(&self.pool)
        .await
        .map_err(map_folder_sql)?;
        search::sync_search_best_effort(
            self,
            "workspace_folder",
            self.sync_search_workspace_folder(&id),
        )
        .await;
        self.get_folder(&id)
            .await?
            .ok_or_else(|| StorageError::NotFound("folder disappeared after insert".into()))
    }

    pub async fn update_folder(
        &self,
        id: &str,
        name: Option<&str>,
        parent_id: Option<Option<&str>>,
    ) -> Result<WorkspaceFolderRow, StorageError> {
        let current = self
            .get_folder(id)
            .await?
            .ok_or_else(|| StorageError::NotFound("folder not found".into()))?;
        if name.is_none() && parent_id.is_none() {
            return Ok(current);
        }
        let name = match name {
            Some(value) => required_text(value, "folder name")?,
            None => current.name.as_str(),
        };
        let next_parent = match parent_id {
            Some(value) => value.map(str::to_string),
            None => current.parent_id.clone(),
        };
        if let Some(parent) = next_parent.as_deref() {
            if parent == id {
                return Err(StorageError::Invalid(
                    "folder cannot be its own parent".into(),
                ));
            }
            self.require_folder_access(&current.owner_user_id, false, parent)
                .await?;
            if self.folder_is_descendant(parent, id).await? {
                return Err(StorageError::Invalid(
                    "cannot move a folder under its descendant".into(),
                ));
            }
        }
        self.ensure_folder_name_available(
            &current.owner_user_id,
            next_parent.as_deref(),
            name,
            Some(id),
        )
        .await?;
        sqlx::query(
            "UPDATE workspace_folders SET name = ?, parent_id = ?, updated_at = ? WHERE id = ?",
        )
        .bind(name)
        .bind(next_parent.as_deref())
        .bind(now_rfc3339())
        .bind(id)
        .execute(&self.pool)
        .await
        .map_err(map_folder_sql)?;
        search::sync_search_best_effort(
            self,
            "workspace_folder",
            self.sync_search_workspace_folder(id),
        )
        .await;
        self.get_folder(id)
            .await?
            .ok_or_else(|| StorageError::NotFound("folder disappeared after update".into()))
    }

    pub(crate) async fn ensure_folder_name_available(
        &self,
        owner_user_id: &str,
        parent_id: Option<&str>,
        name: &str,
        exclude_id: Option<&str>,
    ) -> Result<(), StorageError> {
        let existing = match parent_id {
            Some(parent_id) => {
                sqlx::query_scalar::<_, String>(
                    "SELECT id FROM workspace_folders
                     WHERE owner_user_id = ?
                       AND parent_id = ?
                       AND name = ? COLLATE NOCASE
                     LIMIT 1",
                )
                .bind(owner_user_id)
                .bind(parent_id)
                .bind(name)
                .fetch_optional(&self.pool)
                .await?
            }
            None => {
                sqlx::query_scalar::<_, String>(
                    "SELECT id FROM workspace_folders
                     WHERE owner_user_id = ?
                       AND parent_id IS NULL
                       AND name = ? COLLATE NOCASE
                     LIMIT 1",
                )
                .bind(owner_user_id)
                .bind(name)
                .fetch_optional(&self.pool)
                .await?
            }
        };
        if let Some(existing_id) = existing {
            if exclude_id != Some(existing_id.as_str()) {
                return Err(StorageError::Conflict(
                    "folder name already exists under this parent".into(),
                ));
            }
        }
        Ok(())
    }

    pub async fn delete_folder(&self, id: &str) -> Result<(), StorageError> {
        let result = sqlx::query("DELETE FROM workspace_folders WHERE id = ?")
            .bind(id)
            .execute(&self.pool)
            .await?;
        if result.rows_affected() == 0 {
            return Err(StorageError::NotFound("folder not found".into()));
        }
        let _ = self.delete_search_document("workspace_folder", id).await;
        Ok(())
    }

    pub(crate) async fn folder_is_descendant(
        &self,
        candidate: &str,
        ancestor: &str,
    ) -> Result<bool, StorageError> {
        let mut current = Some(candidate.to_string());
        let mut guard = 0;
        while let Some(id) = current {
            if id == ancestor {
                return Ok(true);
            }
            guard += 1;
            if guard > 64 {
                return Err(StorageError::Invalid("folder tree too deep".into()));
            }
            current = self
                .get_folder(&id)
                .await?
                .and_then(|folder| folder.parent_id);
        }
        Ok(false)
    }

    pub async fn save_workspace(
        &self,
        id: &str,
        layout_json: &str,
        chip_ids: &[String],
        edges: &[WorkspaceSaveEdge],
    ) -> Result<(WorkspaceRow, Vec<ChipRow>, Vec<ChipEdgeRow>), StorageError> {
        require_config_json(layout_json)?;
        let current = self
            .get_workspace(id)
            .await?
            .ok_or_else(|| StorageError::NotFound("workspace not found".into()))?;
        let now = now_rfc3339();
        let version = current.version + 1;
        let mut tx = self.pool.begin().await?;
        let mut saved_chips = Vec::with_capacity(chip_ids.len());
        for chip_id in chip_ids {
            let chip_id = required_text(chip_id, "chip id")?;
            let chip = sqlx::query_as::<_, ChipRow>(&format!(
                "SELECT {CHIP_COLS} FROM chips WHERE id = ?"
            ))
            .bind(chip_id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(|| StorageError::NotFound(format!("chip {chip_id} not found")))?;
            saved_chips.push(chip);
        }
        sqlx::query("DELETE FROM workspace_chips WHERE workspace_id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        for chip in &saved_chips {
            sqlx::query(
                "INSERT INTO workspace_chips (workspace_id, chip_id, created_at)
                 VALUES (?, ?, ?)",
            )
            .bind(id)
            .bind(&chip.id)
            .bind(&now)
            .execute(&mut *tx)
            .await?;
        }
        let saved_edges = replace_workspace_edges(&mut tx, id, edges, &saved_chips, &now).await?;
        sqlx::query(
            "UPDATE workspaces SET layout_json = ?, version = ?, updated_at = ? WHERE id = ?",
        )
        .bind(layout_json)
        .bind(version)
        .bind(&now)
        .bind(id)
        .execute(&mut *tx)
        .await?;
        let snapshot = workspace_snapshot_json(layout_json, &saved_chips, &saved_edges)?;
        sqlx::query(
            "INSERT INTO workspace_revisions (workspace_id, version, snapshot_json, created_at)
             VALUES (?, ?, ?, ?)",
        )
        .bind(id)
        .bind(version)
        .bind(&snapshot)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        let workspace = self
            .get_workspace(id)
            .await?
            .ok_or_else(|| StorageError::NotFound("workspace disappeared after save".into()))?;
        Ok((workspace, saved_chips, saved_edges))
    }

    pub(crate) async fn backfill_workspace_revisions(&self) -> Result<(), StorageError> {
        let workspaces = sqlx::query_as::<_, WorkspaceRow>(&format!(
            "SELECT {WORKSPACE_COLS} FROM workspaces ORDER BY created_at ASC"
        ))
        .fetch_all(&self.pool)
        .await?;
        for workspace in workspaces {
            let exists: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM workspace_revisions WHERE workspace_id = ?",
            )
            .bind(&workspace.id)
            .fetch_one(&self.pool)
            .await?;
            if exists > 0 {
                continue;
            }
            let chips = sqlx::query_as::<_, ChipRow>(&format!(
                "SELECT {CHIP_JOIN_COLS} FROM chips c
                 INNER JOIN workspace_chips wc ON wc.chip_id = c.id
                 WHERE wc.workspace_id = ? ORDER BY c.updated_at DESC"
            ))
            .bind(&workspace.id)
            .fetch_all(&self.pool)
            .await?;
            let snapshot = workspace_snapshot_json(&workspace.layout_json, &chips, &[])?;
            sqlx::query(
                "INSERT INTO workspace_revisions (workspace_id, version, snapshot_json, created_at)
                 VALUES (?, ?, ?, ?)",
            )
            .bind(&workspace.id)
            .bind(workspace.version)
            .bind(&snapshot)
            .bind(&workspace.updated_at)
            .execute(&self.pool)
            .await?;
        }
        Ok(())
    }
}
