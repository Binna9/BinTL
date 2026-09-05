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
            "INSERT INTO datasets
             (id, kind, extract_id, filename, stored_path, size_bytes, delimiter, has_header,
              row_count, created_at, updated_at, workspace_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               kind = excluded.kind,
               extract_id = excluded.extract_id,
               filename = excluded.filename,
               stored_path = excluded.stored_path,
               size_bytes = excluded.size_bytes,
               delimiter = COALESCE(excluded.delimiter, datasets.delimiter),
               has_header = COALESCE(excluded.has_header, datasets.has_header),
               row_count = COALESCE(excluded.row_count, datasets.row_count),
               workspace_id = COALESCE(excluded.workspace_id, datasets.workspace_id),
               updated_at = excluded.updated_at",
        )
        .bind(&row.id)
        .bind(&row.kind)
        .bind(&row.extract_id)
        .bind(&row.filename)
        .bind(&row.stored_path)
        .bind(row.size_bytes)
        .bind(&row.delimiter)
        .bind(has_header)
        .bind(row.row_count)
        .bind(&now)
        .bind(&now)
        .bind(row.workspace_id.as_deref().unwrap_or(DEFAULT_WORKSPACE_ID))
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
                "only transform datasets can be deleted here".into(),
            ));
        }
        delete_guard::ensure_datasets_deletable(&self.pool, &[id.to_string()]).await?;

        let path = self.resolve(&row.stored_path);
        let outputs_root = self.data_dir.join(REL_OUTPUTS);
        let mut tx = self.pool.begin().await?;
        sqlx::query("UPDATE chip_runs SET output_dataset_id = NULL WHERE output_dataset_id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        let deleted = sqlx::query("DELETE FROM datasets WHERE id = ?")
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
        let _ = self.delete_search_document("dataset", id).await;
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
            "UPDATE datasets
             SET workspace_id = ?, producer_chip_run_id = ?, updated_at = ?
             WHERE id = ?",
        )
        .bind(workspace_id)
        .bind(producer_chip_run_id)
        .bind(now_rfc3339())
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
            "SELECT {CHIP_RUN_COLS} FROM chip_runs WHERE legacy_job_id = ?"
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
            "UPDATE jobs SET status = 'succeeded', finished_at = ?, error_message = NULL
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
            "UPDATE chip_runs
             SET status = 'succeeded', output_dataset_id = ?, error_message = NULL,
                 finished_at = ?
             WHERE id = ? AND status = 'running'",
        )
        .bind(&dataset_id)
        .bind(&now)
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
        let now = now_rfc3339();
        let mut tx = self.pool.begin().await?;
        sqlx::query(
            "UPDATE jobs SET status = 'failed', finished_at = ?, error_message = ? WHERE id = ?",
        )
        .bind(&now)
        .bind(error)
        .bind(job_id)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "UPDATE chip_runs
             SET status = 'failed', error_message = ?, finished_at = ?
             WHERE legacy_job_id = ? AND status IN ('queued', 'running')",
        )
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
            "UPDATE datasets
             SET columns_json = ?,
                 row_count = COALESCE(?, row_count),
                 delimiter = COALESCE(?, delimiter),
                 has_header = COALESCE(?, has_header),
                 size_bytes = COALESCE(?, size_bytes),
                 inspected_at = ?,
                 updated_at = ?
             WHERE id = ?",
        )
        .bind(columns_json)
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
             FROM datasets d
             LEFT JOIN extracts e ON e.id = COALESCE(d.extract_id, CASE WHEN d.kind = 'database' THEN d.id END)
             LEFT JOIN connections c ON c.id = e.connection_id"
        )
    }

    pub async fn get_dataset(&self, id: &str) -> Result<Option<DatasetRow>, StorageError> {
        let sql = format!("{} WHERE d.id = ?", Self::dataset_select());
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
        let sql = format!("{} WHERE d.stored_path = ?", Self::dataset_select());
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
            "UPDATE datasets SET
               kind = ?,
               extract_id = COALESCE(?, extract_id),
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
        .bind(&row.extract_id)
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
            "{} WHERE 1=1 {extra} ORDER BY d.created_at DESC",
            Self::dataset_select()
        );
        let mut query = sqlx::query_as::<_, DatasetRow>(&sql);
        for value in &binds {
            query = query.bind(value);
        }
        Ok(query.fetch_all(&self.pool).await?)
    }
}
