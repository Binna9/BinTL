use std::path::Path;
use std::time::Duration;

use sqlx::mysql::{MySqlConnectOptions, MySqlPoolOptions, MySqlSslMode};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions, PgSslMode};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::{MySql, Pool, Postgres, Row, Sqlite};
use storage::LiveConnection;

mod catalog;
mod extract;
mod inspect;
mod query;

pub use catalog::{catalog_layout, list_databases, list_relations, list_schemas, CatalogItem};
pub use extract::{extract_table, parse_delimiter, ExtractOptions};
pub use inspect::{list_columns, preview_table, ColumnInfo, Preview};
pub use query::{extract_query, normalize_sql, run_sql, sql_kind, QueryOutcome, SqlKind};
use tiberius::{AuthMethod, Client, Config, EncryptionLevel};
use tokio::net::TcpStream;
use tokio_util::compat::TokioAsyncWriteCompatExt;

#[derive(Debug, thiserror::Error)]
pub enum ConnectError {
    #[error("{0}")]
    Invalid(String),
    #[error("connect timeout")]
    Timeout,
    #[error(transparent)]
    Sqlx(#[from] sqlx::Error),
    #[error(transparent)]
    Tiberius(#[from] tiberius::error::Error),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Csv(#[from] csv::Error),
}

/// Wire-protocol family. One compiled driver covers many server versions.
pub fn driver_family(driver: &str) -> Result<&'static str, ConnectError> {
    match driver {
        "postgres" | "redshift" | "cockroach" => Ok("postgres"),
        "mysql" | "mariadb" => Ok("mysql"),
        "mssql" | "sqlserver" => Ok("mssql"),
        "sqlite" => Ok("sqlite"),
        other => Err(ConnectError::Invalid(format!("unsupported driver {other}"))),
    }
}

#[derive(Debug, Clone)]
pub struct TableName {
    pub schema: Option<String>,
    pub table: String,
}

pub fn parse_table(raw: &str) -> Result<TableName, ConnectError> {
    let parts: Vec<&str> = raw.split('.').collect();
    if parts.is_empty() || parts.len() > 2 {
        return Err(ConnectError::Invalid("table must be name or schema.name".into()));
    }
    for p in &parts {
        if p.is_empty() || !p.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
            return Err(ConnectError::Invalid(
                "table/schema may only contain letters, digits, underscore".into(),
            ));
        }
    }
    Ok(if parts.len() == 2 {
        TableName {
            schema: Some(parts[0].to_string()),
            table: parts[1].to_string(),
        }
    } else {
        TableName {
            schema: None,
            table: parts[0].to_string(),
        }
    })
}

pub fn parse_ident(raw: &str) -> Result<&str, ConnectError> {
    let raw = raw.trim();
    if raw.is_empty() || raw.len() > 128 {
        return Err(ConnectError::Invalid("invalid identifier".into()));
    }
    if !raw
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err(ConnectError::Invalid(
            "identifier may only contain letters, digits, underscore, hyphen".into(),
        ));
    }
    Ok(raw)
}

pub fn with_database(c: &LiveConnection, database: Option<&str>) -> LiveConnection {
    let Some(database) = database.map(str::trim).filter(|s| !s.is_empty()) else {
        return c.clone();
    };
    if driver_family(&c.driver).ok() == Some("sqlite") || database == c.database {
        return c.clone();
    }
    let mut next = c.clone();
    next.database = database.to_string();
    next
}

pub(crate) fn quote_ident(family: &str, ident: &str) -> String {
    match family {
        "mysql" => format!("`{}`", ident.replace('`', "``")),
        "mssql" => format!("[{}]", ident.replace(']', "]]")),
        _ => format!("\"{}\"", ident.replace('"', "\"\"")),
    }
}

pub(crate) fn qualified(family: &str, t: &TableName) -> String {
    match &t.schema {
        Some(s) => format!("{}.{}", quote_ident(family, s), quote_ident(family, &t.table)),
        None => quote_ident(family, &t.table),
    }
}

pub(crate) fn schema_or<'a>(family: &str, t: &'a TableName) -> &'a str {
    t.schema.as_deref().unwrap_or(match family {
        "postgres" => "public",
        "mssql" => "dbo",
        _ => "",
    })
}

pub(crate) async fn pg_pool(c: &LiveConnection) -> Result<Pool<Postgres>, ConnectError> {
    let ssl = if c.ssl {
        PgSslMode::Require
    } else {
        PgSslMode::Disable
    };
    let opts = PgConnectOptions::new()
        .host(&c.host)
        .port(c.port)
        .username(&c.username)
        .password(&c.password)
        .database(&c.database)
        .ssl_mode(ssl);
    Ok(PgPoolOptions::new()
        .max_connections(1)
        .acquire_timeout(Duration::from_secs(8))
        .connect_with(opts)
        .await?)
}

pub(crate) async fn my_pool(c: &LiveConnection) -> Result<Pool<MySql>, ConnectError> {
    let ssl = if c.ssl {
        MySqlSslMode::Required
    } else {
        MySqlSslMode::Disabled
    };
    let opts = MySqlConnectOptions::new()
        .host(&c.host)
        .port(c.port)
        .username(&c.username)
        .password(&c.password)
        .database(&c.database)
        .ssl_mode(ssl);
    Ok(MySqlPoolOptions::new()
        .max_connections(1)
        .acquire_timeout(Duration::from_secs(8))
        .connect_with(opts)
        .await?)
}

fn sqlite_path(c: &LiveConnection) -> &str {
    if !c.database.is_empty() {
        &c.database
    } else {
        &c.host
    }
}

pub(crate) async fn sqlite_pool(c: &LiveConnection) -> Result<Pool<Sqlite>, ConnectError> {
    let opts = SqliteConnectOptions::new()
        .filename(sqlite_path(c))
        .create_if_missing(false);
    Ok(SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(opts)
        .await?)
}

pub(crate) async fn mssql_client(
    c: &LiveConnection,
) -> Result<Client<tokio_util::compat::Compat<TcpStream>>, ConnectError> {
    let mut config = Config::new();
    config.host(&c.host);
    config.port(c.port);
    config.database(&c.database);
    config.authentication(AuthMethod::sql_server(&c.username, &c.password));
    // ponytail: no custom CA upload yet; trust_cert covers typical self-signed SQL Server TLS
    config.trust_cert();
    config.encryption(if c.ssl {
        EncryptionLevel::Required
    } else {
        EncryptionLevel::NotSupported
    });
    let addr = config.get_addr();
    let tcp = tokio::time::timeout(Duration::from_secs(8), TcpStream::connect(addr))
        .await
        .map_err(|_| ConnectError::Timeout)??;
    tcp.set_nodelay(true)?;
    Ok(Client::connect(config, tcp.compat_write()).await?)
}

pub async fn test_connection(c: &LiveConnection) -> Result<(), ConnectError> {
    match driver_family(&c.driver)? {
        "postgres" => {
            let pool = pg_pool(c).await?;
            sqlx::query("SELECT 1").execute(&pool).await?;
            pool.close().await;
        }
        "mysql" => {
            let pool = my_pool(c).await?;
            sqlx::query("SELECT 1").execute(&pool).await?;
            pool.close().await;
        }
        "sqlite" => {
            let pool = sqlite_pool(c).await?;
            sqlx::query("SELECT 1").execute(&pool).await?;
            pool.close().await;
        }
        "mssql" => {
            let mut client = mssql_client(c).await?;
            client.simple_query("SELECT 1").await?;
        }
        other => return Err(ConnectError::Invalid(format!("unsupported family {other}"))),
    }
    Ok(())
}

pub async fn list_tables(c: &LiveConnection) -> Result<Vec<String>, ConnectError> {
    match driver_family(&c.driver)? {
        "postgres" => {
            let pool = pg_pool(c).await?;
            let rows = sqlx::query(
                "SELECT table_schema || '.' || table_name AS q
                 FROM information_schema.tables
                 WHERE table_type IN ('BASE TABLE', 'VIEW')
                   AND table_schema NOT IN ('pg_catalog', 'information_schema')
                 ORDER BY 1",
            )
            .fetch_all(&pool)
            .await?;
            pool.close().await;
            Ok(rows
                .iter()
                .filter_map(|r| r.try_get::<String, _>("q").ok())
                .collect())
        }
        "mysql" => {
            let pool = my_pool(c).await?;
            let rows = sqlx::query(
                "SELECT table_name
                 FROM information_schema.tables
                 WHERE table_type IN ('BASE TABLE', 'VIEW') AND table_schema = DATABASE()
                 ORDER BY 1",
            )
            .fetch_all(&pool)
            .await?;
            pool.close().await;
            Ok(rows
                .iter()
                .filter_map(|r| r.try_get::<String, _>("table_name").ok())
                .collect())
        }
        "sqlite" => {
            let pool = sqlite_pool(c).await?;
            let rows = sqlx::query(
                "SELECT name FROM sqlite_master
                 WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'
                 ORDER BY 1",
            )
            .fetch_all(&pool)
            .await?;
            pool.close().await;
            Ok(rows
                .iter()
                .filter_map(|r| r.try_get::<String, _>("name").ok())
                .collect())
        }
        "mssql" => {
            let mut client = mssql_client(c).await?;
            let stream = client
                .simple_query(
                    "SELECT TABLE_SCHEMA + '.' + TABLE_NAME
                     FROM INFORMATION_SCHEMA.TABLES
                     WHERE TABLE_TYPE IN ('BASE TABLE', 'VIEW')
                     ORDER BY 1",
                )
                .await?;
            let rows = stream.into_first_result().await?;
            Ok(rows
                .iter()
                .filter_map(|r| r.try_get::<&str, usize>(0).ok().flatten().map(str::to_string))
                .collect())
        }
        other => Err(ConnectError::Invalid(format!("unsupported family {other}"))),
    }
}

pub(crate) fn stringify_pg(row: &sqlx::postgres::PgRow, i: usize) -> String {
    stringify_sqlx(row, i)
}

pub(crate) fn stringify_my(row: &sqlx::mysql::MySqlRow, i: usize) -> String {
    stringify_sqlx(row, i)
}

pub(crate) fn stringify_sqlite(row: &sqlx::sqlite::SqliteRow, i: usize) -> String {
    stringify_sqlx(row, i)
}

fn stringify_sqlx<'r, R: Row>(row: &'r R, i: usize) -> String
where
    usize: sqlx::ColumnIndex<R>,
    String: sqlx::Decode<'r, R::Database> + sqlx::Type<R::Database>,
    i64: sqlx::Decode<'r, R::Database> + sqlx::Type<R::Database>,
    i32: sqlx::Decode<'r, R::Database> + sqlx::Type<R::Database>,
    i16: sqlx::Decode<'r, R::Database> + sqlx::Type<R::Database>,
    f64: sqlx::Decode<'r, R::Database> + sqlx::Type<R::Database>,
    f32: sqlx::Decode<'r, R::Database> + sqlx::Type<R::Database>,
    bool: sqlx::Decode<'r, R::Database> + sqlx::Type<R::Database>,
    chrono::NaiveDateTime: sqlx::Decode<'r, R::Database> + sqlx::Type<R::Database>,
    chrono::NaiveDate: sqlx::Decode<'r, R::Database> + sqlx::Type<R::Database>,
    chrono::DateTime<chrono::Utc>: sqlx::Decode<'r, R::Database> + sqlx::Type<R::Database>,
{
    if let Ok(v) = row.try_get::<Option<String>, _>(i) {
        return v.unwrap_or_default();
    }
    if let Ok(v) = row.try_get::<Option<i64>, _>(i) {
        return v.map(|n| n.to_string()).unwrap_or_default();
    }
    if let Ok(v) = row.try_get::<Option<i32>, _>(i) {
        return v.map(|n| n.to_string()).unwrap_or_default();
    }
    if let Ok(v) = row.try_get::<Option<i16>, _>(i) {
        return v.map(|n| n.to_string()).unwrap_or_default();
    }
    if let Ok(v) = row.try_get::<Option<f64>, _>(i) {
        return v.map(|n| n.to_string()).unwrap_or_default();
    }
    if let Ok(v) = row.try_get::<Option<f32>, _>(i) {
        return v.map(|n| n.to_string()).unwrap_or_default();
    }
    if let Ok(v) = row.try_get::<Option<bool>, _>(i) {
        return v.map(|n| n.to_string()).unwrap_or_default();
    }
    if let Ok(v) = row.try_get::<Option<chrono::NaiveDateTime>, _>(i) {
        return v.map(|t| t.to_string()).unwrap_or_default();
    }
    if let Ok(v) = row.try_get::<Option<chrono::NaiveDate>, _>(i) {
        return v.map(|t| t.to_string()).unwrap_or_default();
    }
    if let Ok(v) = row.try_get::<Option<chrono::DateTime<chrono::Utc>>, _>(i) {
        return v.map(|t| t.to_rfc3339()).unwrap_or_default();
    }
    String::new()
}

pub(crate) fn stringify_ms(row: &tiberius::Row, i: usize) -> String {
    if let Ok(Some(v)) = row.try_get::<&str, usize>(i) {
        return v.to_string();
    }
    if let Ok(Some(v)) = row.try_get::<i64, usize>(i) {
        return v.to_string();
    }
    if let Ok(Some(v)) = row.try_get::<i32, usize>(i) {
        return v.to_string();
    }
    if let Ok(Some(v)) = row.try_get::<f64, usize>(i) {
        return v.to_string();
    }
    if let Ok(Some(v)) = row.try_get::<bool, usize>(i) {
        return v.to_string();
    }
    if let Ok(Some(v)) = row.try_get::<chrono::NaiveDateTime, usize>(i) {
        return v.to_string();
    }
    if let Ok(Some(v)) = row.try_get::<chrono::NaiveDate, usize>(i) {
        return v.to_string();
    }
    String::new()
}

fn read_csv(path: &Path) -> Result<(Vec<String>, Vec<Vec<String>>), ConnectError> {
    let mut rdr = csv::Reader::from_path(path)?;
    let headers: Vec<String> = rdr
        .headers()?
        .iter()
        .map(|s| s.to_string())
        .collect();
    for h in &headers {
        if !h.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') || h.is_empty() {
            return Err(ConnectError::Invalid(format!("bad column name `{h}`")));
        }
    }
    let mut rows = Vec::new();
    for rec in rdr.records() {
        let rec = rec?;
        rows.push(rec.iter().map(|s| s.to_string()).collect());
    }
    Ok((headers, rows))
}

fn create_table_sql(family: &str, q: &str, raw_table: &str, cols: &[String]) -> String {
    let defs = cols
        .iter()
        .map(|c| format!("{} TEXT", quote_ident(family, c)))
        .collect::<Vec<_>>()
        .join(", ");
    match family {
        "mssql" => format!(
            "IF OBJECT_ID(N'{}', N'U') IS NULL CREATE TABLE {q} ({defs})",
            raw_table.replace('\'', "")
        ),
        _ => format!("CREATE TABLE IF NOT EXISTS {q} ({defs})"),
    }
}

fn clear_sql(family: &str, q: &str) -> String {
    match family {
        "sqlite" | "mssql" => format!("DELETE FROM {q}"),
        _ => format!("TRUNCATE TABLE {q}"),
    }
}

/// ponytail: row batches via QueryBuilder; COPY/bulk insert when volume matters.
/// New tables are created as TEXT columns from the CSV header.
pub async fn load_table(
    c: &LiveConnection,
    table: &str,
    csv_path: &Path,
    mode: &str,
) -> Result<u64, ConnectError> {
    if mode != "append" && mode != "replace" {
        return Err(ConnectError::Invalid("mode must be append or replace".into()));
    }
    let family = driver_family(&c.driver)?;
    let parsed = parse_table(table)?;
    let q = qualified(family, &parsed);
    let (cols, rows) = read_csv(csv_path)?;
    if cols.is_empty() {
        return Err(ConnectError::Invalid("csv has no columns".into()));
    }
    let create = create_table_sql(family, &q, table, &cols);
    let n = rows.len() as u64;
    match family {
        "postgres" => {
            let pool = pg_pool(c).await?;
            sqlx::query(&create).execute(&pool).await?;
            if mode == "replace" {
                sqlx::query(&clear_sql(family, &q)).execute(&pool).await?;
            }
            insert_sqlx::<Postgres>(&pool, family, &q, &cols, &rows).await?;
            pool.close().await;
        }
        "mysql" => {
            let pool = my_pool(c).await?;
            sqlx::query(&create).execute(&pool).await?;
            if mode == "replace" {
                sqlx::query(&clear_sql(family, &q)).execute(&pool).await?;
            }
            insert_sqlx::<MySql>(&pool, family, &q, &cols, &rows).await?;
            pool.close().await;
        }
        "sqlite" => {
            let pool = sqlite_pool(c).await?;
            sqlx::query(&create).execute(&pool).await?;
            if mode == "replace" {
                sqlx::query(&clear_sql(family, &q)).execute(&pool).await?;
            }
            insert_sqlx::<Sqlite>(&pool, family, &q, &cols, &rows).await?;
            pool.close().await;
        }
        "mssql" => {
            let mut client = mssql_client(c).await?;
            client.simple_query(create).await?;
            if mode == "replace" {
                client.simple_query(clear_sql(family, &q)).await?;
            }
            let col_sql = cols
                .iter()
                .map(|c| quote_ident(family, c))
                .collect::<Vec<_>>()
                .join(", ");
            for row in &rows {
                let placeholders = (1..=cols.len())
                    .map(|i| format!("@P{i}"))
                    .collect::<Vec<_>>()
                    .join(", ");
                let sql = format!("INSERT INTO {q} ({col_sql}) VALUES ({placeholders})");
                let binds: Vec<&str> = row.iter().map(String::as_str).collect();
                let args: Vec<&dyn tiberius::ToSql> =
                    binds.iter().map(|s| s as &dyn tiberius::ToSql).collect();
                client.execute(sql, &args).await?;
            }
        }
        other => return Err(ConnectError::Invalid(format!("unsupported family {other}"))),
    }
    Ok(n)
}

async fn insert_sqlx<DB>(
    pool: &Pool<DB>,
    family: &str,
    q: &str,
    cols: &[String],
    rows: &[Vec<String>],
) -> Result<(), ConnectError>
where
    DB: sqlx::Database,
    for<'q> <DB as sqlx::Database>::Arguments<'q>: sqlx::IntoArguments<'q, DB>,
    for<'c> &'c mut <DB as sqlx::Database>::Connection: sqlx::Executor<'c, Database = DB>,
{
    if rows.is_empty() {
        return Ok(());
    }
    let col_sql = cols
        .iter()
        .map(|c| quote_ident(family, c))
        .collect::<Vec<_>>()
        .join(", ");
    // ponytail: sqlx QueryBuilder cannot outlive .await here; quoted TEXT
    // literals in 80-row batches. Upgrade to binds if values can contain
    // driver-specific escapes we don't cover.
    for chunk in rows.chunks(80) {
        let mut sql = format!("INSERT INTO {q} ({col_sql}) VALUES ");
        for (i, row) in chunk.iter().enumerate() {
            if i > 0 {
                sql.push_str(", ");
            }
            sql.push('(');
            for (j, cell) in row.iter().enumerate() {
                if j > 0 {
                    sql.push_str(", ");
                }
                sql.push_str(&sql_lit(cell));
            }
            sql.push(')');
        }
        sqlx::query(&sql).execute(pool).await?;
    }
    Ok(())
}

fn sql_lit(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('\'');
    for c in s.chars() {
        if c == '\'' {
            out.push('\'');
        }
        out.push(c);
    }
    out.push('\'');
    out
}

pub fn db_source_path(connection_id: &str, table: &str) -> String {
    format!("db:{connection_id}/{table}")
}

pub fn parse_db_source(source_path: &str) -> Option<(String, String)> {
    let rest = source_path.strip_prefix("db:")?;
    let (id, table) = rest.split_once('/')?;
    if id.is_empty() || table.is_empty() {
        return None;
    }
    Some((id.to_string(), table.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn families() {
        assert_eq!(driver_family("mariadb").unwrap(), "mysql");
        assert_eq!(driver_family("redshift").unwrap(), "postgres");
        assert_eq!(driver_family("cockroach").unwrap(), "postgres");
        assert_eq!(driver_family("mssql").unwrap(), "mssql");
        assert!(driver_family("oracle").is_err());
    }

    #[test]
    fn table_ident() {
        assert!(parse_table("users").is_ok());
        assert!(parse_table("public.users").is_ok());
        assert!(parse_table("public.users;drop").is_err());
        assert!(parse_table("a.b.c").is_err());
    }

    #[test]
    fn db_source_roundtrip() {
        let p = db_source_path("abc", "public.t");
        assert_eq!(
            parse_db_source(&p).unwrap(),
            ("abc".into(), "public.t".into())
        );
        assert!(parse_db_source("extracts/uploads/x/y.csv").is_none());
        assert!(parse_db_source("uploads/x/y.csv").is_none());
    }

    #[test]
    fn default_schema() {
        let t = parse_table("users").unwrap();
        assert_eq!(schema_or("postgres", &t), "public");
        assert_eq!(schema_or("mssql", &t), "dbo");
        let q = parse_table("sales.fact").unwrap();
        assert_eq!(schema_or("postgres", &q), "sales");
    }

    #[test]
    fn ident_ok() {
        assert_eq!(parse_ident("analytics").unwrap(), "analytics");
        assert_eq!(parse_ident("dw-1").unwrap(), "dw-1");
        assert!(parse_ident("").is_err());
        assert!(parse_ident("drop;").is_err());
    }
}
