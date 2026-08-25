use std::fs::File;
use std::path::Path;

use csv::WriterBuilder;
use futures_util::TryStreamExt;
use storage::LiveConnection;

use crate::inspect::list_columns;
use crate::{
    driver_family, mssql_client, my_pool, parse_table, pg_pool, qualified, sqlite_pool,
    stringify_ms, stringify_my, stringify_pg, stringify_sqlite, ConnectError,
};

#[derive(Debug, Clone)]
pub struct ExtractOptions {
    pub delimiter: u8,
    pub header: bool,
    pub quote: u8,
}

impl Default for ExtractOptions {
    fn default() -> Self {
        Self {
            delimiter: b',',
            header: true,
            quote: b'"',
        }
    }
}

pub fn parse_delimiter(raw: &str) -> Result<u8, ConnectError> {
    if raw.chars().count() == 1 {
        let c = raw.chars().next().unwrap();
        if !c.is_ascii() {
            return Err(ConnectError::Invalid("delimiter must be ascii".into()));
        }
        return Ok(c as u8);
    }
    match raw.trim() {
        "tab" | "\\t" => Ok(b'\t'),
        s if s.chars().count() == 1 => {
            let c = s.chars().next().unwrap();
            if !c.is_ascii() {
                return Err(ConnectError::Invalid("delimiter must be ascii".into()));
            }
            Ok(c as u8)
        }
        _ => Err(ConnectError::Invalid(
            "delimiter must be a single ascii character, or tab".into(),
        )),
    }
}

/// Stream `SELECT *` into a delimited text file. Headers come from the table
/// schema so a 0-row table still produces a header-only file.
///
/// ponytail: sync csv writes on the async worker; spawn_blocking the writer
/// if extract volume saturates tokio threads.
pub async fn extract_table(
    c: &LiveConnection,
    table: &str,
    dest: &Path,
    opts: &ExtractOptions,
    on_progress: Option<&(dyn Fn(u64) + Send + Sync)>,
) -> Result<u64, ConnectError> {
    let family = driver_family(&c.driver)?;
    let parsed = parse_table(table)?;
    let q = qualified(family, &parsed);
    let cols = list_columns(c, table).await?;
    if cols.is_empty() {
        return Err(ConnectError::Invalid(format!("no columns for table {table}")));
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut wtr = WriterBuilder::new()
        .delimiter(opts.delimiter)
        .quote(opts.quote)
        .from_path(dest)?;
    if opts.header {
        let headers: Vec<&str> = cols.iter().map(|c| c.name.as_str()).collect();
        wtr.write_record(&headers)?;
    }
    let ncols = cols.len();
    let n = match family {
        "postgres" => stream_pg(c, &q, &mut wtr, ncols, on_progress).await?,
        "mysql" => stream_my(c, &q, &mut wtr, ncols, on_progress).await?,
        "sqlite" => stream_sqlite(c, &q, &mut wtr, ncols, on_progress).await?,
        "mssql" => stream_ms(c, &q, &mut wtr, ncols, on_progress).await?,
        other => return Err(ConnectError::Invalid(format!("unsupported family {other}"))),
    };
    wtr.flush()?;
    Ok(n)
}

pub(crate) fn tick_progress_at(
    on_progress: Option<&(dyn Fn(u64) + Send + Sync)>,
    n: u64,
    every: u64,
) {
    if n == 1 || (every > 0 && n % every == 0) {
        if let Some(cb) = on_progress {
            cb(n);
        }
    }
}

pub(crate) fn tick_progress(on_progress: Option<&(dyn Fn(u64) + Send + Sync)>, n: u64) {
    tick_progress_at(on_progress, n, 10_000);
}

async fn stream_pg(
    c: &LiveConnection,
    q: &str,
    wtr: &mut csv::Writer<File>,
    ncols: usize,
    on_progress: Option<&(dyn Fn(u64) + Send + Sync)>,
) -> Result<u64, ConnectError> {
    let pool = pg_pool(c).await?;
    let sql = format!("SELECT * FROM {q}");
    let mut stream = sqlx::query(&sql).fetch(&pool);
    let mut n = 0u64;
    while let Some(row) = stream.try_next().await? {
        let rec: Vec<String> = (0..ncols).map(|i| stringify_pg(&row, i)).collect();
        wtr.write_record(&rec)?;
        n += 1;
        tick_progress(on_progress, n);
    }
    pool.close().await;
    Ok(n)
}

async fn stream_my(
    c: &LiveConnection,
    q: &str,
    wtr: &mut csv::Writer<File>,
    ncols: usize,
    on_progress: Option<&(dyn Fn(u64) + Send + Sync)>,
) -> Result<u64, ConnectError> {
    let pool = my_pool(c).await?;
    let sql = format!("SELECT * FROM {q}");
    let mut stream = sqlx::query(&sql).fetch(&pool);
    let mut n = 0u64;
    while let Some(row) = stream.try_next().await? {
        let rec: Vec<String> = (0..ncols).map(|i| stringify_my(&row, i)).collect();
        wtr.write_record(&rec)?;
        n += 1;
        tick_progress(on_progress, n);
    }
    pool.close().await;
    Ok(n)
}

async fn stream_sqlite(
    c: &LiveConnection,
    q: &str,
    wtr: &mut csv::Writer<File>,
    ncols: usize,
    on_progress: Option<&(dyn Fn(u64) + Send + Sync)>,
) -> Result<u64, ConnectError> {
    let pool = sqlite_pool(c).await?;
    let sql = format!("SELECT * FROM {q}");
    let mut stream = sqlx::query(&sql).fetch(&pool);
    let mut n = 0u64;
    while let Some(row) = stream.try_next().await? {
        let rec: Vec<String> = (0..ncols).map(|i| stringify_sqlite(&row, i)).collect();
        wtr.write_record(&rec)?;
        n += 1;
        tick_progress(on_progress, n);
    }
    pool.close().await;
    Ok(n)
}

async fn stream_ms(
    c: &LiveConnection,
    q: &str,
    wtr: &mut csv::Writer<File>,
    ncols: usize,
    on_progress: Option<&(dyn Fn(u64) + Send + Sync)>,
) -> Result<u64, ConnectError> {
    let mut client = mssql_client(c).await?;
    let stream = client.simple_query(format!("SELECT * FROM {q}")).await?;
    let mut rows = stream.into_row_stream();
    let mut n = 0u64;
    while let Some(row) = rows.try_next().await? {
        let rec: Vec<String> = (0..ncols).map(|i| stringify_ms(&row, i)).collect();
        wtr.write_record(&rec)?;
        n += 1;
        tick_progress(on_progress, n);
    }
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn delimiters() {
        assert_eq!(parse_delimiter(",").unwrap(), b',');
        assert_eq!(parse_delimiter("|").unwrap(), b'|');
        assert_eq!(parse_delimiter(";").unwrap(), b';');
        assert_eq!(parse_delimiter("^").unwrap(), b'^');
        assert_eq!(parse_delimiter("tab").unwrap(), b'\t');
        assert_eq!(parse_delimiter("\\t").unwrap(), b'\t');
        assert_eq!(parse_delimiter("\t").unwrap(), b'\t');
        assert_eq!(parse_delimiter(":").unwrap(), b':');
        assert_eq!(parse_delimiter(" ").unwrap(), b' ');
        assert_eq!(parse_delimiter(" : ").unwrap(), b':');
        assert!(parse_delimiter("").is_err());
        assert!(parse_delimiter("||").is_err());
    }
}
