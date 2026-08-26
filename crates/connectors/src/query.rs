use std::fs::File;
use std::path::Path;
use std::time::Instant;

use csv::WriterBuilder;
use futures_util::TryStreamExt;
use serde::Serialize;
use sqlx::Column;
use storage::LiveConnection;

use crate::extract::{tick_progress, tick_progress_at, with_sequence, with_sequence_header};
use crate::{
    driver_family, mssql_client, my_pool, pg_pool, sqlite_pool, stringify_ms, stringify_my,
    stringify_pg, stringify_sqlite, ConnectError, ExtractOptions,
};

const MAX_SQL_CHARS: usize = 20_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SqlKind {
    Rows,
    Exec,
}

#[derive(Debug, Clone, Serialize)]
pub struct QueryOutcome {
    pub kind: &'static str,
    pub columns: Vec<String>,
    pub rows: Vec<Vec<String>>,
    pub row_count: u64,
    pub truncated: bool,
    pub elapsed_ms: u64,
}

pub fn normalize_sql(raw: &str) -> Result<String, ConnectError> {
    let sql = raw.trim();
    if sql.is_empty() {
        return Err(ConnectError::Invalid("sql is empty".into()));
    }
    if sql.chars().count() > MAX_SQL_CHARS {
        return Err(ConnectError::Invalid("sql is too long".into()));
    }
    let stripped = strip_trailing_semicolons(sql);
    if has_internal_semicolon(&stripped) {
        return Err(ConnectError::Invalid("one statement only".into()));
    }
    if stripped.is_empty() {
        return Err(ConnectError::Invalid("sql is empty".into()));
    }
    Ok(stripped)
}

pub fn sql_kind(sql: &str) -> SqlKind {
    match first_keyword(sql).as_str() {
        "select" | "with" | "show" | "explain" | "pragma" | "describe" | "desc" | "values"
        | "table" => SqlKind::Rows,
        _ => SqlKind::Exec,
    }
}

pub async fn run_sql(
    c: &LiveConnection,
    sql: &str,
    limit: u32,
    on_progress: Option<&(dyn Fn(u64) + Send + Sync)>,
) -> Result<QueryOutcome, ConnectError> {
    let sql = normalize_sql(sql)?;
    let started = Instant::now();
    let family = driver_family(&c.driver)?;
    let outcome = match sql_kind(&sql) {
        SqlKind::Rows => {
            let limit = u64::from(limit.clamp(1, 1000));
            let capped = apply_preview_limit(family, &sql, limit);
            fetch_rows(c, family, &capped, Some(limit), on_progress).await?
        }
        SqlKind::Exec => exec_sql(c, family, &sql).await?,
    };
    Ok(QueryOutcome {
        elapsed_ms: started.elapsed().as_millis() as u64,
        ..outcome
    })
}

pub async fn extract_query(
    c: &LiveConnection,
    sql: &str,
    dest: &Path,
    opts: &ExtractOptions,
    on_progress: Option<&(dyn Fn(u64) + Send + Sync)>,
) -> Result<u64, ConnectError> {
    let sql = normalize_sql(sql)?;
    if sql_kind(&sql) != SqlKind::Rows {
        return Err(ConnectError::Invalid(
            "extract needs a result set (SELECT / WITH / SHOW …)".into(),
        ));
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut wtr = WriterBuilder::new()
        .delimiter(opts.delimiter)
        .quote(opts.quote)
        .from_path(dest)?;
    let family = driver_family(&c.driver)?;
    let n = match family {
        "postgres" => stream_pg(c, &sql, &mut wtr, opts.header, opts.add_sequence, None, on_progress).await?,
        "mysql" => stream_my(c, &sql, &mut wtr, opts.header, opts.add_sequence, None, on_progress).await?,
        "sqlite" => stream_sqlite(c, &sql, &mut wtr, opts.header, opts.add_sequence, None, on_progress).await?,
        "mssql" => stream_ms(c, &sql, &mut wtr, opts.header, opts.add_sequence, None, on_progress).await?,
        other => return Err(ConnectError::Invalid(format!("unsupported family {other}"))),
    };
    wtr.flush()?;
    Ok(n)
}

async fn fetch_rows(
    c: &LiveConnection,
    family: &str,
    sql: &str,
    limit: Option<u64>,
    on_progress: Option<&(dyn Fn(u64) + Send + Sync)>,
) -> Result<QueryOutcome, ConnectError> {
    let mut sink = RowSink::new(limit);
    match family {
        "postgres" => collect_pg(c, sql, &mut sink, on_progress).await?,
        "mysql" => collect_my(c, sql, &mut sink, on_progress).await?,
        "sqlite" => collect_sqlite(c, sql, &mut sink, on_progress).await?,
        "mssql" => collect_ms(c, sql, &mut sink, on_progress).await?,
        other => return Err(ConnectError::Invalid(format!("unsupported family {other}"))),
    }
    Ok(sink.into_outcome())
}

async fn exec_sql(
    c: &LiveConnection,
    family: &str,
    sql: &str,
) -> Result<QueryOutcome, ConnectError> {
    let affected = match family {
        "postgres" => {
            let pool = pg_pool(c).await?;
            let n = sqlx::query(sql).execute(&pool).await?.rows_affected();
            pool.close().await;
            n
        }
        "mysql" => {
            let pool = my_pool(c).await?;
            let n = sqlx::query(sql).execute(&pool).await?.rows_affected();
            pool.close().await;
            n
        }
        "sqlite" => {
            let pool = sqlite_pool(c).await?;
            let n = sqlx::query(sql).execute(&pool).await?.rows_affected();
            pool.close().await;
            n
        }
        "mssql" => {
            let mut client = mssql_client(c).await?;
            let result = client.execute(sql.to_string(), &[]).await?;
            result.rows_affected().iter().copied().sum()
        }
        other => return Err(ConnectError::Invalid(format!("unsupported family {other}"))),
    };
    Ok(QueryOutcome {
        kind: "exec",
        columns: vec!["rows_affected".into()],
        rows: vec![vec![affected.to_string()]],
        row_count: affected,
        truncated: false,
        elapsed_ms: 0,
    })
}

struct RowSink {
    columns: Vec<String>,
    rows: Vec<Vec<String>>,
    limit: Option<u64>,
    truncated: bool,
}

impl RowSink {
    fn new(limit: Option<u64>) -> Self {
        Self {
            columns: Vec::new(),
            rows: Vec::new(),
            limit,
            truncated: false,
        }
    }

    fn push(&mut self, columns: Vec<String>, rec: Vec<String>) -> bool {
        if self.columns.is_empty() {
            self.columns = columns;
        }
        if let Some(lim) = self.limit {
            if self.rows.len() as u64 >= lim {
                self.truncated = true;
                return false;
            }
        }
        self.rows.push(rec);
        true
    }

    fn into_outcome(self) -> QueryOutcome {
        let row_count = self.rows.len() as u64;
        QueryOutcome {
            kind: "rows",
            columns: self.columns,
            rows: self.rows,
            row_count,
            truncated: self.truncated,
            elapsed_ms: 0,
        }
    }
}

async fn collect_pg(
    c: &LiveConnection,
    sql: &str,
    sink: &mut RowSink,
    on_progress: Option<&(dyn Fn(u64) + Send + Sync)>,
) -> Result<(), ConnectError> {
    let pool = pg_pool(c).await?;
    let mut stream = sqlx::query(sql).fetch(&pool);
    while let Some(row) = stream.try_next().await? {
        let cols = colnames_sqlx(&row);
        let rec: Vec<String> = (0..cols.len()).map(|i| stringify_pg(&row, i)).collect();
        if !sink.push(cols, rec) {
            break;
        }
        tick_progress_at(on_progress, sink.rows.len() as u64, 10);
    }
    pool.close().await;
    Ok(())
}

async fn collect_my(
    c: &LiveConnection,
    sql: &str,
    sink: &mut RowSink,
    on_progress: Option<&(dyn Fn(u64) + Send + Sync)>,
) -> Result<(), ConnectError> {
    let pool = my_pool(c).await?;
    let mut stream = sqlx::query(sql).fetch(&pool);
    while let Some(row) = stream.try_next().await? {
        let cols = colnames_sqlx(&row);
        let rec: Vec<String> = (0..cols.len()).map(|i| stringify_my(&row, i)).collect();
        if !sink.push(cols, rec) {
            break;
        }
        tick_progress_at(on_progress, sink.rows.len() as u64, 10);
    }
    pool.close().await;
    Ok(())
}

async fn collect_sqlite(
    c: &LiveConnection,
    sql: &str,
    sink: &mut RowSink,
    on_progress: Option<&(dyn Fn(u64) + Send + Sync)>,
) -> Result<(), ConnectError> {
    let pool = sqlite_pool(c).await?;
    let mut stream = sqlx::query(sql).fetch(&pool);
    while let Some(row) = stream.try_next().await? {
        let cols = colnames_sqlx(&row);
        let rec: Vec<String> = (0..cols.len()).map(|i| stringify_sqlite(&row, i)).collect();
        if !sink.push(cols, rec) {
            break;
        }
        tick_progress_at(on_progress, sink.rows.len() as u64, 10);
    }
    pool.close().await;
    Ok(())
}

async fn collect_ms(
    c: &LiveConnection,
    sql: &str,
    sink: &mut RowSink,
    on_progress: Option<&(dyn Fn(u64) + Send + Sync)>,
) -> Result<(), ConnectError> {
    let mut client = mssql_client(c).await?;
    if let Some(n) = sink.limit {
        client
            .execute(format!("SET ROWCOUNT {n}"), &[])
            .await?;
    }
    let stream = client.simple_query(sql.to_string()).await?;
    let mut rows = stream.into_row_stream();
    while let Some(row) = rows.try_next().await? {
        let cols: Vec<String> = row.columns().iter().map(|c| c.name().to_string()).collect();
        let rec: Vec<String> = (0..cols.len()).map(|i| stringify_ms(&row, i)).collect();
        if !sink.push(cols, rec) {
            break;
        }
        tick_progress_at(on_progress, sink.rows.len() as u64, 10);
    }
    drop(rows);
    if sink.limit.is_some() {
        let _ = client.execute("SET ROWCOUNT 0", &[]).await;
    }
    Ok(())
}

async fn stream_pg(
    c: &LiveConnection,
    sql: &str,
    wtr: &mut csv::Writer<File>,
    header: bool,
    add_sequence: bool,
    limit: Option<u64>,
    on_progress: Option<&(dyn Fn(u64) + Send + Sync)>,
) -> Result<u64, ConnectError> {
    let pool = pg_pool(c).await?;
    sqlx::query("SET default_transaction_read_only = on")
        .execute(&pool)
        .await?;
    let mut stream = sqlx::query(sql).fetch(&pool);
    let mut n = 0u64;
    let mut wrote_header = false;
    while let Some(row) = stream.try_next().await? {
        let cols = colnames_sqlx(&row);
        if header && !wrote_header {
            wtr.write_record(&with_sequence_header(add_sequence, cols.clone()))?;
            wrote_header = true;
        }
        if let Some(lim) = limit {
            if n >= lim {
                break;
            }
        }
        n += 1;
        let rec: Vec<String> = (0..cols.len()).map(|i| stringify_pg(&row, i)).collect();
        wtr.write_record(&with_sequence(add_sequence, n, rec))?;
        tick_progress(on_progress, n);
    }
    pool.close().await;
    Ok(n)
}

async fn stream_my(
    c: &LiveConnection,
    sql: &str,
    wtr: &mut csv::Writer<File>,
    header: bool,
    add_sequence: bool,
    limit: Option<u64>,
    on_progress: Option<&(dyn Fn(u64) + Send + Sync)>,
) -> Result<u64, ConnectError> {
    let pool = my_pool(c).await?;
    sqlx::query("SET SESSION TRANSACTION READ ONLY")
        .execute(&pool)
        .await?;
    let mut stream = sqlx::query(sql).fetch(&pool);
    let mut n = 0u64;
    let mut wrote_header = false;
    while let Some(row) = stream.try_next().await? {
        let cols = colnames_sqlx(&row);
        if header && !wrote_header {
            wtr.write_record(&with_sequence_header(add_sequence, cols.clone()))?;
            wrote_header = true;
        }
        if let Some(lim) = limit {
            if n >= lim {
                break;
            }
        }
        n += 1;
        let rec: Vec<String> = (0..cols.len()).map(|i| stringify_my(&row, i)).collect();
        wtr.write_record(&with_sequence(add_sequence, n, rec))?;
        tick_progress(on_progress, n);
    }
    pool.close().await;
    Ok(n)
}

async fn stream_sqlite(
    c: &LiveConnection,
    sql: &str,
    wtr: &mut csv::Writer<File>,
    header: bool,
    add_sequence: bool,
    limit: Option<u64>,
    on_progress: Option<&(dyn Fn(u64) + Send + Sync)>,
) -> Result<u64, ConnectError> {
    let pool = sqlite_pool(c).await?;
    sqlx::query("PRAGMA query_only = ON").execute(&pool).await?;
    let mut stream = sqlx::query(sql).fetch(&pool);
    let mut n = 0u64;
    let mut wrote_header = false;
    while let Some(row) = stream.try_next().await? {
        let cols = colnames_sqlx(&row);
        if header && !wrote_header {
            wtr.write_record(&with_sequence_header(add_sequence, cols.clone()))?;
            wrote_header = true;
        }
        if let Some(lim) = limit {
            if n >= lim {
                break;
            }
        }
        n += 1;
        let rec: Vec<String> = (0..cols.len()).map(|i| stringify_sqlite(&row, i)).collect();
        wtr.write_record(&with_sequence(add_sequence, n, rec))?;
        tick_progress(on_progress, n);
    }
    pool.close().await;
    Ok(n)
}

async fn stream_ms(
    c: &LiveConnection,
    sql: &str,
    wtr: &mut csv::Writer<File>,
    header: bool,
    add_sequence: bool,
    limit: Option<u64>,
    on_progress: Option<&(dyn Fn(u64) + Send + Sync)>,
) -> Result<u64, ConnectError> {
    let mut client = mssql_client(c).await?;
    client.execute("BEGIN TRANSACTION", &[]).await?;
    let result = async {
        let stream = client.simple_query(sql.to_string()).await?;
        let mut rows = stream.into_row_stream();
        let mut n = 0u64;
        let mut wrote_header = false;
        while let Some(row) = rows.try_next().await? {
            let cols: Vec<String> = row.columns().iter().map(|c| c.name().to_string()).collect();
            if header && !wrote_header {
                wtr.write_record(&with_sequence_header(add_sequence, cols.clone()))?;
                wrote_header = true;
            }
            if let Some(lim) = limit {
                if n >= lim {
                    break;
                }
            }
            n += 1;
            let rec: Vec<String> = (0..cols.len()).map(|i| stringify_ms(&row, i)).collect();
            wtr.write_record(&with_sequence(add_sequence, n, rec))?;
            tick_progress(on_progress, n);
        }
        drop(rows);
        Ok::<u64, ConnectError>(n)
    }
    .await;
    let rollback = client
        .execute("IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION", &[])
        .await;
    match (result, rollback) {
        (Err(error), _) => Err(error),
        (Ok(_), Err(error)) => Err(error.into()),
        (Ok(n), Ok(_)) => Ok(n),
    }
}

fn colnames_sqlx<R: sqlx::Row>(row: &R) -> Vec<String> {
    row.columns().iter().map(|c| c.name().to_string()).collect()
}

/// Cap a preview SELECT at the DB so large tables do not stream unbounded rows.
pub fn apply_preview_limit(family: &str, sql: &str, limit: u64) -> String {
    match first_keyword(sql).as_str() {
        "show" | "explain" | "pragma" | "describe" | "desc" | "table" => sql.to_string(),
        "select" | "with" | "values" => match family {
            "mssql" => sql.to_string(),
            _ => format!("SELECT * FROM (\n{sql}\n) AS _bintl_preview LIMIT {limit}"),
        },
        _ => sql.to_string(),
    }
}

fn strip_trailing_semicolons(sql: &str) -> String {
    sql.trim_end_matches(|c: char| c == ';' || c.is_whitespace())
        .to_string()
}

fn first_keyword(sql: &str) -> String {
    let rest = skip_trivia(sql);
    rest.split(|c: char| c.is_whitespace() || c == '(')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase()
}

fn skip_trivia(sql: &str) -> &str {
    let bytes = sql.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i].is_ascii_whitespace() {
            i += 1;
            continue;
        }
        if bytes[i] == b'-' && bytes.get(i + 1) == Some(&b'-') {
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        if bytes[i] == b'/' && bytes.get(i + 1) == Some(&b'*') {
            i += 2;
            while i + 1 < bytes.len() && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                i += 1;
            }
            i = i.saturating_add(2);
            continue;
        }
        break;
    }
    &sql[i.min(sql.len())..]
}

fn has_internal_semicolon(sql: &str) -> bool {
    let mut chars = sql.chars().peekable();
    let mut in_single = false;
    let mut in_double = false;
    let mut in_line = false;
    let mut in_block = false;
    while let Some(c) = chars.next() {
        if in_line {
            if c == '\n' {
                in_line = false;
            }
            continue;
        }
        if in_block {
            if c == '*' && chars.peek() == Some(&'/') {
                chars.next();
                in_block = false;
            }
            continue;
        }
        if !in_single && !in_double {
            if c == '-' && chars.peek() == Some(&'-') {
                chars.next();
                in_line = true;
                continue;
            }
            if c == '/' && chars.peek() == Some(&'*') {
                chars.next();
                in_block = true;
                continue;
            }
        }
        if c == '\'' && !in_double {
            if in_single && chars.peek() == Some(&'\'') {
                chars.next();
            } else {
                in_single = !in_single;
            }
            continue;
        }
        if c == '"' && !in_single {
            if in_double && chars.peek() == Some(&'"') {
                chars.next();
            } else {
                in_double = !in_double;
            }
            continue;
        }
        if c == ';' && !in_single && !in_double {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sql_normalize_and_kind() {
        assert_eq!(normalize_sql("  SELECT 1;  ").unwrap(), "SELECT 1");
        assert!(normalize_sql("").is_err());
        assert!(normalize_sql("SELECT 1; DELETE FROM t").is_err());
        assert_eq!(sql_kind("/* x */ -- y\nWITH a AS (SELECT 1) SELECT * FROM a"), SqlKind::Rows);
        assert_eq!(sql_kind("UPDATE t SET a = 1"), SqlKind::Exec);
        assert!(normalize_sql("SELECT ';'").is_ok());
    }

    #[test]
    fn preview_limit_wraps_select() {
        let sql = apply_preview_limit("postgres", "SELECT * FROM public.orders", 100);
        assert!(sql.contains("LIMIT 100"));
        assert!(sql.contains("public.orders"));
        let show = apply_preview_limit("postgres", "SHOW search_path", 100);
        assert_eq!(show, "SHOW search_path");
        let ms = apply_preview_limit("mssql", "SELECT * FROM dbo.t", 50);
        assert_eq!(ms, "SELECT * FROM dbo.t");
    }
}
