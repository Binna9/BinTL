use std::sync::Arc;

use tokio::sync::mpsc;

use crate::config::Config;

#[derive(Clone)]
pub struct AppState {
    pub store: storage::Store,
    pub job_tx: mpsc::Sender<String>,
    pub chip_tx: mpsc::Sender<String>,
    pub config: Arc<Config>,
}
