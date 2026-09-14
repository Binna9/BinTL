use std::sync::Arc;

use tokio::sync::Notify;

use crate::config::Config;

#[derive(Clone)]
pub struct AppState {
    pub store: storage::Store,
    pub dispatch: Arc<Notify>,
    pub config: Arc<Config>,
}

impl AppState {
    pub fn wake(&self) {
        self.dispatch.notify_one();
    }
}
