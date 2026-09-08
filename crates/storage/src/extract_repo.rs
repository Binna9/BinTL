use crate::models::*;
use crate::*;

impl Store {
    pub fn extracts_dir(&self) -> PathBuf {
        self.data_dir.join("extract_runs")
    }

    pub async fn insert_extract(
        &self,
        kind: &str,
        connection_id: &str,
        table_name: &str,
        delimiter: &str,
        header: bool,
        add_sequence: bool,
        sql_text: Option<&str>,
        catalog_database: Option<&str>,
        workspace_id: &str,
        output_filename: Option<&str>,
    ) -> Result<ExtractRow, StorageError> {
        let kind = validate_extract_kind(kind)?;
        self.require_workspace(workspace_id).await?;
        let _ = self
            .get_connection(connection_id)
            .await?
            .ok_or_else(|| StorageError::NotFound("connection not found".into()))?;
        let owner_user_id: String = sqlx::query_scalar("SELECT COALESCE(owner_user_id, (SELECT id FROM users WHERE active = 1 ORDER BY created_at LIMIT 1)) FROM workspaces WHERE id = ?")
            .bind(workspace_id).fetch_optional(&self.pool).await?
            .ok_or_else(|| StorageError::Invalid("extract owner is unavailable".into()))?;
        let definition_id = Uuid::new_v4().to_string();
        let execution_id = Uuid::new_v4().to_string();
        let id = Uuid::new_v4().to_string();
        let created_at = now_rfc3339();
        let source_json = serde_json::json!({"table_name": table_name, "sql_text": sql_text,
            "catalog_database": catalog_database})
        .to_string();
        let filename = output_filename.unwrap_or("extract.csv");
        let snapshot = serde_json::json!({"kind": kind, "connection_id": connection_id,
            "table_name": table_name, "delimiter": delimiter, "header": header,
            "add_sequence": add_sequence, "sql_text": sql_text, "catalog_database": catalog_database,
            "output_filename": output_filename}).to_string();
        let mut tx = self.pool.begin().await?;
        sqlx::query("INSERT INTO extracts (id, owner_user_id, name, source_type, connection_id,
            source_json, output_format, output_filename, delimiter, has_header, add_sequence,
            revision, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'csv', ?, ?, ?, ?, 1, 1, ?, ?)")
            .bind(&definition_id).bind(owner_user_id).bind(table_name).bind(kind).bind(connection_id)
            .bind(&source_json).bind(filename).bind(delimiter).bind(i64::from(header))
            .bind(i64::from(add_sequence)).bind(&created_at).bind(&created_at).execute(&mut *tx).await?;
        sqlx::query(
            "INSERT INTO executions (id, workspace_id, source, trigger_id, status, created_at)
            VALUES (?, ?, 'extract_page', ?, 'queued', ?)",
        )
        .bind(&execution_id)
        .bind(workspace_id)
        .bind(&definition_id)
        .bind(&created_at)
        .execute(&mut *tx)
        .await?;
        sqlx::query("INSERT INTO execution_steps (id, execution_id, kind, extract_id, definition_revision,
            definition_snapshot_json, status, queued_at) VALUES (?, ?, 'extract', ?, 1, ?, 'queued', ?)")
            .bind(&id).bind(&execution_id).bind(&definition_id).bind(snapshot).bind(&created_at).execute(&mut *tx).await?;
        tx.commit().await?;
        search::sync_search_best_effort(self, "extract", self.sync_search_extract(&id)).await;
        self.get_extract(&id)
            .await?
            .ok_or_else(|| StorageError::NotFound("extract disappeared after insert".into()))
    }

    pub async fn get_extract(&self, id: &str) -> Result<Option<ExtractRow>, StorageError> {
        let row = sqlx::query_as::<_, ExtractRow>(&format!(
            "SELECT {EXTRACT_COLS} FROM execution_steps s INNER JOIN executions x ON x.id = s.execution_id
             LEFT JOIN connections c ON c.id = json_extract(s.definition_snapshot_json, '$.connection_id')
             WHERE s.id = ? AND s.kind = 'extract'"
        ))
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row)
    }

    pub async fn list_extracts(
        &self,
        limit: i64,
        scope: Option<&DataScope>,
    ) -> Result<Vec<ExtractRow>, StorageError> {
        let (extra, binds) = match scope {
            Some(scope) => Self::workspace_scope_sql(scope, "x.workspace_id"),
            None => (String::new(), Vec::new()),
        };
        let sql = format!(
            "SELECT {EXTRACT_COLS} FROM execution_steps s INNER JOIN executions x ON x.id = s.execution_id
             LEFT JOIN connections c ON c.id = json_extract(s.definition_snapshot_json, '$.connection_id')
             WHERE s.kind = 'extract'
               AND NOT (s.chip_id IS NOT NULL AND json_extract(s.result_json, '$.child_step_id') IS NOT NULL)
               AND (
                 (s.status != 'succeeded' AND x.source != 'chip')
                 OR EXISTS (
                   SELECT 1
                   FROM execution_outputs visible_output
                   INNER JOIN data_files visible_file ON visible_file.id = visible_output.data_file_id
                   WHERE visible_output.execution_step_id = s.id
                     AND visible_file.deleted_at IS NULL
                     AND NOT EXISTS (
                       SELECT 1
                       FROM execution_outputs newer_output
                       INNER JOIN execution_steps newer_step ON newer_step.id = newer_output.execution_step_id
                       WHERE newer_output.data_file_id = visible_output.data_file_id
                         AND newer_step.kind = 'extract'
                         AND (
                           newer_step.queued_at > s.queued_at
                           OR (newer_step.queued_at = s.queued_at AND newer_step.id > s.id)
                         )
                     )
                 )
               )
               {extra} ORDER BY s.queued_at DESC LIMIT ?"
        );
        let mut query = sqlx::query_as::<_, ExtractRow>(&sql);
        for value in &binds {
            query = query.bind(value);
        }
        let rows = query.bind(limit).fetch_all(&self.pool).await?;
        Ok(rows)
    }

    pub async fn delete_extract(&self, id: &str) -> Result<(), StorageError> {
        let row = self
            .get_extract(id)
            .await?
            .ok_or_else(|| StorageError::NotFound("extract not found".into()))?;
        let mut tx = self.pool.begin().await?;
        sqlx::query(
            "UPDATE workspace_chip_outputs SET current_data_file_id = NULL, updated_at = ?
             WHERE current_data_file_id IN
             (SELECT data_file_id FROM execution_outputs WHERE execution_step_id = ?)",
        )
        .bind(now_rfc3339())
        .bind(id)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "UPDATE data_files SET deleted_at = ?, updated_at = ? WHERE id IN
            (SELECT data_file_id FROM execution_outputs WHERE execution_step_id = ?)",
        )
        .bind(now_rfc3339())
        .bind(now_rfc3339())
        .bind(id)
        .execute(&mut *tx)
        .await?;
        let deleted = sqlx::query("DELETE FROM executions WHERE id = (SELECT execution_id FROM execution_steps WHERE id = ?)")
            .bind(id).execute(&mut *tx).await?;
        if deleted.rows_affected() == 0 {
            return Err(StorageError::NotFound("extract not found".into()));
        }
        tx.commit().await?;
        let mut dirs = Vec::new();
        if let Some(rel) = row.stored_path.as_deref() {
            let path = self.resolve(rel);
            if let Some(parent) = path.parent() {
                dirs.push(parent.to_path_buf());
            }
        }
        dirs.push(self.data_dir.join(REL_DATABASES).join(id));
        dirs.push(self.data_dir.join(REL_API).join(id));
        let mut seen = HashSet::new();
        for dir in dirs {
            if !seen.insert(dir.clone()) {
                continue;
            }
            match tokio::fs::remove_dir_all(&dir).await {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }

        let _ = self.delete_search_document("extract", id).await;
        Ok(())
    }

    pub async fn set_extract_running(&self, id: &str) -> Result<(), StorageError> {
        sqlx::query(
            "UPDATE execution_steps SET status = ?, started_at = ?, error_message = NULL WHERE id = ?",
        )
        .bind("running")
        .bind(now_rfc3339())
        .bind(id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn prepare_extract_chip_run(
        &self,
        id: &str,
        snapshot_json: &str,
    ) -> Result<(), StorageError> {
        require_config_json(snapshot_json)?;
        let result = sqlx::query(
            "UPDATE execution_steps SET definition_snapshot_json = ?
             WHERE id = ? AND kind = 'extract' AND chip_id IS NOT NULL AND status = 'queued'",
        )
        .bind(snapshot_json)
        .bind(id)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 0 {
            return Err(StorageError::Invalid(
                "extract chip run must be queued before preparation".into(),
            ));
        }
        Ok(())
    }

    pub async fn set_extract_succeeded(
        &self,
        id: &str,
        stored_path: &str,
        filename: &str,
        row_count: i64,
    ) -> Result<(), StorageError> {
        let row = self
            .get_extract(id)
            .await?
            .ok_or_else(|| StorageError::NotFound("extract not found".into()))?;
        let size = tokio::fs::metadata(self.resolve(stored_path))
            .await
            .ok()
            .map(|metadata| metadata.len() as i64);
        let linked = self.linked_chip_run_for_extract(id).await?;
        let now = now_rfc3339();
        let mut tx = self.pool.begin().await?;
        let mut file_id = Uuid::new_v4().to_string();
        // Use upsert keyed by stored_path to avoid UNIQUE constraint failures when multiple
        // extract runs produce the same stored_path concurrently.
        sqlx::query(
            "INSERT INTO data_files (id, workspace_id, kind, format, filename, stored_path,
            size_bytes, row_count, delimiter, has_header, created_at, updated_at)
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
        .bind(&file_id)
        .bind(&row.workspace_id)
        .bind(&row.kind)
        .bind(if filename.ends_with(".parquet") {
            "parquet"
        } else {
            "csv"
        })
        .bind(filename)
        .bind(stored_path)
        .bind(size)
        .bind(row_count)
        .bind(&row.delimiter)
        .bind(row.header)
        .bind(&now)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
        // Re-fetch canonical id for the stored_path (in case of conflict)
        file_id = sqlx::query_scalar("SELECT id FROM data_files WHERE stored_path=?")
            .bind(stored_path)
            .fetch_one(&mut *tx)
            .await?;
        // Extract chips own one mutable output slot, just like transform chips.
        // Older versions wrote one dataset/file per execution, leaving duplicate
        // filenames in the file catalog. Retire every previous output of this
        // workspace chip while preserving its execution lineage row.
        let stale_paths = if let Some(parent) = linked.as_ref() {
            let paths = sqlx::query_scalar::<_, String>(
                "SELECT DISTINCT d.stored_path
                 FROM execution_steps s
                 INNER JOIN executions e ON e.id = s.execution_id
                 INNER JOIN execution_outputs o ON o.execution_step_id = s.id
                 INNER JOIN data_files d ON d.id = o.data_file_id
                 WHERE s.chip_id = ? AND e.workspace_id = ? AND s.kind = 'extract'
                   AND d.id != ? AND d.deleted_at IS NULL",
            )
            .bind(&parent.chip_id)
            .bind(&parent.workspace_id)
            .bind(&file_id)
            .fetch_all(&mut *tx)
            .await?;
            sqlx::query(
                "UPDATE data_files SET deleted_at = ?, updated_at = ?
                 WHERE id IN (
                   SELECT DISTINCT o.data_file_id
                   FROM execution_steps s
                   INNER JOIN executions e ON e.id = s.execution_id
                   INNER JOIN execution_outputs o ON o.execution_step_id = s.id
                   WHERE s.chip_id = ? AND e.workspace_id = ? AND s.kind = 'extract'
                     AND o.data_file_id != ?
                 ) AND deleted_at IS NULL",
            )
            .bind(&now)
            .bind(&now)
            .bind(&parent.chip_id)
            .bind(&parent.workspace_id)
            .bind(&file_id)
            .execute(&mut *tx)
            .await?;
            paths
        } else {
            // The extract page creates a fresh definition/execution for every run.
            // Treat matching source + output settings as one logical standalone
            // output slot so reruns keep history without duplicating datasets in
            // the Files page. Different tables/queries remain independent even
            // when they use the same display filename.
            let paths = sqlx::query_scalar::<_, String>(
                "SELECT DISTINCT d.stored_path
                 FROM execution_steps previous
                 INNER JOIN executions previous_execution ON previous_execution.id = previous.execution_id
                 INNER JOIN execution_outputs o ON o.execution_step_id = previous.id
                 INNER JOIN data_files d ON d.id = o.data_file_id
                 WHERE previous.id != ? AND previous.kind = 'extract'
                   AND previous.chip_id IS NULL
                   AND previous_execution.workspace_id = ?
                   AND json_extract(previous.definition_snapshot_json, '$.kind') = ?
                   AND json_extract(previous.definition_snapshot_json, '$.connection_id') = ?
                   AND json_extract(previous.definition_snapshot_json, '$.table_name') = ?
                   AND COALESCE(json_extract(previous.definition_snapshot_json, '$.sql_text'), '') = COALESCE(?, '')
                   AND COALESCE(json_extract(previous.definition_snapshot_json, '$.catalog_database'), '') = COALESCE(?, '')
                   AND COALESCE(json_extract(previous.definition_snapshot_json, '$.output_filename'), '') = COALESCE(?, '')
                   AND COALESCE(json_extract(previous.definition_snapshot_json, '$.delimiter'), ',') = ?
                   AND COALESCE(json_extract(previous.definition_snapshot_json, '$.header'), 1) = ?
                   AND COALESCE(json_extract(previous.definition_snapshot_json, '$.add_sequence'), 0) = ?
                   AND d.id != ? AND d.deleted_at IS NULL",
            )
            .bind(id)
            .bind(&row.workspace_id)
            .bind(&row.kind)
            .bind(&row.connection_id)
            .bind(&row.table_name)
            .bind(row.sql_text.as_deref())
            .bind(row.catalog_database.as_deref())
            .bind(row.output_filename.as_deref())
            .bind(&row.delimiter)
            .bind(row.header)
            .bind(row.add_sequence)
            .bind(&file_id)
            .fetch_all(&mut *tx)
            .await?;
            sqlx::query(
                "UPDATE data_files SET deleted_at = ?, updated_at = ?
                 WHERE id IN (
                   SELECT DISTINCT o.data_file_id
                   FROM execution_steps previous
                   INNER JOIN executions previous_execution ON previous_execution.id = previous.execution_id
                   INNER JOIN execution_outputs o ON o.execution_step_id = previous.id
                   WHERE previous.id != ? AND previous.kind = 'extract'
                     AND previous.chip_id IS NULL
                     AND previous_execution.workspace_id = ?
                     AND json_extract(previous.definition_snapshot_json, '$.kind') = ?
                     AND json_extract(previous.definition_snapshot_json, '$.connection_id') = ?
                     AND json_extract(previous.definition_snapshot_json, '$.table_name') = ?
                     AND COALESCE(json_extract(previous.definition_snapshot_json, '$.sql_text'), '') = COALESCE(?, '')
                     AND COALESCE(json_extract(previous.definition_snapshot_json, '$.catalog_database'), '') = COALESCE(?, '')
                     AND COALESCE(json_extract(previous.definition_snapshot_json, '$.output_filename'), '') = COALESCE(?, '')
                     AND COALESCE(json_extract(previous.definition_snapshot_json, '$.delimiter'), ',') = ?
                     AND COALESCE(json_extract(previous.definition_snapshot_json, '$.header'), 1) = ?
                     AND COALESCE(json_extract(previous.definition_snapshot_json, '$.add_sequence'), 0) = ?
                     AND o.data_file_id != ?
                 ) AND deleted_at IS NULL",
            )
            .bind(&now)
            .bind(&now)
            .bind(id)
            .bind(&row.workspace_id)
            .bind(&row.kind)
            .bind(&row.connection_id)
            .bind(&row.table_name)
            .bind(row.sql_text.as_deref())
            .bind(row.catalog_database.as_deref())
            .bind(row.output_filename.as_deref())
            .bind(&row.delimiter)
            .bind(row.header)
            .bind(row.add_sequence)
            .bind(&file_id)
            .execute(&mut *tx)
            .await?;
            paths
        };
        sqlx::query("INSERT INTO execution_outputs (execution_step_id, port_name, data_file_id) VALUES (?, 'out', ?)")
            .bind(id).bind(&file_id).execute(&mut *tx).await?;
        let result_json =
            serde_json::json!({"filename": filename, "data_file_id": file_id}).to_string();
        sqlx::query(
            "UPDATE execution_steps SET status = 'succeeded', finished_at = ?, output_path = ?,
            output_rows = ?, output_bytes = ?, result_json = ?, error_message = NULL WHERE id = ?",
        )
        .bind(&now)
        .bind(stored_path)
        .bind(row_count)
        .bind(size)
        .bind(result_json)
        .bind(id)
        .execute(&mut *tx)
        .await?;
        if let Some(parent) = linked.as_ref().filter(|parent| parent.run_id != id) {
            sqlx::query("INSERT OR REPLACE INTO execution_outputs (execution_step_id, port_name, data_file_id) VALUES (?, 'out', ?)")
                .bind(&parent.run_id).bind(&file_id).execute(&mut *tx).await?;
            sqlx::query("UPDATE execution_steps SET status='succeeded', finished_at=?,
                result_json=json_set(COALESCE(result_json, '{}'), '$.output_data_file_id', ?), error_message=NULL
                WHERE id=? AND status='running'")
                .bind(&now).bind(&file_id).bind(&parent.run_id).execute(&mut *tx).await?;
        }
        let output_step_id = linked.as_ref().map(|v| v.run_id.as_str()).unwrap_or(id);
        if let Some(workspace_chip_id) = sqlx::query_scalar::<_, Option<String>>(
            "SELECT workspace_chip_id FROM execution_steps WHERE id = ?",
        )
        .bind(output_step_id)
        .fetch_optional(&mut *tx)
        .await?
        .flatten()
        {
            sqlx::query("INSERT INTO workspace_chip_outputs (workspace_chip_id, port_name, current_data_file_id,
                expected_filename, definition_revision, updated_at) VALUES (?, 'out', ?, ?, 1, ?)
                ON CONFLICT(workspace_chip_id, port_name) DO UPDATE SET current_data_file_id = excluded.current_data_file_id,
                expected_filename = excluded.expected_filename, updated_at = excluded.updated_at")
                .bind(workspace_chip_id).bind(&file_id).bind(filename).bind(&now).execute(&mut *tx).await?;
        }
        tx.commit().await?;
        for stale_path in stale_paths {
            let path = self.resolve(&stale_path);
            if path != self.resolve(stored_path) {
                match tokio::fs::remove_file(path).await {
                    Ok(()) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    // The DB state is already correct. A failed physical cleanup
                    // must not turn a successful extraction into a failed run.
                    Err(_) => {}
                }
            }
        }
        search::sync_search_best_effort(self, "dataset", self.sync_search_dataset(&file_id)).await;
        Ok(())
    }

    pub async fn set_extract_progress(&self, id: &str, row_count: i64) -> Result<(), StorageError> {
        sqlx::query(
            "UPDATE execution_steps SET output_rows = ? WHERE id = ? AND status = 'running'",
        )
        .bind(row_count)
        .bind(id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn set_extract_failed(&self, id: &str, error: &str) -> Result<(), StorageError> {
        let now = now_rfc3339();
        let mut tx = self.pool.begin().await?;
        sqlx::query(
            "UPDATE execution_steps SET status = ?, finished_at = ?, error_message = ? WHERE id = ?",
        )
        .bind("failed")
        .bind(&now)
        .bind(error)
        .bind(id)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(())
    }
}
