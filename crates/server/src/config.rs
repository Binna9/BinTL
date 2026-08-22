use std::net::SocketAddr;
use std::path::PathBuf;

use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
pub struct FileConfig {
    pub bind: String,
    pub data_dir: PathBuf,
    pub max_upload_mb: u64,
    pub max_concurrent_jobs: usize,
    pub session_secret: String,
    #[serde(default)]
    pub skip_auth: bool,
    pub auth: AuthConfig,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AuthConfig {
    pub username: String,
    pub password: String,
}

#[derive(Debug, Clone)]
pub struct Config {
    pub bind: SocketAddr,
    pub data_dir: PathBuf,
    pub max_upload_mb: u64,
    pub max_concurrent_jobs: usize,
    pub session_secret: String,
    pub skip_auth: bool,
    pub auth: AuthConfig,
    pub ui_dir: Option<PathBuf>,
}

impl Config {
    pub fn load(path: &std::path::Path) -> Result<Self, String> {
        let raw = std::fs::read_to_string(path)
            .map_err(|e| format!("read config {}: {e}", path.display()))?;
        let mut file: FileConfig =
            toml::from_str(&raw).map_err(|e| format!("parse config: {e}"))?;

        if let Ok(v) = std::env::var("ETL_BIND") {
            file.bind = v;
        }
        if let Ok(v) = std::env::var("ETL_DATA_DIR") {
            file.data_dir = PathBuf::from(v);
        }
        if let Ok(v) = std::env::var("ETL_SESSION_SECRET") {
            file.session_secret = v;
        }
        if let Ok(v) = std::env::var("ETL_AUTH_USERNAME") {
            file.auth.username = v;
        }
        if let Ok(v) = std::env::var("ETL_AUTH_PASSWORD") {
            file.auth.password = v;
        }
        if let Ok(v) = std::env::var("ETL_SKIP_AUTH") {
            file.skip_auth = matches!(v.as_str(), "1" | "true" | "TRUE" | "yes");
        }

        let bind = file
            .bind
            .parse::<SocketAddr>()
            .map_err(|e| format!("invalid bind {}: {e}", file.bind))?;
        if file.session_secret.is_empty() {
            return Err("session_secret is empty".into());
        }

        Ok(Self {
            bind,
            data_dir: file.data_dir,
            max_upload_mb: file.max_upload_mb,
            max_concurrent_jobs: file.max_concurrent_jobs.max(1),
            session_secret: file.session_secret,
            skip_auth: file.skip_auth,
            auth: file.auth,
            ui_dir: std::env::var("ETL_UI_DIR").ok().map(PathBuf::from),
        })
    }

    pub fn max_upload_bytes(&self) -> usize {
        (self.max_upload_mb as usize).saturating_mul(1024 * 1024)
    }
}
