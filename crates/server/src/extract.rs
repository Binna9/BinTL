use std::sync::Mutex;
use std::time::{Duration, Instant};

use connectors::{extract_query, extract_table, parse_delimiter, with_database, ExtractOptions};
use storage::{ProcessLog, Store, LOG_EXTRACTS};

pub fn spawn(store: Store, id: String) {
    tokio::spawn(async move {
        if let Err(err) = run(&store, &id).await {
            tracing::error!(id, %err, "extract failed");
        }
    });
}

pub(crate) async fn run(store: &Store, id: &str) -> Result<(), String> {
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
    let log = ProcessLog::create(&store.data_dir, LOG_EXTRACTS, id).ok();
    if let Some(log) = &log {
        let source = row
            .sql_text
            .as_deref()
            .filter(|s| !s.trim().is_empty())
            .map(|sql| format!("sql={}", truncate(sql, 240)))
            .unwrap_or_else(|| format!("table={}", row.table_name));
        log.write(
            "info",
            "started",
            &format!(
                "{source} delimiter={} header={} sequence={}",
                row.delimiter,
                row.header != 0,
                row.add_sequence != 0
            ),
        );
    }
    if let Err(err) = extract_now(store, &row, log.as_ref()).await {
        if let Some(log) = &log {
            log.write("error", "failed", &err);
        }
        let _ = store.set_extract_failed(id, &err).await;
        return Err(err);
    }
    Ok(())
}

async fn extract_now(
    store: &Store,
    row: &storage::ExtractRow,
    log: Option<&ProcessLog>,
) -> Result<(), String> {
    let live = store
        .live_connection(&row.connection_id)
        .await
        .map_err(|e| e.to_string())?;
    let live = with_database(&live, row.catalog_database.as_deref());
    if let Some(log) = log {
        log.write(
            "info",
            "connected",
            &format!(
                "driver={} database={} name={}",
                live.driver, live.database, live.name
            ),
        );
    }
    let delimiter = parse_delimiter(&row.delimiter).map_err(|e| e.to_string())?;
    let opts = ExtractOptions {
        delimiter,
        header: row.header != 0,
        quote: b'"',
        add_sequence: row.add_sequence != 0,
    };
    let (filename, rel) = Store::extract_file_rel(&row.id, &row.table_name, &row.delimiter);
    let dest = store.resolve(&rel);
    let progress = ExtractProgress::new(store.clone(), row.id.clone(), log.cloned());
    let on_progress = |n: u64| progress.report(n);
    let n = if let Some(sql) = row.sql_text.as_deref().filter(|s| !s.trim().is_empty()) {
        extract_query(&live, sql, &dest, &opts, Some(&on_progress))
            .await
            .map_err(|e| e.to_string())?
    } else {
        extract_table(&live, &row.table_name, &dest, &opts, Some(&on_progress))
            .await
            .map_err(|e| e.to_string())?
    };
    if let Some(log) = log {
        log.write("info", "succeeded", &format!("rows={n} file={rel}"));
    }
    store
        .set_extract_succeeded(&row.id, &rel, &filename, n as i64)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

struct ExtractProgress {
    store: Store,
    id: String,
    log: Option<ProcessLog>,
    last_db: Mutex<Instant>,
}

impl ExtractProgress {
    fn new(store: Store, id: String, log: Option<ProcessLog>) -> Self {
        Self {
            store,
            id,
            log,
            last_db: Mutex::new(Instant::now() - Duration::from_secs(10)),
        }
    }

    fn report(&self, n: u64) {
        if let Some(log) = &self.log {
            log.write("info", "writing", &format!("rows={n}"));
        }
        let mut last = match self.last_db.lock() {
            Ok(guard) => guard,
            Err(_) => return,
        };
        if n != 1 && last.elapsed() < Duration::from_secs(2) && n % 50_000 != 0 {
            return;
        }
        *last = Instant::now();
        drop(last);
        let store = self.store.clone();
        let id = self.id.clone();
        tokio::spawn(async move {
            let _ = store.set_extract_progress(&id, n as i64).await;
        });
    }
}

fn truncate(s: &str, max: usize) -> String {
    let compact = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if compact.chars().count() <= max {
        return compact;
    }
    let cut: String = compact.chars().take(max).collect();
    format!("{cut}…")
}
