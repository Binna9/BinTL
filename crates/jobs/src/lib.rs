use std::sync::Arc;

use connectors::{extract_table, load_table, parse_db_source, ConnectError, ExtractOptions};
use engine::{Engine, EngineError, PolarsEngine, TransformSpec};
use storage::Store;
use tokio::sync::{mpsc, Semaphore};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JobStatus {
    Queued,
    Running,
    Succeeded,
    Failed,
    Canceled,
}

impl JobStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Running => "running",
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
            Self::Canceled => "canceled",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "queued" => Some(Self::Queued),
            "running" => Some(Self::Running),
            "succeeded" => Some(Self::Succeeded),
            "failed" => Some(Self::Failed),
            "canceled" => Some(Self::Canceled),
            _ => None,
        }
    }
}

#[derive(Debug, thiserror::Error)]
#[error("invalid transition {from:?} -> {to:?}")]
pub struct InvalidTransition {
    pub from: JobStatus,
    pub to: JobStatus,
}

pub fn transition(from: JobStatus, to: JobStatus) -> Result<JobStatus, InvalidTransition> {
    use JobStatus::*;
    match (from, to) {
        (Queued, Running)
        | (Failed, Running)
        | (Running, Succeeded)
        | (Running, Failed)
        | (Queued, Canceled) => Ok(to),
        _ => Err(InvalidTransition { from, to }),
    }
}

pub fn spawn_worker(
    store: Store,
    mut rx: mpsc::Receiver<String>,
    max_concurrent: usize,
) -> tokio::task::JoinHandle<()> {
    let engine = PolarsEngine;
    let permits = max_concurrent.max(1);
    tokio::spawn(async move {
        let sem = Arc::new(Semaphore::new(permits));
        while let Some(job_id) = rx.recv().await {
            let permit = match sem.clone().acquire_owned().await {
                Ok(p) => p,
                Err(_) => break,
            };
            let store = store.clone();
            tokio::task::spawn(async move {
                let _permit = permit;
                if let Err(err) = run_one(&store, engine, &job_id).await {
                    tracing::error!(job_id, %err, "job failed");
                    let _ = store.append_log(&job_id, "error", &err.to_string()).await;
                    let _ = store.set_job_failed(&job_id, &err.to_string()).await;
                }
            });
        }
    })
}

#[derive(Debug, thiserror::Error)]
enum RunError {
    #[error(transparent)]
    Storage(#[from] storage::StorageError),
    #[error(transparent)]
    Engine(#[from] EngineError),
    #[error(transparent)]
    Connect(#[from] ConnectError),
    #[error("{0}")]
    State(String),
}

async fn run_one(store: &Store, engine: PolarsEngine, job_id: &str) -> Result<(), RunError> {
    let job = store
        .get_job(job_id)
        .await?
        .ok_or_else(|| RunError::State(format!("job {job_id} missing")))?;
    let from = JobStatus::parse(&job.status)
        .ok_or_else(|| RunError::State(format!("unknown status {}", job.status)))?;
    if matches!(from, JobStatus::Running | JobStatus::Succeeded) {
        return Ok(());
    }
    transition(from, JobStatus::Running).map_err(|e| RunError::State(e.to_string()))?;

    let output_rel = format!("outputs/{job_id}/result.parquet");
    store.set_job_running(job_id, &output_rel).await?;
    store.append_log(job_id, "info", "job started").await?;

    let spec = TransformSpec::parse_json(&job.spec_json)?;
    let input = if let Some((conn_id, table)) = parse_db_source(&job.source_path) {
        let live = store.live_connection(&conn_id).await?;
        let csv_rel = format!("uploads/{job_id}/extract.csv");
        let csv_path = store.resolve(&csv_rel);
        store
            .append_log(
                job_id,
                "info",
                &format!("extract {}.{} {}", live.driver, live.name, table),
            )
            .await?;
        let n = extract_table(&live, &table, &csv_path, &ExtractOptions::default()).await?;
        store
            .append_log(job_id, "info", &format!("extracted {n} rows"))
            .await?;
        csv_path
    } else {
        store.resolve(&job.source_path)
    };
    let output = store.resolve(&output_rel);

    store
        .append_log(
            job_id,
            "info",
            &format!("transform {} -> {}", input.display(), output.display()),
        )
        .await?;

    let dest = spec.dest.clone();
    let csv_out = store.resolve(&format!("outputs/{job_id}/result.csv"));
    let needs_csv = dest.is_some();
    let engine_err = tokio::task::spawn_blocking(move || {
        engine.transform(&input, &output, &spec)?;
        if needs_csv {
            PolarsEngine::export_csv(&output, &csv_out)?;
        }
        Ok::<(), EngineError>(())
    })
    .await
    .map_err(|e| RunError::State(e.to_string()))?;
    engine_err?;

    if let Some(dest) = dest {
        let live = store.live_connection(&dest.connection_id).await?;
        let csv_path = store.resolve(&format!("outputs/{job_id}/result.csv"));
        store
            .append_log(
                job_id,
                "info",
                &format!(
                    "load {}.{} {} ({})",
                    live.driver, dest.table, dest.mode, live.name
                ),
            )
            .await?;
        let n = load_table(&live, &dest.table, &csv_path, &dest.mode).await?;
        store
            .append_log(job_id, "info", &format!("loaded {n} rows"))
            .await?;
    }

    transition(JobStatus::Running, JobStatus::Succeeded)
        .map_err(|e| RunError::State(e.to_string()))?;
    store.append_log(job_id, "info", "job succeeded").await?;
    store.set_job_succeeded(job_id).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn queued_to_running_to_succeeded() {
        assert_eq!(
            transition(JobStatus::Queued, JobStatus::Running).unwrap(),
            JobStatus::Running
        );
        assert_eq!(
            transition(JobStatus::Running, JobStatus::Succeeded).unwrap(),
            JobStatus::Succeeded
        );
        assert!(transition(JobStatus::Succeeded, JobStatus::Running).is_err());
        assert!(transition(JobStatus::Queued, JobStatus::Succeeded).is_err());
    }
}
