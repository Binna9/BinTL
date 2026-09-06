use std::sync::Arc;

use tokio::sync::mpsc;

use crate::config::Config;

#[derive(Debug, Clone)]
pub enum ExecutionTask {
    Job(String),
    Chip(String),
}

#[derive(Clone)]
pub struct AppState {
    pub store: storage::Store,
    pub execution_tx: mpsc::Sender<ExecutionTask>,
    pub config: Arc<Config>,
}
