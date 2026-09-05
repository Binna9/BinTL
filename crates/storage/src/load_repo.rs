use crate::*;

impl Store {
    pub async fn insert_load_definition(
        &self,
        owner_user_id: &str,
        name: &str,
        destination_type: &str,
        spec_json: &str,
    ) -> Result<LoadDefinitionRow, StorageError> {
        let name = name.trim();
        if name.is_empty() {
            return Err(StorageError::Invalid("name required".into()));
        }
        if !matches!(destination_type, "database" | "file") {
            return Err(StorageError::Invalid("invalid load destination type".into()));
        }
        require_config_json(spec_json)?;
        let id = Uuid::new_v4().to_string();
        let now = now_rfc3339();
        sqlx::query(
            "INSERT INTO load_definitions
             (id, owner_user_id, name, destination_type, spec_json, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(owner_user_id)
        .bind(name)
        .bind(destination_type)
        .bind(spec_json)
        .bind(&now)
        .bind(&now)
        .execute(&self.pool)
        .await?;
        self.get_load_definition(&id).await?.ok_or_else(|| StorageError::NotFound("load definition disappeared".into()))
    }

    pub async fn update_load_definition(
        &self,
        id: &str,
        name: &str,
        destination_type: &str,
        spec_json: &str,
    ) -> Result<LoadDefinitionRow, StorageError> {
        if !matches!(destination_type, "database" | "file") {
            return Err(StorageError::Invalid("invalid load destination type".into()));
        }
        require_config_json(spec_json)?;
        let result = sqlx::query(
            "UPDATE load_definitions SET name = ?, destination_type = ?, spec_json = ?, updated_at = ? WHERE id = ?",
        )
        .bind(name.trim())
        .bind(destination_type)
        .bind(spec_json)
        .bind(now_rfc3339())
        .bind(id)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 0 {
            return Err(StorageError::NotFound("load definition not found".into()));
        }
        self.get_load_definition(id).await?.ok_or_else(|| StorageError::NotFound("load definition disappeared".into()))
    }

    pub async fn get_load_definition(&self, id: &str) -> Result<Option<LoadDefinitionRow>, StorageError> {
        Ok(sqlx::query_as::<_, LoadDefinitionRow>(
            "SELECT id, owner_user_id, name, destination_type, spec_json, created_at, updated_at FROM load_definitions WHERE id = ?",
        ).bind(id).fetch_optional(&self.pool).await?)
    }

    pub async fn list_load_definitions(&self, owner_user_id: &str, admin: bool) -> Result<Vec<LoadDefinitionRow>, StorageError> {
        let sql = if admin {
            "SELECT id, owner_user_id, name, destination_type, spec_json, created_at, updated_at FROM load_definitions ORDER BY updated_at DESC"
        } else {
            "SELECT id, owner_user_id, name, destination_type, spec_json, created_at, updated_at FROM load_definitions WHERE owner_user_id = ? ORDER BY updated_at DESC"
        };
        let mut query = sqlx::query_as::<_, LoadDefinitionRow>(sql);
        if !admin { query = query.bind(owner_user_id); }
        Ok(query.fetch_all(&self.pool).await?)
    }

    pub async fn delete_load_definition(&self, id: &str) -> Result<(), StorageError> {
        let used: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM chip_bindings WHERE ref_kind = 'load_definition' AND ref_id = ?")
            .bind(id).fetch_one(&self.pool).await?;
        if used > 0 { return Err(StorageError::Conflict("load definition is used by a chip".into())); }
        let result = sqlx::query("DELETE FROM load_definitions WHERE id = ?").bind(id).execute(&self.pool).await?;
        if result.rows_affected() == 0 { return Err(StorageError::NotFound("load definition not found".into())); }
        Ok(())
    }

    pub async fn insert_load_result(
        &self, run_id: &str, destination: &str, mode: &str, input_rows: Option<i64>,
        loaded_rows: i64, input_bytes: Option<i64>, duration_ms: i64, artifact_path: Option<&str>,
    ) -> Result<(), StorageError> {
        sqlx::query(
            "INSERT INTO load_results (chip_run_id, destination, write_mode, input_rows, loaded_rows, rejected_rows, input_bytes, duration_ms, artifact_path, validation_status, created_at)
             VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, 'passed', ?)",
        ).bind(run_id).bind(destination).bind(mode).bind(input_rows).bind(loaded_rows)
          .bind(input_bytes).bind(duration_ms).bind(artifact_path).bind(now_rfc3339())
          .execute(&self.pool).await?;
        Ok(())
    }

    pub async fn get_load_result(&self, run_id: &str) -> Result<Option<LoadResultRow>, StorageError> {
        Ok(sqlx::query_as::<_, LoadResultRow>(
            "SELECT chip_run_id, destination, write_mode, input_rows, loaded_rows, rejected_rows, input_bytes, duration_ms, artifact_path, validation_status, created_at FROM load_results WHERE chip_run_id = ?",
        ).bind(run_id).fetch_optional(&self.pool).await?)
    }

    pub async fn set_load_chip_run_succeeded(&self, id: &str) -> Result<(), StorageError> {
        let result = sqlx::query(
            "UPDATE chip_runs SET status = 'succeeded', error_message = NULL, finished_at = ? WHERE id = ? AND status = 'running'",
        ).bind(now_rfc3339()).bind(id).execute(&self.pool).await?;
        if result.rows_affected() == 0 { return Err(StorageError::Invalid("only a running load run can succeed".into())); }
        Ok(())
    }
}
