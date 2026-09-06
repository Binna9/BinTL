use crate::models::*;
use crate::*;

impl Store {
    pub async fn insert_transform(
        &self,
        name: &str,
        dataset_id: &str,
        spec_json: &str,
        input_chip_id: Option<&str>,
    ) -> Result<TransformRow, StorageError> {
        let name = name.trim();
        if name.is_empty() {
            return Err(StorageError::Invalid("name required".into()));
        }
        let dataset = self.get_dataset(dataset_id).await?;
        let workspace_id = match dataset.as_ref() {
            Some(dataset) => dataset.workspace_id.clone(),
            None => {
                let chip_id = input_chip_id
                    .filter(|value| !value.trim().is_empty())
                    .ok_or_else(|| StorageError::NotFound("dataset not found".into()))?;
                self.chip_workspace_hint(chip_id)
                    .await?
                    .ok_or_else(|| StorageError::NotFound("chip workspace not found".into()))?
            }
        };
        let default_input_file_id = dataset.as_ref().map(|dataset| dataset.id.as_str());
        let id = Uuid::new_v4().to_string();
        let now = now_rfc3339();
        let owner_user_id: String = sqlx::query_scalar(
            "SELECT COALESCE(w.owner_user_id, (SELECT id FROM users WHERE active = 1 ORDER BY created_at LIMIT 1))
             FROM workspaces w WHERE w.id = ?",
        )
        .bind(&workspace_id)
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(|| StorageError::Invalid("transform owner is unavailable".into()))?;
        let output_filename = format!("transform-{id}.parquet");
        sqlx::query(
            "INSERT INTO transforms
             (id, owner_user_id, name, default_input_file_id, spec_json, output_format,
              output_filename_template, revision, active, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 'parquet', ?, 1, 1, ?, ?)",
        )
        .bind(&id)
        .bind(owner_user_id)
        .bind(name)
        .bind(default_input_file_id)
        .bind(spec_json)
        .bind(output_filename)
        .bind(&now)
        .bind(&now)
        .execute(&self.pool)
        .await?;
        if let Some(chip_id) = input_chip_id
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            self.bind_chip_to_transform(chip_id, &id).await?;
        }
        search::sync_search_best_effort(self, "transform", self.sync_search_transform(&id)).await;
        self.get_transform(&id)
            .await?
            .ok_or_else(|| StorageError::NotFound("transform disappeared after insert".into()))
    }

    pub async fn update_transform(
        &self,
        id: &str,
        name: Option<&str>,
        dataset_id: Option<&str>,
        spec_json: Option<&str>,
        input_chip_id: Option<Option<&str>>,
    ) -> Result<TransformRow, StorageError> {
        let current = self
            .get_transform(id)
            .await?
            .ok_or_else(|| StorageError::NotFound("transform not found".into()))?;
        let name = name
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(current.name.as_str());
        let dataset_id = dataset_id.unwrap_or(current.dataset_id.as_str());
        let spec_json = spec_json.unwrap_or(current.spec_json.as_str());
        let input_chip_id = match input_chip_id {
            Some(value) => value.map(str::to_string),
            None => current.input_chip_id.clone(),
        };
        let dataset = self.get_dataset(dataset_id).await?;
        if dataset.is_none() && input_chip_id.is_none() {
            return Err(StorageError::NotFound("dataset not found".into()));
        }
        let now = now_rfc3339();
        sqlx::query(
            "UPDATE transforms SET name = ?, default_input_file_id = ?, spec_json = ?,
             revision = revision + 1, updated_at = ? WHERE id = ?",
        )
        .bind(name)
        .bind(dataset.as_ref().map(|row| row.id.as_str()))
        .bind(spec_json)
        .bind(&now)
        .bind(id)
        .execute(&self.pool)
        .await?;
        search::sync_search_best_effort(self, "transform", self.sync_search_transform(id)).await;
        if let Some(chip_id) = input_chip_id.as_deref().filter(|value| !value.is_empty()) {
            self.bind_chip_to_transform(chip_id, id).await?;
        }
        self.get_transform(id)
            .await?
            .ok_or_else(|| StorageError::NotFound("transform disappeared after update".into()))
    }

    pub async fn bind_chip_to_transform(
        &self,
        chip_id: &str,
        transform_id: &str,
    ) -> Result<(), StorageError> {
        let chip = self
            .get_chip(chip_id)
            .await?
            .ok_or_else(|| StorageError::NotFound("chip not found".into()))?;
        if chip.kind != "transform" {
            return Err(StorageError::Invalid(
                "only transform chips can bind a transform definition".into(),
            ));
        }
        let _ = self
            .get_transform(transform_id)
            .await?
            .ok_or_else(|| StorageError::NotFound("transform not found".into()))?;
        sqlx::query(
            "UPDATE chips SET transform_id = ?, extract_id = NULL, load_id = NULL, updated_at = ?
             WHERE id = ? AND kind = 'transform'",
        )
        .bind(transform_id)
        .bind(now_rfc3339())
        .bind(chip_id)
        .execute(&self.pool)
        .await?;
        search::sync_search_best_effort(self, "chip", self.sync_search_chip(chip_id)).await;
        Ok(())
    }

    pub async fn get_transform(&self, id: &str) -> Result<Option<TransformRow>, StorageError> {
        let row = sqlx::query_as::<_, TransformRow>(
            "SELECT t.id, t.name, COALESCE(t.default_input_file_id, 'contract:' || COALESCE(d.workspace_id, (SELECT wc.workspace_id FROM workspace_chips wc INNER JOIN chips c ON c.id=wc.chip_id WHERE c.transform_id=t.id LIMIT 1), 'default') || ':' || COALESCE((SELECT c.id FROM chips c WHERE c.transform_id=t.id LIMIT 1), t.id)) AS dataset_id, t.spec_json,
                    t.created_at, t.updated_at, COALESCE(d.workspace_id, (SELECT wc.workspace_id FROM workspace_chips wc INNER JOIN chips c ON c.id=wc.chip_id WHERE c.transform_id=t.id LIMIT 1)) AS workspace_id,
                    (SELECT c.id FROM chips c WHERE c.transform_id = t.id ORDER BY c.updated_at DESC LIMIT 1) AS input_chip_id
             FROM transforms t LEFT JOIN data_files d ON d.id = t.default_input_file_id WHERE t.id = ?",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row)
    }

    pub async fn get_transform_for_chip(
        &self,
        chip_id: &str,
    ) -> Result<Option<TransformRow>, StorageError> {
        let row = sqlx::query_as::<_, TransformRow>(
            "SELECT t.id, t.name, COALESCE(t.default_input_file_id, 'contract:' || COALESCE(d.workspace_id, wc.workspace_id, 'default') || ':' || c.id) AS dataset_id, t.spec_json,
                    t.created_at, t.updated_at, COALESCE(d.workspace_id, wc.workspace_id) AS workspace_id, c.id AS input_chip_id
             FROM transforms t INNER JOIN chips c ON c.transform_id = t.id
             LEFT JOIN data_files d ON d.id=t.default_input_file_id
             LEFT JOIN workspace_chips wc ON wc.chip_id=c.id
             WHERE c.id = ? ORDER BY t.updated_at DESC
             LIMIT 1",
        )
        .bind(chip_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row)
    }

    pub async fn delete_transform(&self, id: &str) -> Result<(), StorageError> {
        delete_guard::ensure_transform_deletable(&self.pool, id).await?;
        let deleted = sqlx::query("DELETE FROM transforms WHERE id = ?")
            .bind(id)
            .execute(&self.pool)
            .await
            .map_err(delete_guard::map_delete_sql)?;
        if deleted.rows_affected() == 0 {
            return Err(StorageError::NotFound("transform not found".into()));
        }
        let _ = self.delete_search_document("transform", id).await;
        Ok(())
    }

    pub async fn list_transforms(
        &self,
        scope: Option<&DataScope>,
    ) -> Result<Vec<TransformRow>, StorageError> {
        let (extra, binds) = match scope {
            Some(scope) => {
                Self::workspace_scope_sql(scope, "COALESCE(d.workspace_id, (SELECT wc.workspace_id FROM workspace_chips wc INNER JOIN chips c ON c.id=wc.chip_id WHERE c.transform_id=t.id LIMIT 1))")
            }
            None => (String::new(), Vec::new()),
        };
        let sql = format!(
            "SELECT t.id, t.name, COALESCE(t.default_input_file_id, 'contract:' || COALESCE(d.workspace_id, (SELECT wc.workspace_id FROM workspace_chips wc INNER JOIN chips c ON c.id=wc.chip_id WHERE c.transform_id=t.id LIMIT 1), 'default') || ':' || COALESCE((SELECT c.id FROM chips c WHERE c.transform_id=t.id LIMIT 1), t.id)) AS dataset_id, t.spec_json,
                    t.created_at, t.updated_at, COALESCE(d.workspace_id, (SELECT wc.workspace_id FROM workspace_chips wc INNER JOIN chips c ON c.id=wc.chip_id WHERE c.transform_id=t.id LIMIT 1)) AS workspace_id,
                    (SELECT c.id FROM chips c WHERE c.transform_id = t.id ORDER BY c.updated_at DESC LIMIT 1) AS input_chip_id
             FROM transforms t LEFT JOIN data_files d ON d.id = t.default_input_file_id
             WHERE 1=1 {extra} ORDER BY t.updated_at DESC"
        );
        let mut query = sqlx::query_as::<_, TransformRow>(&sql);
        for value in &binds {
            query = query.bind(value);
        }
        Ok(query.fetch_all(&self.pool).await?)
    }
}
