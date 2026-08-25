use serde::Serialize;
use sqlx::Row;
use storage::LiveConnection;

use crate::{
    driver_family, mssql_client, my_pool, parse_table, pg_pool, qualified, schema_or, sqlite_pool,
    stringify_ms, stringify_my, stringify_pg, stringify_sqlite, ConnectError,
};

#[derive(Debug, Clone, Serialize)]
pub struct ColumnInfo {
    pub ordinal: i32,
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub primary_key: bool,
    pub default_value: Option<String>,
    pub max_length: Option<i64>,
    pub numeric_precision: Option<i64>,
    pub numeric_scale: Option<i64>,
    pub extra: Option<String>,
    pub comment: Option<String>,
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
                "SELECT
                    c.ordinal_position,
                    c.column_name,
                    CASE
                      WHEN c.character_maximum_length IS NOT NULL
                        THEN c.udt_name || '(' || c.character_maximum_length || ')'
                      WHEN c.data_type = 'numeric' AND c.numeric_precision IS NOT NULL
                        THEN c.udt_name || '(' || c.numeric_precision || ',' || COALESCE(c.numeric_scale, 0) || ')'
                      ELSE c.udt_name
                    END,
                    c.is_nullable,
                    c.column_default,
                    c.character_maximum_length,
                    c.numeric_precision,
                    c.numeric_scale,
                    EXISTS (
                      SELECT 1
                      FROM information_schema.table_constraints tc
                      JOIN information_schema.key_column_usage kcu
                        ON tc.constraint_name = kcu.constraint_name
                       AND tc.table_schema = kcu.table_schema
                       AND tc.table_name = kcu.table_name
                      WHERE tc.constraint_type = 'PRIMARY KEY'
                        AND kcu.table_schema = c.table_schema
                        AND kcu.table_name = c.table_name
                        AND kcu.column_name = c.column_name
                    ),
                    CASE WHEN c.is_identity = 'YES' THEN 'identity' ELSE NULL END,
                    (
                      SELECT d.description
                      FROM pg_catalog.pg_namespace nsp
                      JOIN pg_catalog.pg_class cls
                        ON cls.relnamespace = nsp.oid
                      JOIN pg_catalog.pg_attribute att
                        ON att.attrelid = cls.oid
                       AND att.attname = c.column_name
                       AND att.attnum > 0
                       AND NOT att.attisdropped
                      LEFT JOIN pg_catalog.pg_description d
                        ON d.objoid = cls.oid
                       AND d.objsubid = att.attnum
                      WHERE nsp.nspname = c.table_schema
                        AND cls.relname = c.table_name
                      LIMIT 1
                    )
                 FROM information_schema.columns c
                 WHERE c.table_schema = $1 AND c.table_name = $2
                 ORDER BY c.ordinal_position",
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
            let sql = "SELECT
                    ORDINAL_POSITION,
                    COLUMN_NAME,
                    COLUMN_TYPE,
                    IS_NULLABLE,
                    COLUMN_DEFAULT,
                    CHARACTER_MAXIMUM_LENGTH,
                    NUMERIC_PRECISION,
                    NUMERIC_SCALE,
                    COLUMN_KEY = 'PRI',
                    NULLIF(EXTRA, ''),
                    NULLIF(COLUMN_COMMENT, '')
                 FROM information_schema.columns
                 WHERE table_schema = ? AND table_name = ?
                 ORDER BY ORDINAL_POSITION";
            let rows = if let Some(schema) = &parsed.schema {
                sqlx::query(sql)
                    .bind(schema)
                    .bind(&parsed.table)
                    .fetch_all(&pool)
                    .await?
            } else {
                sqlx::query(
                    "SELECT
                    ORDINAL_POSITION,
                    COLUMN_NAME,
                    COLUMN_TYPE,
                    IS_NULLABLE,
                    COLUMN_DEFAULT,
                    CHARACTER_MAXIMUM_LENGTH,
                    NUMERIC_PRECISION,
                    NUMERIC_SCALE,
                    COLUMN_KEY = 'PRI',
                    NULLIF(EXTRA, ''),
                    NULLIF(COLUMN_COMMENT, '')
                 FROM information_schema.columns
                 WHERE table_schema = DATABASE() AND table_name = ?
                 ORDER BY ORDINAL_POSITION",
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
                    let cid: i64 = r.try_get(0).unwrap_or(0);
                    let notnull: i64 = r.try_get(3).unwrap_or(0);
                    let pk: i64 = r.try_get(5).unwrap_or(0);
                    ColumnInfo {
                        ordinal: (cid + 1) as i32,
                        name: sqlx_string(r, 1),
                        data_type: sqlx_string(r, 2),
                        nullable: notnull == 0,
                        primary_key: pk != 0,
                        default_value: sqlx_opt_string(r, 4),
                        max_length: None,
                        numeric_precision: None,
                        numeric_scale: None,
                        extra: None,
                        comment: None,
                    }
                })
                .collect())
        }
        "mssql" => {
            let mut client = mssql_client(c).await?;
            let schema = schema_or(family, &parsed);
            let sql = format!(
                "SELECT
                    c.ORDINAL_POSITION,
                    c.COLUMN_NAME,
                    CASE
                      WHEN c.CHARACTER_MAXIMUM_LENGTH IS NOT NULL
                           AND c.DATA_TYPE IN ('varchar','nvarchar','char','nchar','varbinary','binary')
                        THEN c.DATA_TYPE + '(' + CASE WHEN c.CHARACTER_MAXIMUM_LENGTH = -1 THEN 'max' ELSE CAST(c.CHARACTER_MAXIMUM_LENGTH AS varchar(16)) END + ')'
                      WHEN c.DATA_TYPE IN ('decimal','numeric') AND c.NUMERIC_PRECISION IS NOT NULL
                        THEN c.DATA_TYPE + '(' + CAST(c.NUMERIC_PRECISION AS varchar(16)) + ',' + CAST(ISNULL(c.NUMERIC_SCALE,0) AS varchar(16)) + ')'
                      ELSE c.DATA_TYPE
                    END,
                    c.IS_NULLABLE,
                    CONVERT(nvarchar(400), c.COLUMN_DEFAULT),
                    c.CHARACTER_MAXIMUM_LENGTH,
                    c.NUMERIC_PRECISION,
                    c.NUMERIC_SCALE,
                    CASE WHEN pk.COLUMN_NAME IS NULL THEN N'NO' ELSE N'YES' END,
                    CASE WHEN COLUMNPROPERTY(OBJECT_ID(QUOTENAME(N'{schema}') + N'.' + QUOTENAME(N'{}')), c.COLUMN_NAME, 'IsIdentity') = 1 THEN N'identity' ELSE NULL END,
                    (
                      SELECT CAST(ep.value AS nvarchar(4000))
                      FROM sys.extended_properties ep
                      INNER JOIN sys.columns sc
                        ON ep.major_id = sc.object_id AND ep.minor_id = sc.column_id
                      INNER JOIN sys.objects so ON so.object_id = sc.object_id
                      INNER JOIN sys.schemas ss ON ss.schema_id = so.schema_id
                      WHERE ep.class = 1
                        AND ep.name = N'MS_Description'
                        AND ss.name = c.TABLE_SCHEMA
                        AND so.name = c.TABLE_NAME
                        AND sc.name = c.COLUMN_NAME
                    )
                 FROM INFORMATION_SCHEMA.COLUMNS c
                 LEFT JOIN (
                   SELECT kcu.COLUMN_NAME
                   FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
                   INNER JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
                     ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
                    AND tc.TABLE_SCHEMA = kcu.TABLE_SCHEMA
                   WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
                     AND tc.TABLE_SCHEMA = N'{schema}'
                     AND tc.TABLE_NAME = N'{}'
                 ) pk ON pk.COLUMN_NAME = c.COLUMN_NAME
                 WHERE c.TABLE_SCHEMA = N'{schema}' AND c.TABLE_NAME = N'{}'
                 ORDER BY c.ORDINAL_POSITION",
                parsed.table, parsed.table, parsed.table
            );
            let stream = client.simple_query(sql).await?;
            let rows = stream.into_first_result().await?;
            Ok(rows
                .iter()
                .map(|r| ColumnInfo {
                    ordinal: r.try_get::<i32, usize>(0).ok().flatten().unwrap_or(0),
                    name: r
                        .try_get::<&str, usize>(1)
                        .ok()
                        .flatten()
                        .unwrap_or("")
                        .to_string(),
                    data_type: r
                        .try_get::<&str, usize>(2)
                        .ok()
                        .flatten()
                        .unwrap_or("")
                        .to_string(),
                    nullable: r
                        .try_get::<&str, usize>(3)
                        .ok()
                        .flatten()
                        .map(|s| !s.eq_ignore_ascii_case("NO"))
                        .unwrap_or(true),
                    default_value: r
                        .try_get::<&str, usize>(4)
                        .ok()
                        .flatten()
                        .map(str::to_string),
                    max_length: r.try_get::<i32, usize>(5).ok().flatten().map(|v| v as i64),
                    numeric_precision: r.try_get::<u8, usize>(6).ok().flatten().map(|v| v as i64)
                        .or_else(|| r.try_get::<i32, usize>(6).ok().flatten().map(|v| v as i64)),
                    numeric_scale: r.try_get::<i32, usize>(7).ok().flatten().map(|v| v as i64),
                    primary_key: r
                        .try_get::<&str, usize>(8)
                        .ok()
                        .flatten()
                        .map(|s| s.eq_ignore_ascii_case("YES"))
                        .unwrap_or(false),
                    extra: r
                        .try_get::<&str, usize>(9)
                        .ok()
                        .flatten()
                        .map(str::to_string),
                    comment: r
                        .try_get::<&str, usize>(10)
                        .ok()
                        .flatten()
                        .map(str::to_string),
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
    bool: for<'r> sqlx::Decode<'r, R::Database> + sqlx::Type<R::Database>,
    i16: for<'r> sqlx::Decode<'r, R::Database> + sqlx::Type<R::Database>,
    i32: for<'r> sqlx::Decode<'r, R::Database> + sqlx::Type<R::Database>,
    i64: for<'r> sqlx::Decode<'r, R::Database> + sqlx::Type<R::Database>,
    String: for<'r> sqlx::Decode<'r, R::Database> + sqlx::Type<R::Database>,
{
    ColumnInfo {
        ordinal: sqlx_i32(row, 0),
        name: sqlx_string(row, 1),
        data_type: sqlx_string(row, 2),
        nullable: !sqlx_string(row, 3).eq_ignore_ascii_case("NO"),
        default_value: sqlx_opt_string(row, 4),
        max_length: sqlx_opt_i64(row, 5),
        numeric_precision: sqlx_opt_i64(row, 6),
        numeric_scale: sqlx_opt_i64(row, 7),
        primary_key: sqlx_bool(row, 8),
        extra: sqlx_opt_string(row, 9),
        comment: sqlx_opt_string(row, 10),
    }
}

fn sqlx_i32<'r, R: Row>(row: &'r R, i: usize) -> i32
where
    usize: sqlx::ColumnIndex<R>,
    i16: sqlx::Decode<'r, R::Database> + sqlx::Type<R::Database>,
    i32: sqlx::Decode<'r, R::Database> + sqlx::Type<R::Database>,
    i64: sqlx::Decode<'r, R::Database> + sqlx::Type<R::Database>,
{
    row.try_get::<i32, _>(i)
        .or_else(|_| row.try_get::<i64, _>(i).map(|v| v as i32))
        .or_else(|_| row.try_get::<i16, _>(i).map(|v| v as i32))
        .unwrap_or(0)
}

fn sqlx_opt_i64<'r, R: Row>(row: &'r R, i: usize) -> Option<i64>
where
    usize: sqlx::ColumnIndex<R>,
    i16: sqlx::Decode<'r, R::Database> + sqlx::Type<R::Database>,
    i32: sqlx::Decode<'r, R::Database> + sqlx::Type<R::Database>,
    i64: sqlx::Decode<'r, R::Database> + sqlx::Type<R::Database>,
{
    row.try_get::<Option<i64>, _>(i)
        .ok()
        .flatten()
        .or_else(|| row.try_get::<i64, _>(i).ok())
        .or_else(|| row.try_get::<Option<i32>, _>(i).ok().flatten().map(|v| v as i64))
        .or_else(|| row.try_get::<i32, _>(i).ok().map(|v| v as i64))
        .or_else(|| row.try_get::<Option<i16>, _>(i).ok().flatten().map(|v| v as i64))
}

fn sqlx_opt_string<'r, R: Row>(row: &'r R, i: usize) -> Option<String>
where
    usize: sqlx::ColumnIndex<R>,
    String: sqlx::Decode<'r, R::Database> + sqlx::Type<R::Database>,
{
    row.try_get::<Option<String>, _>(i)
        .ok()
        .flatten()
        .or_else(|| row.try_get::<String, _>(i).ok())
        .and_then(|v| {
            let trimmed = v.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(v)
            }
        })
}

fn sqlx_bool<'r, R: Row>(row: &'r R, i: usize) -> bool
where
    usize: sqlx::ColumnIndex<R>,
    bool: sqlx::Decode<'r, R::Database> + sqlx::Type<R::Database>,
    i32: sqlx::Decode<'r, R::Database> + sqlx::Type<R::Database>,
    i64: sqlx::Decode<'r, R::Database> + sqlx::Type<R::Database>,
    String: sqlx::Decode<'r, R::Database> + sqlx::Type<R::Database>,
{
    row.try_get::<bool, _>(i)
        .or_else(|_| row.try_get::<i64, _>(i).map(|v| v != 0))
        .or_else(|_| row.try_get::<i32, _>(i).map(|v| v != 0))
        .or_else(|_| {
            row.try_get::<String, _>(i)
                .map(|s| s.eq_ignore_ascii_case("YES") || s == "1" || s.eq_ignore_ascii_case("true"))
        })
        .unwrap_or(false)
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
