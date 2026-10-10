use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tokio::task::AbortHandle;

use crate::storage::Store;

pub struct AppState {
    pub store: Arc<Store>,
    /// In-flight suggestion requests, so they can be cancelled.
    pub llm_tasks: Mutex<HashMap<String, AbortHandle>>,
}

impl AppState {
    pub fn new(store: Store) -> Self {
        Self { store: Arc::new(store), llm_tasks: Mutex::new(HashMap::new()) }
    }
}
