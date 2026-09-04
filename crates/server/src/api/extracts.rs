use super::*;

pub(super) fn compact_sql(sql: &str) -> String {
    let compact = sql.split_whitespace().collect::<Vec<_>>().join(" ");
    if compact.chars().count() <= 240 {
        return compact;
    }
    format!("{}…", compact.chars().take(240).collect::<String>())
}

#[derive(Deserialize)]
struct CreateExtractBody {
    #[serde(default)]
    kind: Option<String>,
    connection_id: String,
    #[serde(default)]
    table: Option<String>,
    #[serde(default)]
    sql: Option<String>,
    #[serde(default)]
    source: Option<Value>,
    #[serde(default)]
    delimiter: Option<String>,
    #[serde(default)]
    header: Option<bool>,
    #[serde(default)]
    add_sequence: Option<bool>,
    #[serde(default)]
    database: Option<String>,
    #[serde(default)]
    workspace_id: Option<String>,
    #[serde(default)]
    filename: Option<String>,
    #[serde(default)]
    name: Option<String>,
}

#[derive(Deserialize)]
struct HttpPreviewBody {
    connection_id: String,
    #[serde(default)]
    request_type: String,
    #[serde(default = "default_http_method")]
    method: String,
    #[serde(default)]
    path: String,
    #[serde(default)]
    query: Vec<HttpKv>,
    #[serde(default)]
    headers: Vec<HttpKv>,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    body_mode: String,
    #[serde(default)]
    form: Vec<HttpKv>,
    #[serde(default)]
    timeout_ms: Option<u64>,
    #[serde(default)]
    graphql_query: String,
    #[serde(default)]
    graphql_variables: Value,
    #[serde(default)]
    graphql_operation_name: String,
    #[serde(default)]
    records_path: String,
    #[serde(default)]
    limit: Option<usize>,
}

pub(super) fn default_http_method() -> String {
    "GET".into()
}

pub(super) async fn create_extract(
    State(state): State<AppState>,
    user: CurrentUser,
    Json(body): Json<CreateExtractBody>,
) -> Result<(StatusCode, Json<Value>), AppError> {
    let kind = body
        .kind
        .as_deref()
        .unwrap_or("database")
        .trim()
        .to_ascii_lowercase();
    match kind.as_str() {
        "api" => create_api_extract(state, user, body).await,
        "database" => create_database_extract(state, user, body).await,
        other => Err(AppError::bad(format!("unsupported extract kind: {other}"))),
    }
}

pub(super) async fn create_api_extract(
    state: AppState,
    user: CurrentUser,
    body: CreateExtractBody,
) -> Result<(StatusCode, Json<Value>), AppError> {
    let connection = state
        .store
        .get_connection(&body.connection_id)
        .await?
        .ok_or_else(|| AppError::not_found("connection not found"))?;
    if connection.driver != "http" {
        return Err(AppError::bad("api extract needs an http connection"));
    }
    let raw = if let Some(source) = body.source {
        serde_json::to_string(&source).map_err(|error| AppError::bad(error.to_string()))?
    } else {
        body.sql
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| AppError::bad("source or sql required for api extract"))?
            .to_string()
    };
    let spec = parse_http_spec(&raw).map_err(|error| AppError::bad(error.to_string()))?;
    let source = json!({
        "type": "http",
        "request_type": spec.request_type,
        "method": spec.method,
        "path": spec.path,
        "query": spec.query,
        "headers": spec.headers,
        "body": spec.body,
        "body_mode": spec.body_mode,
        "form": spec.form,
        "timeout_ms": spec.timeout_ms,
        "graphql_query": spec.graphql_query,
        "graphql_variables": spec.graphql_variables,
        "graphql_operation_name": spec.graphql_operation_name,
        "records_path": spec.records_path,
    });
    let sql = serde_json::to_string(&source).map_err(|error| AppError::bad(error.to_string()))?;
    let table = match body
        .table
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(table) => table.to_string(),
        None if !spec.path.trim().is_empty() => {
            spec.path.trim().trim_matches('/').replace('/', "_")
        }
        None => "http".into(),
    };
    let delimiter = body.delimiter.unwrap_or_else(|| ",".into());
    parse_delimiter(&delimiter).map_err(|e| AppError::bad(e.to_string()))?;
    let workspace_id = access::write_workspace(&state.store, &user, body.workspace_id).await?;
    let output_filename = body
        .filename
        .as_deref()
        .or(body.name.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let row = state
        .store
        .insert_extract(
            "api",
            &body.connection_id,
            &table,
            &delimiter,
            body.header.unwrap_or(true),
            body.add_sequence.unwrap_or(false),
            Some(&sql),
            None,
            &workspace_id,
            output_filename,
        )
        .await?;
    crate::extract::spawn(state.store.clone(), row.id.clone());
    Ok((
        StatusCode::CREATED,
        Json(serde_json::to_value(row).unwrap()),
    ))
}

pub(super) async fn create_database_extract(
    state: AppState,
    user: CurrentUser,
    body: CreateExtractBody,
) -> Result<(StatusCode, Json<Value>), AppError> {
    let sql = match body.sql.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(raw) => {
            let sql = normalize_sql(raw).map_err(|e| AppError::bad(e.to_string()))?;
            if sql_kind(&sql) != SqlKind::Rows {
                return Err(AppError::bad(
                    "extract needs a result set (SELECT / WITH / SHOW …)",
                ));
            }
            Some(sql)
        }
        None => None,
    };
    let table = match body
        .table
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        Some(table) => {
            parse_table(table).map_err(|e| AppError::bad(e.to_string()))?;
            table.to_string()
        }
        None if sql.is_some() => "query".into(),
        None => return Err(AppError::bad("table or sql required")),
    };
    let delimiter = body.delimiter.unwrap_or_else(|| ",".into());
    parse_delimiter(&delimiter).map_err(|e| AppError::bad(e.to_string()))?;
    let catalog_database = match body
        .database
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        Some(database) => {
            parse_ident(database).map_err(|e| AppError::bad(e.to_string()))?;
            Some(database.to_string())
        }
        None => None,
    };
    let workspace_id = access::write_workspace(&state.store, &user, body.workspace_id).await?;
    let output_filename = body
        .filename
        .as_deref()
        .or(body.name.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let row = state
        .store
        .insert_extract(
            "database",
            &body.connection_id,
            &table,
            &delimiter,
            body.header.unwrap_or(true),
            body.add_sequence.unwrap_or(false),
            sql.as_deref(),
            catalog_database.as_deref(),
            &workspace_id,
            output_filename,
        )
        .await?;
    crate::extract::spawn(state.store.clone(), row.id.clone());
    Ok((
        StatusCode::CREATED,
        Json(serde_json::to_value(row).unwrap()),
    ))
}

pub(super) async fn http_preview(
    State(state): State<AppState>,
    _user: CurrentUser,
    Json(body): Json<HttpPreviewBody>,
) -> Result<Json<Value>, AppError> {
    let live = state.store.live_connection(&body.connection_id).await?;
    if live.driver != "http" {
        return Err(AppError::bad("http preview needs an http connection"));
    }
    let spec = HttpRequestSpec {
        request_type: body.request_type,
        method: body.method,
        path: body.path,
        query: body.query,
        headers: body.headers,
        body: body.body,
        body_mode: body.body_mode,
        form: body.form,
        timeout_ms: body.timeout_ms,
        graphql_query: body.graphql_query,
        graphql_variables: body.graphql_variables,
        graphql_operation_name: body.graphql_operation_name,
        records_path: body.records_path,
    };
    let raw = serde_json::to_string(&spec).map_err(|error| AppError::bad(error.to_string()))?;
    let spec = parse_http_spec(&raw).map_err(|error| AppError::bad(error.to_string()))?;
    let limit = body.limit.unwrap_or(50).clamp(1, 500);
    let preview = preview_http(&live, &spec, limit)
        .await
        .map_err(|error| AppError::bad(error.to_string()))?;
    let rows = preview
        .rows
        .into_iter()
        .map(|row| {
            preview
                .columns
                .iter()
                .map(|column| row.get(column).cloned().unwrap_or_default())
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();
    Ok(Json(json!({
        "status": preview.status,
        "columns": preview.columns,
        "rows": rows,
        "row_count": preview.row_count,
        "truncated": preview.row_count > rows.len(),
        "limit": limit,
    })))
}

pub(super) async fn list_extracts(
    State(state): State<AppState>,
    user: CurrentUser,
    Query(q): Query<ListQuery>,
) -> Result<Json<Value>, AppError> {
    let limit = q.limit.unwrap_or(50).clamp(1, 200);
    let extracts = state
        .store
        .list_extracts(limit, Some(&user.scope(q.workspace_id)))
        .await?;
    Ok(Json(json!({ "extracts": extracts })))
}

pub(super) async fn get_extract(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> Result<Json<Value>, AppError> {
    let row = access::require_extract(&state.store, &user, &id).await?;
    Ok(Json(serde_json::to_value(row).unwrap()))
}

pub(super) async fn delete_extract(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> Result<Json<Value>, AppError> {
    access::require_extract(&state.store, &user, &id).await?;
    state.store.delete_extract(&id).await?;
    Ok(Json(json!({ "ok": true })))
}

pub(super) async fn preview_extract(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
    Query(query): Query<ListQuery>,
) -> Result<Json<Value>, AppError> {
    let row = access::require_extract(&state.store, &user, &id).await?;
    if row.status != "succeeded" {
        return Err(AppError::conflict("preview available only when succeeded"));
    }
    let stored_path = row
        .stored_path
        .clone()
        .ok_or_else(|| AppError::not_found("extract file missing"))?;
    let path = state.store.resolve(&stored_path);
    let delimiter_raw = if row.delimiter.trim().is_empty() {
        ",".into()
    } else {
        row.delimiter.clone()
    };
    let delimiter = parse_delimiter(&delimiter_raw)?;
    let has_header = row.header != 0;
    let limit = query.limit.unwrap_or(200).clamp(1, 1000) as usize;
    let preview = tokio::task::spawn_blocking(move || {
        read_upload_preview(&path, delimiter, has_header, limit)
    })
    .await
    .map_err(|error| {
        AppError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("extract preview failed: {error}"),
        )
    })??;
    let filename = row.filename.clone().unwrap_or_else(|| "extract.txt".into());
    Ok(Json(json!({
        "id": row.id,
        "filename": filename,
        "stored_path": stored_path,
        "delimiter": delimiter_raw,
        "has_header": has_header,
        "columns": preview.columns,
        "rows": preview.rows,
        "row_count": preview.row_count,
        "truncated": preview.truncated,
    })))
}

pub(super) async fn extract_logs(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> Result<Json<Value>, AppError> {
    access::require_extract(&state.store, &user, &id).await?;
    let text = state
        .store
        .read_process_log(storage::LOG_EXTRACTS, &id)
        .await?;
    Ok(Json(json!({ "id": id, "text": text })))
}

pub(super) async fn extract_file(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let row = access::require_extract(&state.store, &user, &id).await?;
    if row.status != "succeeded" {
        return Err(AppError::conflict("file available only when succeeded"));
    }
    let rel = row
        .stored_path
        .ok_or_else(|| AppError::not_found("extract file missing"))?;
    let path = state.store.resolve(&rel);
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|_| AppError::not_found("extract file missing"))?;
    let name = row.filename.as_deref().unwrap_or("extract.txt");
    let disp = format!("attachment; filename=\"{name}\"");
    let ctype = if name.ends_with(".tsv") {
        "text/tab-separated-values; charset=utf-8"
    } else {
        "text/csv; charset=utf-8"
    };
    Ok((
        AppendHeaders([
            (CONTENT_TYPE, HeaderValue::from_str(ctype).unwrap()),
            (CONTENT_DISPOSITION, HeaderValue::from_str(&disp).unwrap()),
        ]),
        bytes,
    ))
}
