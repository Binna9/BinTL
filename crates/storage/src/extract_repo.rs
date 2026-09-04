use crate::models::*;
use crate::*;

impl Store {
    pub fn extracts_dir(&self) -> PathBuf {
        self.data_dir.join("extracts")
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
        let id = Uuid::new_v4().to_string();
        let created_at = now_rfc3339();
        sqlx::query(
            "INSERT INTO extracts
             (id, kind, connection_id, table_name, delimiter, header, add_sequence, status, created_at,
              sql_text, catalog_database, workspace_id, output_filename)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(kind)
        .bind(connection_id)
        .bind(table_name)
        .bind(delimiter)
        .bind(i64::from(header))
        .bind(i64::from(add_sequence))
        .bind(&created_at)
        .bind(sql_text)
        .bind(catalog_database)
        .bind(workspace_id)
        .bind(output_filename)
        .execute(&self.pool)
        .await?;
        search::sync_search_best_effort(self, "extract", self.sync_search_extract(&id)).await;
        self.get_extract(&id)
            .await?
            .ok_or_else(|| StorageError::NotFound("extract disappeared after insert".into()))
    }

    pub async fn get_extract(&self, id: &str) -> Result<Option<ExtractRow>, StorageError> {
        let row = sqlx::query_as::<_, ExtractRow>(&format!(
            "SELECT {EXTRACT_COLS} FROM extracts e
             LEFT JOIN connections c ON c.id = e.connection_id
             WHERE e.id = ?"
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
            Some(scope) => Self::workspace_scope_sql(scope, "e.workspace_id"),
            None => (String::new(), Vec::new()),
        };
        let sql = format!(
            "SELECT {EXTRACT_COLS} FROM extracts e
             LEFT JOIN connections c ON c.id = e.connection_id
             WHERE 1=1 {extra}
             ORDER BY e.created_at DESC LIMIT ?"
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

        let dataset_ids = self.dataset_ids_for_extract(id).await?;
        delete_guard::ensure_datasets_deletable_by_chips(&self.pool, &dataset_ids).await?;

        let mut tx = self.pool.begin().await?;
        let transform_ids =
            delete_guard::delete_transforms_for_datasets(&mut tx, &dataset_ids).await?;
        sqlx::query("UPDATE chip_runs SET legacy_extract_id = NULL WHERE legacy_extract_id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM datasets WHERE id = ? OR extract_id = ?")
            .bind(id)
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_err(delete_guard::map_delete_sql)?;
        let deleted = sqlx::query("DELETE FROM extracts WHERE id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        if deleted.rows_affected() == 0 {
            return Err(StorageError::NotFound("extract not found".into()));
        }
        tx.commit().await?;
        for transform_id in &transform_ids {
            let _ = self.delete_search_document("transform", transform_id).await;
        }
        for dataset_id in &dataset_ids {
            let _ = self.delete_search_document("dataset", dataset_id).await;
        }

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
            "UPDATE extracts SET status = ?, started_at = ?, error_message = NULL WHERE id = ?",
        )
        .bind("running")
        .bind(now_rfc3339())
        .bind(id)
        .execute(&self.pool)
        .await?;
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
        let linked_run = sqlx::query_as::<_, (String, String, String)>(
            "SELECT id, chip_id, workspace_id FROM chip_runs
             WHERE legacy_extract_id = ? AND status = 'running'",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;
        let now = now_rfc3339();
        let mut tx = self.pool.begin().await?;
        sqlx::query(
            "UPDATE extracts
             SET status = ?, finished_at = ?, stored_path = ?, filename = ?, row_count = ?,
                 error_message = NULL
             WHERE id = ?",
        )
        .bind("succeeded")
        .bind(&now)
        .bind(stored_path)
        .bind(filename)
        .bind(row_count)
        .bind(id)
        .execute(&mut *tx)
        .await?;

        let mut dataset_sync_id = id.to_string();
        if let Some((run_id, chip_id, workspace_id)) = &linked_run {
            let chip_name = self
                .get_chip(chip_id)
                .await?
                .map(|chip| chip.name)
                .unwrap_or_else(|| filename.to_string());
            let display_name = chip_slot::display_filename(&chip_name, "extract", &row.delimiter);
            dataset_sync_id = self
                .upsert_chip_output_slot_dataset(
                    &mut tx,
                    workspace_id,
                    chip_id,
                    run_id,
                    &row.kind,
                    &display_name,
                    stored_path,
                    size,
                    Some(row_count),
                    Some(row.delimiter.as_str()),
                    Some(row.header != 0),
                    Some(id),
                )
                .await?;
            let result = sqlx::query(
                "UPDATE chip_runs
                 SET status = 'succeeded', output_dataset_id = ?, error_message = NULL,
                     finished_at = ?
                 WHERE id = ? AND status = 'running'",
            )
            .bind(&dataset_sync_id)
            .bind(&now)
            .bind(run_id)
            .execute(&mut *tx)
            .await?;
            if result.rows_affected() == 0 {
                return Err(StorageError::Invalid(
                    "linked chip run is not running".into(),
                ));
            }
        } else {
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
                   delimiter = excluded.delimiter,
                   has_header = excluded.has_header,
                   row_count = excluded.row_count,
                   workspace_id = excluded.workspace_id,
                   updated_at = excluded.updated_at",
            )
            .bind(id)
            .bind(&row.kind)
            .bind(id)
            .bind(filename)
            .bind(stored_path)
            .bind(size)
            .bind(&row.delimiter)
            .bind(row.header)
            .bind(row_count)
            .bind(&now)
            .bind(&now)
            .bind(&row.workspace_id)
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await?;
        search::sync_search_best_effort(self, "extract", self.sync_search_extract(id)).await;
        search::sync_search_best_effort(
            self,
            "dataset",
            self.sync_search_dataset(&dataset_sync_id),
        )
        .await;
        Ok(())
    }

    pub async fn set_extract_progress(&self, id: &str, row_count: i64) -> Result<(), StorageError> {
        sqlx::query("UPDATE extracts SET row_count = ? WHERE id = ? AND status = 'running'")
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
            "UPDATE extracts SET status = ?, finished_at = ?, error_message = ? WHERE id = ?",
        )
        .bind("failed")
        .bind(&now)
        .bind(error)
        .bind(id)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "UPDATE chip_runs
             SET status = 'failed', error_message = ?, finished_at = ?
             WHERE legacy_extract_id = ? AND status IN ('queued', 'running')",
        )
        .bind(error)
        .bind(&now)
        .bind(id)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(())
    }
}
