use serde::Serialize;
use sqlx::Row;
use storage::LiveConnection;

use crate::{
    driver_family, mssql_client, my_pool, parse_ident, pg_pool, sqlite_pool, with_database,
    ConnectError,
};

#[derive(Debug, Clone, Serialize)]
pub struct CatalogItem {
    pub name: String,
    pub kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current: Option<bool>,
}

pub fn catalog_layout(driver: &str) -> Result<&'static str, ConnectError> {
    Ok(match driver_family(driver)? {
        "postgres" | "mssql" => "database.schema.table",
        _ => "database.table",
    })
}

pub async fn list_databases(c: &LiveConnection) -> Result<Vec<CatalogItem>, ConnectError> {
    match driver_family(&c.driver)? {
        "postgres" => {
            let pool = pg_pool(c).await?;
            let rows = sqlx::query(
                "SELECT datname
                 FROM pg_database
                 WHERE datallowconn AND NOT datistemplate
                 ORDER BY 1",
            )
            .fetch_all(&pool)
            .await?;
            pool.close().await;
            Ok(rows
                .iter()
                .filter_map(|r| r.try_get::<String, _>(0).ok())
                .map(|name| item_db(&name, &c.database))
                .collect())
        }
        "mysql" => {
            let pool = my_pool(c).await?;
            let rows = sqlx::query(
                "SELECT schema_name
                 FROM information_schema.schemata
                 WHERE schema_name NOT IN ('information_schema', 'performance_schema', 'mysql', 'sys')
                 ORDER BY 1",
            )
            .fetch_all(&pool)
            .await?;
            pool.close().await;
            Ok(rows
                .iter()
                .filter_map(|r| r.try_get::<String, _>(0).ok())
                .map(|name| item_db(&name, &c.database))
                .collect())
        }
        "sqlite" => {
            let name = if c.database.is_empty() {
                "main".to_string()
            } else {
                c.database.clone()
            };
            Ok(vec![item_db(&name, &name)])
        }
        "mssql" => {
            let mut client = mssql_client(c).await?;
            let stream = client
                .simple_query(
                    "SELECT name FROM sys.databases
                     WHERE state_desc = 'ONLINE'
                       AND name NOT IN ('master', 'tempdb', 'model', 'msdb')
                     ORDER BY 1",
                )
                .await?;
            let rows = stream.into_first_result().await?;
            let mut out: Vec<CatalogItem> = rows
                .iter()
                .filter_map(|r| r.try_get::<&str, usize>(0).ok().flatten().map(str::to_string))
                .map(|name| item_db(&name, &c.database))
                .collect();
            if out.iter().all(|d| d.current != Some(true)) && !c.database.is_empty() {
                out.insert(0, item_db(&c.database, &c.database));
            }
            Ok(out)
        }
        other => Err(ConnectError::Invalid(format!("unsupported family {other}"))),
    }
}

pub async fn list_schemas(
    c: &LiveConnection,
    database: &str,
) -> Result<Vec<CatalogItem>, ConnectError> {
    parse_ident(database)?;
    let live = with_database(c, Some(database));
    match driver_family(&c.driver)? {
        "postgres" => {
            let pool = pg_pool(&live).await?;
            let rows = sqlx::query(
                "SELECT schema_name
                 FROM information_schema.schemata
                 WHERE schema_name NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
                   AND schema_name NOT LIKE 'pg_%'
                 ORDER BY 1",
            )
            .fetch_all(&pool)
            .await?;
            pool.close().await;
            Ok(rows
                .iter()
                .filter_map(|r| r.try_get::<String, _>(0).ok())
                .map(|name| CatalogItem {
                    name,
                    kind: "schema",
                    current: None,
                })
                .collect())
        }
        "mssql" => {
            let mut client = mssql_client(&live).await?;
            let stream = client
                .simple_query(
                    "SELECT SCHEMA_NAME
                     FROM INFORMATION_SCHEMA.SCHEMATA
                     WHERE SCHEMA_NAME NOT IN (
                       'sys', 'INFORMATION_SCHEMA', 'guest',
                       'db_owner', 'db_accessadmin', 'db_securityadmin',
                       'db_ddladmin', 'db_backupoperator', 'db_datareader',
                       'db_datawriter', 'db_denydatareader', 'db_denydatawriter'
                     )
                     ORDER BY 1",
                )
                .await?;
            let rows = stream.into_first_result().await?;
            Ok(rows
                .iter()
                .filter_map(|r| r.try_get::<&str, usize>(0).ok().flatten().map(str::to_string))
                .map(|name| CatalogItem {
                    name,
                    kind: "schema",
                    current: None,
                })
                .collect())
        }
        "mysql" | "sqlite" => Ok(Vec::new()),
        other => Err(ConnectError::Invalid(format!("unsupported family {other}"))),
    }
}

pub async fn list_relations(
    c: &LiveConnection,
    database: &str,
    schema: Option<&str>,
) -> Result<Vec<CatalogItem>, ConnectError> {
    parse_ident(database)?;
    if let Some(schema) = schema {
        parse_ident(schema)?;
    }
    let live = with_database(c, Some(database));
    match driver_family(&c.driver)? {
        "postgres" => {
            let schema = schema.ok_or_else(|| ConnectError::Invalid("schema required".into()))?;
            let pool = pg_pool(&live).await?;
            let rows = sqlx::query(
                "SELECT table_name, table_type
                 FROM information_schema.tables
                 WHERE table_schema = $1
                   AND table_type IN ('BASE TABLE', 'VIEW')
                 ORDER BY 1",
            )
            .bind(schema)
            .fetch_all(&pool)
            .await?;
            pool.close().await;
            Ok(rows.iter().filter_map(rel_from_sqlx).collect())
        }
        "mysql" => {
            let pool = my_pool(&live).await?;
            let rows = sqlx::query(
                "SELECT table_name, table_type
                 FROM information_schema.tables
                 WHERE table_schema = ?
                   AND table_type IN ('BASE TABLE', 'VIEW')
                 ORDER BY 1",
            )
            .bind(database)
            .fetch_all(&pool)
            .await?;
            pool.close().await;
            Ok(rows.iter().filter_map(rel_from_sqlx).collect())
        }
        "sqlite" => {
            let pool = sqlite_pool(&live).await?;
            let rows = sqlx::query(
                "SELECT name, type FROM sqlite_master
                 WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'
                 ORDER BY 1",
            )
            .fetch_all(&pool)
            .await?;
            pool.close().await;
            Ok(rows
                .iter()
                .filter_map(|r| {
                    let name = r.try_get::<String, _>(0).ok()?;
                    let kind = match r.try_get::<String, _>(1).ok().as_deref() {
                        Some("view") => "view",
                        _ => "table",
                    };
                    Some(CatalogItem {
                        name,
                        kind,
                        current: None,
                    })
                })
                .collect())
        }
        "mssql" => {
            let schema = schema.ok_or_else(|| ConnectError::Invalid("schema required".into()))?;
            let mut client = mssql_client(&live).await?;
            let sql = format!(
                "SELECT TABLE_NAME, TABLE_TYPE
                 FROM INFORMATION_SCHEMA.TABLES
                 WHERE TABLE_SCHEMA = '{schema}'
                   AND TABLE_TYPE IN ('BASE TABLE', 'VIEW')
                 ORDER BY 1"
            );
            let stream = client.simple_query(sql).await?;
            let rows = stream.into_first_result().await?;
            Ok(rows
                .iter()
                .filter_map(|r| {
                    let name = r.try_get::<&str, usize>(0).ok().flatten()?.to_string();
                    let kind = match r.try_get::<&str, usize>(1).ok().flatten() {
                        Some(t) if t.eq_ignore_ascii_case("VIEW") => "view",
                        _ => "table",
                    };
                    Some(CatalogItem {
                        name,
                        kind,
                        current: None,
                    })
                })
                .collect())
        }
        other => Err(ConnectError::Invalid(format!("unsupported family {other}"))),
    }
}

fn item_db(name: &str, current: &str) -> CatalogItem {
    CatalogItem {
        name: name.to_string(),
        kind: "database",
        current: Some(name == current),
    }
}

fn rel_from_sqlx<R: Row>(row: &R) -> Option<CatalogItem>
where
    usize: sqlx::ColumnIndex<R>,
    String: for<'r> sqlx::Decode<'r, R::Database> + sqlx::Type<R::Database>,
{
    let name = row.try_get::<String, _>(0).ok()?;
    let type_name = row.try_get::<String, _>(1).ok().unwrap_or_default();
    let kind = if type_name.to_ascii_uppercase().contains("VIEW") {
        "view"
    } else {
        "table"
    };
    Some(CatalogItem {
        name,
        kind,
        current: None,
    })
}
