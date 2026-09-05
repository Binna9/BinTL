use crate::models::*;
use crate::*;

impl Store {
    pub async fn create_chip_run(
        &self,
        chip_id: &str,
        workspace_id: &str,
        expected_revision: i64,
        config_snapshot_json: &str,
        input_dataset_id: Option<&str>,
    ) -> Result<ChipRunRow, StorageError> {
        let task = self
            .get_chip(chip_id)
            .await?
            .ok_or_else(|| StorageError::NotFound("chip not found".into()))?;
        if task.active == 0 || task.revision != expected_revision {
            return Err(StorageError::Invalid(
                "chip changed before the run could be queued".into(),
            ));
        }
        let on_workspace: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM workspace_chips WHERE workspace_id = ? AND chip_id = ?",
        )
        .bind(workspace_id)
        .bind(chip_id)
        .fetch_one(&self.pool)
        .await?;
        if on_workspace == 0 {
            return Err(StorageError::Invalid(
                "chip is not placed on this workspace".into(),
            ));
        }
        require_config_json(config_snapshot_json)?;
        if let Some(dataset_id) = input_dataset_id {
            let dataset = self
                .get_dataset(dataset_id)
                .await?
                .ok_or_else(|| StorageError::NotFound("input dataset not found".into()))?;
            if dataset.workspace_id != workspace_id {
                return Err(StorageError::Invalid(
                    "input dataset belongs to another workspace".into(),
                ));
            }
        }
        let id = Uuid::new_v4().to_string();
        let result = sqlx::query(
            "INSERT INTO chip_runs
             (id, chip_id, workspace_id, kind, status, config_snapshot_json,
              revision_snapshot, input_dataset_id, created_at)
             VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(chip_id)
        .bind(workspace_id)
        .bind(&task.kind)
        .bind(config_snapshot_json)
        .bind(expected_revision)
        .bind(input_dataset_id)
        .bind(now_rfc3339())
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 0 {
            return Err(StorageError::Invalid(
                "chip changed before the run could be queued".into(),
            ));
        }
        self.get_chip_run(&id)
            .await?
            .ok_or_else(|| StorageError::NotFound("chip run disappeared after insert".into()))
    }

    pub async fn get_chip_run(&self, id: &str) -> Result<Option<ChipRunRow>, StorageError> {
        Ok(sqlx::query_as::<_, ChipRunRow>(&format!(
            "SELECT {CHIP_RUN_COLS} FROM chip_runs WHERE id = ?"
        ))
        .bind(id)
        .fetch_optional(&self.pool)
        .await?)
    }

    pub async fn list_chip_runs(
        &self,
        workspace_id: &str,
    ) -> Result<Vec<ChipRunRow>, StorageError> {
        self.require_workspace(workspace_id).await?;
        Ok(sqlx::query_as::<_, ChipRunRow>(&format!(
            "SELECT {CHIP_RUN_COLS} FROM chip_runs
             WHERE workspace_id = ? ORDER BY created_at DESC"
        ))
        .bind(workspace_id)
        .fetch_all(&self.pool)
        .await?)
    }

    pub async fn list_chip_edges(
        &self,
        workspace_id: &str,
    ) -> Result<Vec<ChipEdgeRow>, StorageError> {
        self.require_workspace(workspace_id).await?;
        Ok(sqlx::query_as::<_, ChipEdgeRow>(&format!(
            "SELECT {CHIP_EDGE_COLS} FROM chip_edges
             WHERE workspace_id = ? ORDER BY created_at ASC"
        ))
        .bind(workspace_id)
        .fetch_all(&self.pool)
        .await?)
    }

    pub async fn latest_chip_output(&self, chip_id: &str) -> Result<Option<String>, StorageError> {
        Ok(sqlx::query_scalar(
            "SELECT output_dataset_id FROM chip_runs
             WHERE chip_id = ? AND status = 'succeeded' AND output_dataset_id IS NOT NULL
             ORDER BY COALESCE(finished_at, created_at) DESC, created_at DESC
             LIMIT 1",
        )
        .bind(chip_id)
        .fetch_optional(&self.pool)
        .await?)
    }

    pub async fn latest_chip_output_for_workspace(
        &self,
        workspace_id: &str,
        chip_id: &str,
    ) -> Result<Option<String>, StorageError> {
        let slot_id: Option<String> = sqlx::query_scalar(
            "SELECT s.dataset_id FROM chip_output_slots s
             INNER JOIN datasets d ON d.id = s.dataset_id
             WHERE s.workspace_id = ? AND s.chip_id = ?
               AND d.status = 'materialized'
               AND d.stored_path IS NOT NULL AND TRIM(d.stored_path) != ''",
        )
        .bind(workspace_id)
        .bind(chip_id)
        .fetch_optional(&self.pool)
        .await?;
        if slot_id.is_some() {
            return Ok(slot_id);
        }
        Ok(sqlx::query_scalar(
            "SELECT output_dataset_id FROM chip_runs
             WHERE chip_id = ? AND workspace_id = ? AND status = 'succeeded'
               AND output_dataset_id IS NOT NULL
             ORDER BY COALESCE(finished_at, created_at) DESC, created_at DESC
             LIMIT 1",
        )
        .bind(chip_id)
        .bind(workspace_id)
        .fetch_optional(&self.pool)
        .await?)
    }

    pub async fn find_planned_input_dataset(
        &self,
        workspace_id: &str,
        consumer_chip_id: &str,
    ) -> Result<Option<DatasetRow>, StorageError> {
        let id: Option<String> = sqlx::query_scalar(
            "SELECT id FROM datasets
             WHERE workspace_id = ? AND consumer_chip_id = ? AND status = 'planned'
             LIMIT 1",
        )
        .bind(workspace_id)
        .bind(consumer_chip_id)
        .fetch_optional(&self.pool)
        .await?;
        match id {
            Some(dataset_id) => self.get_dataset(&dataset_id).await,
            None => Ok(None),
        }
    }

    pub async fn upsert_planned_input_dataset(
        &self,
        workspace_id: &str,
        consumer_chip_id: &str,
        source_chip_id: &str,
        source_extract_definition_id: Option<&str>,
        kind: &str,
        filename: &str,
        columns_json: &str,
        delimiter: &str,
        header: bool,
    ) -> Result<DatasetRow, StorageError> {
        let now = now_rfc3339();
        if let Some(existing) = self
            .find_planned_input_dataset(workspace_id, consumer_chip_id)
            .await?
        {
            sqlx::query(
                "UPDATE datasets SET
                   kind = ?,
                   source_chip_id = ?,
                   source_extract_definition_id = ?,
                   filename = ?,
                   columns_json = ?,
                   delimiter = ?,
                   has_header = ?,
                   inspected_at = ?,
                   updated_at = ?
                 WHERE id = ?",
            )
            .bind(kind)
            .bind(source_chip_id)
            .bind(source_extract_definition_id)
            .bind(filename)
            .bind(columns_json)
            .bind(delimiter)
            .bind(i64::from(header))
            .bind(&now)
            .bind(&now)
            .bind(&existing.id)
            .execute(&self.pool)
            .await?;
            return self
                .get_dataset(&existing.id)
                .await?
                .ok_or_else(|| StorageError::NotFound("planned dataset missing".into()));
        }
        let id = Uuid::new_v4().to_string();
        let stored_path = format!("__planned__/{id}");
        sqlx::query(
            "INSERT INTO datasets
             (id, kind, extract_id, filename, stored_path, size_bytes, delimiter, has_header,
              columns_json, row_count, inspected_at, created_at, updated_at, workspace_id,
              producer_chip_run_id, status, source_chip_id, consumer_chip_id,
              source_extract_definition_id)
             VALUES (?, ?, NULL, ?, ?, NULL, ?, ?, ?, NULL, ?, ?, ?, ?, NULL,
                     'planned', ?, ?, ?)",
        )
        .bind(&id)
        .bind(kind)
        .bind(filename)
        .bind(&stored_path)
        .bind(delimiter)
        .bind(i64::from(header))
        .bind(columns_json)
        .bind(&now)
        .bind(&now)
        .bind(&now)
        .bind(workspace_id)
        .bind(source_chip_id)
        .bind(consumer_chip_id)
        .bind(source_extract_definition_id)
        .execute(&self.pool)
        .await?;
        self.get_dataset(&id)
            .await?
            .ok_or_else(|| StorageError::NotFound("planned dataset missing".into()))
    }

    pub async fn linked_chip_run_for_extract(
        &self,
        extract_id: &str,
    ) -> Result<Option<LinkedChipRun>, StorageError> {
        Ok(sqlx::query_as::<_, (String, String, String)>(
            "SELECT id, chip_id, workspace_id FROM chip_runs
             WHERE legacy_extract_id = ? AND status IN ('queued', 'running')",
        )
        .bind(extract_id)
        .fetch_optional(&self.pool)
        .await?
        .map(|(run_id, chip_id, workspace_id)| LinkedChipRun {
            run_id,
            chip_id,
            workspace_id,
        }))
    }

    pub async fn linked_chip_run_for_job(
        &self,
        job_id: &str,
    ) -> Result<Option<LinkedChipRun>, StorageError> {
        Ok(sqlx::query_as::<_, (String, String, String)>(
            "SELECT id, chip_id, workspace_id FROM chip_runs
             WHERE legacy_job_id = ? AND status IN ('queued', 'running')",
        )
        .bind(job_id)
        .fetch_optional(&self.pool)
        .await?
        .map(|(run_id, chip_id, workspace_id)| LinkedChipRun {
            run_id,
            chip_id,
            workspace_id,
        }))
    }

    pub(crate) async fn upsert_chip_output_slot_dataset(
        &self,
        tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
        workspace_id: &str,
        chip_id: &str,
        chip_run_id: &str,
        kind: &str,
        filename: &str,
        stored_path: &str,
        size_bytes: Option<i64>,
        row_count: Option<i64>,
        delimiter: Option<&str>,
        has_header: Option<bool>,
        extract_id: Option<&str>,
    ) -> Result<String, StorageError> {
        let existing: Option<String> = sqlx::query_scalar(
            "SELECT dataset_id FROM chip_output_slots
             WHERE workspace_id = ? AND chip_id = ?",
        )
        .bind(workspace_id)
        .bind(chip_id)
        .fetch_optional(&mut **tx)
        .await?;
        let had_slot = existing.is_some();
        let mut dataset_id = existing.unwrap_or_else(|| Uuid::new_v4().to_string());
        if !had_slot {
            if let Some(path_owner) =
                sqlx::query_scalar("SELECT id FROM datasets WHERE stored_path = ?")
                    .bind(stored_path)
                    .fetch_optional(&mut **tx)
                    .await?
            {
                dataset_id = path_owner;
            }
        }
        let now = now_rfc3339();
        let has_header_i64 = has_header.map(i64::from);
        sqlx::query(
            "INSERT INTO datasets
             (id, kind, extract_id, filename, stored_path, size_bytes, delimiter, has_header,
              row_count, created_at, updated_at, workspace_id, producer_chip_run_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               kind = excluded.kind,
               extract_id = excluded.extract_id,
               filename = excluded.filename,
               stored_path = excluded.stored_path,
               size_bytes = excluded.size_bytes,
               delimiter = COALESCE(excluded.delimiter, datasets.delimiter),
               has_header = COALESCE(excluded.has_header, datasets.has_header),
               row_count = COALESCE(excluded.row_count, datasets.row_count),
               workspace_id = excluded.workspace_id,
               producer_chip_run_id = excluded.producer_chip_run_id,
               updated_at = excluded.updated_at",
        )
        .bind(&dataset_id)
        .bind(kind)
        .bind(extract_id)
        .bind(filename)
        .bind(stored_path)
        .bind(size_bytes)
        .bind(delimiter)
        .bind(has_header_i64)
        .bind(row_count)
        .bind(&now)
        .bind(&now)
        .bind(workspace_id)
        .bind(chip_run_id)
        .execute(&mut **tx)
        .await?;
        sqlx::query(
            "INSERT INTO chip_output_slots
             (workspace_id, chip_id, dataset_id, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(workspace_id, chip_id) DO UPDATE SET
               dataset_id = excluded.dataset_id,
               updated_at = excluded.updated_at",
        )
        .bind(workspace_id)
        .bind(chip_id)
        .bind(&dataset_id)
        .bind(&now)
        .bind(&now)
        .execute(&mut **tx)
        .await?;
        Ok(dataset_id)
    }

    pub async fn set_chip_run_running(&self, id: &str) -> Result<(), StorageError> {
        let result = sqlx::query(
            "UPDATE chip_runs SET status = 'running', started_at = ?, error_message = NULL
             WHERE id = ? AND status = 'queued'",
        )
        .bind(now_rfc3339())
        .bind(id)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 0 {
            return Err(StorageError::Invalid(
                "chip run must be queued before starting".into(),
            ));
        }
        Ok(())
    }

    pub async fn attach_chip_run_extract(
        &self,
        id: &str,
        extract_id: &str,
    ) -> Result<(), StorageError> {
        update_running_chip_ref(&self.pool, id, "legacy_extract_id", extract_id).await
    }

    pub async fn attach_chip_run_job(&self, id: &str, job_id: &str) -> Result<(), StorageError> {
        update_running_chip_ref(&self.pool, id, "legacy_job_id", job_id).await
    }

    pub async fn set_chip_run_succeeded(
        &self,
        id: &str,
        output_dataset_id: &str,
    ) -> Result<(), StorageError> {
        let run = self
            .get_chip_run(id)
            .await?
            .ok_or_else(|| StorageError::NotFound("chip run not found".into()))?;
        let dataset = self
            .get_dataset(output_dataset_id)
            .await?
            .ok_or_else(|| StorageError::NotFound("output dataset not found".into()))?;
        if dataset.workspace_id != run.workspace_id
            || dataset.producer_chip_run_id.as_deref() != Some(id)
        {
            return Err(StorageError::Invalid(
                "output dataset provenance does not match chip run".into(),
            ));
        }
        let result = sqlx::query(
            "UPDATE chip_runs
             SET status = 'succeeded', output_dataset_id = ?, error_message = NULL,
                 finished_at = ?
             WHERE id = ? AND status = 'running'",
        )
        .bind(output_dataset_id)
        .bind(now_rfc3339())
        .bind(id)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 0 {
            return Err(StorageError::Invalid(
                "only a running chip run can succeed".into(),
            ));
        }
        Ok(())
    }

    pub async fn set_chip_run_failed(&self, id: &str, error: &str) -> Result<(), StorageError> {
        let result = sqlx::query(
            "UPDATE chip_runs
             SET status = 'failed', error_message = ?, finished_at = ?
             WHERE id = ? AND status IN ('queued', 'running')",
        )
        .bind(error)
        .bind(now_rfc3339())
        .bind(id)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 0 {
            return Err(StorageError::Invalid(
                "only a queued or running chip run can fail".into(),
            ));
        }
        Ok(())
    }

    pub(crate) async fn require_workspace(&self, id: &str) -> Result<(), StorageError> {
        if self.get_workspace(id).await?.is_none() {
            return Err(StorageError::NotFound("workspace not found".into()));
        }
        Ok(())
    }
}
