use axum::extract::{DefaultBodyLimit, Multipart, Path, Query, State};
use axum::http::header::{CONTENT_DISPOSITION, CONTENT_TYPE, SET_COOKIE};
use axum::http::{HeaderValue, StatusCode};
use axum::response::{AppendHeaders, IntoResponse};
use axum::routing::{get, post};
use axum::{Json, Router};
use connectors::{
    catalog_layout, db_source_path, export_sheet_to_csv, list_columns, list_databases,
    list_relations, list_schemas, list_sheets, list_tables, normalize_sql, parse_delimiter,
    parse_ident, parse_table, preview_table, run_sql, sniff_delimiter, spreadsheet_format, sql_kind,
    test_connection, with_database, SqlKind,
};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashSet};
use std::path::Path as FsPath;

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
        .route("/api/files/stage", post(stage_spreadsheet))
        .route("/api/files/commit", post(commit_spreadsheet))
        .route("/api/files/stage/{id}", axum::routing::delete(cancel_stage))
        .route("/api/files/{id}", axum::routing::delete(delete_file))
        .route("/api/files/{id}/preview", get(preview_file))
        .route(
            "/api/connections",
            post(create_connection).get(list_connections),
        )
        .route(
            "/api/connections/{id}",
            get(get_connection)
                .put(update_connection)
                .delete(delete_connection),
        )
        .route("/api/connections/{id}/test", post(test_saved_connection))
        .route("/api/connections/{id}/tables", get(connection_tables))
        .route("/api/connections/{id}/databases", get(connection_databases))
        .route("/api/connections/{id}/schemas", get(connection_schemas))
        .route("/api/connections/{id}/relations", get(connection_relations))
        .route("/api/connections/{id}/columns", get(connection_columns))
        .route("/api/connections/{id}/preview", get(connection_preview))
        .route("/api/connections/{id}/query", post(connection_query))
        .route("/api/logs/{area}/{id}", get(process_logs))
        .route("/api/extracts", post(create_extract).get(list_extracts))
        .route("/api/extracts/{id}", get(get_extract))
        .route("/api/extracts/{id}/logs", get(extract_logs))
        .route("/api/extracts/{id}/file", get(extract_file))
        .route("/api/jobs", post(create_job).get(list_jobs))
        .route("/api/jobs/{id}", get(get_job))
        .route("/api/jobs/{id}/run", post(run_job))
        .route("/api/jobs/{id}/result", get(job_result))
        .merge(crate::workspace::routes())
        .merge(crate::task::routes())
        .merge(crate::transform::routes())
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
    if body.username != state.config.auth.username || body.password != state.config.auth.password {
        return Err(AppError::unauthorized());
    }
    let cookie = auth::session_cookie(&state.config.session_secret, &body.username);
    Ok(([(SET_COOKIE, cookie)], Json(json!({ "ok": true }))))
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
    let mut requested_name: Option<String> = None;
    let mut payload: Option<(String, Vec<u8>)> = None;
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| AppError::bad(e.to_string()))?
    {
        match field.name() {
            Some("filename") => {
                requested_name = Some(
                    field
                        .text()
                        .await
                        .map_err(|e| AppError::bad(e.to_string()))?,
                );
            }
            Some("file") => {
                let original = field.file_name().unwrap_or("upload.bin").to_string();
                let data = field
                    .bytes()
                    .await
                    .map_err(|e| AppError::bad(e.to_string()))?;
                payload = Some((original, data.to_vec()));
            }
            _ => {}
        }
    }
    let (original, data) =
        payload.ok_or_else(|| AppError::bad("multipart field `file` required"))?;
    require_csv_filename(&original)?;
    let filename = storage::resolve_upload_filename(&original, requested_name.as_deref());
    require_csv_filename(&filename)?;
    let delimiter_raw = sniff_delimiter(&data).unwrap_or_else(|| ",".into());
    let delimiter = parse_delimiter(&delimiter_raw)?;
    validate_csv(&data, delimiter)?;
    let meta = state
        .store
        .save_upload(&filename, &data, Some(&delimiter_raw), Some(true))
        .await?;
    Ok(Json(json!({
        "id": meta.id,
        "filename": meta.filename,
        "size": meta.size,
        "stored_path": meta.stored_path,
    })))
}

async fn stage_spreadsheet(
    State(state): State<AppState>,
    mut multipart: Multipart,
) -> Result<(StatusCode, Json<Value>), AppError> {
    let mut payload: Option<(String, Vec<u8>)> = None;
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|error| AppError::bad(error.to_string()))?
    {
        if field.name() == Some("file") {
            let original_filename = field
                .file_name()
                .ok_or_else(|| AppError::bad("uploaded spreadsheet needs a filename"))?
                .to_string();
            let bytes = field
                .bytes()
                .await
                .map_err(|error| AppError::bad(error.to_string()))?;
            payload = Some((original_filename, bytes.to_vec()));
        }
    }
    let (original_filename, bytes) =
        payload.ok_or_else(|| AppError::bad("multipart field `file` required"))?;
    let format = spreadsheet_format(FsPath::new(&original_filename))?.to_string();
    let staged = state
        .store
        .stage_spreadsheet(&original_filename, &bytes)
        .await?;
    let path = staged.path.clone();
    let sheets = match tokio::task::spawn_blocking(move || list_sheets(&path)).await {
        Ok(Ok(sheets)) => sheets,
        Ok(Err(error)) => {
            let _ = state.store.delete_stage(&staged.id).await;
            return Err(error.into());
        }
        Err(error) => {
            let _ = state.store.delete_stage(&staged.id).await;
            return Err(AppError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("spreadsheet task failed: {error}"),
            ));
        }
    };
    if sheets.is_empty() {
        let _ = state.store.delete_stage(&staged.id).await;
        return Err(AppError::bad("spreadsheet contains no worksheets"));
    }
    Ok((
        StatusCode::CREATED,
        Json(json!({
            "staging_id": staged.id,
            "original_filename": staged.original_filename,
            "format": format,
            "sheets": sheets,
        })),
    ))
}

#[derive(Debug, Clone, Deserialize)]
struct CommitSheet {
    name: String,
    filename: String,
}

#[derive(Deserialize)]
struct CommitSpreadsheetBody {
    staging_id: String,
    sheets: Vec<CommitSheet>,
    #[serde(default)]
    delimiter: Option<String>,
    #[serde(default)]
    header: Option<bool>,
    #[serde(default)]
    add_sequence: Option<bool>,
}

async fn commit_spreadsheet(
    State(state): State<AppState>,
    Json(body): Json<CommitSpreadsheetBody>,
) -> Result<(StatusCode, Json<Value>), AppError> {
    if body.sheets.is_empty() {
        return Err(AppError::bad("at least one sheet must be selected"));
    }
    let staged = state.store.staged_file(&body.staging_id).await?;
    let selected = normalize_commit_sheets(body.sheets)?;
    let delimiter_raw = body.delimiter.unwrap_or_else(|| ",".into());
    let delimiter = parse_delimiter(&delimiter_raw)?;
    let header = body.header.unwrap_or(true);
    let add_sequence = body.add_sequence.unwrap_or(false);
    let path = staged.path.clone();
    let exports = tokio::task::spawn_blocking(
        move || -> Result<Vec<(String, Vec<u8>)>, connectors::ConnectError> {
            let available: HashSet<String> = list_sheets(&path)?
                .into_iter()
                .map(|sheet| sheet.name)
                .collect();
            let mut exports = Vec::with_capacity(selected.len());
            for sheet in selected {
                if !available.contains(&sheet.name) {
                    return Err(connectors::ConnectError::Invalid(format!(
                        "sheet `{}` not found",
                        sheet.name
                    )));
                }
                let csv = export_sheet_to_csv(&path, &sheet.name, delimiter, header, add_sequence)?;
                exports.push((sheet.filename, csv));
            }
            Ok(exports)
        },
    )
    .await
    .map_err(|error| {
        AppError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("spreadsheet task failed: {error}"),
        )
    })??;

    for (_, bytes) in &exports {
        validate_csv(bytes, delimiter)?;
    }
    state.store.delete_stage(&staged.id).await?;
    let mut files = Vec::with_capacity(exports.len());
    for (filename, bytes) in exports {
        files.push(
            state
                .store
                .save_upload(
                    &filename,
                    &bytes,
                    Some(delimiter_raw.as_str()),
                    Some(header),
                )
                .await?,
        );
    }
    Ok((StatusCode::CREATED, Json(json!({ "files": files }))))
}

async fn cancel_stage(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, AppError> {
    state.store.delete_stage(&id).await?;
    Ok(Json(json!({ "ok": true })))
}

fn normalize_commit_sheets(sheets: Vec<CommitSheet>) -> Result<Vec<CommitSheet>, AppError> {
    let mut names = HashSet::new();
    let mut normalized = Vec::with_capacity(sheets.len());
    for sheet in sheets {
        let name = sheet.name.trim();
        if name.is_empty() {
            return Err(AppError::bad("sheet name required"));
        }
        if !names.insert(name.to_string()) {
            return Err(AppError::bad(format!(
                "sheet `{name}` selected more than once"
            )));
        }
        if sheet.filename.trim().is_empty() {
            return Err(AppError::bad("csv filename required"));
        }
        let filename =
            storage::resolve_upload_filename(&format!("{name}.csv"), Some(sheet.filename.trim()));
        require_csv_filename(&filename)?;
        normalized.push(CommitSheet {
            name: name.to_string(),
            filename,
        });
    }
    Ok(normalized)
}

fn require_csv_filename(filename: &str) -> Result<(), AppError> {
    let is_csv = FsPath::new(filename)
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("csv"));
    if !is_csv {
        return Err(AppError::bad("only .csv files are accepted"));
    }
    Ok(())
}

fn validate_csv(bytes: &[u8], delimiter: u8) -> Result<(), AppError> {
    if bytes.is_empty() {
        return Err(AppError::bad("csv must not be empty"));
    }
    let mut reader = csv::ReaderBuilder::new()
        .delimiter(delimiter)
        .has_headers(false)
        .flexible(false)
        .from_reader(bytes);
    let mut expected_width = None;
    let mut row_count = 0usize;
    for record in reader.records() {
        let record = record.map_err(|error| AppError::bad(format!("invalid csv: {error}")))?;
        if record.is_empty() {
            return Err(AppError::bad("csv rows must not be empty"));
        }
        match expected_width {
            Some(width) if width != record.len() => {
                return Err(AppError::bad("csv rows must have a consistent width"));
            }
            None => expected_width = Some(record.len()),
            _ => {}
        }
        row_count += 1;
    }
    if row_count == 0 {
        return Err(AppError::bad("csv must contain at least one row"));
    }
    Ok(())
}

async fn list_files(State(state): State<AppState>) -> Result<Json<Value>, AppError> {
    let files = state.store.list_uploads().await?;
    Ok(Json(json!({ "files": files })))
}

async fn delete_file(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, AppError> {
    state.store.delete_upload(&id).await?;
    Ok(Json(json!({ "ok": true })))
}

async fn preview_file(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<ListQuery>,
) -> Result<Json<Value>, AppError> {
    let meta = state.store.get_upload(&id).await?;
    let path = state.store.upload_path(&id).await?;
    let dataset = state.store.get_dataset(&id).await?;
    let stored_delimiter = dataset
        .as_ref()
        .and_then(|row| row.delimiter.clone())
        .filter(|value| !value.trim().is_empty());
    let has_header = dataset
        .as_ref()
        .and_then(|row| row.has_header)
        .map(|value| value != 0)
        .unwrap_or(true);
    let sample = tokio::fs::read(&path)
        .await
        .map_err(|error| AppError::bad(format!("file read failed: {error}")))?;
    let delimiter_raw = stored_delimiter
        .clone()
        .or_else(|| sniff_delimiter(&sample))
        .unwrap_or_else(|| ",".into());
    let delimiter = parse_delimiter(&delimiter_raw)?;
    let limit = query.limit.unwrap_or(200).clamp(1, 1000) as usize;
    let preview = tokio::task::spawn_blocking(move || {
        read_upload_preview(&path, delimiter, has_header, limit)
    })
    .await
    .map_err(|error| {
        AppError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("file preview failed: {error}"),
        )
    })??;
    if stored_delimiter.is_none() {
        if let Ok(columns_json) = serde_json::to_string(&preview.columns) {
            let _ = state
                .store
                .update_dataset_inspect(
                    &id,
                    &columns_json,
                    Some(preview.row_count as i64),
                    Some(&delimiter_raw),
                    Some(has_header),
                    Some(meta.size as i64),
                )
                .await;
        }
    }
    Ok(Json(json!({
        "id": meta.id,
        "filename": meta.filename,
        "stored_path": meta.stored_path,
        "delimiter": delimiter_raw,
        "has_header": has_header,
        "columns": preview.columns,
        "rows": preview.rows,
        "row_count": preview.row_count,
        "truncated": preview.truncated,
    })))
}

struct UploadPreview {
    columns: Vec<String>,
    rows: Vec<Vec<String>>,
    row_count: u64,
    truncated: bool,
}

fn read_upload_preview(
    path: &FsPath,
    delimiter: u8,
    has_header: bool,
    limit: usize,
) -> Result<UploadPreview, AppError> {
    let mut reader = csv::ReaderBuilder::new()
        .delimiter(delimiter)
        .has_headers(has_header)
        .flexible(true)
        .from_path(path)
        .map_err(|error| AppError::bad(format!("invalid csv: {error}")))?;
    let mut columns: Vec<String> = if has_header {
        reader
            .headers()
            .map_err(|error| AppError::bad(format!("invalid csv: {error}")))?
            .iter()
            .map(str::to_string)
            .collect()
    } else {
        Vec::new()
    };
    let mut rows = Vec::new();
    let mut row_count = 0u64;
    for record in reader.records() {
        let record = record.map_err(|error| AppError::bad(format!("invalid csv: {error}")))?;
        row_count += 1;
        if columns.is_empty() {
            columns = (0..record.len()).map(|index| format!("{}", index + 1)).collect();
        }
        if rows.len() < limit {
            rows.push(record.iter().map(str::to_string).collect());
        }
    }
    if columns.is_empty() {
        return Err(AppError::bad("csv must contain at least one row"));
    }
    Ok(UploadPreview {
        columns,
        rows,
        row_count,
        truncated: row_count as usize > limit,
    })
}

#[derive(Deserialize)]
struct CreateConnectionBody {
    name: String,
    driver: String,
    host: String,
    #[serde(default)]
    port: Option<u16>,
    database: String,
    username: String,
    #[serde(default)]
    password: String,
    #[serde(default)]
    ssl: bool,
}

fn default_port(driver: &str, port: Option<u16>) -> u16 {
    port.unwrap_or(match driver {
        "mysql" | "mariadb" => 3306,
        "mssql" => 1433,
        "sqlite" => 0,
        _ => 5432,
    })
}

async fn create_connection(
    State(state): State<AppState>,
    Json(body): Json<CreateConnectionBody>,
) -> Result<(StatusCode, Json<Value>), AppError> {
    let driver = body.driver.to_ascii_lowercase();
    let row = state
        .store
        .insert_connection(storage::NewConnection {
            name: body.name,
            driver: driver.clone(),
            host: body.host,
            port: default_port(&driver, body.port),
            database: body.database,
            username: body.username,
            password: body.password,
            ssl: body.ssl,
        })
        .await?;
    Ok((
        StatusCode::CREATED,
        Json(serde_json::to_value(row).unwrap()),
    ))
}

async fn update_connection(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<CreateConnectionBody>,
) -> Result<Json<Value>, AppError> {
    let driver = body.driver.to_ascii_lowercase();
    let row = state
        .store
        .update_connection(
            &id,
            storage::NewConnection {
                name: body.name,
                driver: driver.clone(),
                host: body.host,
                port: default_port(&driver, body.port),
                database: body.database,
                username: body.username,
                password: body.password,
                ssl: body.ssl,
            },
        )
        .await?;
    Ok(Json(serde_json::to_value(row).unwrap()))
}

async fn list_connections(State(state): State<AppState>) -> Result<Json<Value>, AppError> {
    let connections = state.store.list_connections().await?;
    Ok(Json(json!({ "connections": connections })))
}

async fn get_connection(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, AppError> {
    let row = state
        .store
        .get_connection(&id)
        .await?
        .ok_or_else(|| AppError::not_found("connection not found"))?;
    Ok(Json(serde_json::to_value(row).unwrap()))
}

async fn delete_connection(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, AppError> {
    state.store.delete_connection(&id).await?;
    Ok(Json(json!({ "ok": true })))
}

async fn test_saved_connection(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, AppError> {
    let live = state.store.live_connection(&id).await?;
    test_connection(&live).await?;
    Ok(Json(json!({ "ok": true, "driver": live.driver })))
}

async fn connection_tables(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, AppError> {
    let live = state.store.live_connection(&id).await?;
    let tables = list_tables(&live).await?;
    Ok(Json(json!({ "tables": tables })))
}

async fn connection_databases(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, AppError> {
    let live = state.store.live_connection(&id).await?;
    let layout = catalog_layout(&live.driver)?;
    let databases = list_databases(&live).await?;
    Ok(Json(json!({
        "layout": layout,
        "current": live.database,
        "databases": databases,
    })))
}

#[derive(Deserialize)]
struct CatalogQuery {
    database: String,
    schema: Option<String>,
}

async fn connection_schemas(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<CatalogQuery>,
) -> Result<Json<Value>, AppError> {
    parse_ident(&q.database).map_err(|e| AppError::bad(e.to_string()))?;
    let live = state.store.live_connection(&id).await?;
    let schemas = list_schemas(&live, &q.database).await?;
    Ok(Json(json!({ "database": q.database, "schemas": schemas })))
}

async fn connection_relations(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<CatalogQuery>,
) -> Result<Json<Value>, AppError> {
    parse_ident(&q.database).map_err(|e| AppError::bad(e.to_string()))?;
    if let Some(schema) = q.schema.as_deref() {
        parse_ident(schema).map_err(|e| AppError::bad(e.to_string()))?;
    }
    let live = state.store.live_connection(&id).await?;
    let tables = list_relations(&live, &q.database, q.schema.as_deref()).await?;
    Ok(Json(json!({
        "database": q.database,
        "schema": q.schema,
        "tables": tables,
    })))
}

#[derive(Deserialize)]
struct TableQuery {
    table: String,
    limit: Option<u32>,
    database: Option<String>,
}

async fn connection_columns(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<TableQuery>,
) -> Result<Json<Value>, AppError> {
    parse_table(&q.table).map_err(|e| AppError::bad(e.to_string()))?;
    if let Some(database) = q.database.as_deref() {
        parse_ident(database).map_err(|e| AppError::bad(e.to_string()))?;
    }
    let live = state.store.live_connection(&id).await?;
    let live = with_database(&live, q.database.as_deref());
    let columns = list_columns(&live, &q.table).await?;
    Ok(Json(json!({ "table": q.table, "columns": columns })))
}

async fn connection_preview(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<TableQuery>,
) -> Result<Json<Value>, AppError> {
    parse_table(&q.table).map_err(|e| AppError::bad(e.to_string()))?;
    if let Some(database) = q.database.as_deref() {
        parse_ident(database).map_err(|e| AppError::bad(e.to_string()))?;
    }
    let live = state.store.live_connection(&id).await?;
    let live = with_database(&live, q.database.as_deref());
    let limit = q.limit.unwrap_or(50).clamp(1, 200);
    let preview = preview_table(&live, &q.table, limit).await?;
    Ok(Json(json!({
        "table": q.table,
        "limit": limit,
        "columns": preview.columns,
        "rows": preview.rows,
    })))
}

#[derive(Deserialize)]
struct RunQueryBody {
    sql: String,
    #[serde(default)]
    limit: Option<u32>,
    #[serde(default)]
    database: Option<String>,
    #[serde(default)]
    log_id: Option<String>,
}

async fn connection_query(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<RunQueryBody>,
) -> Result<Json<Value>, AppError> {
    let sql = normalize_sql(&body.sql).map_err(|e| AppError::bad(e.to_string()))?;
    if let Some(database) = body.database.as_deref() {
        parse_ident(database).map_err(|e| AppError::bad(e.to_string()))?;
    }
    let live = state.store.live_connection(&id).await?;
    let live = with_database(&live, body.database.as_deref());
    let limit = body.limit.unwrap_or(100).clamp(1, 1000);
    let log_id = body
        .log_id
        .as_deref()
        .filter(|value| storage::safe_log_id(value))
        .map(str::to_string)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let log = storage::ProcessLog::create(&state.store.data_dir, storage::LOG_QUERY, &log_id).ok();
    if let Some(log) = &log {
        log.write(
            "info",
            "started",
            &format!(
                "preview_limit={limit} driver={} database={} sql={}",
                live.driver,
                live.database,
                compact_sql(&sql)
            ),
        );
    }
    let progress_log = log.clone();
    let on_progress = move |n: u64| {
        if let Some(log) = &progress_log {
            log.write("info", "reading", &format!("rows={n}"));
        }
    };
    match run_sql(&live, &sql, limit, Some(&on_progress)).await {
        Ok(out) => {
            if let Some(log) = &log {
                log.write(
                    "info",
                    "succeeded",
                    &format!("rows={} elapsed_ms={}", out.row_count, out.elapsed_ms),
                );
            }
            Ok(Json(json!({
                "kind": out.kind,
                "columns": out.columns,
                "rows": out.rows,
                "row_count": out.row_count,
                "truncated": out.truncated,
                "elapsed_ms": out.elapsed_ms,
                "limit": limit,
                "log_id": log_id,
            })))
        }
        Err(err) => {
            if let Some(log) = &log {
                log.write("error", "failed", &err.to_string());
            }
            Err(err.into())
        }
    }
}

async fn process_logs(
    State(state): State<AppState>,
    Path((area, id)): Path<(String, String)>,
) -> Result<Json<Value>, AppError> {
    let text = state.store.read_process_log(&area, &id).await?;
    Ok(Json(json!({ "area": area, "id": id, "text": text })))
}

fn compact_sql(sql: &str) -> String {
    let compact = sql.split_whitespace().collect::<Vec<_>>().join(" ");
    if compact.chars().count() <= 240 {
        return compact;
    }
    format!("{}…", compact.chars().take(240).collect::<String>())
}

#[derive(Deserialize)]
struct CreateExtractBody {
    connection_id: String,
    #[serde(default)]
    table: Option<String>,
    #[serde(default)]
    sql: Option<String>,
    #[serde(default)]
    delimiter: Option<String>,
    #[serde(default)]
    header: Option<bool>,
    #[serde(default)]
    add_sequence: Option<bool>,
    #[serde(default)]
    database: Option<String>,
}

async fn create_extract(
    State(state): State<AppState>,
    Json(body): Json<CreateExtractBody>,
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
    let row = state
        .store
        .insert_extract(
            &body.connection_id,
            &table,
            &delimiter,
            body.header.unwrap_or(true),
            body.add_sequence.unwrap_or(false),
            sql.as_deref(),
            catalog_database.as_deref(),
        )
        .await?;
    crate::extract::spawn(state.store.clone(), row.id.clone());
    Ok((
        StatusCode::CREATED,
        Json(serde_json::to_value(row).unwrap()),
    ))
}

async fn list_extracts(
    State(state): State<AppState>,
    Query(q): Query<ListQuery>,
) -> Result<Json<Value>, AppError> {
    let limit = q.limit.unwrap_or(50).clamp(1, 200);
    let extracts = state.store.list_extracts(limit).await?;
    Ok(Json(json!({ "extracts": extracts })))
}

async fn get_extract(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, AppError> {
    let row = state
        .store
        .get_extract(&id)
        .await?
        .ok_or_else(|| AppError::not_found("extract not found"))?;
    Ok(Json(serde_json::to_value(row).unwrap()))
}

async fn extract_logs(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, AppError> {
    let _row = state
        .store
        .get_extract(&id)
        .await?
        .ok_or_else(|| AppError::not_found("extract not found"))?;
    let text = state
        .store
        .read_process_log(storage::LOG_EXTRACTS, &id)
        .await?;
    Ok(Json(json!({ "id": id, "text": text })))
}

async fn extract_file(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let row = state
        .store
        .get_extract(&id)
        .await?
        .ok_or_else(|| AppError::not_found("extract not found"))?;
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
}

fn merge_spec(body: &CreateJobBody) -> Result<Value, AppError> {
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

async fn create_job(
    State(state): State<AppState>,
    Json(body): Json<CreateJobBody>,
) -> Result<(StatusCode, Json<Value>), AppError> {
    let mut extract_read: Option<(String, bool)> = None;
    let source = if let Some(file_id) = body.file_id.clone() {
        state.store.source_for_file_id(&file_id).await?
    } else if let Some(extract_id) = body.extract_id.clone() {
        let row = state
            .store
            .get_extract(&extract_id)
            .await?
            .ok_or_else(|| AppError::not_found("extract not found"))?;
        if row.status != "succeeded" {
            return Err(AppError::conflict("extract not ready"));
        }
        extract_read = Some((row.delimiter.clone(), row.header != 0));
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
    let job = state.store.insert_job(&source, &spec_json).await?;
    Ok((
        StatusCode::CREATED,
        Json(serde_json::to_value(job).unwrap()),
    ))
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
            (CONTENT_DISPOSITION, HeaderValue::from_str(&disp).unwrap()),
        ]),
        bytes,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn csv_upload_validation_requires_rows_and_consistent_width() {
        assert!(validate_csv(b"name,amount\nalice,10\n", b',').is_ok());
        assert!(validate_csv(b"name|amount\nalice|10\n", b'|').is_ok());
        assert!(validate_csv(b"", b',').is_err());
        assert!(validate_csv(b"\n\n", b',').is_err());
        assert!(validate_csv(b"a,b\n1\n", b',').is_err());
        assert!(validate_csv(b"a,b\n\"unterminated\n", b',').is_err());
    }

    #[test]
    fn commit_sheet_validation_requires_unique_names_and_csv_filenames() {
        let valid = normalize_commit_sheets(vec![CommitSheet {
            name: "Sales".into(),
            filename: "sales.csv".into(),
        }])
        .unwrap();
        assert_eq!(valid[0].filename, "sales.csv");

        assert!(normalize_commit_sheets(vec![CommitSheet {
            name: "Sales".into(),
            filename: "sales.xlsx".into(),
        }])
        .is_err());
        assert!(normalize_commit_sheets(vec![
            CommitSheet {
                name: "Sales".into(),
                filename: "sales.csv".into(),
            },
            CommitSheet {
                name: "Sales".into(),
                filename: "sales-copy.csv".into(),
            },
        ])
        .is_err());
    }
}
