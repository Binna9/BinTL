use connectors::{extract_query, extract_table, parse_delimiter, with_database, ExtractOptions};
use storage::Store;

pub fn spawn(store: Store, id: String) {
    tokio::spawn(async move {
        if let Err(err) = run(&store, &id).await {
            tracing::error!(id, %err, "extract failed");
        }
    });
}

async fn run(store: &Store, id: &str) -> Result<(), String> {
    let row = store
        .get_extract(id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("extract {id} missing"))?;
    if row.status != "queued" {
        return Ok(());
    }
    store
        .set_extract_running(id)
        .await
        .map_err(|e| e.to_string())?;
    if let Err(err) = extract_now(store, &row).await {
        let _ = store.set_extract_failed(id, &err).await;
        return Err(err);
    }
    Ok(())
}

async fn extract_now(store: &Store, row: &storage::ExtractRow) -> Result<(), String> {
    let live = store
        .live_connection(&row.connection_id)
        .await
        .map_err(|e| e.to_string())?;
    let live = with_database(&live, row.catalog_database.as_deref());
    let delimiter = parse_delimiter(&row.delimiter).map_err(|e| e.to_string())?;
    let opts = ExtractOptions {
        delimiter,
        header: row.header != 0,
        quote: b'"',
    };
    let (filename, rel) = Store::extract_file_rel(&row.id, &row.table_name, &row.delimiter);
    let dest = store.resolve(&rel);
    let n = if let Some(sql) = row.sql_text.as_deref().filter(|s| !s.trim().is_empty()) {
        extract_query(&live, sql, &dest, &opts)
            .await
            .map_err(|e| e.to_string())?
    } else {
        extract_table(&live, &row.table_name, &dest, &opts)
            .await
            .map_err(|e| e.to_string())?
    };
    store
        .set_extract_succeeded(&row.id, &rel, &filename, n as i64)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}
