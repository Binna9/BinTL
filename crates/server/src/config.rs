use std::net::SocketAddr;
use std::path::PathBuf;

use serde::Deserialize;

#[derive(Debug, Clone, Default, Deserialize)]
struct OdbcFileConfig {
    #[serde(default)]
    pub oracle_driver: Option<String>,
    #[serde(default)]
    pub tibero_driver: Option<String>,
    #[serde(default)]
    pub tibero_jdbc: Option<String>,
    #[serde(default)]
    pub sys_ini: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct FileConfig {
    pub bind: String,
    pub data_dir: PathBuf,
    pub max_upload_mb: u64,
    pub max_concurrent_jobs: usize,
    pub session_secret: String,
    #[serde(default)]
    pub encryption_secret: Option<String>,
    #[serde(default)]
    pub skip_auth: bool,
    #[serde(default)]
    odbc: OdbcFileConfig,
}

#[derive(Debug, Clone)]
pub struct Config {
    pub bind: SocketAddr,
    pub data_dir: PathBuf,
    pub max_upload_mb: u64,
    pub max_concurrent_jobs: usize,
    pub session_secret: String,
    pub encryption_secret: String,
    pub skip_auth: bool,
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
        if let Ok(v) = std::env::var("ETL_ENCRYPTION_SECRET") {
            if !v.is_empty() {
                file.encryption_secret = Some(v);
            }
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
        let encryption_secret = file
            .encryption_secret
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| file.session_secret.clone());

        apply_odbc(&file.odbc);

        Ok(Self {
            bind,
            data_dir: file.data_dir,
            max_upload_mb: file.max_upload_mb,
            max_concurrent_jobs: file.max_concurrent_jobs.max(1),
            session_secret: file.session_secret,
            encryption_secret,
            skip_auth: file.skip_auth,
            ui_dir: std::env::var("ETL_UI_DIR").ok().map(PathBuf::from),
        })
    }

    pub fn max_upload_bytes(&self) -> usize {
        (self.max_upload_mb as usize).saturating_mul(1024 * 1024)
    }
}

fn nonempty(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string())
}

fn apply_odbc(odbc: &OdbcFileConfig) {
    connectors::configure_odbc(connectors::OdbcSettings {
        oracle_driver: nonempty(odbc.oracle_driver.as_deref()),
        tibero_driver: nonempty(odbc.tibero_driver.as_deref()),
        tibero_jdbc: nonempty(std::env::var("BINTL_TIBERO_JDBC_JAR").ok().as_deref())
            .or_else(|| nonempty(odbc.tibero_jdbc.as_deref())),
    });
    if let Some(sys_ini) = nonempty(odbc.sys_ini.as_deref()) {
        set_env_if_unset("ODBCSYSINI", &sys_ini);
    }
}

fn set_env_if_unset(key: &str, value: &str) {
    if std::env::var_os(key).is_some() {
        return;
    }
    // SAFETY: Config::load runs once at startup, before any Oracle/Tibero connect.
    unsafe { std::env::set_var(key, value) };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_odbc_section() {
        let file: FileConfig = toml::from_str(
            r#"
bind = "127.0.0.1:1"
data_dir = "."
max_upload_mb = 1
max_concurrent_jobs = 1
session_secret = "x"
[odbc]
tibero_driver = "/opt/tibero6/client/lib/libtbodbc.so"
oracle_driver = "Oracle 21c ODBC driver"
tibero_jdbc = "/opt/tibero6/client/lib/jar/tibero6-jdbc.jar"
sys_ini = "/opt/tibero6/client/config"
"#,
        )
        .unwrap();
        assert_eq!(
            file.odbc.tibero_driver.as_deref(),
            Some("/opt/tibero6/client/lib/libtbodbc.so")
        );
        assert_eq!(
            file.odbc.oracle_driver.as_deref(),
            Some("Oracle 21c ODBC driver")
        );
        assert_eq!(
            file.odbc.tibero_jdbc.as_deref(),
            Some("/opt/tibero6/client/lib/jar/tibero6-jdbc.jar")
        );
        assert_eq!(
            file.odbc.sys_ini.as_deref(),
            Some("/opt/tibero6/client/config")
        );
    }

    #[test]
    fn odbc_section_is_optional() {
        let file: FileConfig = toml::from_str(
            r#"
bind = "127.0.0.1:1"
data_dir = "."
max_upload_mb = 1
max_concurrent_jobs = 1
session_secret = "x"
"#,
        )
        .unwrap();
        assert!(file.odbc.tibero_driver.is_none());
        assert!(file.odbc.oracle_driver.is_none());
        assert!(file.odbc.tibero_jdbc.is_none());
        assert!(file.odbc.sys_ini.is_none());
    }
}
