mod secret;

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

#[derive(Clone)]
pub struct Store {
    pub pool: SqlitePool,
    pub data_dir: PathBuf,
    secret_key: [u8; 32],
}

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
        tokio::fs::create_dir_all(data_dir.join("uploads")).await?;
        tokio::fs::create_dir_all(data_dir.join("outputs")).await?;
        tokio::fs::create_dir_all(data_dir.join("extracts")).await?;

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
        Ok(Self {
            pool,
            data_dir,
            secret_key: secret::key_from_secret(session_secret),
        })
    }

    pub fn uploads_dir(&self) -> PathBuf {
        self.data_dir.join("uploads")
    }

    pub fn outputs_dir(&self) -> PathBuf {
        self.data_dir.join("outputs")
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
    ) -> Result<FileMeta, StorageError> {
        let id = Uuid::new_v4().to_string();
        let filename = safe_filename(filename);
        let rel = format!("uploads/{id}/{filename}");
        let dest = self.data_dir.join(&rel);
        if let Some(parent) = dest.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        tokio::fs::write(&dest, bytes).await?;
        Ok(FileMeta {
            id,
            filename,
            size: bytes.len() as u64,
            stored_path: rel,
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
                    stored_path: format!("uploads/{id}/{}", file.file_name().to_string_lossy()),
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
                return Ok(format!("uploads/{file_id}/{name}"));
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

    pub async fn get_job(&self, id: &str) -> Result<Option<JobRow>, StorageError> {
        let row = sqlx::query_as::<_, JobRow>(
            "SELECT id, status, source_path, output_path, spec_json, error_message,
                    created_at, started_at, finished_at
             FROM jobs WHERE id = ?",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row)
    }

    pub async fn list_jobs(&self, limit: i64) -> Result<Vec<JobRow>, StorageError> {
        let rows = sqlx::query_as::<_, JobRow>(
            "SELECT id, status, source_path, output_path, spec_json, error_message,
                    created_at, started_at, finished_at
             FROM jobs ORDER BY created_at DESC LIMIT ?",
        )
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
        Ok(())
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

    pub fn extract_file_rel(id: &str, table: &str, delimiter: &str) -> (String, String) {
        let ext = match delimiter {
            "tab" | "\\t" | "\t" => "tsv",
            "," => "csv",
            _ => "txt",
        };
        let filename = format!("{}.{}", safe_filename(&table.replace('.', "_")), ext);
        let rel = format!("extracts/{id}/{filename}");
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

fn supported_driver(driver: &str) -> bool {
    matches!(
        driver,
        "postgres" | "redshift" | "cockroach" | "mysql" | "mariadb" | "mssql" | "sqlite"
    )
}

pub fn now_rfc3339() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
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
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') {
                c
            } else {
                '_'
            }
        })
        .collect();
    if cleaned.is_empty() {
        "upload.bin".into()
    } else {
        cleaned
    }
}
