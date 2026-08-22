use serde::Serialize;
use sqlx::Row;
use storage::LiveConnection;

use crate::{
    driver_family, mssql_client, my_pool, parse_table, pg_pool, qualified, schema_or, sqlite_pool,
    stringify_ms, stringify_my, stringify_pg, stringify_sqlite, ConnectError,
};

#[derive(Debug, Clone, Serialize)]
pub struct ColumnInfo {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct Preview {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<String>>,
}

pub async fn list_columns(
    c: &LiveConnection,
    table: &str,
) -> Result<Vec<ColumnInfo>, ConnectError> {
    let family = driver_family(&c.driver)?;
    let parsed = parse_table(table)?;
    match family {
        "postgres" => {
            let pool = pg_pool(c).await?;
            let schema = schema_or(family, &parsed);
            let rows = sqlx::query(
                "SELECT column_name, data_type, is_nullable
                 FROM information_schema.columns
                 WHERE table_schema = $1 AND table_name = $2
                 ORDER BY ordinal_position",
            )
            .bind(schema)
            .bind(&parsed.table)
            .fetch_all(&pool)
            .await?;
            pool.close().await;
            Ok(rows.iter().map(col_from_info).collect())
        }
        "mysql" => {
            let pool = my_pool(c).await?;
            let rows = if let Some(schema) = &parsed.schema {
                sqlx::query(
                    "SELECT column_name, data_type, is_nullable
                     FROM information_schema.columns
                     WHERE table_schema = ? AND table_name = ?
                     ORDER BY ordinal_position",
                )
                .bind(schema)
                .bind(&parsed.table)
                .fetch_all(&pool)
                .await?
            } else {
                sqlx::query(
                    "SELECT column_name, data_type, is_nullable
                     FROM information_schema.columns
                     WHERE table_schema = DATABASE() AND table_name = ?
                     ORDER BY ordinal_position",
                )
                .bind(&parsed.table)
                .fetch_all(&pool)
                .await?
            };
            pool.close().await;
            Ok(rows.iter().map(col_from_info).collect())
        }
        "sqlite" => {
            let pool = sqlite_pool(c).await?;
            let ident = crate::quote_ident("sqlite", &parsed.table);
            let rows = sqlx::query(&format!("PRAGMA table_info({ident})"))
                .fetch_all(&pool)
                .await?;
            pool.close().await;
            Ok(rows
                .iter()
                .map(|r| {
                    let name = sqlx_string(r, 1);
                    let data_type = sqlx_string(r, 2);
                    let notnull: i64 = r.try_get(3).unwrap_or(0);
                    ColumnInfo {
                        name,
                        data_type,
                        nullable: notnull == 0,
                    }
                })
                .collect())
        }
        "mssql" => {
            let mut client = mssql_client(c).await?;
            let schema = schema_or(family, &parsed);
            let sql = format!(
                "SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE
                 FROM INFORMATION_SCHEMA.COLUMNS
                 WHERE TABLE_SCHEMA = '{schema}' AND TABLE_NAME = '{}'
                 ORDER BY ORDINAL_POSITION",
                parsed.table
            );
            let stream = client.simple_query(sql).await?;
            let rows = stream.into_first_result().await?;
            Ok(rows
                .iter()
                .map(|r| ColumnInfo {
                    name: r
                        .try_get::<&str, usize>(0)
                        .ok()
                        .flatten()
                        .unwrap_or("")
                        .to_string(),
                    data_type: r
                        .try_get::<&str, usize>(1)
                        .ok()
                        .flatten()
                        .unwrap_or("")
                        .to_string(),
                    nullable: r
                        .try_get::<&str, usize>(2)
                        .ok()
                        .flatten()
                        .map(|s| !s.eq_ignore_ascii_case("NO"))
                        .unwrap_or(true),
                })
                .collect())
        }
        other => Err(ConnectError::Invalid(format!("unsupported family {other}"))),
    }
}

pub async fn preview_table(
    c: &LiveConnection,
    table: &str,
    limit: u32,
) -> Result<Preview, ConnectError> {
    let limit = limit.clamp(1, 200);
    let cols = list_columns(c, table).await?;
    if cols.is_empty() {
        return Err(ConnectError::Invalid(format!("no columns for table {table}")));
    }
    let names: Vec<String> = cols.into_iter().map(|c| c.name).collect();
    let family = driver_family(&c.driver)?;
    let parsed = parse_table(table)?;
    let q = qualified(family, &parsed);
    let ncols = names.len();
    let rows = match family {
        "postgres" => {
            let pool = pg_pool(c).await?;
            let fetched = sqlx::query(&format!("SELECT * FROM {q} LIMIT {limit}"))
                .fetch_all(&pool)
                .await?;
            let rows = map_sqlx(&fetched, ncols, stringify_pg);
            pool.close().await;
            rows
        }
        "mysql" => {
            let pool = my_pool(c).await?;
            let fetched = sqlx::query(&format!("SELECT * FROM {q} LIMIT {limit}"))
                .fetch_all(&pool)
                .await?;
            let rows = map_sqlx(&fetched, ncols, stringify_my);
            pool.close().await;
            rows
        }
        "sqlite" => {
            let pool = sqlite_pool(c).await?;
            let fetched = sqlx::query(&format!("SELECT * FROM {q} LIMIT {limit}"))
                .fetch_all(&pool)
                .await?;
            let rows = map_sqlx(&fetched, ncols, stringify_sqlite);
            pool.close().await;
            rows
        }
        "mssql" => {
            let mut client = mssql_client(c).await?;
            let stream = client
                .simple_query(format!("SELECT TOP {limit} * FROM {q}"))
                .await?;
            let fetched = stream.into_first_result().await?;
            fetched
                .iter()
                .map(|r| (0..ncols).map(|i| stringify_ms(r, i)).collect())
                .collect()
        }
        other => return Err(ConnectError::Invalid(format!("unsupported family {other}"))),
    };
    Ok(Preview {
        columns: names,
        rows,
    })
}

fn map_sqlx<R, F>(rows: &[R], ncols: usize, cell: F) -> Vec<Vec<String>>
where
    F: Fn(&R, usize) -> String,
{
    rows.iter()
        .map(|r| (0..ncols).map(|i| cell(r, i)).collect())
        .collect()
}

fn col_from_info<R>(row: &R) -> ColumnInfo
where
    R: Row,
    usize: sqlx::ColumnIndex<R>,
    String: for<'r> sqlx::Decode<'r, R::Database> + sqlx::Type<R::Database>,
{
    ColumnInfo {
        name: sqlx_string(row, 0),
        data_type: sqlx_string(row, 1),
        nullable: !sqlx_string(row, 2).eq_ignore_ascii_case("NO"),
    }
}

fn sqlx_string<'r, R: Row>(row: &'r R, i: usize) -> String
where
    usize: sqlx::ColumnIndex<R>,
    String: sqlx::Decode<'r, R::Database> + sqlx::Type<R::Database>,
{
    row.try_get::<String, _>(i)
        .or_else(|_| {
            row.try_get::<Option<String>, _>(i)
                .map(|v| v.unwrap_or_default())
        })
        .unwrap_or_default()
}
