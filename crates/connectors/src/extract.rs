use std::fs::File;
use std::path::Path;

use csv::WriterBuilder;
use futures_util::TryStreamExt;
use storage::LiveConnection;
use tokio::io::AsyncWriteExt;

use crate::inspect::list_columns;
use crate::{
    driver_family, mssql_client, my_pool, oracle, parse_table, pg_pool, qualified, sql_lit,
    sqlite_pool, stringify_ms, stringify_my, stringify_pg, stringify_sqlite, ConnectError,
};

#[derive(Debug, Clone)]
pub struct ExtractOptions {
    pub delimiter: u8,
    pub header: bool,
    pub quote: u8,
    pub add_sequence: bool,
}

impl Default for ExtractOptions {
    fn default() -> Self {
        Self {
            delimiter: b',',
            header: true,
            quote: b'"',
            add_sequence: false,
        }
    }
}

pub const SEQUENCE_HEADER: &str = "#";

pub(crate) fn with_sequence_header(add_sequence: bool, mut headers: Vec<String>) -> Vec<String> {
    if add_sequence {
        headers.insert(0, SEQUENCE_HEADER.into());
    }
    headers
}

pub(crate) fn with_sequence(add_sequence: bool, seq: u64, mut fields: Vec<String>) -> Vec<String> {
    if add_sequence {
        fields.insert(0, seq.to_string());
    }
    fields
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

const SNIFF_DELIMS: &[(&str, u8)] = &[
    (",", b','),
    ("|", b'|'),
    (";", b';'),
    ("tab", b'\t'),
    ("^", b'^'),
];

/// Source `.dat` / law-tool files separate fields with this, not a comma.
pub const COLON_PIPE: &str = ":||";
/// csv and polars only accept one byte. `:||` is rewritten to this on read.
const COLON_PIPE_SENTINEL: u8 = 0x1f;

pub fn is_colon_pipe(raw: &str) -> bool {
    raw.trim() == COLON_PIPE
}

/// Replace `:||` with a single byte so the csv crate can parse the file.
/// Quoting stays off: this format does not quote, and field text contains `"`.
///
/// ponytail: a field that itself contains `:||` is split. The source format
/// does not escape the delimiter.
pub fn rewrite_colon_pipe(bytes: &[u8]) -> Result<Vec<u8>, ConnectError> {
    if bytes.contains(&COLON_PIPE_SENTINEL) {
        return Err(ConnectError::Invalid(
            "file contains a character reserved for the `:||` delimiter".into(),
        ));
    }
    let pattern = COLON_PIPE.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index..].starts_with(pattern) {
            out.push(COLON_PIPE_SENTINEL);
            index += pattern.len();
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    Ok(out)
}

/// ponytail: the first two rows both starting with a numeric id means there is
/// no header. A header whose first cell is only digits would be treated as data.
pub fn colon_pipe_has_header(bytes: &[u8]) -> bool {
    let Ok(text) = std::str::from_utf8(bytes) else {
        return true;
    };
    let mut rows = text
        .split('\n')
        .map(|line| line.trim_end_matches('\r'))
        .filter(|line| !line.trim().is_empty());
    let (Some(first), Some(second)) = (rows.next(), rows.next()) else {
        return true;
    };
    let digit_id = |row: &str| {
        let lead = row.split(COLON_PIPE).next().unwrap_or("");
        !lead.is_empty() && lead.bytes().all(|byte| byte.is_ascii_digit())
    };
    !(digit_id(first) && digit_id(second))
}

/// Guess a delimiter from a text sample. Prefers a separator that splits most
/// rows into the same number of columns (at least 2).
pub fn sniff_delimiter(sample: &[u8]) -> Option<String> {
    let truncated = sample.len() > 64 * 1024;
    let sample = if truncated {
        &sample[..64 * 1024]
    } else {
        sample
    };
    let mut best: Option<(usize, usize, &str)> = None;
    for (token, byte) in SNIFF_DELIMS {
        let Some((consistent, columns)) = score_delimiter(sample, *byte) else {
            continue;
        };
        if prefer_delimiter(best, consistent, columns) {
            best = Some((consistent, columns, token));
        }
    }
    if let Some((consistent, columns, total)) = score_colon_pipe(sample, truncated) {
        // Each `:||` contains two `|` bytes, so a pipe sniff looks like more
        // columns. A sample that splits evenly on `:||` is that delimiter.
        if consistent == total {
            return Some(COLON_PIPE.to_string());
        }
        if prefer_delimiter(best, consistent, columns) {
            best = Some((consistent, columns, COLON_PIPE));
        }
    }
    best.map(|(_, _, token)| token.to_string())
}

fn prefer_delimiter(best: Option<(usize, usize, &str)>, consistent: usize, columns: usize) -> bool {
    match best {
        None => true,
        Some((best_consistent, best_columns, _)) => {
            consistent > best_consistent
                || (consistent == best_consistent && columns > best_columns)
        }
    }
}

fn score_delimiter(sample: &[u8], delimiter: u8) -> Option<(usize, usize)> {
    let mut reader = csv::ReaderBuilder::new()
        .delimiter(delimiter)
        .has_headers(false)
        .flexible(true)
        .from_reader(sample);
    let mut widths = Vec::new();
    for record in reader.records().take(24) {
        let Ok(record) = record else {
            continue;
        };
        if record.iter().all(|field| field.trim().is_empty()) {
            continue;
        }
        widths.push(record.len());
    }
    if widths.len() < 2 {
        return None;
    }
    let columns = *widths.iter().max()?;
    if columns < 2 {
        return None;
    }
    let consistent = widths.iter().filter(|width| **width == columns).count();
    if consistent * 2 < widths.len() {
        return None;
    }
    Some((consistent, columns))
}

fn score_colon_pipe(sample: &[u8], truncated: bool) -> Option<(usize, usize, usize)> {
    // A 64KB cut can land in the middle of a UTF-8 character. Keep only
    // complete lines so `from_utf8` does not reject the whole sample.
    let sample = if truncated || std::str::from_utf8(sample).is_err() {
        let end = sample.iter().rposition(|byte| *byte == b'\n')?;
        &sample[..=end]
    } else {
        sample
    };
    let text = std::str::from_utf8(sample).ok()?;
    let mut lines: Vec<&str> = text
        .split('\n')
        .map(|line| line.trim_end_matches('\r'))
        .filter(|line| !line.trim().is_empty())
        .collect();
    if truncated && !sample.ends_with(b"\n") {
        lines.pop();
    }
    let widths: Vec<usize> = lines
        .into_iter()
        .take(24)
        .map(|line| line.split(COLON_PIPE).count())
        .collect();
    if widths.len() < 2 {
        return None;
    }
    let columns = *widths.iter().max()?;
    if columns < 2 {
        return None;
    }
    let consistent = widths.iter().filter(|width| **width == columns).count();
    if consistent * 2 < widths.len() {
        return None;
    }
    Some((consistent, columns, widths.len()))
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
        return Err(ConnectError::Invalid(format!(
            "no columns for table {table}"
        )));
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }
    if c.driver == "postgres" && !opts.add_sequence {
        let sql = postgres_copy_to_sql(&q, opts.header, opts.delimiter, opts.quote);
        return copy_postgres_to_file(c, &sql, dest, opts.header, opts.quote, on_progress).await;
    }
    let mut wtr = WriterBuilder::new()
        .delimiter(opts.delimiter)
        .quote(opts.quote)
        .from_path(dest)?;
    if opts.header {
        let headers = with_sequence_header(
            opts.add_sequence,
            cols.iter().map(|c| c.name.clone()).collect(),
        );
        wtr.write_record(&headers)?;
    }
    let ncols = cols.len();
    let n = match family {
        "postgres" => stream_pg(c, &q, &mut wtr, ncols, opts.add_sequence, on_progress).await?,
        "mysql" => stream_my(c, &q, &mut wtr, ncols, opts.add_sequence, on_progress).await?,
        "sqlite" => stream_sqlite(c, &q, &mut wtr, ncols, opts.add_sequence, on_progress).await?,
        "mssql" => stream_ms(c, &q, &mut wtr, ncols, opts.add_sequence, on_progress).await?,
        "oracle" => stream_oracle(c, &q, &mut wtr, ncols, opts.add_sequence, on_progress)?,
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

pub(crate) fn postgres_copy_to_sql(source: &str, header: bool, delimiter: u8, quote: u8) -> String {
    format!(
        "COPY {source} TO STDOUT WITH (FORMAT csv, HEADER {}, DELIMITER {}, QUOTE {})",
        if header { "true" } else { "false" },
        sql_lit(std::str::from_utf8(&[delimiter]).unwrap_or(",")),
        sql_lit(std::str::from_utf8(&[quote]).unwrap_or("\"")),
    )
}

pub(crate) fn postgres_copy_to_query(sql: &str, header: bool, delimiter: u8, quote: u8) -> String {
    postgres_copy_to_sql(&format!("({sql})"), header, delimiter, quote)
}

pub(crate) async fn copy_postgres_to_file(
    c: &LiveConnection,
    copy_sql: &str,
    dest: &Path,
    header: bool,
    quote: u8,
    on_progress: Option<&(dyn Fn(u64) + Send + Sync)>,
) -> Result<u64, ConnectError> {
    let pool = pg_pool(c).await?;
    let mut conn = pool.acquire().await?;
    let n = {
        let mut stream = conn.copy_out_raw(copy_sql).await?;
        let mut out = tokio::fs::File::create(dest).await?;
        let mut counter = CsvRecordCounter::new(quote);
        while let Some(chunk) = stream.try_next().await? {
            out.write_all(&chunk).await?;
            counter.push(&chunk);
            let n = counter.data_rows(header);
            if n > 0 {
                tick_progress(on_progress, n);
            }
        }
        out.flush().await?;
        counter.data_rows(header)
    };
    // Pool::close waits while this connection is still checked out.
    let _ = conn.close().await;
    pool.close().await;
    Ok(n)
}

struct CsvRecordCounter {
    in_quotes: bool,
    pending_quote: bool,
    records: u64,
    quote: u8,
}

impl CsvRecordCounter {
    fn new(quote: u8) -> Self {
        Self {
            in_quotes: false,
            pending_quote: false,
            records: 0,
            quote,
        }
    }

    fn data_rows(&self, header: bool) -> u64 {
        if header {
            self.records.saturating_sub(1)
        } else {
            self.records
        }
    }

    fn push(&mut self, bytes: &[u8]) {
        let mut i = 0;
        if self.pending_quote {
            self.pending_quote = false;
            if bytes.first() == Some(&self.quote) {
                i = 1;
            } else {
                self.in_quotes = false;
            }
        }
        while i < bytes.len() {
            let b = bytes[i];
            if self.in_quotes {
                if b == self.quote {
                    if i + 1 == bytes.len() {
                        self.pending_quote = true;
                        return;
                    }
                    if bytes[i + 1] == self.quote {
                        i += 2;
                        continue;
                    }
                    self.in_quotes = false;
                }
            } else if b == self.quote {
                self.in_quotes = true;
            } else if b == b'\n' {
                self.records += 1;
            }
            i += 1;
        }
    }
}

async fn stream_pg(
    c: &LiveConnection,
    q: &str,
    wtr: &mut csv::Writer<File>,
    ncols: usize,
    add_sequence: bool,
    on_progress: Option<&(dyn Fn(u64) + Send + Sync)>,
) -> Result<u64, ConnectError> {
    let pool = pg_pool(c).await?;
    let mut conn = pool.acquire().await?;
    let sql = format!("SELECT * FROM {q}");
    let n = {
        let mut stream = sqlx::query(&sql).fetch(&mut *conn);
        let mut n = 0u64;
        while let Some(row) = stream.try_next().await? {
            n += 1;
            let rec: Vec<String> = (0..ncols).map(|i| stringify_pg(&row, i)).collect();
            wtr.write_record(&with_sequence(add_sequence, n, rec))?;
            tick_progress(on_progress, n);
        }
        n
    };
    let _ = conn.close().await;
    pool.close().await;
    Ok(n)
}

async fn stream_my(
    c: &LiveConnection,
    q: &str,
    wtr: &mut csv::Writer<File>,
    ncols: usize,
    add_sequence: bool,
    on_progress: Option<&(dyn Fn(u64) + Send + Sync)>,
) -> Result<u64, ConnectError> {
    let pool = my_pool(c).await?;
    let mut conn = pool.acquire().await?;
    let sql = format!("SELECT * FROM {q}");
    let n = {
        let mut stream = sqlx::query(&sql).fetch(&mut *conn);
        let mut n = 0u64;
        while let Some(row) = stream.try_next().await? {
            n += 1;
            let rec: Vec<String> = (0..ncols).map(|i| stringify_my(&row, i)).collect();
            wtr.write_record(&with_sequence(add_sequence, n, rec))?;
            tick_progress(on_progress, n);
        }
        n
    };
    let _ = conn.close().await;
    pool.close().await;
    Ok(n)
}

async fn stream_sqlite(
    c: &LiveConnection,
    q: &str,
    wtr: &mut csv::Writer<File>,
    ncols: usize,
    add_sequence: bool,
    on_progress: Option<&(dyn Fn(u64) + Send + Sync)>,
) -> Result<u64, ConnectError> {
    let pool = sqlite_pool(c).await?;
    let mut conn = pool.acquire().await?;
    let sql = format!("SELECT * FROM {q}");
    let n = {
        let mut stream = sqlx::query(&sql).fetch(&mut *conn);
        let mut n = 0u64;
        while let Some(row) = stream.try_next().await? {
            n += 1;
            let rec: Vec<String> = (0..ncols).map(|i| stringify_sqlite(&row, i)).collect();
            wtr.write_record(&with_sequence(add_sequence, n, rec))?;
            tick_progress(on_progress, n);
        }
        n
    };
    let _ = conn.close().await;
    pool.close().await;
    Ok(n)
}

async fn stream_ms(
    c: &LiveConnection,
    q: &str,
    wtr: &mut csv::Writer<File>,
    ncols: usize,
    add_sequence: bool,
    on_progress: Option<&(dyn Fn(u64) + Send + Sync)>,
) -> Result<u64, ConnectError> {
    let mut client = mssql_client(c).await?;
    let stream = client.simple_query(format!("SELECT * FROM {q}")).await?;
    let mut rows = stream.into_row_stream();
    let mut n = 0u64;
    while let Some(row) = rows.try_next().await? {
        n += 1;
        let rec: Vec<String> = (0..ncols).map(|i| stringify_ms(&row, i)).collect();
        wtr.write_record(&with_sequence(add_sequence, n, rec))?;
        tick_progress(on_progress, n);
    }
    Ok(n)
}

fn stream_oracle(
    c: &LiveConnection,
    q: &str,
    wtr: &mut csv::Writer<File>,
    ncols: usize,
    add_sequence: bool,
    on_progress: Option<&(dyn Fn(u64) + Send + Sync)>,
) -> Result<u64, ConnectError> {
    oracle::with_conn(c, |conn| {
        let sql = format!("SELECT * FROM {q}");
        let mut n = 0u64;
        oracle::stream_query(
            conn,
            &sql,
            |_| Ok(()),
            |rec| {
                n += 1;
                let row: Vec<String> = rec.iter().take(ncols).cloned().collect();
                wtr.write_record(&with_sequence(add_sequence, n, row))?;
                tick_progress(on_progress, n);
                Ok(())
            },
        )?;
        Ok(n)
    })
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

    #[test]
    fn sniffs_pipe_when_commas_are_thousands() {
        let sample = "IPM 광고비|활성 사용자\nLTM|트래픽(세션)\n광고 1,000회 노출당 비용|클릭수\n";
        assert_eq!(sniff_delimiter(sample.as_bytes()).as_deref(), Some("|"));
    }

    #[test]
    fn sniffs_comma_csv() {
        let sample = "a,b,c\n1,2,3\n4,5,6\n";
        assert_eq!(sniff_delimiter(sample.as_bytes()).as_deref(), Some(","));
    }

    #[test]
    fn sniffs_colon_pipe_when_pipes_and_commas_are_inside_fields() {
        let sample = "260151:||:||법률 | 시행령:||제2조,제3조\n260150:||:||여신:||제2조,제41조\n";
        assert_eq!(sniff_delimiter(sample.as_bytes()).as_deref(), Some(":||"));
        assert!(!colon_pipe_has_header(sample.as_bytes()));
        let headed = "id:||name\n260151:||법률\n260150:||여신\n";
        assert!(colon_pipe_has_header(headed.as_bytes()));
        let rewritten = rewrite_colon_pipe(sample.as_bytes()).unwrap();
        assert_eq!(rewritten.iter().filter(|byte| **byte == 0x1f).count(), 6);
        assert_eq!(
            sniff_delimiter(b"a:||b:||c\n1:||2:||3\n").as_deref(),
            Some(":||")
        );
        let line = "12:||가 |\n2:||나\n";
        let mut long = Vec::new();
        while long.len() < 70_000 {
            long.extend(line.as_bytes());
        }
        assert_eq!(sniff_delimiter(&long).as_deref(), Some(":||"));
    }

    #[test]
    fn sequence_is_opt_in() {
        assert_eq!(with_sequence(false, 1, vec!["a".into()]), vec!["a"]);
        assert_eq!(with_sequence(true, 3, vec!["a".into()]), vec!["3", "a"]);
        assert_eq!(
            with_sequence_header(true, vec!["name".into()]),
            vec!["#", "name"]
        );
        assert_eq!(
            with_sequence_header(false, vec!["name".into()]),
            vec!["name"]
        );
    }

    #[test]
    fn postgres_copy_to_sql_matches_extract_options() {
        assert_eq!(
            postgres_copy_to_sql("\"public\".\"users\"", true, b',', b'"'),
            "COPY \"public\".\"users\" TO STDOUT WITH (FORMAT csv, HEADER true, DELIMITER ',', QUOTE '\"')"
        );
        assert_eq!(
            postgres_copy_to_query("SELECT 1 AS id", false, b'|', b'"'),
            "COPY (SELECT 1 AS id) TO STDOUT WITH (FORMAT csv, HEADER false, DELIMITER '|', QUOTE '\"')"
        );
    }

    #[test]
    fn csv_record_counter_counts_data_rows_across_chunks() {
        let mut counter = CsvRecordCounter::new(b'"');
        counter.push(b"id,name\n1,");
        counter.push(b"\"a\"\"b\"\n");
        assert_eq!(counter.data_rows(true), 1);
        let mut quoted_newline = CsvRecordCounter::new(b'"');
        quoted_newline.push(b"h\n\"a\nb\",c\n");
        assert_eq!(quoted_newline.data_rows(true), 1);
        let mut split_quote = CsvRecordCounter::new(b'"');
        split_quote.push(b"h\n\"a");
        split_quote.push(b"\"\"b\",c\n");
        assert_eq!(split_quote.data_rows(true), 1);
    }
}
