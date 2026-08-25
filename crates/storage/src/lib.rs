mod process_log;
mod secret;

pub use process_log::{
    safe_log_id, ProcessLog, LOG_AREAS, LOG_CONNECTIONS, LOG_EXTRACTS, LOG_FILES, LOG_JOBS,
    LOG_QUERY,
};

use std::path::{Path, PathBuf};

use chrono::{SecondsFormat, Utc};
use serde::Serialize;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
use sqlx::SqlitePool;
use uuid::Uuid;

#[derive(Debug, thiserror::Error)]
pub enum StorageError {
    #[error(transparent)]
    Sqlx(#[from] sqlx::Error),
    #[error(transparent)]
    Migrate(#[from] sqlx::migrate::MigrateError),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    Invalid(String),
}

/// Relative dirs under `data_dir`. Transform inputs live under `extracts/`
/// by source kind; `outputs/` is convert/load results.
pub const REL_UPLOADS: &str = "extracts/uploads";
pub const REL_DATABASES: &str = "extracts/databases";
pub const REL_API: &str = "extracts/api";
pub const REL_OUTPUTS: &str = "outputs";
pub const REL_LOGS: &str = "logs";
pub const REL_STAGING: &str = "staging";

const EXTRACT_KINDS: [&str; 3] = ["uploads", "databases", "api"];

#[derive(Clone)]
pub struct Store {
    pub pool: SqlitePool,
    pub data_dir: PathBuf,
    secret_key: [u8; 32],
}

const JOB_COLS: &str = "id, status, source_path, output_path, spec_json, error_message,
        created_at, started_at, finished_at, kind, transform_id, dataset_id";

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct JobRow {
    pub id: String,
    pub status: String,
    pub source_path: String,
    pub output_path: Option<String>,
    pub spec_json: String,
    pub error_message: Option<String>,
    pub created_at: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub kind: String,
    pub transform_id: Option<String>,
    pub dataset_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct DatasetRow {
    pub id: String,
    pub kind: String,
    pub extract_id: Option<String>,
    pub filename: String,
    pub stored_path: String,
    pub size_bytes: Option<i64>,
    pub delimiter: Option<String>,
    pub has_header: Option<i64>,
    pub columns_json: Option<String>,
    pub row_count: Option<i64>,
    pub inspected_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub table_name: String,
    pub connection_name: String,
}

const DATASET_COLS: &str = "d.id, d.kind, d.extract_id, d.filename, d.stored_path, d.size_bytes,
        d.delimiter, d.has_header, d.columns_json, d.row_count, d.inspected_at,
        d.created_at, d.updated_at,
        COALESCE(e.table_name, '') AS table_name,
        COALESCE(c.name, '') AS connection_name";

#[derive(Debug, Clone)]
pub struct DatasetUpsert {
    pub id: String,
    pub kind: String,
    pub extract_id: Option<String>,
    pub filename: String,
    pub stored_path: String,
    pub size_bytes: Option<i64>,
    pub delimiter: Option<String>,
    pub has_header: Option<bool>,
    pub row_count: Option<i64>,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct TransformRow {
    pub id: String,
    pub name: String,
    pub dataset_id: String,
    pub spec_json: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct JobLogRow {
    pub id: i64,
    pub job_id: String,
    pub ts: String,
    pub level: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct FileMeta {
    pub id: String,
    pub filename: String,
    pub size: u64,
    pub stored_path: String,
}

#[derive(Debug, Clone)]
pub struct StagedFile {
    pub id: String,
    pub original_filename: String,
    pub path: PathBuf,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct ExtractRow {
    pub id: String,
    pub connection_id: String,
    pub table_name: String,
    pub delimiter: String,
    pub header: i64,
    pub status: String,
    pub stored_path: Option<String>,
    pub filename: Option<String>,
    pub row_count: Option<i64>,
    pub error_message: Option<String>,
    pub created_at: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub sql_text: Option<String>,
    pub catalog_database: Option<String>,
    pub connection_name: String,
}

const EXTRACT_COLS: &str = "e.id, e.connection_id, e.table_name, e.delimiter, e.header,
        e.status, e.stored_path, e.filename, e.row_count, e.error_message,
        e.created_at, e.started_at, e.finished_at, e.sql_text, e.catalog_database,
        COALESCE(c.name, '') AS connection_name";

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct ConnectionRow {
    pub id: String,
    pub name: String,
    pub driver: String,
    pub host: String,
    pub port: i64,
    pub database_name: String,
    pub username: String,
    pub ssl: i64,
    pub created_at: String,
}

#[derive(Debug, Clone)]
pub struct LiveConnection {
    pub id: String,
    pub name: String,
    pub driver: String,
    pub host: String,
    pub port: u16,
    pub database: String,
    pub username: String,
    pub password: String,
    pub ssl: bool,
}

#[derive(Debug, Clone)]
pub struct NewConnection {
    pub name: String,
    pub driver: String,
    pub host: String,
    pub port: u16,
    pub database: String,
    pub username: String,
    pub password: String,
    pub ssl: bool,
}

impl Store {
    pub async fn open(
        data_dir: impl Into<PathBuf>,
        session_secret: &str,
    ) -> Result<Self, StorageError> {
        let data_dir = data_dir.into();
        ensure_data_layout(&data_dir).await?;

        let db_path = data_dir.join("etl.db");
        let options = SqliteConnectOptions::new()
            .filename(&db_path)
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .foreign_keys(true);

        let pool = SqlitePoolOptions::new()
            .max_connections(5)
            .connect_with(options)
            .await?;

        sqlx::migrate!("./migrations").run(&pool).await?;
        rewrite_legacy_stored_paths(&pool).await?;
        let store = Self {
            pool,
            data_dir,
            secret_key: secret::key_from_secret(session_secret),
        };
        store.backfill_datasets().await?;
        Ok(store)
    }

    pub fn uploads_dir(&self) -> PathBuf {
        self.data_dir.join(REL_UPLOADS)
    }

    pub fn outputs_dir(&self) -> PathBuf {
        self.data_dir.join(REL_OUTPUTS)
    }

    pub fn staging_dir(&self) -> PathBuf {
        self.data_dir.join(REL_STAGING)
    }

    pub fn resolve(&self, stored: &str) -> PathBuf {
        let p = Path::new(stored);
        if p.is_absolute() {
            p.to_path_buf()
        } else {
            self.data_dir.join(p)
        }
    }

    pub async fn save_upload(
        &self,
        filename: &str,
        bytes: &[u8],
        delimiter: Option<&str>,
    ) -> Result<FileMeta, StorageError> {
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
                has_header: None,
                row_count: None,
            })
            .await
        {
            let _ = tokio::fs::remove_dir_all(self.uploads_dir().join(&id)).await;
            return Err(error);
        }
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

    pub async fn list_uploads(&self) -> Result<Vec<FileMeta>, StorageError> {
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

    pub async fn source_for_file_id(&self, file_id: &str) -> Result<String, StorageError> {
        if Uuid::parse_str(file_id).is_err() {
            return Err(StorageError::Invalid("invalid file_id".into()));
        }
        let dir = self.uploads_dir().join(file_id);
        let mut files = tokio::fs::read_dir(&dir).await.map_err(|_| {
            StorageError::NotFound(format!("file {file_id} not found"))
        })?;
        while let Some(file) = files.next_entry().await? {
            if file.file_type().await?.is_file() {
                let name = file.file_name().to_string_lossy().into_owned();
                return Ok(upload_rel(file_id, &name));
            }
        }
        Err(StorageError::NotFound(format!("file {file_id} not found")))
    }

    pub async fn insert_job(
        &self,
        source_path: &str,
        spec_json: &str,
    ) -> Result<JobRow, StorageError> {
        let id = Uuid::new_v4().to_string();
        let created_at = now_rfc3339();
        sqlx::query(
            "INSERT INTO jobs (id, status, source_path, spec_json, created_at)
             VALUES (?, 'queued', ?, ?, ?)",
        )
        .bind(&id)
        .bind(source_path)
        .bind(spec_json)
        .bind(&created_at)
        .execute(&self.pool)
        .await?;
        self.get_job(&id)
            .await?
            .ok_or_else(|| StorageError::NotFound("job disappeared after insert".into()))
    }

    pub async fn insert_transform_job(
        &self,
        source_path: &str,
        spec_json: &str,
        transform_id: &str,
        dataset_id: &str,
    ) -> Result<JobRow, StorageError> {
        let id = Uuid::new_v4().to_string();
        let created_at = now_rfc3339();
        sqlx::query(
            "INSERT INTO jobs
             (id, status, source_path, spec_json, created_at, kind, transform_id, dataset_id)
             VALUES (?, 'queued', ?, ?, ?, 'transform', ?, ?)",
        )
        .bind(&id)
        .bind(source_path)
        .bind(spec_json)
        .bind(&created_at)
        .bind(transform_id)
        .bind(dataset_id)
        .execute(&self.pool)
        .await?;
        self.get_job(&id)
            .await?
            .ok_or_else(|| StorageError::NotFound("job disappeared after insert".into()))
    }

    pub async fn get_job(&self, id: &str) -> Result<Option<JobRow>, StorageError> {
        let row = sqlx::query_as::<_, JobRow>(&format!(
            "SELECT {JOB_COLS} FROM jobs WHERE id = ?"
        ))
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row)
    }

    pub async fn list_jobs(&self, limit: i64) -> Result<Vec<JobRow>, StorageError> {
        let rows = sqlx::query_as::<_, JobRow>(&format!(
            "SELECT {JOB_COLS} FROM jobs ORDER BY created_at DESC LIMIT ?"
        ))
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows)
    }

    pub async fn set_job_running(
        &self,
        id: &str,
        output_path: &str,
    ) -> Result<(), StorageError> {
        sqlx::query(
            "UPDATE jobs SET status = ?, started_at = ?, output_path = ?, error_message = NULL
             WHERE id = ?",
        )
        .bind("running")
        .bind(now_rfc3339())
        .bind(output_path)
        .bind(id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn set_job_succeeded(&self, id: &str) -> Result<(), StorageError> {
        sqlx::query("UPDATE jobs SET status = ?, finished_at = ? WHERE id = ?")
            .bind("succeeded")
            .bind(now_rfc3339())
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn set_job_failed(&self, id: &str, error: &str) -> Result<(), StorageError> {
        sqlx::query(
            "UPDATE jobs SET status = ?, finished_at = ?, error_message = ? WHERE id = ?",
        )
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
        sqlx::query("INSERT INTO job_logs (job_id, ts, level, message) VALUES (?, ?, ?, ?)")
            .bind(job_id)
            .bind(now_rfc3339())
            .bind(level)
            .bind(message)
            .execute(&self.pool)
            .await?;
        if let Ok(log) = ProcessLog::create(&self.data_dir, LOG_JOBS, job_id) {
            log.write(level, "job", message);
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
            "SELECT id, job_id, ts, level, message FROM job_logs
             WHERE job_id = ? ORDER BY id ASC",
        )
        .bind(job_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows)
    }

    pub async fn insert_connection(
        &self,
        new: NewConnection,
    ) -> Result<ConnectionRow, StorageError> {
        let driver = new.driver.to_ascii_lowercase();
        if !supported_driver(&driver) {
            return Err(StorageError::Invalid(
                "driver must be postgres, redshift, cockroach, mysql, mariadb, mssql, or sqlite"
                    .into(),
            ));
        }
        if new.name.trim().is_empty() {
            return Err(StorageError::Invalid("name required".into()));
        }
        if driver == "sqlite" {
            if new.database.trim().is_empty() && new.host.trim().is_empty() {
                return Err(StorageError::Invalid("sqlite needs a file path in database".into()));
            }
        } else if new.host.trim().is_empty() || new.database.trim().is_empty() {
            return Err(StorageError::Invalid("host and database required".into()));
        }
        let id = Uuid::new_v4().to_string();
        let created_at = now_rfc3339();
        let cipher = secret::encrypt(&self.secret_key, &new.password)?;
        sqlx::query(
            "INSERT INTO connections
             (id, name, driver, host, port, database_name, username, password_cipher, ssl, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(new.name.trim())
        .bind(&driver)
        .bind(new.host.trim())
        .bind(new.port as i64)
        .bind(new.database.trim())
        .bind(new.username.trim())
        .bind(&cipher)
        .bind(i64::from(new.ssl))
        .bind(&created_at)
        .execute(&self.pool)
        .await?;
        self.get_connection(&id)
            .await?
            .ok_or_else(|| StorageError::NotFound("connection disappeared after insert".into()))
    }

    pub async fn update_connection(
        &self,
        id: &str,
        new: NewConnection,
    ) -> Result<ConnectionRow, StorageError> {
        if self.get_connection(id).await?.is_none() {
            return Err(StorageError::NotFound("connection not found".into()));
        }
        let driver = new.driver.to_ascii_lowercase();
        if !supported_driver(&driver) {
            return Err(StorageError::Invalid(
                "driver must be postgres, redshift, cockroach, mysql, mariadb, mssql, or sqlite"
                    .into(),
            ));
        }
        if new.name.trim().is_empty() {
            return Err(StorageError::Invalid("name required".into()));
        }
        if driver == "sqlite" {
            if new.database.trim().is_empty() && new.host.trim().is_empty() {
                return Err(StorageError::Invalid("sqlite needs a file path in database".into()));
            }
        } else if new.host.trim().is_empty() || new.database.trim().is_empty() {
            return Err(StorageError::Invalid("host and database required".into()));
        }

        if new.password.is_empty() {
            sqlx::query(
                "UPDATE connections
                 SET name = ?, driver = ?, host = ?, port = ?, database_name = ?, username = ?, ssl = ?
                 WHERE id = ?",
            )
            .bind(new.name.trim())
            .bind(&driver)
            .bind(new.host.trim())
            .bind(new.port as i64)
            .bind(new.database.trim())
            .bind(new.username.trim())
            .bind(i64::from(new.ssl))
            .bind(id)
            .execute(&self.pool)
            .await?;
        } else {
            let cipher = secret::encrypt(&self.secret_key, &new.password)?;
            sqlx::query(
                "UPDATE connections
                 SET name = ?, driver = ?, host = ?, port = ?, database_name = ?, username = ?, password_cipher = ?, ssl = ?
                 WHERE id = ?",
            )
            .bind(new.name.trim())
            .bind(&driver)
            .bind(new.host.trim())
            .bind(new.port as i64)
            .bind(new.database.trim())
            .bind(new.username.trim())
            .bind(&cipher)
            .bind(i64::from(new.ssl))
            .bind(id)
            .execute(&self.pool)
            .await?;
        }

        self.get_connection(id)
            .await?
            .ok_or_else(|| StorageError::NotFound("connection disappeared after update".into()))
    }

    pub async fn get_connection(&self, id: &str) -> Result<Option<ConnectionRow>, StorageError> {
        let row = sqlx::query_as::<_, ConnectionRow>(
            "SELECT id, name, driver, host, port, database_name, username, ssl, created_at
             FROM connections WHERE id = ?",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row)
    }

    pub async fn list_connections(&self) -> Result<Vec<ConnectionRow>, StorageError> {
        let rows = sqlx::query_as::<_, ConnectionRow>(
            "SELECT id, name, driver, host, port, database_name, username, ssl, created_at
             FROM connections ORDER BY created_at DESC",
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(rows)
    }

    pub async fn delete_connection(&self, id: &str) -> Result<(), StorageError> {
        let res = sqlx::query("DELETE FROM connections WHERE id = ?")
            .bind(id)
            .execute(&self.pool)
            .await?;
        if res.rows_affected() == 0 {
            return Err(StorageError::NotFound("connection not found".into()));
        }
        Ok(())
    }

    pub fn extracts_dir(&self) -> PathBuf {
        self.data_dir.join("extracts")
    }

    pub async fn insert_extract(
        &self,
        connection_id: &str,
        table_name: &str,
        delimiter: &str,
        header: bool,
        sql_text: Option<&str>,
        catalog_database: Option<&str>,
    ) -> Result<ExtractRow, StorageError> {
        let _ = self
            .get_connection(connection_id)
            .await?
            .ok_or_else(|| StorageError::NotFound("connection not found".into()))?;
        let id = Uuid::new_v4().to_string();
        let created_at = now_rfc3339();
        sqlx::query(
            "INSERT INTO extracts
             (id, connection_id, table_name, delimiter, header, status, created_at, sql_text, catalog_database)
             VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?)",
        )
        .bind(&id)
        .bind(connection_id)
        .bind(table_name)
        .bind(delimiter)
        .bind(i64::from(header))
        .bind(&created_at)
        .bind(sql_text)
        .bind(catalog_database)
        .execute(&self.pool)
        .await?;
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

    pub async fn list_extracts(&self, limit: i64) -> Result<Vec<ExtractRow>, StorageError> {
        let rows = sqlx::query_as::<_, ExtractRow>(&format!(
            "SELECT {EXTRACT_COLS} FROM extracts e
             LEFT JOIN connections c ON c.id = e.connection_id
             ORDER BY e.created_at DESC LIMIT ?"
        ))
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows)
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
        sqlx::query(
            "UPDATE extracts
             SET status = ?, finished_at = ?, stored_path = ?, filename = ?, row_count = ?,
                 error_message = NULL
             WHERE id = ?",
        )
        .bind("succeeded")
        .bind(now_rfc3339())
        .bind(stored_path)
        .bind(filename)
        .bind(row_count)
        .bind(id)
        .execute(&self.pool)
        .await?;
        let size = tokio::fs::metadata(self.resolve(stored_path))
            .await
            .ok()
            .map(|m| m.len() as i64);
        let row = self.get_extract(id).await?;
        if let Some(row) = row {
            self.upsert_dataset(&DatasetUpsert {
                id: row.id,
                kind: "database".into(),
                extract_id: Some(id.to_string()),
                filename: filename.to_string(),
                stored_path: stored_path.to_string(),
                size_bytes: size,
                delimiter: Some(row.delimiter),
                has_header: Some(row.header != 0),
                row_count: Some(row_count),
            })
            .await?;
        }
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
        sqlx::query(
            "UPDATE extracts SET status = ?, finished_at = ?, error_message = ? WHERE id = ?",
        )
        .bind("failed")
        .bind(now_rfc3339())
        .bind(error)
        .bind(id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn upsert_dataset(&self, row: &DatasetUpsert) -> Result<DatasetRow, StorageError> {
        if !matches!(row.kind.as_str(), "upload" | "database" | "api") {
            return Err(StorageError::Invalid("dataset kind must be upload, database, or api".into()));
        }
        let now = now_rfc3339();
        let has_header = row.has_header.map(i64::from);
        sqlx::query(
            "INSERT INTO datasets
             (id, kind, extract_id, filename, stored_path, size_bytes, delimiter, has_header,
              row_count, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               kind = excluded.kind,
               extract_id = excluded.extract_id,
               filename = excluded.filename,
               stored_path = excluded.stored_path,
               size_bytes = excluded.size_bytes,
               delimiter = COALESCE(excluded.delimiter, datasets.delimiter),
               has_header = COALESCE(excluded.has_header, datasets.has_header),
               row_count = COALESCE(excluded.row_count, datasets.row_count),
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
        .execute(&self.pool)
        .await?;
        self.get_dataset(&row.id)
            .await?
            .ok_or_else(|| StorageError::NotFound("dataset disappeared after upsert".into()))
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

    fn dataset_select() -> String {
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

    pub async fn list_datasets(&self) -> Result<Vec<DatasetRow>, StorageError> {
        let sql = format!("{} ORDER BY d.created_at DESC", Self::dataset_select());
        let rows = sqlx::query_as::<_, DatasetRow>(&sql)
            .fetch_all(&self.pool)
            .await?;
        Ok(rows)
    }

    pub async fn insert_transform(
        &self,
        name: &str,
        dataset_id: &str,
        spec_json: &str,
    ) -> Result<TransformRow, StorageError> {
        let name = name.trim();
        if name.is_empty() {
            return Err(StorageError::Invalid("name required".into()));
        }
        let _ = self
            .get_dataset(dataset_id)
            .await?
            .ok_or_else(|| StorageError::NotFound("dataset not found".into()))?;
        let id = Uuid::new_v4().to_string();
        let now = now_rfc3339();
        sqlx::query(
            "INSERT INTO transforms (id, name, dataset_id, spec_json, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(name)
        .bind(dataset_id)
        .bind(spec_json)
        .bind(&now)
        .bind(&now)
        .execute(&self.pool)
        .await?;
        self.get_transform(&id)
            .await?
            .ok_or_else(|| StorageError::NotFound("transform disappeared after insert".into()))
    }

    pub async fn update_transform(
        &self,
        id: &str,
        name: Option<&str>,
        dataset_id: Option<&str>,
        spec_json: Option<&str>,
    ) -> Result<TransformRow, StorageError> {
        let current = self
            .get_transform(id)
            .await?
            .ok_or_else(|| StorageError::NotFound("transform not found".into()))?;
        let name = name
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(current.name.as_str());
        let dataset_id = dataset_id.unwrap_or(current.dataset_id.as_str());
        let spec_json = spec_json.unwrap_or(current.spec_json.as_str());
        let _ = self
            .get_dataset(dataset_id)
            .await?
            .ok_or_else(|| StorageError::NotFound("dataset not found".into()))?;
        let now = now_rfc3339();
        sqlx::query(
            "UPDATE transforms SET name = ?, dataset_id = ?, spec_json = ?, updated_at = ? WHERE id = ?",
        )
        .bind(name)
        .bind(dataset_id)
        .bind(spec_json)
        .bind(&now)
        .bind(id)
        .execute(&self.pool)
        .await?;
        self.get_transform(id)
            .await?
            .ok_or_else(|| StorageError::NotFound("transform disappeared after update".into()))
    }

    pub async fn get_transform(&self, id: &str) -> Result<Option<TransformRow>, StorageError> {
        let row = sqlx::query_as::<_, TransformRow>(
            "SELECT id, name, dataset_id, spec_json, created_at, updated_at
             FROM transforms WHERE id = ?",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row)
    }

    pub async fn list_transforms(&self) -> Result<Vec<TransformRow>, StorageError> {
        let rows = sqlx::query_as::<_, TransformRow>(
            "SELECT id, name, dataset_id, spec_json, created_at, updated_at
             FROM transforms ORDER BY updated_at DESC",
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(rows)
    }

    pub async fn backfill_datasets(&self) -> Result<(), StorageError> {
        let extracts = sqlx::query_as::<_, ExtractBackfillRow>(
            "SELECT id, delimiter, header, stored_path, filename, row_count
             FROM extracts
             WHERE status = 'succeeded' AND stored_path IS NOT NULL AND filename IS NOT NULL",
        )
        .fetch_all(&self.pool)
        .await?;
        for row in extracts {
            let stored_path = row.stored_path.unwrap_or_default();
            let filename = row.filename.unwrap_or_default();
            if stored_path.is_empty() || filename.is_empty() {
                continue;
            }
            let abs = self.resolve(&stored_path);
            if !abs.is_file() {
                continue;
            }
            let size = tokio::fs::metadata(&abs)
                .await
                .ok()
                .map(|m| m.len() as i64);
            self.upsert_dataset(&DatasetUpsert {
                id: row.id.clone(),
                kind: "database".into(),
                extract_id: Some(row.id),
                filename,
                stored_path,
                size_bytes: size,
                delimiter: Some(row.delimiter),
                has_header: Some(row.header != 0),
                row_count: row.row_count,
            })
            .await?;
        }

        let uploads = self.list_uploads().await?;
        for file in uploads {
            self.upsert_dataset(&DatasetUpsert {
                id: file.id,
                kind: "upload".into(),
                extract_id: None,
                filename: file.filename,
                stored_path: file.stored_path,
                size_bytes: Some(file.size as i64),
                delimiter: None,
                has_header: None,
                row_count: None,
            })
            .await?;
        }
        Ok(())
    }

    pub fn extract_file_rel(id: &str, table: &str, delimiter: &str) -> (String, String) {
        let ext = match delimiter {
            "tab" | "\\t" | "\t" => "tsv",
            "," => "csv",
            _ => "txt",
        };
        let filename = format!("{}.{}", safe_filename(&table.replace('.', "_")), ext);
        let rel = database_rel(id, &filename);
        (filename, rel)
    }

    pub async fn live_connection(&self, id: &str) -> Result<LiveConnection, StorageError> {
        let row = sqlx::query_as::<_, ConnectionSecretRow>(
            "SELECT id, name, driver, host, port, database_name, username, password_cipher, ssl
             FROM connections WHERE id = ?",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(|| StorageError::NotFound("connection not found".into()))?;
        let password = secret::decrypt(&self.secret_key, &row.password_cipher)?;
        Ok(LiveConnection {
            id: row.id,
            name: row.name,
            driver: row.driver,
            host: row.host,
            port: u16::try_from(row.port).unwrap_or(0),
            database: row.database_name,
            username: row.username,
            password,
            ssl: row.ssl != 0,
        })
    }
}

#[derive(sqlx::FromRow)]
struct ExtractBackfillRow {
    id: String,
    delimiter: String,
    header: i64,
    stored_path: Option<String>,
    filename: Option<String>,
    row_count: Option<i64>,
}

#[derive(sqlx::FromRow)]
struct ConnectionSecretRow {
    id: String,
    name: String,
    driver: String,
    host: String,
    port: i64,
    database_name: String,
    username: String,
    password_cipher: String,
    ssl: i64,
}

pub fn upload_rel(id: &str, filename: &str) -> String {
    format!("{REL_UPLOADS}/{id}/{filename}")
}

pub fn database_rel(id: &str, filename: &str) -> String {
    format!("{REL_DATABASES}/{id}/{filename}")
}

pub fn job_db_extract_rel(job_id: &str) -> String {
    database_rel(job_id, "extract.csv")
}

async fn ensure_data_layout(data_dir: &Path) -> Result<(), StorageError> {
    tokio::fs::create_dir_all(data_dir.join(REL_OUTPUTS)).await?;
    tokio::fs::create_dir_all(data_dir.join(REL_STAGING)).await?;
    for kind in EXTRACT_KINDS {
        tokio::fs::create_dir_all(data_dir.join("extracts").join(kind)).await?;
    }
    for area in LOG_AREAS {
        tokio::fs::create_dir_all(data_dir.join(REL_LOGS).join(area)).await?;
    }
    migrate_legacy_extract_dirs(data_dir).await?;
    Ok(())
}

/// Move `data/uploads/` and leftover `data/extracts/{uuid}/` into the kinded tree.
async fn migrate_legacy_extract_dirs(data_dir: &Path) -> Result<(), StorageError> {
    let extracts = data_dir.join("extracts");
    let databases = extracts.join("databases");
    let uploads_new = extracts.join("uploads");

    if extracts.is_dir() {
        let mut rd = tokio::fs::read_dir(&extracts).await?;
        while let Some(entry) = rd.next_entry().await? {
            if !entry.file_type().await?.is_dir() {
                continue;
            }
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if matches!(name_str.as_ref(), "uploads" | "databases" | "api") {
                continue;
            }
            let dest = databases.join(&name);
            if dest.exists() {
                continue;
            }
            tokio::fs::rename(entry.path(), dest).await?;
        }
    }

    let uploads_old = data_dir.join("uploads");
    if uploads_old.is_dir() {
        let mut rd = tokio::fs::read_dir(&uploads_old).await?;
        while let Some(entry) = rd.next_entry().await? {
            let dest = uploads_new.join(entry.file_name());
            if dest.exists() {
                continue;
            }
            tokio::fs::rename(entry.path(), dest).await?;
        }
        let _ = tokio::fs::remove_dir(&uploads_old).await;
    }
    Ok(())
}

async fn rewrite_legacy_stored_paths(pool: &SqlitePool) -> Result<(), StorageError> {
    sqlx::query(
        "UPDATE extracts
         SET stored_path = 'extracts/databases/' || substr(stored_path, 10)
         WHERE stored_path LIKE 'extracts/%'
           AND stored_path NOT LIKE 'extracts/uploads/%'
           AND stored_path NOT LIKE 'extracts/databases/%'
           AND stored_path NOT LIKE 'extracts/api/%'",
    )
    .execute(pool)
    .await?;
    sqlx::query(
        "UPDATE jobs
         SET source_path = 'extracts/uploads/' || substr(source_path, 9)
         WHERE source_path LIKE 'uploads/%'",
    )
    .execute(pool)
    .await?;
    sqlx::query(
        "UPDATE jobs
         SET source_path = 'extracts/databases/' || substr(source_path, 10)
         WHERE source_path LIKE 'extracts/%'
           AND source_path NOT LIKE 'extracts/uploads/%'
           AND source_path NOT LIKE 'extracts/databases/%'
           AND source_path NOT LIKE 'extracts/api/%'",
    )
    .execute(pool)
    .await?;
    Ok(())
}

fn supported_driver(driver: &str) -> bool {
    matches!(
        driver,
        "postgres" | "redshift" | "cockroach" | "mysql" | "mariadb" | "mssql" | "sqlite"
    )
}

fn validate_uuid(id: &str, field: &str) -> Result<(), StorageError> {
    Uuid::parse_str(id)
        .map(|_| ())
        .map_err(|_| StorageError::Invalid(format!("invalid {field}")))
}

pub fn now_rfc3339() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub fn resolve_upload_filename(original: &str, requested: Option<&str>) -> String {
    let source = requested
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .unwrap_or(original);
    let mut name = safe_filename(source);
    let orig_ext = Path::new(original)
        .extension()
        .and_then(|ext| ext.to_str())
        .filter(|ext| !ext.is_empty());
    if Path::new(&name).extension().is_none() {
        if let Some(ext) = orig_ext {
            name = safe_filename(&format!("{name}.{ext}"));
        }
    }
    name
}

fn safe_filename(name: &str) -> String {
    let base = Path::new(name)
        .file_name()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty() && *s != "." && *s != "..")
        .unwrap_or("upload.bin");
    let cleaned: String = base
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
                '_'
            } else {
                c
            }
        })
        .collect::<String>()
        .trim_matches(|c: char| c == ' ' || c == '.')
        .to_string();
    if cleaned.is_empty() {
        "upload.bin".into()
    } else {
        cleaned
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_paths_are_kinded() {
        assert_eq!(
            upload_rel("abc", "sales.csv"),
            "extracts/uploads/abc/sales.csv"
        );
        let (name, rel) = Store::extract_file_rel("abc", "public.users", ",");
        assert_eq!(name, "public_users.csv");
        assert_eq!(rel, "extracts/databases/abc/public_users.csv");
        assert_eq!(
            job_db_extract_rel("job-1"),
            "extracts/databases/job-1/extract.csv"
        );
        let (_, tsv) = Store::extract_file_rel("id", "t", "tab");
        assert_eq!(tsv, "extracts/databases/id/t.tsv");
    }

    #[test]
    fn upload_filename_uses_requested_name() {
        assert_eq!(
            resolve_upload_filename("a.csv", Some("sales")),
            "sales.csv"
        );
        assert_eq!(
            resolve_upload_filename("a.csv", Some("매출자료.csv")),
            "매출자료.csv"
        );
        assert_eq!(resolve_upload_filename("a.csv", Some("  ")), "a.csv");
        assert_eq!(
            resolve_upload_filename("a.csv", Some("../x.csv")),
            "x.csv"
        );
    }

    #[test]
    fn staging_ids_must_be_uuids() {
        assert!(validate_uuid(&Uuid::new_v4().to_string(), "staging_id").is_ok());
        assert!(validate_uuid("../escape", "staging_id").is_err());
    }

    #[tokio::test]
    async fn stages_reads_and_deletes_a_spreadsheet() {
        let root = std::env::temp_dir().join(format!("bintl-storage-test-{}", Uuid::new_v4()));
        let store = Store::open(&root, "test-session-secret").await.unwrap();
        let staged = store
            .stage_spreadsheet("../report.xlsx", b"spreadsheet")
            .await
            .unwrap();
        assert_eq!(staged.original_filename, "report.xlsx");
        assert_eq!(
            store
                .staged_file(&staged.id)
                .await
                .unwrap()
                .original_filename,
            "report.xlsx"
        );
        store.delete_stage(&staged.id).await.unwrap();
        assert!(matches!(
            store.staged_file(&staged.id).await,
            Err(StorageError::NotFound(_))
        ));
        store.pool.close().await;
        std::fs::remove_dir_all(root).unwrap();
    }
}
