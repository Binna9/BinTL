use std::sync::OnceLock;

use odbc_api::buffers::TextRowSet;
use odbc_api::{environment, Connection, ConnectionOptions, Cursor, ResultSetMetadata};
use storage::LiveConnection;

use crate::{quote_ident, sql_lit, ConnectError, LoadColumnRule};

const LOGIN_TIMEOUT_SEC: u32 = 8;
const BATCH_ROWS: usize = 500;
const MAX_TEXT: usize = 4096;

#[derive(Debug, Clone, Default)]
pub struct OdbcSettings {
    pub oracle_driver: Option<String>,
    pub tibero_driver: Option<String>,
    pub tibero_jdbc: Option<String>,
}

static ODBC: OnceLock<OdbcSettings> = OnceLock::new();

pub fn configure_odbc(settings: OdbcSettings) {
    let _ = ODBC.set(settings);
}

pub(crate) fn configured_tibero_jdbc() -> Option<String> {
    nonempty(ODBC.get()?.tibero_jdbc.as_deref())
}

pub(crate) enum OraConn<'a> {
    Odbc(Connection<'a>),
    Jdbc(crate::tibero_jdbc::JdbcConn),
}

pub(crate) fn map_odbc(error: odbc_api::Error) -> ConnectError {
    ConnectError::Invalid(error.to_string())
}

pub(crate) fn vendor(driver: &str) -> &'static str {
    if driver.eq_ignore_ascii_case("tibero") {
        "tibero"
    } else {
        "oracle"
    }
}

pub(crate) fn pick_driver(
    vendor: &str,
    installed: &[String],
    forced: Option<&str>,
) -> Option<String> {
    if let Some(forced) = forced.map(str::trim).filter(|value| !value.is_empty()) {
        return Some(forced.to_string());
    }
    let ranked: Vec<(String, String)> = installed
        .iter()
        .map(|name| (name.clone(), name.to_ascii_lowercase()))
        .collect();
    if vendor == "tibero" {
        return ranked
            .into_iter()
            .find(|(_, lower)| lower.contains("tibero"))
            .map(|(name, _)| name);
    }
    ranked
        .iter()
        .find(|(_, lower)| lower.contains("oracle") && lower.contains("instantclient"))
        .or_else(|| {
            ranked
                .iter()
                .find(|(_, lower)| lower.contains("oracle") && !lower.contains("microsoft"))
        })
        .or_else(|| ranked.iter().find(|(_, lower)| lower.contains("oracle")))
        .map(|(name, _)| name.clone())
}

fn brace(value: &str) -> String {
    format!("{{{}}}", value.replace('}', "}}"))
}

fn is_driver_lib(name: &str) -> bool {
    let name = name.trim();
    name.contains('/')
        || name.contains('\\')
        || name.ends_with(".so")
        || name.to_ascii_lowercase().ends_with(".dll")
}

fn driver_attr(name: &str) -> String {
    if is_driver_lib(name) {
        odbc_api::escape_attribute_value(name).into_owned()
    } else {
        brace(name)
    }
}

pub(crate) fn connection_string(c: &LiveConnection, driver_name: &str) -> String {
    let uid = odbc_api::escape_attribute_value(&c.username);
    let pwd = odbc_api::escape_attribute_value(&c.password);
    let host = odbc_api::escape_attribute_value(&c.host);
    let database = odbc_api::escape_attribute_value(&c.database);
    let driver = driver_attr(driver_name);
    if vendor(&c.driver) == "tibero" {
        format!(
            "Driver={driver};SERVER={host};PORT={};DB={database};UID={uid};PWD={pwd};",
            c.port
        )
    } else {
        format!(
            "Driver={driver};DBQ=//{host}:{}/{database};UID={uid};PWD={pwd};",
            c.port
        )
    }
}

fn nonempty(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string())
}

fn env_driver(vendor: &str) -> Option<String> {
    let key = if vendor == "tibero" {
        "BINTL_TIBERO_ODBC_DRIVER"
    } else {
        "BINTL_ORACLE_ODBC_DRIVER"
    };
    nonempty(std::env::var(key).ok().as_deref())
}

fn configured_driver(vendor: &str) -> Option<String> {
    env_driver(vendor).or_else(|| {
        let settings = ODBC.get()?;
        if vendor == "tibero" {
            settings.tibero_driver.clone()
        } else {
            settings.oracle_driver.clone()
        }
    })
}

fn resolve_driver(c: &LiveConnection) -> Result<String, ConnectError> {
    let vendor = vendor(&c.driver);
    if let Some(name) = pick_driver(vendor, &[], configured_driver(vendor).as_deref()) {
        return Ok(name);
    }
    let env = environment().map_err(|error| {
        ConnectError::Invalid(format!(
            "ODBC driver manager is unavailable ({error}). Install unixODBC (or the Windows ODBC driver manager) and an Oracle/Tibero ODBC driver."
        ))
    })?;
    let installed: Vec<String> = env
        .drivers()
        .map_err(map_odbc)?
        .into_iter()
        .map(|info| info.description)
        .collect();
    pick_driver(vendor, &installed, None).ok_or_else(|| {
        ConnectError::Invalid(format!(
            "no {vendor} ODBC driver found. Install the vendor ODBC driver, or set odbc.{vendor}_driver in config.toml (or BINTL_{}_ODBC_DRIVER) to its exact name or .so/.dll path.",
            vendor.to_ascii_uppercase()
        ))
    })
}

fn open_conn(c: &LiveConnection) -> Result<Connection<'static>, ConnectError> {
    let driver_name = resolve_driver(c)?;
    let conn_str = connection_string(c, &driver_name);
    let env = environment().map_err(map_odbc)?;
    env.connect_with_connection_string(
        &conn_str,
        ConnectionOptions {
            login_timeout_sec: Some(LOGIN_TIMEOUT_SEC),
            packet_size: None,
        },
    )
    .map_err(map_odbc)
}

/// Sync ODBC (Oracle) or JDBC (Tibero) on a Tokio worker. Callers stay on the async path.
pub(crate) fn with_conn<T>(
    c: &LiveConnection,
    f: impl FnOnce(&OraConn<'_>) -> Result<T, ConnectError>,
) -> Result<T, ConnectError> {
    tokio::task::block_in_place(|| {
        if vendor(&c.driver) == "tibero" {
            let conn = crate::tibero_jdbc::open(c)?;
            f(&OraConn::Jdbc(conn))
        } else {
            let conn = open_conn(c)?;
            f(&OraConn::Odbc(conn))
        }
    })
}

fn cell(batch: &TextRowSet, col: usize, row: usize) -> String {
    match batch.at(col, row) {
        Some(bytes) => String::from_utf8_lossy(bytes).into_owned(),
        None => String::new(),
    }
}

pub(crate) fn query_rows(
    conn: &OraConn<'_>,
    sql: &str,
) -> Result<(Vec<String>, Vec<Vec<String>>), ConnectError> {
    match conn {
        OraConn::Jdbc(conn) => return crate::tibero_jdbc::query_rows(conn, sql),
        OraConn::Odbc(conn) => query_rows_odbc(conn, sql),
    }
}

fn query_rows_odbc(
    conn: &Connection<'_>,
    sql: &str,
) -> Result<(Vec<String>, Vec<Vec<String>>), ConnectError> {
    let mut cursor = match conn.execute(sql, ()).map_err(map_odbc)? {
        Some(cursor) => cursor,
        None => return Ok((Vec::new(), Vec::new())),
    };
    let columns: Vec<String> = cursor
        .column_names()
        .map_err(map_odbc)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(map_odbc)?;
    let mut buffers =
        TextRowSet::for_cursor(BATCH_ROWS, &mut cursor, Some(MAX_TEXT)).map_err(map_odbc)?;
    let mut row_set = cursor.bind_buffer(&mut buffers).map_err(map_odbc)?;
    let mut rows = Vec::new();
    while let Some(batch) = row_set.fetch().map_err(map_odbc)? {
        for row_index in 0..batch.num_rows() {
            rows.push(
                (0..batch.num_cols())
                    .map(|col| cell(batch, col, row_index))
                    .collect(),
            );
        }
    }
    Ok((columns, rows))
}

pub(crate) fn query_rows_any(
    conn: &OraConn<'_>,
    sqls: &[&str],
) -> Result<(Vec<String>, Vec<Vec<String>>), ConnectError> {
    let mut last = None;
    for sql in sqls {
        match query_rows(conn, sql) {
            Ok(rows) => return Ok(rows),
            Err(error) => last = Some(error),
        }
    }
    Err(last.unwrap_or_else(|| ConnectError::Invalid("no catalog query succeeded".into())))
}

pub(crate) fn exec(conn: &OraConn<'_>, sql: &str) -> Result<u64, ConnectError> {
    match conn {
        OraConn::Jdbc(conn) => return crate::tibero_jdbc::exec(conn, sql),
        OraConn::Odbc(conn) => exec_odbc(conn, sql),
    }
}

fn exec_odbc(conn: &Connection<'_>, sql: &str) -> Result<u64, ConnectError> {
    let mut stmt = conn.preallocate().map_err(map_odbc)?;
    let cursor = stmt.execute(sql, ()).map_err(map_odbc)?;
    drop(cursor);
    Ok(stmt.row_count().map_err(map_odbc)?.unwrap_or(0) as u64)
}

pub(crate) fn exec_ignore(
    conn: &OraConn<'_>,
    sql: &str,
    needles: &[&str],
) -> Result<(), ConnectError> {
    match exec(conn, sql) {
        Ok(_) => Ok(()),
        Err(error) => {
            let message = error.to_string();
            if needles.iter().any(|needle| message.contains(needle)) {
                Ok(())
            } else {
                Err(error)
            }
        }
    }
}

pub(crate) fn set_current_schema(conn: &OraConn<'_>, schema: &str) -> Result<(), ConnectError> {
    exec(
        conn,
        &format!(
            "ALTER SESSION SET CURRENT_SCHEMA = {}",
            quote_ident("oracle", schema)
        ),
    )
    .map(|_| ())
}

pub(crate) fn stream_query(
    conn: &OraConn<'_>,
    sql: &str,
    on_columns: impl FnMut(&[String]) -> Result<(), ConnectError>,
    on_row: impl FnMut(&[String]) -> Result<(), ConnectError>,
) -> Result<u64, ConnectError> {
    match conn {
        OraConn::Jdbc(conn) => {
            return crate::tibero_jdbc::stream_query(conn, sql, on_columns, on_row)
        }
        OraConn::Odbc(conn) => stream_query_odbc(conn, sql, on_columns, on_row),
    }
}

fn stream_query_odbc(
    conn: &Connection<'_>,
    sql: &str,
    mut on_columns: impl FnMut(&[String]) -> Result<(), ConnectError>,
    mut on_row: impl FnMut(&[String]) -> Result<(), ConnectError>,
) -> Result<u64, ConnectError> {
    let mut cursor = match conn.execute(sql, ()).map_err(map_odbc)? {
        Some(cursor) => cursor,
        None => {
            on_columns(&[])?;
            return Ok(0);
        }
    };
    let columns: Vec<String> = cursor
        .column_names()
        .map_err(map_odbc)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(map_odbc)?;
    on_columns(&columns)?;
    let mut buffers =
        TextRowSet::for_cursor(BATCH_ROWS, &mut cursor, Some(MAX_TEXT)).map_err(map_odbc)?;
    let mut row_set = cursor.bind_buffer(&mut buffers).map_err(map_odbc)?;
    let mut n = 0u64;
    while let Some(batch) = row_set.fetch().map_err(map_odbc)? {
        for row_index in 0..batch.num_rows() {
            let rec: Vec<String> = (0..batch.num_cols())
                .map(|col| cell(batch, col, row_index))
                .collect();
            on_row(&rec)?;
            n += 1;
        }
    }
    Ok(n)
}

fn already_exists_needles() -> &'static [&'static str] {
    &[
        "ORA-00955",
        "TBR-12011",
        "already used by an existing object",
        "already exists",
    ]
}

fn missing_table_needles() -> &'static [&'static str] {
    &["ORA-00942", "TBR-0008", "table or view does not exist"]
}

pub(crate) fn prepare_table(
    conn: &OraConn<'_>,
    create: &str,
    drop: Option<&str>,
    clear: Option<&str>,
) -> Result<(), ConnectError> {
    if let Some(drop) = drop {
        exec_ignore(conn, drop, missing_table_needles())?;
        exec(conn, create)?;
        return Ok(());
    }
    exec_ignore(conn, create, already_exists_needles())?;
    if let Some(clear) = clear {
        exec(conn, clear)?;
    }
    Ok(())
}

pub(crate) fn insert_rows(
    conn: &OraConn<'_>,
    q: &str,
    cols: &[String],
    column_rules: &[LoadColumnRule],
    rows: &[Vec<String>],
    mode: &str,
    conflict_keys: &[String],
    null_marker: Option<&str>,
) -> Result<(), ConnectError> {
    if rows.is_empty() {
        return Ok(());
    }
    let sql = if mode == "upsert" {
        merge_sql(q, cols, column_rules, rows, conflict_keys, null_marker)
    } else {
        insert_values_sql(q, cols, column_rules, rows, null_marker)
    };
    exec(conn, &sql)?;
    Ok(())
}

fn insert_values_sql(
    q: &str,
    cols: &[String],
    column_rules: &[LoadColumnRule],
    rows: &[Vec<String>],
    null_marker: Option<&str>,
) -> String {
    let col_sql = cols
        .iter()
        .map(|c| quote_ident("oracle", c))
        .collect::<Vec<_>>()
        .join(", ");
    let mut sql = format!("INSERT INTO {q} ({col_sql}) VALUES ");
    for (i, row) in rows.iter().enumerate() {
        if i > 0 {
            sql.push_str(", ");
        }
        sql.push('(');
        for (j, cell) in row.iter().enumerate() {
            if j > 0 {
                sql.push_str(", ");
            }
            if crate::cell_is_null(cell, &column_rules[j], null_marker) {
                sql.push_str("NULL");
            } else {
                sql.push_str(&sql_lit(cell));
            }
        }
        sql.push(')');
    }
    sql
}

fn merge_sql(
    q: &str,
    cols: &[String],
    column_rules: &[LoadColumnRule],
    rows: &[Vec<String>],
    conflict_keys: &[String],
    null_marker: Option<&str>,
) -> String {
    let quoted_cols: Vec<String> = cols.iter().map(|c| quote_ident("oracle", c)).collect();
    let mut src = String::from("SELECT ");
    for (i, row) in rows.iter().enumerate() {
        if i > 0 {
            src.push_str(" FROM DUAL UNION ALL SELECT ");
        }
        for (j, cell) in row.iter().enumerate() {
            if j > 0 {
                src.push_str(", ");
            }
            if crate::cell_is_null(cell, &column_rules[j], null_marker) {
                src.push_str("NULL");
            } else {
                src.push_str(&sql_lit(cell));
            }
            src.push_str(" AS ");
            src.push_str(&quoted_cols[j]);
        }
    }
    src.push_str(" FROM DUAL");
    let on = conflict_keys
        .iter()
        .map(|key| {
            let quoted = quote_ident("oracle", key);
            format!("dest.{quoted} = src.{quoted}")
        })
        .collect::<Vec<_>>()
        .join(" AND ");
    let update_cols: Vec<&String> = cols
        .iter()
        .filter(|col| !conflict_keys.iter().any(|key| key == *col))
        .collect();
    let mut sql = format!("MERGE INTO {q} dest USING ({src}) src ON ({on})");
    if !update_cols.is_empty() {
        let assignments = update_cols
            .iter()
            .map(|col| {
                let quoted = quote_ident("oracle", col);
                format!("dest.{quoted} = src.{quoted}")
            })
            .collect::<Vec<_>>()
            .join(", ");
        sql.push_str(&format!(" WHEN MATCHED THEN UPDATE SET {assignments}"));
    }
    sql.push_str(&format!(
        " WHEN NOT MATCHED THEN INSERT ({}) VALUES ({})",
        quoted_cols.join(", "),
        quoted_cols
            .iter()
            .map(|col| format!("src.{col}"))
            .collect::<Vec<_>>()
            .join(", ")
    ));
    sql
}

#[cfg(test)]
mod tests {
    use super::*;
    use storage::LiveConnection;

    fn live(driver: &str) -> LiveConnection {
        LiveConnection {
            http_auth: None,
            id: "test".into(),
            name: "test".into(),
            driver: driver.into(),
            host: "db.local".into(),
            port: if driver == "tibero" { 8629 } else { 1521 },
            database: "ORCL".into(),
            username: "hr".into(),
            password: "p;x".into(),
            ssl: false,
        }
    }

    #[test]
    fn picks_instantclient_over_microsoft() {
        let installed = [
            "Microsoft ODBC for Oracle".into(),
            "Oracle in instantclient_21_13".into(),
        ];
        assert_eq!(
            pick_driver("oracle", &installed, None).as_deref(),
            Some("Oracle in instantclient_21_13")
        );
        assert_eq!(
            pick_driver("tibero", &["Tibero 6 ODBC Driver".into()], None).as_deref(),
            Some("Tibero 6 ODBC Driver")
        );
        assert!(pick_driver("oracle", &["PostgreSQL Unicode".into()], None).is_none());
        assert_eq!(
            pick_driver("oracle", &installed, Some("Custom Oracle")).as_deref(),
            Some("Custom Oracle")
        );
    }

    #[test]
    fn connection_strings() {
        let oracle = connection_string(&live("oracle"), "Oracle in instantclient_21_1");
        assert!(oracle.contains("Driver={Oracle in instantclient_21_1}"));
        assert!(oracle.contains("DBQ=//db.local:1521/ORCL"));
        assert!(oracle.contains("UID=hr"));
        assert!(oracle.contains("PWD={p;x}"));

        let tibero = connection_string(&live("tibero"), "Tibero 6 ODBC Driver");
        assert!(tibero.contains("Driver={Tibero 6 ODBC Driver}"));
        assert!(tibero.contains("SERVER=db.local"));
        assert!(tibero.contains("PORT=8629"));
        assert!(tibero.contains("DB=ORCL"));

        let path = connection_string(&live("tibero"), "/opt/tibero6/client/lib/libtbodbc.so");
        assert!(path.contains("Driver=/opt/tibero6/client/lib/libtbodbc.so"));
        assert!(!path.contains("Driver={/opt/tibero6/client/lib/libtbodbc.so}"));
    }

    #[test]
    fn merge_skips_matched_update_when_only_keys() {
        let rules = vec![LoadColumnRule {
            name: "id".into(),
            empty_as_null: true,
            nullable: false,
            data_type: "NUMBER".into(),
        }];
        let sql = merge_sql(
            "\"HR\".\"T\"",
            &["id".into()],
            &rules,
            &[vec!["1".into()]],
            &["id".into()],
            None,
        );
        assert!(sql.contains("MERGE INTO"));
        assert!(!sql.contains("WHEN MATCHED"));
        assert!(sql.contains("WHEN NOT MATCHED"));
    }
}
