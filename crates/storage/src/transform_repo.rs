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
        let dataset = self
            .get_dataset(dataset_id)
            .await?
            .ok_or_else(|| StorageError::NotFound("dataset not found".into()))?;
        let id = Uuid::new_v4().to_string();
        let now = now_rfc3339();
        sqlx::query(
            "INSERT INTO transforms
             (id, name, dataset_id, spec_json, created_at, updated_at, workspace_id, input_chip_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(name)
        .bind(dataset_id)
        .bind(spec_json)
        .bind(&now)
        .bind(&now)
        .bind(&dataset.workspace_id)
        .bind(input_chip_id)
        .execute(&self.pool)
        .await?;
        search::sync_search_best_effort(self, "transform", self.sync_search_transform(&id)).await;
        if let Some(chip_id) = input_chip_id
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            self.bind_chip_to_transform(chip_id, &id).await?;
        }
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
        let _ = self
            .get_dataset(dataset_id)
            .await?
            .ok_or_else(|| StorageError::NotFound("dataset not found".into()))?;
        let now = now_rfc3339();
        sqlx::query(
            "UPDATE transforms SET name = ?, dataset_id = ?, spec_json = ?, updated_at = ?,
             input_chip_id = ? WHERE id = ?",
        )
        .bind(name)
        .bind(dataset_id)
        .bind(spec_json)
        .bind(&now)
        .bind(&input_chip_id)
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
        let now = now_rfc3339();
        let mut tx = self.pool.begin().await?;
        sqlx::query("DELETE FROM chip_bindings WHERE chip_id = ?")
            .bind(chip_id)
            .execute(&mut *tx)
            .await?;
        sqlx::query(
            "INSERT INTO chip_bindings (chip_id, ref_kind, ref_id) VALUES (?, 'transform', ?)",
        )
        .bind(chip_id)
        .bind(transform_id)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "UPDATE chips SET config_json = NULL, revision = revision + 1, updated_at = ?
             WHERE id = ?",
        )
        .bind(&now)
        .bind(chip_id)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        search::sync_search_best_effort(self, "chip", self.sync_search_chip(chip_id)).await;
        Ok(())
    }

    pub async fn get_transform(&self, id: &str) -> Result<Option<TransformRow>, StorageError> {
        let row = sqlx::query_as::<_, TransformRow>(
            "SELECT id, name, dataset_id, spec_json, created_at, updated_at, workspace_id, input_chip_id
             FROM transforms WHERE id = ?",
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
            "SELECT id, name, dataset_id, spec_json, created_at, updated_at, workspace_id, input_chip_id
             FROM transforms
             WHERE input_chip_id = ?
             ORDER BY updated_at DESC
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
            Some(scope) => Self::workspace_scope_sql(scope, "workspace_id"),
            None => (String::new(), Vec::new()),
        };
        let sql = format!(
            "SELECT id, name, dataset_id, spec_json, created_at, updated_at, workspace_id, input_chip_id
             FROM transforms WHERE 1=1 {extra} ORDER BY updated_at DESC"
        );
        let mut query = sqlx::query_as::<_, TransformRow>(&sql);
        for value in &binds {
            query = query.bind(value);
        }
        Ok(query.fetch_all(&self.pool).await?)
    }
}
