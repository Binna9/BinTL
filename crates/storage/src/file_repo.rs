use crate::models::*;
use crate::*;

impl Store {
    pub async fn save_upload(
        &self,
        filename: &str,
        bytes: &[u8],
        delimiter: Option<&str>,
        has_header: Option<bool>,
        workspace_id: &str,
    ) -> Result<FileMeta, StorageError> {
        self.require_workspace(workspace_id).await?;
        let id = Uuid::new_v4().to_string();
        let filename = safe_filename(filename);
        let rel = upload_rel(&id, &filename);
        let dest = self.data_dir.join(&rel);
        if let Some(parent) = dest.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        tokio::fs::write(&dest, bytes).await?;
        if let Err(error) = self
            .upsert_dataset(&DatasetUpsert {
                id: id.clone(),
                kind: "upload".into(),
                extract_id: None,
                filename: filename.clone(),
                stored_path: rel.clone(),
                size_bytes: Some(bytes.len() as i64),
                delimiter: delimiter.map(str::to_string),
                has_header,
                row_count: None,
                workspace_id: Some(workspace_id.to_string()),
            })
            .await
        {
            let _ = tokio::fs::remove_dir_all(self.uploads_dir().join(&id)).await;
            return Err(error);
        }
        search::sync_search_best_effort(self, "dataset", self.sync_search_dataset(&id)).await;
        Ok(FileMeta {
            id,
            filename,
            size: bytes.len() as u64,
            stored_path: rel,
        })
    }

    pub async fn stage_spreadsheet(
        &self,
        original_filename: &str,
        bytes: &[u8],
    ) -> Result<StagedFile, StorageError> {
        let id = Uuid::new_v4().to_string();
        let original_filename = safe_filename(original_filename);
        let dir = self.staging_dir().join(&id);
        let path = dir.join(&original_filename);
        tokio::fs::create_dir_all(&dir).await?;
        if let Err(error) = tokio::fs::write(&path, bytes).await {
            let _ = tokio::fs::remove_dir_all(&dir).await;
            return Err(error.into());
        }
        Ok(StagedFile {
            id,
            original_filename,
            path,
        })
    }

    pub async fn staged_file(&self, id: &str) -> Result<StagedFile, StorageError> {
        validate_uuid(id, "staging_id")?;
        let dir = self.staging_dir().join(id);
        let mut entries = tokio::fs::read_dir(&dir)
            .await
            .map_err(|error| match error.kind() {
                std::io::ErrorKind::NotFound => {
                    StorageError::NotFound("staging file not found".into())
                }
                _ => error.into(),
            })?;
        let mut staged = None;
        while let Some(entry) = entries.next_entry().await? {
            if !entry.file_type().await?.is_file() || staged.is_some() {
                return Err(StorageError::Invalid("invalid staging directory".into()));
            }
            staged = Some(StagedFile {
                id: id.to_string(),
                original_filename: entry.file_name().to_string_lossy().into_owned(),
                path: entry.path(),
            });
        }
        staged.ok_or_else(|| StorageError::NotFound("staging file not found".into()))
    }

    pub async fn delete_stage(&self, id: &str) -> Result<(), StorageError> {
        validate_uuid(id, "staging_id")?;
        let dir = self.staging_dir().join(id);
        tokio::fs::remove_dir_all(dir)
            .await
            .map_err(|error| match error.kind() {
                std::io::ErrorKind::NotFound => {
                    StorageError::NotFound("staging file not found".into())
                }
                _ => error.into(),
            })
    }

    pub async fn list_uploads(
        &self,
        scope: Option<&DataScope>,
    ) -> Result<Vec<FileMeta>, StorageError> {
        let rows = self.list_datasets(scope).await?;
        Ok(rows
            .into_iter()
            .filter(|row| row.kind == "upload")
            .map(|row| FileMeta {
                id: row.id,
                filename: row.filename,
                size: row.size_bytes.unwrap_or(0) as u64,
                stored_path: row.stored_path,
            })
            .collect())
    }

    pub(crate) async fn list_upload_dirs(&self) -> Result<Vec<FileMeta>, StorageError> {
        let mut out = Vec::new();
        let root = self.uploads_dir();
        let mut dirs = match tokio::fs::read_dir(&root).await {
            Ok(d) => d,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(out),
            Err(e) => return Err(e.into()),
        };
        while let Some(entry) = dirs.next_entry().await? {
            if !entry.file_type().await?.is_dir() {
                continue;
            }
            let id = entry.file_name().to_string_lossy().into_owned();
            if Uuid::parse_str(&id).is_err() {
                continue;
            }
            let mut files = tokio::fs::read_dir(entry.path()).await?;
            while let Some(file) = files.next_entry().await? {
                if !file.file_type().await?.is_file() {
                    continue;
                }
                let filename = file.file_name().to_string_lossy().into_owned();
                let size = file.metadata().await?.len();
                out.push(FileMeta {
                    id: id.clone(),
                    filename,
                    size,
                    stored_path: upload_rel(&id, &file.file_name().to_string_lossy()),
                });
            }
        }
        out.sort_by(|a, b| b.id.cmp(&a.id));
        Ok(out)
    }

    pub(crate) async fn first_upload_file(
        &self,
        id: &str,
    ) -> Result<(String, PathBuf, u64), StorageError> {
        validate_uuid(id, "file_id")?;
        let dir = self.uploads_dir().join(id);
        let mut files = tokio::fs::read_dir(&dir)
            .await
            .map_err(|error| match error.kind() {
                std::io::ErrorKind::NotFound => {
                    StorageError::NotFound(format!("file {id} not found"))
                }
                _ => error.into(),
            })?;
        while let Some(file) = files.next_entry().await? {
            if file.file_type().await?.is_file() {
                let filename = file.file_name().to_string_lossy().into_owned();
                let size = file.metadata().await?.len();
                return Ok((filename, file.path(), size));
            }
        }
        Err(StorageError::NotFound(format!("file {id} not found")))
    }

    pub async fn get_upload(&self, id: &str) -> Result<FileMeta, StorageError> {
        let (filename, _, size) = self.first_upload_file(id).await?;
        Ok(FileMeta {
            id: id.to_string(),
            filename: filename.clone(),
            size,
            stored_path: upload_rel(id, &filename),
        })
    }

    pub async fn upload_path(&self, id: &str) -> Result<PathBuf, StorageError> {
        let (_, path, _) = self.first_upload_file(id).await?;
        Ok(path)
    }

    pub async fn delete_upload(&self, id: &str) -> Result<(), StorageError> {
        validate_uuid(id, "file_id")?;
        let dataset_ids = self.dataset_ids_for_upload(id).await?;
        let dir = self.uploads_dir().join(id);
        let dir_exists = dir.is_dir();
        if dataset_ids.is_empty() && !dir_exists {
            return Err(StorageError::NotFound(format!("file {id} not found")));
        }
        delete_guard::ensure_datasets_deletable_by_chips(&self.pool, &dataset_ids).await?;

        let prefix = format!("{REL_UPLOADS}/{id}/%");
        let mut tx = self.pool.begin().await?;
        let transform_ids =
            delete_guard::delete_transforms_for_datasets(&mut tx, &dataset_ids).await?;
        let deleted = sqlx::query("DELETE FROM datasets WHERE id = ? OR stored_path LIKE ?")
            .bind(id)
            .bind(&prefix)
            .execute(&mut *tx)
            .await
            .map_err(delete_guard::map_delete_sql)?;
        tx.commit().await?;
        if !dir_exists && deleted.rows_affected() == 0 && transform_ids.is_empty() {
            return Err(StorageError::NotFound(format!("file {id} not found")));
        }
        for transform_id in &transform_ids {
            let _ = self.delete_search_document("transform", transform_id).await;
        }
        for dataset_id in &dataset_ids {
            let _ = self.delete_search_document("dataset", dataset_id).await;
        }
        if dir_exists {
            match tokio::fs::remove_dir_all(&dir).await {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
        Ok(())
    }

    pub(crate) async fn dataset_ids_for_upload(
        &self,
        id: &str,
    ) -> Result<Vec<String>, StorageError> {
        let prefix = format!("{REL_UPLOADS}/{id}/%");
        Ok(
            sqlx::query_scalar("SELECT id FROM datasets WHERE id = ? OR stored_path LIKE ?")
                .bind(id)
                .bind(&prefix)
                .fetch_all(&self.pool)
                .await?,
        )
    }

    pub(crate) async fn dataset_ids_for_extract(
        &self,
        id: &str,
    ) -> Result<Vec<String>, StorageError> {
        Ok(
            sqlx::query_scalar("SELECT id FROM datasets WHERE id = ? OR extract_id = ?")
                .bind(id)
                .bind(id)
                .fetch_all(&self.pool)
                .await?,
        )
    }

    pub async fn source_for_file_id(&self, file_id: &str) -> Result<String, StorageError> {
        if Uuid::parse_str(file_id).is_err() {
            return Err(StorageError::Invalid("invalid file_id".into()));
        }
        let dir = self.uploads_dir().join(file_id);
        let mut files = tokio::fs::read_dir(&dir)
            .await
            .map_err(|_| StorageError::NotFound(format!("file {file_id} not found")))?;
        while let Some(file) = files.next_entry().await? {
            if file.file_type().await?.is_file() {
                let name = file.file_name().to_string_lossy().into_owned();
                return Ok(upload_rel(file_id, &name));
            }
        }
        Err(StorageError::NotFound(format!("file {file_id} not found")))
    }
}
