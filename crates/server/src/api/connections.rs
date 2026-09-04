use super::*;

#[derive(Deserialize)]
struct CreateConnectionBody {
    name: String,
    driver: String,
    host: String,
    #[serde(default)]
    port: Option<u16>,
    #[serde(default)]
    database: String,
    #[serde(default)]
    username: String,
    #[serde(default)]
    password: String,
    #[serde(default)]
    ssl: bool,
}

pub(super) fn default_port(driver: &str, port: Option<u16>) -> u16 {
    port.unwrap_or(match driver {
        "mysql" | "mariadb" => 3306,
        "mssql" => 1433,
        "sqlite" | "http" => 0,
        _ => 5432,
    })
}

pub(super) async fn create_connection(
    State(state): State<AppState>,
    user: CurrentUser,
    Json(body): Json<CreateConnectionBody>,
) -> Result<(StatusCode, Json<Value>), AppError> {
    access::require_connection_write(&user)?;
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

pub(super) async fn update_connection(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
    Json(body): Json<CreateConnectionBody>,
) -> Result<Json<Value>, AppError> {
    access::require_connection_write(&user)?;
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

pub(super) async fn list_connections(
    State(state): State<AppState>,
) -> Result<Json<Value>, AppError> {
    let connections = state.store.list_connections().await?;
    Ok(Json(json!({ "connections": connections })))
}

pub(super) async fn get_connection(
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

pub(super) async fn delete_connection(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> Result<Json<Value>, AppError> {
    access::require_connection_write(&user)?;
    state.store.delete_connection(&id).await?;
    Ok(Json(json!({ "ok": true })))
}

pub(super) async fn test_saved_connection(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, AppError> {
    let live = state.store.live_connection(&id).await?;
    test_connection(&live).await?;
    Ok(Json(json!({ "ok": true, "driver": live.driver })))
}

pub(super) async fn connection_tables(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, AppError> {
    let live = state.store.live_connection(&id).await?;
    let tables = list_tables(&live).await?;
    Ok(Json(json!({ "tables": tables })))
}

pub(super) async fn connection_databases(
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

pub(super) async fn connection_schemas(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<CatalogQuery>,
) -> Result<Json<Value>, AppError> {
    parse_ident(&q.database).map_err(|e| AppError::bad(e.to_string()))?;
    let live = state.store.live_connection(&id).await?;
    let schemas = list_schemas(&live, &q.database).await?;
    Ok(Json(json!({ "database": q.database, "schemas": schemas })))
}

pub(super) async fn connection_relations(
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

pub(super) async fn connection_columns(
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

pub(super) async fn connection_preview(
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

pub(super) async fn connection_query(
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
