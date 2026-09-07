use crate::models::*;
use crate::*;

impl Store {
    pub async fn upsert_dataset(&self, row: &DatasetUpsert) -> Result<DatasetRow, StorageError> {
        if !matches!(
            row.kind.as_str(),
            "upload" | "database" | "api" | "transform"
        ) {
            return Err(StorageError::Invalid(
                "dataset kind must be upload, database, api, or transform".into(),
            ));
        }
        if let Some(existing) = self.get_dataset_by_stored_path(&row.stored_path).await? {
            if existing.id != row.id {
                return self.merge_dataset_metadata(&existing.id, row).await;
            }
        }
        let now = now_rfc3339();
        let has_header = row.has_header.map(i64::from);
        sqlx::query(
            "INSERT INTO data_files
             (id, kind, filename, stored_path, size_bytes, delimiter, has_header,
              row_count, created_at, updated_at, workspace_id, format)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               kind = excluded.kind,
               filename = excluded.filename,
               stored_path = excluded.stored_path,
               size_bytes = excluded.size_bytes,
               delimiter = COALESCE(excluded.delimiter, data_files.delimiter),
               has_header = COALESCE(excluded.has_header, data_files.has_header),
               row_count = COALESCE(excluded.row_count, data_files.row_count),
               workspace_id = COALESCE(excluded.workspace_id, data_files.workspace_id),
               updated_at = excluded.updated_at",
        )
        .bind(&row.id)
        .bind(&row.kind)
        .bind(&row.filename)
        .bind(&row.stored_path)
        .bind(row.size_bytes)
        .bind(&row.delimiter)
        .bind(has_header)
        .bind(row.row_count)
        .bind(&now)
        .bind(&now)
        .bind(row.workspace_id.as_deref().unwrap_or(DEFAULT_WORKSPACE_ID))
        .bind(file_format(&row.filename, row.delimiter.as_deref()))
        .execute(&self.pool)
        .await?;
        self.get_dataset(&row.id)
            .await?
            .ok_or_else(|| StorageError::NotFound("dataset disappeared after upsert".into()))
    }

    pub async fn delete_transform_dataset(&self, id: &str) -> Result<(), StorageError> {
        let row = self
            .get_dataset(id)
            .await?
            .ok_or_else(|| StorageError::NotFound("dataset not found".into()))?;
        if row.kind != "transform" {
            return Err(StorageError::Invalid(
                "only transform data files can be deleted here".into(),
            ));
        }
        delete_guard::ensure_datasets_deletable(&self.pool, &[id.to_string()]).await?;

        let path = self.resolve(&row.stored_path);
        let outputs_root = self.data_dir.join(REL_OUTPUTS);
        let mut tx = self.pool.begin().await?;
        sqlx::query("UPDATE workspace_chip_outputs SET current_data_file_id = NULL WHERE current_data_file_id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        let deleted = sqlx::query("UPDATE data_files SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL")
            .bind(now_rfc3339())
            .bind(now_rfc3339())
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_err(delete_guard::map_delete_sql)?;
        if deleted.rows_affected() == 0 {
            return Err(StorageError::NotFound("dataset not found".into()));
        }
        tx.commit().await?;

        if let Some(parent) = path.parent() {
            let remove = if parent == outputs_root {
                tokio::fs::remove_file(&path).await
            } else if parent.starts_with(&self.data_dir) {
                tokio::fs::remove_dir_all(parent).await
            } else {
                Ok(())
            };
            match remove {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
        let _ = self.delete_search_document("data_file", id).await;
        Ok(())
    }

    pub async fn set_dataset_provenance(
        &self,
        dataset_id: &str,
        workspace_id: &str,
        producer_chip_run_id: &str,
    ) -> Result<(), StorageError> {
        self.require_workspace(workspace_id).await?;
        let run = self
            .get_chip_run(producer_chip_run_id)
            .await?
            .ok_or_else(|| StorageError::NotFound("producer chip run not found".into()))?;
        if run.workspace_id != workspace_id {
            return Err(StorageError::Invalid(
                "dataset and producer chip run workspace mismatch".into(),
            ));
        }
        let result = sqlx::query(
            "INSERT INTO execution_outputs (execution_step_id, port_name, data_file_id)
             VALUES (?, 'out', ?)
             ON CONFLICT(execution_step_id, port_name) DO UPDATE SET data_file_id = excluded.data_file_id",
        )
        .bind(producer_chip_run_id)
        .bind(dataset_id)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 0 {
            return Err(StorageError::NotFound("dataset not found".into()));
        }
        Ok(())
    }

    pub async fn complete_chip_run_for_job(
        &self,
        job_id: &str,
        stored_path: &str,
    ) -> Result<Option<String>, StorageError> {
        let run = sqlx::query_as::<_, ChipRunRow>(&format!(
            "SELECT {CHIP_RUN_COLS} FROM execution_steps s INNER JOIN executions e ON e.id=s.execution_id
             WHERE json_extract(s.result_json, '$.child_step_id') = ?"
        ))
        .bind(job_id)
        .fetch_optional(&self.pool)
        .await?;
        let Some(run) = run else {
            self.set_job_succeeded(job_id).await?;
            return Ok(None);
        };
        if run.status != "running" {
            return Err(StorageError::Invalid(
                "linked chip run is not running".into(),
            ));
        }
        let chip_name = match self.get_transform_for_chip(&run.chip_id).await? {
            Some(transform) => transform.name,
            None => self
                .get_chip(&run.chip_id)
                .await?
                .map(|chip| chip.name)
                .unwrap_or_else(|| "result".into()),
        };
        let display_name = chip_slot::display_filename(&chip_name, "transform", ",");
        let size = tokio::fs::metadata(self.resolve(stored_path)).await?.len() as i64;
        let now = now_rfc3339();
        let mut tx = self.pool.begin().await?;
        let job_result = sqlx::query(
            "UPDATE execution_steps SET status = 'succeeded', finished_at = ?, error_message = NULL
             WHERE id = ? AND status = 'running'",
        )
        .bind(&now)
        .bind(job_id)
        .execute(&mut *tx)
        .await?;
        if job_result.rows_affected() == 0 {
            return Err(StorageError::Invalid("linked job is not running".into()));
        }
        let dataset_id = self
            .upsert_chip_output_slot_dataset(
                &mut tx,
                &run.workspace_id,
                &run.chip_id,
                &run.id,
                "transform",
                &display_name,
                stored_path,
                Some(size),
                None,
                None,
                None,
                None,
            )
            .await?;
        let result = sqlx::query(
            "UPDATE execution_steps SET status = 'succeeded', error_message = NULL,
                 finished_at = ?, result_json=json_set(COALESCE(result_json, '{}'), '$.output_data_file_id', ?)
             WHERE id = ? AND status = 'running'",
        )
        .bind(&now)
        .bind(&dataset_id)
        .bind(&run.id)
        .execute(&mut *tx)
        .await?;
        if result.rows_affected() == 0 {
            return Err(StorageError::Invalid(
                "only a running chip run can succeed".into(),
            ));
        }
        tx.commit().await?;
        search::sync_search_best_effort(self, "dataset", self.sync_search_dataset(&dataset_id))
            .await;
        Ok(Some(dataset_id))
    }

    pub async fn fail_chip_run_for_job(
        &self,
        job_id: &str,
        error: &str,
    ) -> Result<(), StorageError> {
        self.fail_chip_run_for_job_with_code(job_id, "TRANSFORM_ENGINE_FAILED", error)
            .await
    }

    pub async fn fail_chip_run_for_job_with_code(
        &self,
        job_id: &str,
        error_code: &str,
        error: &str,
    ) -> Result<(), StorageError> {
        let now = now_rfc3339();
        let mut tx = self.pool.begin().await?;
        sqlx::query(
            "UPDATE execution_steps SET status = 'failed', finished_at = ?, error_code = ?, error_message = ? WHERE id = ?",
        )
        .bind(&now)
        .bind(error_code)
        .bind(error)
        .bind(job_id)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "UPDATE execution_steps
             SET status = 'failed', error_code = ?, error_message = ?, finished_at = ?
             WHERE json_extract(result_json, '$.child_step_id') = ? AND status IN ('queued', 'running')",
        )
        .bind(error_code)
        .bind(error)
        .bind(&now)
        .bind(job_id)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn update_dataset_inspect(
        &self,
        id: &str,
        columns_json: &str,
        row_count: Option<i64>,
        delimiter: Option<&str>,
        has_header: Option<bool>,
        size_bytes: Option<i64>,
    ) -> Result<DatasetRow, StorageError> {
        let now = now_rfc3339();
        let res = sqlx::query(
            "UPDATE data_files
             SET schema_id = ?, row_count = COALESCE(?, row_count),
                 delimiter = COALESCE(?, delimiter),
                 has_header = COALESCE(?, has_header),
                 size_bytes = COALESCE(?, size_bytes),
                 inspected_at = ?,
                 updated_at = ?
             WHERE id = ?",
        )
        .bind(self.upsert_data_schema(columns_json).await?.id)
        .bind(row_count)
        .bind(delimiter)
        .bind(has_header.map(i64::from))
        .bind(size_bytes)
        .bind(&now)
        .bind(&now)
        .bind(id)
        .execute(&self.pool)
        .await?;
        if res.rows_affected() == 0 {
            return Err(StorageError::NotFound("dataset not found".into()));
        }
        self.get_dataset(id)
            .await?
            .ok_or_else(|| StorageError::NotFound("dataset disappeared after inspect".into()))
    }

    pub(crate) fn dataset_select() -> String {
        format!(
            "SELECT {DATASET_COLS}
             FROM data_files d
             LEFT JOIN data_schemas s ON s.id = d.schema_id"
        )
    }

    pub async fn get_dataset(&self, id: &str) -> Result<Option<DatasetRow>, StorageError> {
        let sql = format!(
            "{} WHERE d.id = ? AND d.deleted_at IS NULL",
            Self::dataset_select()
        );
        let row = sqlx::query_as::<_, DatasetRow>(&sql)
            .bind(id)
            .fetch_optional(&self.pool)
            .await?;
        Ok(row)
    }

    pub(crate) async fn get_dataset_by_stored_path(
        &self,
        stored_path: &str,
    ) -> Result<Option<DatasetRow>, StorageError> {
        let path = stored_path.trim();
        if path.is_empty() {
            return Ok(None);
        }
        let sql = format!(
            "{} WHERE d.stored_path = ? AND d.deleted_at IS NULL",
            Self::dataset_select()
        );
        let row = sqlx::query_as::<_, DatasetRow>(&sql)
            .bind(path)
            .fetch_optional(&self.pool)
            .await?;
        Ok(row)
    }

    pub(crate) async fn merge_dataset_metadata(
        &self,
        id: &str,
        row: &DatasetUpsert,
    ) -> Result<DatasetRow, StorageError> {
        let now = now_rfc3339();
        let has_header = row.has_header.map(i64::from);
        sqlx::query(
            "UPDATE data_files SET
               kind = ?,
               filename = ?,
               size_bytes = COALESCE(?, size_bytes),
               delimiter = COALESCE(?, delimiter),
               has_header = COALESCE(?, has_header),
               row_count = COALESCE(?, row_count),
               workspace_id = COALESCE(?, workspace_id),
               updated_at = ?
             WHERE id = ?",
        )
        .bind(&row.kind)
        .bind(&row.filename)
        .bind(row.size_bytes)
        .bind(&row.delimiter)
        .bind(has_header)
        .bind(row.row_count)
        .bind(row.workspace_id.as_deref().unwrap_or(DEFAULT_WORKSPACE_ID))
        .bind(&now)
        .bind(id)
        .execute(&self.pool)
        .await?;
        self.get_dataset(id)
            .await?
            .ok_or_else(|| StorageError::NotFound("dataset disappeared after merge".into()))
    }

    pub async fn list_datasets(
        &self,
        scope: Option<&DataScope>,
    ) -> Result<Vec<DatasetRow>, StorageError> {
        let (extra, binds) = match scope {
            Some(scope) => Self::workspace_scope_sql(scope, "d.workspace_id"),
            None => (String::new(), Vec::new()),
        };
        let sql = format!(
            "{} WHERE d.deleted_at IS NULL {extra} ORDER BY d.created_at DESC",
            Self::dataset_select()
        );
        let mut query = sqlx::query_as::<_, DatasetRow>(&sql);
        for value in &binds {
            query = query.bind(value);
        }
        Ok(query.fetch_all(&self.pool).await?)
    }

    pub async fn upsert_data_schema(
        &self,
        columns_json: &str,
    ) -> Result<DataSchemaRow, StorageError> {
        let _: serde_json::Value = serde_json::from_str(columns_json)
            .map_err(|error| StorageError::Invalid(format!("invalid columns JSON: {error}")))?;
        if let Some(row) = sqlx::query_as::<_, DataSchemaRow>(
            "SELECT id, fingerprint, columns_json, created_at FROM data_schemas WHERE fingerprint = ?",
        )
        .bind(columns_json)
        .fetch_optional(&self.pool)
        .await?
        {
            return Ok(row);
        }
        let id = Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO data_schemas (id, fingerprint, columns_json, created_at) VALUES (?, ?, ?, ?)")
            .bind(&id).bind(columns_json).bind(columns_json).bind(now_rfc3339())
            .execute(&self.pool).await?;
        Ok(sqlx::query_as::<_, DataSchemaRow>(
            "SELECT id, fingerprint, columns_json, created_at FROM data_schemas WHERE id = ?",
        )
        .bind(id)
        .fetch_one(&self.pool)
        .await?)
    }
}

fn file_format(filename: &str, delimiter: Option<&str>) -> &'static str {
    let lower = filename.to_ascii_lowercase();
    if lower.ends_with(".parquet") {
        "parquet"
    } else if lower.ends_with(".json") {
        "json"
    } else if delimiter == Some("\t") || lower.ends_with(".tsv") {
        "tsv"
    } else {
        "csv"
    }
}
