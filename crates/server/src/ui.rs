use std::path::{Path, PathBuf};

use axum::body::Body;
use axum::extract::State;
use axum::http::{header, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use rust_embed::RustEmbed;

use crate::state::AppState;

#[derive(RustEmbed)]
#[folder = "../../ui/dist"]
struct Assets;

pub async fn fallback(State(state): State<AppState>, uri: Uri) -> Response {
    let path = uri.path();
    if path.starts_with("/api") {
        return (
            StatusCode::NOT_FOUND,
            [(header::CONTENT_TYPE, "application/json")],
            r#"{"error":"not found"}"#,
        )
            .into_response();
    }
    if let Some(dir) = &state.config.ui_dir {
        return serve_disk(dir, path).await;
    }
    serve_embed(path)
}

fn serve_embed(path: &str) -> Response {
    let rel = normalized_rel(path);
    if let Some(file) = Assets::get(&rel) {
        let mime = file.metadata.mimetype();
        return Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, mime)
            .body(Body::from(file.data.into_owned()))
            .unwrap();
    }
    if rel.starts_with("assets/") {
        return (StatusCode::NOT_FOUND, "not found").into_response();
    }
    match Assets::get("index.html") {
        Some(file) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
            .body(Body::from(file.data.into_owned()))
            .unwrap(),
        None => (StatusCode::NOT_FOUND, "ui not built").into_response(),
    }
}

async fn serve_disk(dir: &Path, path: &str) -> Response {
    let rel = normalized_rel(path);
    let candidate = dir.join(&rel);
    if let Some(file) = read_under(dir, &candidate).await {
        return file_response(&candidate, file);
    }
    if rel.starts_with("assets/") {
        return (StatusCode::NOT_FOUND, "not found").into_response();
    }
    let index = dir.join("index.html");
    match read_under(dir, &index).await {
        Some(file) => file_response(&index, file),
        None => (StatusCode::NOT_FOUND, "ui not built").into_response(),
    }
}

fn normalized_rel(path: &str) -> String {
    let rel = path.trim_start_matches('/');
    if rel.is_empty() {
        "index.html".into()
    } else {
        rel.to_string()
    }
}

async fn read_under(root: &Path, path: &Path) -> Option<Vec<u8>> {
    let root = tokio::fs::canonicalize(root).await.ok()?;
    let canon = tokio::fs::canonicalize(path).await.ok()?;
    if !canon.starts_with(&root) {
        return None;
    }
    tokio::fs::read(canon).await.ok()
}

fn file_response(path: &PathBuf, bytes: Vec<u8>) -> Response {
    let mime = mime_guess::from_path(path).first_or_octet_stream();
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime.as_ref())
        .body(Body::from(bytes))
        .unwrap()
}
