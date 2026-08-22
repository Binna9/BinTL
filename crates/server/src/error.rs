use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

#[derive(Debug)]
pub struct AppError {
    status: StatusCode,
    message: String,
}

impl AppError {
    pub fn new(status: StatusCode, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }

    pub fn unauthorized() -> Self {
        Self::new(StatusCode::UNAUTHORIZED, "unauthorized")
    }

    pub fn not_found(msg: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, msg)
    }

    pub fn bad(msg: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, msg)
    }

    pub fn conflict(msg: impl Into<String>) -> Self {
        Self::new(StatusCode::CONFLICT, msg)
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        (self.status, Json(json!({ "error": self.message }))).into_response()
    }
}

impl From<connectors::ConnectError> for AppError {
    fn from(err: connectors::ConnectError) -> Self {
        match &err {
            connectors::ConnectError::Invalid(m) => Self::bad(m.clone()),
            _ => Self::new(StatusCode::BAD_GATEWAY, err.to_string()),
        }
    }
}

impl From<storage::StorageError> for AppError {
    fn from(err: storage::StorageError) -> Self {
        match &err {
            storage::StorageError::NotFound(m) => Self::not_found(m.clone()),
            storage::StorageError::Invalid(m) => Self::bad(m.clone()),
            _ => Self::new(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
        }
    }
}
