use super::*;

pub(super) async fn list_jobs(
    State(state): State<AppState>,
    user: CurrentUser,
    Query(q): Query<ListQuery>,
) -> Result<Json<Value>, AppError> {
    let limit = q.limit.unwrap_or(50).clamp(1, 200);
    let transform_runs = state
        .store
        .list_jobs(limit, Some(&user.scope(q.workspace_id)))
        .await?;
    Ok(Json(json!({ "jobs": transform_runs })))
}

pub(super) async fn get_job(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> Result<Json<Value>, AppError> {
    let job = access::require_job(&state.store, &user, &id).await?;
    let logs = state.store.list_logs(&id).await?;
    let mut value = serde_json::to_value(job).unwrap();
    value["logs"] = serde_json::to_value(logs).unwrap();
    Ok(Json(value))
}

pub(super) async fn run_job(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> Result<Json<Value>, AppError> {
    access::require_transform_run(&user)?;
    let job = access::require_job(&state.store, &user, &id).await?;
    if job.status == "running" {
        return Err(AppError::conflict("job already running"));
    }
    if job.status == "failed" {
        state.store.requeue_failed_job(&id).await?;
    }
    state.wake();
    Ok(Json(json!({ "ok": true, "id": id, "status": "queued" })))
}

pub(super) async fn job_result(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let job = access::require_job(&state.store, &user, &id).await?;
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
            (CONTENT_DISPOSITION, HeaderValue::from_str(&disp).unwrap()),
        ]),
        bytes,
    ))
}
