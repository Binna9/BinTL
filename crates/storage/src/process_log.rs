use std::fs::OpenOptions;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use chrono::{SecondsFormat, Utc};

/// Page / pipeline folders under `data/logs/`.
pub const LOG_EXTRACTS: &str = "extracts";
pub const LOG_JOBS: &str = "jobs";
pub const LOG_QUERY: &str = "query";
pub const LOG_FILES: &str = "files";
pub const LOG_CONNECTIONS: &str = "connections";

pub const LOG_AREAS: [&str; 5] = [
    LOG_EXTRACTS,
    LOG_JOBS,
    LOG_QUERY,
    LOG_FILES,
    LOG_CONNECTIONS,
];

/// One append-only text file: `data/logs/{area}/{id}.log`.
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_line() {
        let dir = std::env::temp_dir().join(format!("bintl-log-{}", std::process::id()));
        let log = ProcessLog::create(&dir, LOG_EXTRACTS, "abc-1").unwrap();
        log.write("info", "started", "table=orders delimiter=,");
        log.write("info", "writing", "rows=10000");
        let body = std::fs::read_to_string(&log.path).unwrap();
        assert!(body.contains("started  table=orders"));
        assert!(body.contains("writing  rows=10000"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn rejects_path_escape() {
        assert!(ProcessLog::create(Path::new("/tmp"), "extracts", "../x").is_err());
        assert!(ProcessLog::create(Path::new("/tmp"), "nope", "abc").is_err());
    }
}
