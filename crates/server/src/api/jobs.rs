use super::*;

#[derive(Deserialize)]
struct CreateJobBody {
    file_id: Option<String>,
    extract_id: Option<String>,
    source_path: Option<String>,
    connection_id: Option<String>,
    table: Option<String>,
    dest_connection_id: Option<String>,
    dest_table: Option<String>,
    #[serde(default)]
    mode: Option<String>,
    #[serde(default)]
    select: Option<Vec<String>>,
    filter: Option<String>,
    #[serde(default)]
    rename: Option<BTreeMap<String, String>>,
    spec: Option<Value>,
    #[serde(default)]
    workspace_id: Option<String>,
}

pub(super) fn merge_spec(body: &CreateJobBody) -> Result<Value, AppError> {
    let mut spec = body
        .spec
        .clone()
        .unwrap_or_else(|| json!({"version": 1, "op": "pipeline", "sink": "parquet"}));
    if !spec.is_object() {
        return Err(AppError::bad("spec must be an object"));
    }
    let obj = spec.as_object_mut().unwrap();
    obj.entry("version").or_insert(json!(1));
    obj.entry("op").or_insert(json!("pipeline"));
    obj.entry("sink").or_insert(json!("parquet"));
    if let Some(select) = &body.select {
        obj.insert("select".into(), json!(select));
    }
    if let Some(filter) = &body.filter {
        if !filter.trim().is_empty() {
            obj.insert("filter".into(), json!(filter));
        }
    }
    if let Some(rename) = &body.rename {
        obj.insert("rename".into(), json!(rename));
    }
    if let (Some(connection_id), Some(table)) = (&body.dest_connection_id, &body.dest_table) {
        parse_table(table).map_err(|e| AppError::bad(e.to_string()))?;
        let mut dest = Map::new();
        dest.insert("connection_id".into(), json!(connection_id));
        dest.insert("table".into(), json!(table));
        dest.insert(
            "mode".into(),
            json!(body.mode.as_deref().unwrap_or("append")),
        );
        obj.insert("dest".into(), Value::Object(dest));
        obj.insert("op".into(), json!("pipeline"));
    }
    Ok(spec)
}

pub(super) async fn create_job(
    State(state): State<AppState>,
    user: CurrentUser,
    Json(body): Json<CreateJobBody>,
) -> Result<(StatusCode, Json<Value>), AppError> {
    let mut extract_read: Option<(String, bool)> = None;
    let mut workspace_id = body.workspace_id.clone();
    let source = if let Some(file_id) = body.file_id.clone() {
        let dataset = access::require_dataset(&state.store, &user, &file_id).await?;
        workspace_id = Some(dataset.workspace_id);
        state.store.source_for_file_id(&file_id).await?
    } else if let Some(extract_id) = body.extract_id.clone() {
        let row = access::require_extract(&state.store, &user, &extract_id).await?;
        if row.status != "succeeded" {
            return Err(AppError::conflict("extract not ready"));
        }
        extract_read = Some((row.delimiter.clone(), row.header != 0));
        workspace_id = Some(row.workspace_id.clone());
        row.stored_path
            .ok_or_else(|| AppError::not_found("extract file missing"))?
    } else if let (Some(connection_id), Some(table)) =
        (body.connection_id.clone(), body.table.clone())
    {
        parse_table(&table).map_err(|e| AppError::bad(e.to_string()))?;
        let _ = state
            .store
            .get_connection(&connection_id)
            .await?
            .ok_or_else(|| AppError::not_found("connection not found"))?;
        db_source_path(&connection_id, &table)
    } else if let Some(path) = body.source_path.clone() {
        if path.is_empty() || path.contains("..") {
            return Err(AppError::bad("invalid source_path"));
        }
        path
    } else {
        return Err(AppError::bad(
            "file_id, extract_id, connection_id+table, or source_path required",
        ));
    };
    if let Some(mode) = body.mode.as_deref() {
        if mode != "append" && mode != "replace" {
            return Err(AppError::bad("mode must be append or replace"));
        }
    }
    if let Some(id) = &body.dest_connection_id {
        let _ = state
            .store
            .get_connection(id)
            .await?
            .ok_or_else(|| AppError::not_found("dest connection not found"))?;
    }
    let mut spec = merge_spec(&body)?;
    if let Some((delimiter, has_header)) = extract_read {
        let obj = spec.as_object_mut().unwrap();
        obj.entry("delimiter").or_insert(json!(delimiter));
        obj.entry("has_header").or_insert(json!(has_header));
    }
    let spec_json = serde_json::to_string(&spec).map_err(|e| AppError::bad(e.to_string()))?;
    let workspace_id = access::write_workspace(&state.store, &user, workspace_id).await?;
    let job = state
        .store
        .insert_job(&source, &spec_json, &workspace_id)
        .await?;
    Ok((
        StatusCode::CREATED,
        Json(serde_json::to_value(job).unwrap()),
    ))
}

#[derive(Deserialize)]
struct ListQuery {
    limit: Option<i64>,
    workspace_id: Option<String>,
}

pub(super) async fn list_jobs(
    State(state): State<AppState>,
    user: CurrentUser,
    Query(q): Query<ListQuery>,
) -> Result<Json<Value>, AppError> {
    let limit = q.limit.unwrap_or(50).clamp(1, 200);
    let jobs = state
        .store
        .list_jobs(limit, Some(&user.scope(q.workspace_id)))
        .await?;
    Ok(Json(json!({ "jobs": jobs })))
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
    let job = access::require_job(&state.store, &user, &id).await?;
    if job.status == "running" {
        return Err(AppError::conflict("job already running"));
    }
    state
        .job_tx
        .try_send(id.clone())
        .map_err(|_| AppError::new(StatusCode::SERVICE_UNAVAILABLE, "job queue full"))?;
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
