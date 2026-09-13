use serde::{Deserialize, Serialize};
use crate::StorageError;

/// Non-secret authentication settings. Passwords and tokens use password_cipher.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct HttpAuthConfig {
    pub mode: String,
    pub api_key_name: String,
    pub api_key_location: String,
    pub login_path: String,
    pub login_body_mode: String,
    pub username_field: String,
    pub password_field: String,
    pub access_token_path: String,
    pub token_header: String,
    pub token_prefix: String,
    pub refresh_path: String,
    pub refresh_token_path: String,
    pub refresh_field: String,
    pub refresh_body_mode: String,
}
impl Default for HttpAuthConfig {
    fn default() -> Self {
        Self {
            mode: "none".into(), api_key_name: "X-API-Key".into(), api_key_location: "header".into(),
            login_path: "/auth/login".into(), login_body_mode: "json".into(),
            username_field: "email".into(), password_field: "password".into(),
            access_token_path: "data.accessToken".into(), token_header: "Authorization".into(), token_prefix: "Bearer".into(),
            refresh_path: String::new(), refresh_token_path: "data.refreshToken".into(),
            refresh_field: "refreshToken".into(), refresh_body_mode: "json".into(),
        }
    }
}
impl HttpAuthConfig {
    pub fn validate(&self) -> Result<(), StorageError> {
        let invalid = |message: &str| StorageError::Invalid(message.into());
        if !matches!(self.mode.as_str(), "none" | "basic" | "bearer" | "api_key" | "custom") {
            return Err(invalid("unsupported HTTP authentication mode"));
        }
        if self.mode == "api_key" && (self.api_key_name.trim().is_empty() || !matches!(self.api_key_location.as_str(), "header" | "query")) {
            return Err(invalid("API key name and header/query location are required"));
        }
        if self.mode == "custom" {
            if self.login_path.trim().is_empty() || self.username_field.trim().is_empty()
                || self.password_field.trim().is_empty() || self.access_token_path.trim().is_empty()
                || self.token_header.trim().is_empty() {
                return Err(invalid("login URL, credential field names, token path and token header are required"));
            }
            let user = self.username_field.trim();
            let pass = self.password_field.trim();
            if user == pass || user.starts_with(&format!("{pass}.")) || pass.starts_with(&format!("{user}.")) {
                return Err(invalid("username and password fields must not overlap"));
            }
            if !matches!(self.login_body_mode.as_str(), "json" | "urlencoded") {
                return Err(invalid("login body mode must be json or urlencoded"));
            }
            if !self.refresh_path.trim().is_empty() && (self.refresh_field.trim().is_empty()
                || self.refresh_token_path.trim().is_empty()
                || !matches!(self.refresh_body_mode.as_str(), "json" | "urlencoded" | "header")) {
                return Err(invalid("refresh token path, field and body mode are required"));
            }
        }
        Ok(())
    }
}
