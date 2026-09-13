use crate::models::*;
use crate::*;

impl Store {
    /// Skips use the existing canceled storage state, with an explicit reason code.
    /// This preserves compatibility with older databases and cancellation readers.
    pub async fn skip_workspace_step(&self, id: &str, reason: &str) -> Result<(), StorageError> {
        let changed = sqlx::query("UPDATE execution_steps SET status='canceled', error_code='WORKSPACE_STEP_SKIPPED', error_message=?, finished_at=? WHERE id=? AND status='queued' AND execution_id IN (SELECT id FROM executions WHERE source='workspace' AND status='running')")
            .bind(reason).bind(now_rfc3339()).bind(id).execute(&self.pool).await?;
        if changed.rows_affected() != 1 {
            return Err(StorageError::Invalid("only a waiting workspace step can be skipped".into()));
        }
        self.append_execution_log(id, "info", "skipped", reason, None).await
    }

    /// Bind only runtime data IDs; recipe settings were frozen before any work started.
    pub async fn bind_workspace_step_input(&self, id: &str, input: Option<&str>, source: Option<&str>) -> Result<(), StorageError> {
        let mut tx = self.pool.begin().await?;
        let workspace: String = sqlx::query_scalar("SELECT e.workspace_id FROM execution_steps s JOIN executions e ON e.id=s.execution_id WHERE s.id=? AND s.status='queued' AND e.source='workspace' AND e.status='running'")
            .bind(id).fetch_optional(&mut *tx).await?
            .ok_or_else(|| StorageError::Invalid("workspace step is not waiting".into()))?;
        for dataset_id in [input, source].into_iter().flatten() {
            let valid: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM data_files WHERE id=? AND workspace_id=? AND deleted_at IS NULL")
                .bind(dataset_id).bind(&workspace).fetch_one(&mut *tx).await?;
            if valid != 1 {
                return Err(StorageError::Invalid("input dataset is unavailable in this workspace".into()));
            }
        }
        if let Some(input) = input {
            sqlx::query("INSERT INTO execution_inputs (execution_step_id, port_name, data_file_id, ordinal) VALUES (?, 'in', ?, 0)")
                .bind(id).bind(input).execute(&mut *tx).await?;
        }
        if let Some(source) = source {
            let changed = sqlx::query("UPDATE execution_steps SET definition_snapshot_json=json_set(definition_snapshot_json, '$.source_data_file_id', ?) WHERE id=? AND kind='validation'")
                .bind(source).bind(id).execute(&mut *tx).await?;
            if changed.rows_affected() != 1 {
                return Err(StorageError::Invalid("only validation steps accept a source input".into()));
            }
            sqlx::query("INSERT INTO execution_inputs (execution_step_id, port_name, data_file_id, ordinal) VALUES (?, 'source', ?, 1)")
                .bind(id).bind(source).execute(&mut *tx).await?;
        }
        tx.commit().await?;
        Ok(())
    }

    pub async fn skip_waiting_workspace_steps(&self, execution_id: &str, reason: &str) -> Result<(), StorageError> {
        let ids: Vec<String> = sqlx::query_scalar("SELECT id FROM execution_steps WHERE execution_id=? AND status='queued'")
            .bind(execution_id).fetch_all(&self.pool).await?;
        for id in ids {
            self.skip_workspace_step(&id, reason).await?;
        }
        Ok(())
    }

    pub async fn output_contract_filename(
        &self,
        workspace_id: &str,
        chip_id: &str,
    ) -> Result<Option<String>, StorageError> {
        let filename: Option<String> = sqlx::query_scalar(
            "SELECT COALESCE(
                     CASE c.kind WHEN 'extract' THEN e.output_filename
                                 WHEN 'transform' THEN t.output_filename_template END,
                     o.expected_filename)
             FROM workspace_chips wc
             INNER JOIN chips c ON c.id = wc.chip_id
             LEFT JOIN workspace_chip_outputs o ON o.workspace_chip_id = wc.id AND o.port_name = 'out'
             LEFT JOIN extracts e ON e.id = c.extract_id
             LEFT JOIN transforms t ON t.id = c.transform_id
             WHERE wc.workspace_id = ? AND wc.chip_id = ? LIMIT 1",
        )
        .bind(workspace_id)
        .bind(chip_id)
        .fetch_optional(&self.pool)
        .await?;
        // Older workspace contracts accidentally appended `.planned` while a
        // downstream input was unresolved. It is metadata, not part of a file name.
        Ok(filename.map(|name| {
            let mut clean = name;
            while clean.to_ascii_lowercase().ends_with(".planned") {
                clean.truncate(clean.len() - ".planned".len());
            }
            clean
        }))
    }

    pub async fn create_chip_run(
        &self,
        chip_id: &str,
        workspace_id: &str,
        expected_revision: i64,
        config_snapshot_json: &str,
        input_dataset_id: Option<&str>,
    ) -> Result<ChipRunRow, StorageError> {
        self.create_chip_run_in_execution(chip_id, workspace_id, expected_revision,
            config_snapshot_json, input_dataset_id, None).await
    }

    pub async fn create_chip_run_in_execution(
        &self,
        chip_id: &str,
        workspace_id: &str,
        expected_revision: i64,
        config_snapshot_json: &str,
        input_dataset_id: Option<&str>,
        parent_execution_id: Option<&str>,
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
        let execution_id = parent_execution_id.map(str::to_owned).unwrap_or_else(|| Uuid::new_v4().to_string());
        let placement_id: Option<String> = sqlx::query_scalar(
            "SELECT id FROM workspace_chips WHERE workspace_id = ? AND chip_id = ? LIMIT 1",
        )
        .bind(workspace_id)
        .bind(chip_id)
        .fetch_optional(&self.pool)
        .await?;
        let binding = self.get_chip_binding(chip_id).await?;
        let now = now_rfc3339();
        let mut tx = self.pool.begin().await?;
        if parent_execution_id.is_some() {
            let valid: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM executions WHERE id=? AND workspace_id=? AND source='workspace' AND status='running'")
                .bind(&execution_id).bind(workspace_id).fetch_one(&mut *tx).await?;
            if valid != 1 {
                return Err(StorageError::Invalid("workspace execution is not running".into()));
            }
        } else {
        sqlx::query(
            "INSERT INTO executions (id, workspace_id, source, trigger_id, status, created_at)
                     VALUES (?, ?, 'chip', ?, 'queued', ?)",
        )
        .bind(&execution_id)
        .bind(workspace_id)
        .bind(chip_id)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
        }
        let (extract_id, transform_id, load_id) = match binding
            .as_ref()
            .map(|b| (b.ref_kind.as_str(), b.ref_id.as_str()))
        {
            Some(("extract_recipe", id)) => (Some(id), None, None),
            Some(("transform", id)) => (None, Some(id), None),
            Some(("load_recipe", id)) => (None, None, Some(id)),
            _ => (None, None, None),
        };
        let result = sqlx::query(
            "INSERT INTO execution_steps
            (id, execution_id, workspace_chip_id, chip_id, kind, extract_id, transform_id, load_id,
             definition_revision, definition_snapshot_json, status, queued_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)",
        )
        .bind(&id)
        .bind(&execution_id)
        .bind(placement_id)
        .bind(chip_id)
        .bind(&task.kind)
        .bind(extract_id)
        .bind(transform_id)
        .bind(load_id)
        .bind(expected_revision)
        .bind(config_snapshot_json)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
        if let Some(file_id) = input_dataset_id {
            sqlx::query("INSERT INTO execution_inputs (execution_step_id, port_name, data_file_id, ordinal) VALUES (?, 'in', ?, 0)")
                .bind(&id).bind(file_id).execute(&mut *tx).await?;
        }
        tx.commit().await?;
        // Keep execution history bounded per chip. Logs and validation results
        // cascade with their execution step.
        sqlx::query(
            "DELETE FROM executions WHERE id IN (
               SELECT s.execution_id FROM execution_steps s
               INNER JOIN executions e ON e.id=s.execution_id
               WHERE e.source='chip' AND s.chip_id = ? AND s.status IN ('succeeded', 'failed', 'canceled')
               ORDER BY s.queued_at DESC LIMIT -1 OFFSET 50
             )",
        )
        .bind(chip_id)
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

    pub async fn recover_interrupted_workspace_executions(&self) -> Result<(), StorageError> {
        let now = now_rfc3339();
        let reason = "Server restarted before workspace execution completed";
        let mut tx = self.pool.begin().await?;
        sqlx::query("UPDATE execution_steps SET status='failed', error_code='EXECUTION_INTERRUPTED', error_message=?, finished_at=? WHERE status IN ('queued','running') AND execution_id IN (SELECT id FROM executions WHERE source='workspace' AND status IN ('queued','running'))")
            .bind(reason).bind(&now).execute(&mut *tx).await?;
        sqlx::query("UPDATE executions SET status='failed', error_message=?, finished_at=? WHERE source='workspace' AND status IN ('queued','running')")
            .bind(reason).bind(&now).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn create_workspace_execution(&self, workspace_id: &str, requested_by: &str) -> Result<String, StorageError> {
        self.require_workspace(workspace_id).await?;
        let id = Uuid::new_v4().to_string();
        let now = now_rfc3339();
        sqlx::query("INSERT INTO executions (id, workspace_id, requested_by, source, status, created_at, started_at) VALUES (?, ?, ?, 'workspace', 'running', ?, ?)")
            .bind(&id).bind(workspace_id).bind(requested_by).bind(&now).bind(&now).execute(&self.pool).await?;
        Ok(id)
    }

    pub async fn finish_workspace_execution(&self, id: &str, error: Option<&str>) -> Result<(), StorageError> {
        sqlx::query("UPDATE executions SET status=?, error_message=?, finished_at=? WHERE id=? AND source='workspace' AND status='running'")
            .bind(if error.is_some() { "failed" } else { "succeeded" }).bind(error).bind(now_rfc3339()).bind(id).execute(&self.pool).await?;
        Ok(())
    }

    pub async fn list_workspace_executions(&self, workspace_id: &str) -> Result<Vec<WorkspaceExecutionRow>, StorageError> {
        self.require_workspace(workspace_id).await?;
        Ok(sqlx::query_as::<_, WorkspaceExecutionRow>("SELECT id, workspace_id, status, created_at, started_at, finished_at, error_message FROM executions WHERE workspace_id=? AND source='workspace' ORDER BY created_at DESC, rowid DESC")
            .bind(workspace_id).fetch_all(&self.pool).await?)
    }

    pub async fn get_chip_run(&self, id: &str) -> Result<Option<ChipRunRow>, StorageError> {
        Ok(sqlx::query_as::<_, ChipRunRow>(&format!(
            "SELECT {CHIP_RUN_COLS} FROM execution_steps s INNER JOIN executions e ON e.id = s.execution_id WHERE s.id = ?"
        ))
        .bind(id)
        .fetch_optional(&self.pool)
        .await?)
    }

    pub async fn chip_run_result_json(&self, id: &str) -> Result<Option<String>, StorageError> {
        Ok(
            sqlx::query_scalar("SELECT result_json FROM execution_steps WHERE id = ?")
                .bind(id)
                .fetch_optional(&self.pool)
                .await?
                .flatten(),
        )
    }

    pub async fn list_chip_runs(
        &self,
        workspace_id: &str,
    ) -> Result<Vec<ChipRunRow>, StorageError> {
        self.require_workspace(workspace_id).await?;
        Ok(sqlx::query_as::<_, ChipRunRow>(&format!(
            "SELECT {CHIP_RUN_COLS} FROM execution_steps s INNER JOIN executions e ON e.id = s.execution_id
             WHERE e.workspace_id = ? AND s.chip_id IS NOT NULL ORDER BY s.queued_at DESC"
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
            "SELECT we.id, we.workspace_id, fc.chip_id AS from_chip_id, tc.chip_id AS to_chip_id,
                    we.kind, we.from_port, we.to_port, we.created_at
             FROM workspace_edges we INNER JOIN workspace_chips fc ON fc.id = we.from_workspace_chip_id
             INNER JOIN workspace_chips tc ON tc.id = we.to_workspace_chip_id
             WHERE we.workspace_id = ? ORDER BY we.created_at ASC"
        ))
        .bind(workspace_id)
        .fetch_all(&self.pool)
        .await?)
    }

    pub async fn latest_chip_output(&self, chip_id: &str) -> Result<Option<String>, StorageError> {
        Ok(sqlx::query_scalar(
            "SELECT o.data_file_id FROM execution_steps s INNER JOIN execution_outputs o ON o.execution_step_id = s.id
             INNER JOIN data_files d ON d.id = o.data_file_id
             WHERE s.chip_id = ? AND s.status = 'succeeded' AND d.deleted_at IS NULL
             ORDER BY COALESCE(s.finished_at, s.queued_at) DESC
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
            "SELECT o.current_data_file_id FROM workspace_chip_outputs o
             INNER JOIN workspace_chips wc ON wc.id = o.workspace_chip_id
             INNER JOIN data_files d ON d.id = o.current_data_file_id
             WHERE wc.workspace_id = ? AND wc.chip_id = ? AND d.deleted_at IS NULL",
        )
        .bind(workspace_id)
        .bind(chip_id)
        .fetch_optional(&self.pool)
        .await?;
        if slot_id.is_some() {
            return Ok(slot_id);
        }
        Ok(sqlx::query_scalar(
            "SELECT o.data_file_id FROM execution_steps s INNER JOIN executions e ON e.id = s.execution_id
             INNER JOIN execution_outputs o ON o.execution_step_id = s.id
             INNER JOIN data_files d ON d.id = o.data_file_id
             WHERE s.chip_id = ? AND e.workspace_id = ? AND s.status = 'succeeded'
               AND d.deleted_at IS NULL
             ORDER BY COALESCE(s.finished_at, s.queued_at) DESC
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
        let row = sqlx::query_as::<_, (String, String, Option<String>, String)>(
            "SELECT o.expected_filename, COALESCE(s.columns_json, '[]'), o.schema_id, fc.chip_id
             FROM workspace_edges e
             INNER JOIN workspace_chips tc ON tc.id=e.to_workspace_chip_id
             INNER JOIN workspace_chips fc ON fc.id=e.from_workspace_chip_id
             INNER JOIN workspace_chip_outputs o ON o.workspace_chip_id=fc.id AND o.port_name='out'
             LEFT JOIN data_schemas s ON s.id=o.schema_id
             WHERE e.workspace_id=? AND tc.chip_id=? AND e.kind='data' LIMIT 1",
        )
        .bind(workspace_id)
        .bind(consumer_chip_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(
            row.map(|(filename, columns_json, _, source_chip_id)| DatasetRow {
                id: format!("contract:{workspace_id}:{consumer_chip_id}"),
                kind: "transform".into(),
                extract_id: None,
                filename,
                stored_path: String::new(),
                size_bytes: None,
                delimiter: Some(",".into()),
                has_header: Some(1),
                columns_json: Some(columns_json),
                row_count: None,
                inspected_at: None,
                created_at: now_rfc3339(),
                updated_at: now_rfc3339(),
                workspace_id: workspace_id.into(),
                producer_chip_run_id: None,
                table_name: String::new(),
                connection_name: String::new(),
                status: "planned".into(),
                source_chip_id: Some(source_chip_id),
                consumer_chip_id: Some(consumer_chip_id.into()),
                source_extract_definition_id: None,
            }),
        )
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
        let _ = (source_extract_definition_id, kind, delimiter, header);
        let schema = self.upsert_data_schema(columns_json).await?;
        let placement: String = sqlx::query_scalar(
            "SELECT id FROM workspace_chips WHERE workspace_id=? AND chip_id=? LIMIT 1",
        )
        .bind(workspace_id)
        .bind(source_chip_id)
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(|| StorageError::NotFound("source chip placement not found".into()))?;
        sqlx::query("INSERT INTO workspace_chip_outputs (workspace_chip_id, port_name, schema_id, expected_filename, definition_revision, updated_at)
            VALUES (?, 'out', ?, ?, 1, ?) ON CONFLICT(workspace_chip_id, port_name) DO UPDATE SET
            schema_id=excluded.schema_id, expected_filename=excluded.expected_filename, updated_at=excluded.updated_at")
            .bind(placement).bind(schema.id).bind(filename).bind(now_rfc3339()).execute(&self.pool).await?;
        self.find_planned_input_dataset(workspace_id, consumer_chip_id)
            .await?
            .ok_or_else(|| StorageError::NotFound("planned input contract missing".into()))
    }

    pub async fn linked_chip_run_for_extract(
        &self,
        extract_id: &str,
    ) -> Result<Option<LinkedChipRun>, StorageError> {
        Ok(sqlx::query_as::<_, (String, String, String)>(
            "SELECT p.id, COALESCE(p.chip_id, x.trigger_id), x.workspace_id
             FROM execution_steps p INNER JOIN executions x ON x.id=p.execution_id
             WHERE p.id=?
               AND (p.chip_id IS NOT NULL OR (x.source='chip' AND x.trigger_id IS NOT NULL))
               AND p.status IN ('queued','running')
             UNION ALL
             SELECT p.id, p.chip_id, x.workspace_id FROM execution_steps p INNER JOIN executions x ON x.id=p.execution_id
             WHERE json_extract(p.result_json, '$.child_step_id')=? AND p.status IN ('queued','running')
             LIMIT 1",
        )
        .bind(extract_id)
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
            "SELECT p.id, p.chip_id, x.workspace_id FROM execution_steps p INNER JOIN executions x ON x.id=p.execution_id
             WHERE json_extract(p.result_json, '$.child_step_id')=? AND p.status IN ('queued','running')",
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
        let placement_id: String = sqlx::query_scalar(
            "SELECT id FROM workspace_chips WHERE workspace_id=? AND chip_id=? LIMIT 1",
        )
        .bind(workspace_id)
        .bind(chip_id)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or_else(|| StorageError::NotFound("chip placement not found".into()))?;
        let mut dataset_id = sqlx::query_scalar("SELECT id FROM data_files WHERE stored_path=?")
            .bind(stored_path)
            .fetch_optional(&mut **tx)
            .await?
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let now = now_rfc3339();
        let has_header_i64 = has_header.map(i64::from);
        // Try to insert a new data_files row keyed by stored_path. If another concurrent
        // transaction created the same stored_path, use ON CONFLICT(stored_path) DO UPDATE
        // so the statement does not fail. After the upsert, query the actual id by stored_path
        // to ensure we reference the correct dataset id (either existing or newly created).
        sqlx::query(
            "INSERT INTO data_files
             (id, workspace_id, kind, format, filename, stored_path, size_bytes, delimiter, has_header,
              row_count, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(stored_path) DO UPDATE SET
               kind = excluded.kind,
               filename = excluded.filename,
               size_bytes = excluded.size_bytes,
               delimiter = COALESCE(excluded.delimiter, data_files.delimiter),
               has_header = COALESCE(excluded.has_header, data_files.has_header),
               row_count = COALESCE(excluded.row_count, data_files.row_count),
               workspace_id = excluded.workspace_id,
               deleted_at = NULL,
               updated_at = excluded.updated_at",
        )
        .bind(&dataset_id)
        .bind(workspace_id)
        .bind(kind)
        .bind(if filename.ends_with(".parquet") { "parquet" } else { "csv" })
        .bind(filename)
        .bind(stored_path)
        .bind(size_bytes)
        .bind(delimiter)
        .bind(has_header_i64)
        .bind(row_count)
        .bind(&now)
        .bind(&now)
        .execute(&mut **tx)
        .await?;
        // Re-fetch the id for the stored_path to get the canonical id (in case of conflict)
        dataset_id = sqlx::query_scalar("SELECT id FROM data_files WHERE stored_path=?")
            .bind(stored_path)
            .fetch_one(&mut **tx)
            .await?;
        let _ = extract_id;
        sqlx::query("INSERT OR REPLACE INTO execution_outputs (execution_step_id, port_name, data_file_id) VALUES (?, 'out', ?)")
            .bind(chip_run_id).bind(&dataset_id).execute(&mut **tx).await?;
        sqlx::query(
            "INSERT INTO workspace_chip_outputs
             (workspace_chip_id, port_name, current_data_file_id, expected_filename, definition_revision, updated_at)
             VALUES (?, 'out', ?, ?, 1, ?)
             ON CONFLICT(workspace_chip_id, port_name) DO UPDATE SET
               current_data_file_id = excluded.current_data_file_id, expected_filename=excluded.expected_filename,
               updated_at = excluded.updated_at",
        )
        .bind(placement_id)
        .bind(&dataset_id)
        .bind(filename)
        .bind(&now)
        .execute(&mut **tx)
        .await?;
        Ok(dataset_id)
    }

    pub async fn set_chip_run_running(&self, id: &str) -> Result<(), StorageError> {
        let result = sqlx::query(
            "UPDATE execution_steps SET status = 'running', started_at = ?, error_message = NULL
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
        link_child_step(&self.pool, id, extract_id).await
    }

    pub async fn attach_chip_run_job(&self, id: &str, job_id: &str) -> Result<(), StorageError> {
        link_child_step(&self.pool, id, job_id).await
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
            "UPDATE execution_steps
             SET status = 'succeeded', error_message = NULL, finished_at = ?,
                 result_json = json_set(COALESCE(result_json, '{}'), '$.output_data_file_id', ?)
             WHERE id = ? AND status = 'running'",
        )
        .bind(now_rfc3339())
        .bind(output_dataset_id)
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
        self.set_chip_run_failed_with_code(id, "INTERNAL_UNCLASSIFIED", error)
            .await
    }

    pub async fn set_chip_run_failed_with_code(
        &self,
        id: &str,
        error_code: &str,
        error: &str,
    ) -> Result<(), StorageError> {
        let result = sqlx::query(
            "UPDATE execution_steps
             SET status = 'failed', error_code = ?, error_message = ?, finished_at = COALESCE(finished_at, ?)
             WHERE id = ? AND status IN ('queued', 'running', 'failed')",
        )
        .bind(error_code)
        .bind(error)
        .bind(now_rfc3339())
        .bind(id)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 0 {
            return Err(StorageError::Invalid(
                "chip run cannot be marked failed".into(),
            ));
        }
        Ok(())
    }

    pub async fn finish_validation_chip_run(
        &self,
        id: &str,
        passed: bool,
        result_json: &str,
        source_rows: i64,
        target_rows: i64,
    ) -> Result<(), StorageError> {
        require_config_json(result_json)?;
        let result = sqlx::query(
            "UPDATE execution_steps
             SET status = ?, result_json = ?, input_rows = ?, output_rows = ?,
                 error_code = ?, error_message = ?, finished_at = ?
             WHERE id = ? AND status = 'running'",
        )
        .bind(if passed { "succeeded" } else { "failed" })
        .bind(result_json)
        .bind(source_rows)
        .bind(target_rows)
        .bind(if passed {
            None
        } else {
            Some("VALIDATION_DIFFERENCE_FOUND")
        })
        .bind(if passed {
            None
        } else {
            Some("validation differences found")
        })
        .bind(now_rfc3339())
        .bind(id)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 0 {
            return Err(StorageError::Invalid(
                "only a running validation run can finish".into(),
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

#[cfg(test)]
mod workspace_execution_tests {
    use super::*;

    #[tokio::test]
    async fn workspace_skip_and_runtime_binding_preserve_snapshots_and_scope() {
        let root = std::env::temp_dir().join(format!("bintl-workspace-inputs-{}", Uuid::new_v4()));
        let store = Store::open(&root, "test-secret").await.unwrap();
        let user = store.ensure_bootstrap("admin", "admin").await.unwrap();
        let workspace = store.insert_workspace("Inputs", None, &user.id, None).await.unwrap();
        let other = store.insert_workspace("Other", None, &user.id, None).await.unwrap();
        let config = r#"{"source_data_file_id":"","keys":["id"],"workspace_rule_snapshot":true}"#;
        let chip = store.insert_chip(&user.id, &workspace.id, "Compare", "validation", config).await.unwrap();
        store.attach_chip_to_workspace(&workspace.id, &chip.id).await.unwrap();
        let execution = store.create_workspace_execution(&workspace.id, &user.id).await.unwrap();
        let run = store.create_chip_run_in_execution(&chip.id, &workspace.id, chip.revision, config, None, Some(&execution)).await.unwrap();
        let source = Uuid::new_v4().to_string();
        let target = Uuid::new_v4().to_string();
        let foreign = Uuid::new_v4().to_string();
        for (id, owner) in [(&source, &workspace.id), (&target, &workspace.id), (&foreign, &other.id)] {
            sqlx::query("INSERT INTO data_files (id, workspace_id, kind, format, filename, stored_path, created_at, updated_at) VALUES (?, ?, 'upload', 'csv', 'test.csv', ?, ?, ?)")
                .bind(id).bind(owner).bind(format!("uploads/{id}.csv"))
                .bind(now_rfc3339()).bind(now_rfc3339()).execute(&store.pool).await.unwrap();
        }
        // A bad source must roll back the otherwise valid target binding.
        assert!(store.bind_workspace_step_input(&run.id, Some(&target), Some(&foreign)).await.is_err());
        let untouched = store.get_chip_run(&run.id).await.unwrap().unwrap();
        assert!(untouched.input_dataset_id.is_none());
        assert_eq!(untouched.config_snapshot_json, config);
        store.bind_workspace_step_input(&run.id, Some(&target), Some(&source)).await.unwrap();
        let bound = store.get_chip_run(&run.id).await.unwrap().unwrap();
        assert_eq!(bound.input_dataset_id.as_deref(), Some(target.as_str()));
        let snapshot: serde_json::Value = serde_json::from_str(&bound.config_snapshot_json).unwrap();
        assert_eq!(snapshot["source_data_file_id"], source);
        assert_eq!(snapshot["keys"], serde_json::json!(["id"]));
        assert_eq!(snapshot["workspace_rule_snapshot"], true);
        assert!(store.bind_workspace_step_input(&run.id, Some(&target), Some(&source)).await.is_err());
        store.skip_workspace_step(&run.id, "Condition not met").await.unwrap();
        let skipped = store.get_chip_run(&run.id).await.unwrap().unwrap();
        assert_eq!(skipped.status, "canceled");
        assert_eq!(skipped.error_code.as_deref(), Some("WORKSPACE_STEP_SKIPPED"));
        assert!(skipped.started_at.is_none() && skipped.finished_at.is_some());
        assert_eq!(store.list_logs(&run.id).await.unwrap()[0].message, "Condition not met");
        assert_eq!(store.get_execution(&execution).await.unwrap().unwrap().status, "running");
        assert!(store.skip_workspace_step(&run.id, "Again").await.is_err());
        assert!(store.bind_workspace_step_input(&run.id, None, None).await.is_err());

        let running = store.create_chip_run_in_execution(&chip.id, &workspace.id, chip.revision, config, None, Some(&execution)).await.unwrap();
        store.set_chip_run_running(&running.id).await.unwrap();
        assert!(store.skip_workspace_step(&running.id, "Too late").await.is_err());
        let standalone = store.create_chip_run(&chip.id, &workspace.id, chip.revision, config, None).await.unwrap();
        assert!(store.skip_workspace_step(&standalone.id, "Not a workspace step").await.is_err());
        assert!(store.bind_workspace_step_input(&standalone.id, None, None).await.is_err());
        store.pool.close().await;
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn workspace_execution_is_grouped_and_only_orchestrator_finishes_it() {
        let root = std::env::temp_dir().join(format!("bintl-workspace-runs-{}", Uuid::new_v4()));
        let store = Store::open(&root, "test-secret").await.unwrap();
        let user = store.ensure_bootstrap("admin", "admin").await.unwrap();
        let workspace = store.insert_workspace("History", None, &user.id, None).await.unwrap();
        let config = r#"{"connection_id":"c","source":{"type":"table","table":"users"}}"#;
        let chip = store.insert_chip(&user.id, &workspace.id, "Users", "extract", config).await.unwrap();
        store.attach_chip_to_workspace(&workspace.id, &chip.id).await.unwrap();
        let execution = store.create_workspace_execution(&workspace.id, &user.id).await.unwrap();
        let first = store.create_chip_run_in_execution(&chip.id, &workspace.id, chip.revision, config, None, Some(&execution)).await.unwrap();
        assert_eq!(first.execution_id, execution);
        assert_eq!(first.execution_source, "workspace");
        store.set_execution_step_running(&first.id, None).await.unwrap();
        store.finish_execution_step(&first.id, "succeeded", None, None).await.unwrap();
        let parent = store.get_execution(&execution).await.unwrap().unwrap();
        assert_eq!(parent.status, "running");
        assert!(parent.finished_at.is_none());
        let second = store.create_chip_run_in_execution(&chip.id, &workspace.id, chip.revision, config, None, Some(&execution)).await.unwrap();
        store.set_chip_run_running(&second.id).await.unwrap();
        store.set_chip_run_failed(&second.id, "failed second chip").await.unwrap();
        store.append_execution_log(&second.id, "error", "failed", "workspace-only log", None).await.unwrap();
        assert_eq!(store.get_execution(&execution).await.unwrap().unwrap().status, "running");
        store.finish_workspace_execution(&execution, Some("failed second chip")).await.unwrap();
        let parent = store.get_execution(&execution).await.unwrap().unwrap();
        assert_eq!(parent.status, "failed");
        assert!(parent.finished_at.is_some());
        assert!(store.create_chip_run_in_execution(&chip.id, &workspace.id, chip.revision, config, None, Some(&execution)).await.is_err());

        // Per-chip pruning must never delete a grouped execution or its logs.
        for _ in 0..52 {
            let single = store.create_chip_run(&chip.id, &workspace.id, chip.revision, config, None).await.unwrap();
            assert_eq!(single.execution_source, "chip");
            store.set_chip_run_failed(&single.id, "standalone").await.unwrap();
        }
        assert_eq!(store.list_workspace_executions(&workspace.id).await.unwrap().len(), 1);
        assert_eq!(store.list_logs(&second.id).await.unwrap()[0].message, "workspace-only log");
        assert_eq!(store.list_chip_runs(&workspace.id).await.unwrap().iter().filter(|run| run.execution_id == execution).count(), 2);
        // Removing an extract output must not delete its whole workspace execution.
        store.delete_extract(&first.id).await.unwrap();
        assert!(store.get_chip_run(&second.id).await.unwrap().is_some());
        assert!(store.get_execution(&execution).await.unwrap().is_some());

        let success = store.create_workspace_execution(&workspace.id, &user.id).await.unwrap();
        let step = store.create_chip_run_in_execution(&chip.id, &workspace.id, chip.revision, config, None, Some(&success)).await.unwrap();
        store.finish_execution_step(&step.id, "succeeded", None, None).await.unwrap();
        store.finish_workspace_execution(&success, None).await.unwrap();
        assert_eq!(store.list_workspace_executions(&workspace.id).await.unwrap()[0].status, "succeeded");
        let interrupted = store.create_workspace_execution(&workspace.id, &user.id).await.unwrap();
        let pending = store.create_chip_run_in_execution(&chip.id, &workspace.id, chip.revision, config, None, Some(&interrupted)).await.unwrap();
        store.recover_interrupted_workspace_executions().await.unwrap();
        assert_eq!(store.get_chip_run(&pending.id).await.unwrap().unwrap().status, "failed");
        assert_eq!(store.get_execution(&interrupted).await.unwrap().unwrap().status, "failed");
        assert_eq!(store.get_execution(&success).await.unwrap().unwrap().status, "succeeded");
        store.pool.close().await;
        let _ = std::fs::remove_dir_all(root);
    }
}
