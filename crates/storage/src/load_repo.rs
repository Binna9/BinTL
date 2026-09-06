use crate::*;

impl Store {
    pub async fn bind_chip_to_load(
        &self,
        chip_id: &str,
        load_definition_id: &str,
    ) -> Result<(), StorageError> {
        let chip = self
            .get_chip(chip_id)
            .await?
            .ok_or_else(|| StorageError::NotFound("chip not found".into()))?;
        if chip.kind != "load" {
            return Err(StorageError::Invalid(
                "only load chips can bind a load definition".into(),
            ));
        }
        let _ = self
            .get_load_definition(load_definition_id)
            .await?
            .ok_or_else(|| StorageError::NotFound("load definition not found".into()))?;
        sqlx::query(
            "UPDATE chips SET load_id = ?, extract_id = NULL, transform_id = NULL,
                     updated_at = ? WHERE id = ? AND kind = 'load'",
        )
        .bind(load_definition_id)
        .bind(now_rfc3339())
        .bind(chip_id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

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
            return Err(StorageError::Invalid(
                "invalid load destination type".into(),
            ));
        }
        require_config_json(spec_json)?;
        let id = Uuid::new_v4().to_string();
        let now = now_rfc3339();
        let spec: serde_json::Value = serde_json::from_str(spec_json)
            .map_err(|error| StorageError::Invalid(error.to_string()))?;
        let input_id = spec.get("input_dataset_id").and_then(|v| v.as_str());
        let connection_id = spec
            .pointer("/destination/connection_id")
            .and_then(|v| v.as_str());
        let write_mode = spec
            .get("write_mode")
            .and_then(|v| v.as_str())
            .unwrap_or("append");
        let batch_size = spec
            .get("batch_size")
            .and_then(|v| v.as_i64())
            .unwrap_or(5000);
        let conflict_keys = spec
            .get("conflict_keys")
            .cloned()
            .unwrap_or_else(|| serde_json::json!([]))
            .to_string();
        let destination = spec
            .get("destination")
            .ok_or_else(|| StorageError::Invalid("load destination required".into()))?
            .to_string();
        sqlx::query(
            "INSERT INTO loads
             (id, owner_user_id, name, default_input_file_id, destination_type, connection_id,
              destination_json, write_mode, batch_size, conflict_keys_json, revision, active,
              created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)",
        )
        .bind(&id)
        .bind(owner_user_id)
        .bind(name)
        .bind(input_id)
        .bind(destination_type)
        .bind(connection_id)
        .bind(destination)
        .bind(write_mode)
        .bind(batch_size)
        .bind(conflict_keys)
        .bind(&now)
        .bind(&now)
        .execute(&self.pool)
        .await?;
        search::sync_search_best_effort(self, "load", self.sync_search_load(&id)).await;
        self.get_load_definition(&id)
            .await?
            .ok_or_else(|| StorageError::NotFound("load definition disappeared".into()))
    }

    pub async fn update_load_definition(
        &self,
        id: &str,
        name: &str,
        destination_type: &str,
        spec_json: &str,
    ) -> Result<LoadDefinitionRow, StorageError> {
        if !matches!(destination_type, "database" | "file") {
            return Err(StorageError::Invalid(
                "invalid load destination type".into(),
            ));
        }
        require_config_json(spec_json)?;
        let spec: serde_json::Value = serde_json::from_str(spec_json)
            .map_err(|error| StorageError::Invalid(error.to_string()))?;
        let destination = spec
            .get("destination")
            .ok_or_else(|| StorageError::Invalid("load destination required".into()))?
            .to_string();
        let result = sqlx::query(
            "UPDATE loads SET name = ?, default_input_file_id = ?, destination_type = ?,
             connection_id = ?, destination_json = ?, write_mode = ?, batch_size = ?,
             conflict_keys_json = ?, revision = revision + 1, updated_at = ? WHERE id = ?",
        )
        .bind(name.trim())
        .bind(spec.get("input_dataset_id").and_then(|v| v.as_str()))
        .bind(destination_type)
        .bind(
            spec.pointer("/destination/connection_id")
                .and_then(|v| v.as_str()),
        )
        .bind(destination)
        .bind(
            spec.get("write_mode")
                .and_then(|v| v.as_str())
                .unwrap_or("append"),
        )
        .bind(
            spec.get("batch_size")
                .and_then(|v| v.as_i64())
                .unwrap_or(5000),
        )
        .bind(
            spec.get("conflict_keys")
                .cloned()
                .unwrap_or_else(|| serde_json::json!([]))
                .to_string(),
        )
        .bind(now_rfc3339())
        .bind(id)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 0 {
            return Err(StorageError::NotFound("load definition not found".into()));
        }
        search::sync_search_best_effort(self, "load", self.sync_search_load(id)).await;
        self.get_load_definition(id)
            .await?
            .ok_or_else(|| StorageError::NotFound("load definition disappeared".into()))
    }

    pub async fn get_load_definition(
        &self,
        id: &str,
    ) -> Result<Option<LoadDefinitionRow>, StorageError> {
        Ok(sqlx::query_as::<_, LoadDefinitionRow>(
            "SELECT id, owner_user_id, name, destination_type,
                    json_object(
                      'input_dataset_id', default_input_file_id,
                      'destination', json(destination_json),
                      'write_mode', write_mode,
                      'conflict_keys', json(conflict_keys_json),
                      'batch_size', batch_size
                    ) AS spec_json,
                    created_at, updated_at FROM loads WHERE id = ?",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?)
    }

    pub async fn list_load_definitions(
        &self,
        owner_user_id: &str,
        admin: bool,
    ) -> Result<Vec<LoadDefinitionRow>, StorageError> {
        let sql = if admin {
            "SELECT id, owner_user_id, name, destination_type,
                    json_object('input_dataset_id', default_input_file_id, 'destination', json(destination_json),
                    'write_mode', write_mode, 'conflict_keys', json(conflict_keys_json), 'batch_size', batch_size) AS spec_json,
                    created_at, updated_at FROM loads ORDER BY updated_at DESC"
        } else {
            "SELECT id, owner_user_id, name, destination_type,
                    json_object('input_dataset_id', default_input_file_id, 'destination', json(destination_json),
                    'write_mode', write_mode, 'conflict_keys', json(conflict_keys_json), 'batch_size', batch_size) AS spec_json,
                    created_at, updated_at FROM loads WHERE owner_user_id = ? ORDER BY updated_at DESC"
        };
        let mut query = sqlx::query_as::<_, LoadDefinitionRow>(sql);
        if !admin {
            query = query.bind(owner_user_id);
        }
        Ok(query.fetch_all(&self.pool).await?)
    }

    pub async fn delete_load_definition(&self, id: &str) -> Result<(), StorageError> {
        let used: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM chips WHERE load_id = ?")
            .bind(id)
            .fetch_one(&self.pool)
            .await?;
        if used > 0 {
            return Err(StorageError::Conflict(
                "load definition is used by a chip".into(),
            ));
        }
        let result = sqlx::query("DELETE FROM loads WHERE id = ?")
            .bind(id)
            .execute(&self.pool)
            .await?;
        if result.rows_affected() == 0 {
            return Err(StorageError::NotFound("load definition not found".into()));
        }
        let _ = self.delete_search_document("load", id).await;
        Ok(())
    }

    pub async fn insert_load_result(
        &self,
        run_id: &str,
        destination: &str,
        mode: &str,
        input_rows: Option<i64>,
        loaded_rows: i64,
        input_bytes: Option<i64>,
        duration_ms: i64,
        artifact_path: Option<&str>,
    ) -> Result<(), StorageError> {
        let result = serde_json::json!({"destination": destination, "write_mode": mode,
            "input_rows": input_rows, "loaded_rows": loaded_rows, "rejected_rows": 0,
            "input_bytes": input_bytes, "duration_ms": duration_ms, "artifact_path": artifact_path,
            "validation_status": "passed"});
        sqlx::query(
            "UPDATE execution_steps SET input_rows = ?, output_rows = ?, rejected_rows = 0,
                     input_bytes = ?, result_json = ? WHERE id = ?",
        )
        .bind(input_rows)
        .bind(loaded_rows)
        .bind(input_bytes)
        .bind(result.to_string())
        .bind(run_id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn get_load_result(
        &self,
        run_id: &str,
    ) -> Result<Option<LoadResultRow>, StorageError> {
        Ok(sqlx::query_as::<_, LoadResultRow>(
            "SELECT id AS chip_run_id, json_extract(result_json, '$.destination') AS destination,
                    json_extract(result_json, '$.write_mode') AS write_mode, input_rows,
                    output_rows AS loaded_rows, COALESCE(rejected_rows, 0) AS rejected_rows,
                    input_bytes, json_extract(result_json, '$.duration_ms') AS duration_ms,
                    json_extract(result_json, '$.artifact_path') AS artifact_path,
                    COALESCE(json_extract(result_json, '$.validation_status'), 'pending') AS validation_status,
                    COALESCE(finished_at, queued_at) AS created_at
             FROM execution_steps WHERE id = ? AND kind = 'load' AND result_json IS NOT NULL",
        ).bind(run_id).fetch_optional(&self.pool).await?)
    }

    pub async fn set_load_chip_run_succeeded(&self, id: &str) -> Result<(), StorageError> {
        let result = sqlx::query(
            "UPDATE execution_steps SET status = 'succeeded', error_message = NULL, finished_at = ? WHERE id = ? AND status = 'running'",
        ).bind(now_rfc3339()).bind(id).execute(&self.pool).await?;
        if result.rows_affected() == 0 {
            return Err(StorageError::Invalid(
                "only a running load run can succeed".into(),
            ));
        }
        Ok(())
    }
}
