use std::fs::OpenOptions;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use chrono::{SecondsFormat, Utc};

/// SQL preview diagnostics under `data/logs/query`. Chip runs use `execution_logs`.
pub const LOG_QUERY: &str = "query";
pub const LOG_AREAS: [&str; 1] = [LOG_QUERY];

const LEGACY_LOG_AREAS: [&str; 6] = [
    "extracts",
    "extract_runs",
    "transform_runs",
    "jobs",
    "files",
    "connections",
];

/// Preview files older than this are removed on store open.
pub const QUERY_LOG_MAX_AGE: Duration = Duration::from_secs(7 * 24 * 60 * 60);

/// One append-only text file: `data/logs/query/{id}.log`.
#[derive(Debug, Clone)]
pub struct ProcessLog {
    pub path: PathBuf,
}

impl ProcessLog {
    pub fn dir(data_dir: &Path, area: &str) -> PathBuf {
        data_dir.join("logs").join(area)
    }

    pub fn file(data_dir: &Path, area: &str, id: &str) -> PathBuf {
        Self::dir(data_dir, area).join(format!("{id}.log"))
    }

    pub fn create(data_dir: &Path, area: &str, id: &str) -> io::Result<Self> {
        if !LOG_AREAS.contains(&area) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "unknown log area",
            ));
        }
        if !safe_log_id(id) {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "unsafe log id"));
        }
        let dir = Self::dir(data_dir, area);
        std::fs::create_dir_all(&dir)?;
        Ok(Self {
            path: dir.join(format!("{id}.log")),
        })
    }

    /// `2026-08-25T01:30:12.123Z  info   writing  rows=50000`
    pub fn write(&self, level: &str, event: &str, detail: &str) {
        let ts = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
        let line = if detail.is_empty() {
            format!("{ts}  {level:<5}  {event}\n")
        } else {
            format!("{ts}  {level:<5}  {event}  {detail}\n")
        };
        let _ = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
            .and_then(|mut file| file.write_all(line.as_bytes()));
    }
}

pub fn safe_log_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 80
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

pub async fn clean_process_logs(data_dir: &Path) -> io::Result<()> {
    let logs = data_dir.join("logs");
    for name in LEGACY_LOG_AREAS {
        let path = logs.join(name);
        if path.is_dir() {
            tokio::fs::remove_dir_all(&path).await?;
        }
    }
    let query = logs.join(LOG_QUERY);
    if !query.is_dir() {
        return Ok(());
    }
    let cutoff = SystemTime::now()
        .checked_sub(QUERY_LOG_MAX_AGE)
        .unwrap_or(SystemTime::UNIX_EPOCH);
    let mut rd = tokio::fs::read_dir(&query).await?;
    while let Some(entry) = rd.next_entry().await? {
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("log") {
            continue;
        }
        let meta = entry.metadata().await?;
        if !meta.is_file() {
            continue;
        }
        let modified = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        if modified < cutoff {
            tokio::fs::remove_file(path).await?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_line() {
        let dir = std::env::temp_dir().join(format!("bintl-log-{}", std::process::id()));
        let log = ProcessLog::create(&dir, LOG_QUERY, "abc-1").unwrap();
        log.write("info", "started", "sql=select 1");
        log.write("info", "reading", "rows=10");
        let body = std::fs::read_to_string(&log.path).unwrap();
        assert!(body.contains("started  sql=select 1"));
        assert!(body.contains("reading  rows=10"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn rejects_chip_run_areas_and_path_escape() {
        assert!(ProcessLog::create(Path::new("/tmp"), "query", "../x").is_err());
        assert!(ProcessLog::create(Path::new("/tmp"), "extract_runs", "abc").is_err());
        assert!(ProcessLog::create(Path::new("/tmp"), "extracts", "abc").is_err());
    }

    #[tokio::test]
    async fn removes_legacy_log_dirs() {
        let dir = std::env::temp_dir().join(format!("bintl-log-clean-{}", std::process::id()));
        tokio::fs::create_dir_all(dir.join("logs/extracts")).await.unwrap();
        tokio::fs::write(dir.join("logs/extracts/old.log"), "leftover")
            .await
            .unwrap();
        tokio::fs::create_dir_all(dir.join("logs/query")).await.unwrap();
        tokio::fs::write(dir.join("logs/query/fresh.log"), "keep")
            .await
            .unwrap();
        clean_process_logs(&dir).await.unwrap();
        assert!(!dir.join("logs/extracts").exists());
        assert!(dir.join("logs/query/fresh.log").is_file());
        let _ = tokio::fs::remove_dir_all(&dir).await;
    }
}
