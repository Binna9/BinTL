use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::{Notify, Semaphore};

use crate::execution_error;

pub async fn run_loop(
    store: storage::Store,
    dispatch: Arc<Notify>,
    permits: Arc<Semaphore>,
) {
    let in_flight = Arc::new(Mutex::new(HashSet::<String>::new()));
    loop {
        pump(&store, &dispatch, &permits, &in_flight).await;
        tokio::select! {
            _ = dispatch.notified() => {}
            _ = tokio::time::sleep(Duration::from_millis(500)) => {}
        }
    }
}

async fn pump(
    store: &storage::Store,
    dispatch: &Arc<Notify>,
    permits: &Arc<Semaphore>,
    in_flight: &Arc<Mutex<HashSet<String>>>,
) {
    loop {
        let Ok(permit) = permits.clone().try_acquire_owned() else {
            return;
        };
        let Some(id) = next_step(store, in_flight).await else {
            drop(permit);
            return;
        };
        let store = store.clone();
        let dispatch = dispatch.clone();
        let in_flight = in_flight.clone();
        tokio::spawn(async move {
            run_step(&store, &dispatch, &id).await;
            if let Ok(mut running) = in_flight.lock() {
                running.remove(&id);
            }
            drop(permit);
            dispatch.notify_one();
        });
    }
}

async fn next_step(
    store: &storage::Store,
    in_flight: &Mutex<HashSet<String>>,
) -> Option<String> {
    let ids = store.list_dispatchable_steps(16).await.ok()?;
    let mut running = in_flight.lock().ok()?;
    for id in ids {
        if running.insert(id.clone()) {
            return Some(id);
        }
    }
    None
}

async fn run_step(store: &storage::Store, dispatch: &Notify, id: &str) {
    let step = match store.get_execution_step(id).await {
        Ok(Some(step)) if step.status == "queued" => step,
        _ => return,
    };
    if step.chip_id.is_some() {
        if let Err(error) = crate::chip::run_one(store, dispatch, id).await {
            if error != "canceled" {
                tracing::error!(execution_step_id = id, %error, "chip execution failed");
                execution_error::record_chip_failure(store, id, &step.kind, &error).await;
            }
        }
        return;
    }
    let result = match step.kind.as_str() {
        "extract" => crate::extract::run(store, id).await,
        "transform" => jobs::execute(store, id).await,
        "load" => crate::load::run_queued(store, id).await,
        other => Err(format!("unsupported standalone kind {other}")),
    };
    if let Err(error) = result {
        if error == "canceled" {
            return;
        }
        tracing::error!(execution_step_id = id, kind = %step.kind, %error, "standalone execution failed");
        match step.kind.as_str() {
            "extract" | "load" => {}
            "transform" => execution_error::record_transform_job_failure(store, id, &error).await,
            other => execution_error::record_chip_failure(store, id, other, &error).await,
        }
    }
}
