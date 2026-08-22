use axum::extract::{DefaultBodyLimit, Multipart, Path, Query, State};
use axum::http::header::{CONTENT_DISPOSITION, CONTENT_TYPE, SET_COOKIE};
use axum::http::{HeaderValue, StatusCode};
use axum::response::{AppendHeaders, IntoResponse};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::auth;
use crate::error::AppError;
use crate::state::AppState;

pub fn public_routes() -> Router<AppState> {
    Router::new()
        .route("/api/health", get(health))
        .route("/api/login", post(login))
        .route("/api/logout", post(logout))
}

pub fn protected_routes(max_upload_bytes: usize) -> Router<AppState> {
    Router::new()
        .route("/api/files", post(upload_file).get(list_files))
        .route("/api/jobs", post(create_job).get(list_jobs))
        .route("/api/jobs/{id}", get(get_job))
        .route("/api/jobs/{id}/run", post(run_job))
        .route("/api/jobs/{id}/result", get(job_result))
        .layer(DefaultBodyLimit::max(max_upload_bytes))
}

async fn health() -> Json<Value> {
    Json(json!({
        "ok": true,
        "version": env!("CARGO_PKG_VERSION"),
    }))
}

#[derive(Deserialize)]
struct LoginBody {
    username: String,
    password: String,
}

async fn login(
    State(state): State<AppState>,
    Json(body): Json<LoginBody>,
) -> Result<impl IntoResponse, AppError> {
    if body.username != state.config.auth.username
        || body.password != state.config.auth.password
    {
        return Err(AppError::unauthorized());
    }
    let cookie = auth::session_cookie(&state.config.session_secret, &body.username);
    Ok((
        [(SET_COOKIE, cookie)],
        Json(json!({ "ok": true })),
    ))
}

async fn logout() -> impl IntoResponse {
    (
        [(SET_COOKIE, auth::clear_cookie())],
        Json(json!({ "ok": true })),
    )
}

async fn upload_file(
    State(state): State<AppState>,
    mut multipart: Multipart,
) -> Result<Json<Value>, AppError> {
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| AppError::bad(e.to_string()))?
    {
        if field.name() != Some("file") {
            continue;
        }
        let filename = field
            .file_name()
            .unwrap_or("upload.bin")
            .to_string();
        let data = field
            .bytes()
            .await
            .map_err(|e| AppError::bad(e.to_string()))?;
        let meta = state.store.save_upload(&filename, &data).await?;
        return Ok(Json(json!({
            "id": meta.id,
            "filename": meta.filename,
            "size": meta.size,
            "stored_path": meta.stored_path,
        })));
    }
    Err(AppError::bad("multipart field `file` required"))
}

async fn list_files(State(state): State<AppState>) -> Result<Json<Value>, AppError> {
    let files = state.store.list_uploads().await?;
    Ok(Json(json!({ "files": files })))
}

#[derive(Deserialize)]
struct CreateJobBody {
    file_id: Option<String>,
    source_path: Option<String>,
    spec: Option<Value>,
}

async fn create_job(
    State(state): State<AppState>,
    Json(body): Json<CreateJobBody>,
) -> Result<(StatusCode, Json<Value>), AppError> {
    let source = if let Some(file_id) = body.file_id {
        state.store.source_for_file_id(&file_id).await?
    } else if let Some(path) = body.source_path {
        if path.is_empty() || path.contains("..") {
            return Err(AppError::bad("invalid source_path"));
        }
        path
    } else {
        return Err(AppError::bad("file_id or source_path required"));
    };
    let spec = body
        .spec
        .unwrap_or_else(|| json!({"version": 1, "op": "identity", "sink": "parquet"}));
    let spec_json = serde_json::to_string(&spec).map_err(|e| AppError::bad(e.to_string()))?;
    let job = state.store.insert_job(&source, &spec_json).await?;
    Ok((StatusCode::CREATED, Json(serde_json::to_value(job).unwrap())))
}

#[derive(Deserialize)]
struct ListQuery {
    limit: Option<i64>,
}

async fn list_jobs(
    State(state): State<AppState>,
    Query(q): Query<ListQuery>,
) -> Result<Json<Value>, AppError> {
    let limit = q.limit.unwrap_or(50).clamp(1, 200);
    let jobs = state.store.list_jobs(limit).await?;
    Ok(Json(json!({ "jobs": jobs })))
}

async fn get_job(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, AppError> {
    let job = state
        .store
        .get_job(&id)
        .await?
        .ok_or_else(|| AppError::not_found("job not found"))?;
    let logs = state.store.list_logs(&id).await?;
    let mut value = serde_json::to_value(job).unwrap();
    value["logs"] = serde_json::to_value(logs).unwrap();
    Ok(Json(value))
}

async fn run_job(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, AppError> {
    let job = state
        .store
        .get_job(&id)
        .await?
        .ok_or_else(|| AppError::not_found("job not found"))?;
    if job.status == "running" {
        return Err(AppError::conflict("job already running"));
    }
    state
        .job_tx
        .try_send(id.clone())
        .map_err(|_| AppError::new(StatusCode::SERVICE_UNAVAILABLE, "job queue full"))?;
    Ok(Json(json!({ "ok": true, "id": id, "status": "queued" })))
}

async fn job_result(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let job = state
        .store
        .get_job(&id)
        .await?
        .ok_or_else(|| AppError::not_found("job not found"))?;
    if job.status != "succeeded" {
        return Err(AppError::conflict("result available only when succeeded"));
    }
    let rel = job
        .output_path
        .ok_or_else(|| AppError::not_found("output missing"))?;
    let path = state.store.resolve(&rel);
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|_| AppError::not_found("output file missing"))?;
    let name = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("result.parquet");
    let disp = format!("attachment; filename=\"{name}\"");
    Ok((
        AppendHeaders([
            (
                CONTENT_TYPE,
                HeaderValue::from_static("application/vnd.apache.parquet"),
            ),
            (
                CONTENT_DISPOSITION,
                HeaderValue::from_str(&disp).unwrap(),
            ),
        ]),
        bytes,
    ))
}
