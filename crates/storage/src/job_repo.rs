use crate::models::*;
use crate::*;

impl Store {
    pub async fn insert_transform_job(
        &self,
        source_path: &str,
        spec_json: &str,
        transform_id: &str,
        dataset_id: &str,
        workspace_id: &str,
    ) -> Result<JobRow, StorageError> {
        self.require_workspace(workspace_id).await?;
        let execution_id = Uuid::new_v4().to_string();
        let id = Uuid::new_v4().to_string();
        let created_at = now_rfc3339();
        let mut tx = self.pool.begin().await?;
        sqlx::query("INSERT INTO executions (id, workspace_id, source, trigger_id, status, created_at) VALUES (?, ?, 'transform_page', ?, 'queued', ?)")
            .bind(&execution_id).bind(workspace_id).bind(transform_id).bind(&created_at).execute(&mut *tx).await?;
        sqlx::query("INSERT INTO execution_steps (id, execution_id, kind, transform_id, definition_revision,
                     definition_snapshot_json, source_path, status, queued_at)
                     VALUES (?, ?, 'transform', ?, 1, ?, ?, 'queued', ?)")
            .bind(&id).bind(&execution_id).bind(transform_id).bind(spec_json).bind(source_path).bind(&created_at)
            .execute(&mut *tx).await?;
        sqlx::query("INSERT INTO execution_inputs (execution_step_id, port_name, data_file_id, ordinal) VALUES (?, 'in', ?, 0)")
            .bind(&id).bind(dataset_id).execute(&mut *tx).await?;
        tx.commit().await?;
        self.get_job(&id)
            .await?
            .ok_or_else(|| StorageError::NotFound("job disappeared after insert".into()))
    }

    pub async fn get_job(&self, id: &str) -> Result<Option<JobRow>, StorageError> {
        let row = sqlx::query_as::<_, JobRow>(&format!("SELECT {JOB_COLS} FROM execution_steps s INNER JOIN executions e ON e.id = s.execution_id WHERE s.id = ?"))
            .bind(id)
            .fetch_optional(&self.pool)
            .await?;
        Ok(row)
    }

    pub async fn list_jobs(
        &self,
        limit: i64,
        scope: Option<&DataScope>,
    ) -> Result<Vec<JobRow>, StorageError> {
        let (extra, binds) = match scope {
            Some(scope) => Self::workspace_scope_sql(scope, "e.workspace_id"),
            None => (String::new(), Vec::new()),
        };
        let sql = format!(
            "SELECT {JOB_COLS} FROM execution_steps s INNER JOIN executions e ON e.id = s.execution_id
             WHERE s.kind = 'transform'
               AND NOT EXISTS (
                 SELECT 1 FROM execution_steps parent
                 WHERE json_extract(parent.result_json, '$.child_step_id') = s.id
               )
               {extra}
             ORDER BY s.queued_at DESC LIMIT ?"
        );
        let mut query = sqlx::query_as::<_, JobRow>(&sql);
        for value in &binds {
            query = query.bind(value);
        }
        let rows = query.bind(limit).fetch_all(&self.pool).await?;
        Ok(rows)
    }

    pub async fn requeue_failed_job(&self, id: &str) -> Result<(), StorageError> {
        let now = now_rfc3339();
        let mut tx = self.pool.begin().await?;
        let execution_id: String = sqlx::query_scalar(
            "SELECT execution_id FROM execution_steps WHERE id = ? AND status = 'failed' AND kind = 'transform'",
        )
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| StorageError::Invalid("job is not waiting to retry".into()))?;
        sqlx::query(
            "UPDATE execution_steps SET status = 'queued', error_code = NULL, error_message = NULL,
             started_at = NULL, finished_at = NULL, queued_at = ?
             WHERE id = ? AND status = 'failed'",
        )
        .bind(&now)
        .bind(id)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "UPDATE executions SET status = 'queued', error_message = NULL, started_at = NULL, finished_at = NULL
             WHERE id = ? AND source != 'workspace'",
        )
        .bind(execution_id)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn transform_download_filename(
        &self,
        transform_id: Option<&str>,
    ) -> Result<Option<String>, StorageError> {
        let Some(transform_id) = transform_id.map(str::trim).filter(|id| !id.is_empty()) else {
            return Ok(None);
        };
        let Some(transform) = self.get_transform(transform_id).await? else {
            return Ok(None);
        };
        Ok(Some(chip_slot::display_filename(
            &transform.name,
            "transform",
            ",",
        )))
    }

    pub async fn set_job_running(&self, id: &str, output_path: &str) -> Result<(), StorageError> {
        sqlx::query(
            "UPDATE execution_steps SET status = ?, started_at = ?, output_path = ?, error_message = NULL
             WHERE id = ? AND status = 'queued'",
        )
        .bind("running")
        .bind(now_rfc3339())
        .bind(output_path)
        .bind(id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn set_job_succeeded(
        &self,
        id: &str,
        row_count: Option<i64>,
    ) -> Result<(), StorageError> {
        let changed = sqlx::query("UPDATE execution_steps SET status = ?, finished_at = ?, output_rows = COALESCE(?, output_rows) WHERE id = ? AND status = 'running'")
            .bind("succeeded")
            .bind(now_rfc3339())
            .bind(row_count)
            .bind(id)
            .execute(&self.pool)
            .await?;
        if changed.rows_affected() == 0 {
            return Ok(());
        }
        let job = self
            .get_job(id)
            .await?
            .ok_or_else(|| StorageError::NotFound("job not found".into()))?;
        if let Some(stored_path) = job.output_path.as_deref().filter(|path| !path.is_empty()) {
            let abs = self.resolve(stored_path);
            if abs.is_file() {
                let fallback = abs
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("result.parquet");
                let filename = self
                    .transform_download_filename(job.transform_id.as_deref())
                    .await?
                    .unwrap_or_else(|| fallback.to_string());
                let size = tokio::fs::metadata(&abs)
                    .await
                    .ok()
                    .map(|meta| meta.len() as i64);
                self.upsert_dataset(&DatasetUpsert {
                    id: job.id.clone(),
                    kind: "transform".into(),
                    extract_id: None,
                    filename,
                    stored_path: stored_path.to_string(),
                    size_bytes: size,
                    delimiter: None,
                    has_header: None,
                    row_count,
                    workspace_id: Some(job.workspace_id),
                })
                .await?;
            }
        }
        Ok(())
    }

    pub async fn set_job_failed(&self, id: &str, error: &str) -> Result<(), StorageError> {
        sqlx::query("UPDATE execution_steps SET status = ?, finished_at = ?, error_message = ? WHERE id = ?")
            .bind("failed")
            .bind(now_rfc3339())
            .bind(error)
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn append_log(
        &self,
        job_id: &str,
        level: &str,
        message: &str,
    ) -> Result<(), StorageError> {
        self.append_execution_log(job_id, level, "job", message, None)
            .await?;
        // Transform chips execute through a child job. Mirror the event onto the
        // parent chip run so every chip kind is queried through the same run id.
        if let Some(link) = self.linked_chip_run_for_job(job_id).await? {
            if link.run_id != job_id {
                self.append_execution_log(&link.run_id, level, "transform", message, None)
                    .await?;
            }
        }
        Ok(())
    }

    pub async fn read_process_log(&self, area: &str, id: &str) -> Result<String, StorageError> {
        if !LOG_AREAS.contains(&area) || !safe_log_id(id) {
            return Err(StorageError::Invalid("invalid log path".into()));
        }
        let path = ProcessLog::file(&self.data_dir, area, id);
        match tokio::fs::read_to_string(path).await {
            Ok(text) => Ok(text),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
            Err(err) => Err(err.into()),
        }
    }

    pub async fn list_logs(&self, job_id: &str) -> Result<Vec<JobLogRow>, StorageError> {
        let rows = sqlx::query_as::<_, JobLogRow>(
            "SELECT id, execution_step_id AS job_id, created_at AS ts, level, message FROM execution_logs
             WHERE execution_step_id = ? ORDER BY created_at ASC, sequence ASC",
        )
        .bind(job_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows)
    }
}
