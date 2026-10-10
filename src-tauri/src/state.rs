use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

use tokio::task::AbortHandle;

use crate::error::AppResult;
use crate::model::AnalysisResult;
use crate::storage::Store;

/// Unsaved analyses (what-if scenarios, fix previews) kept so they can be compared.
const SCRATCH_CAPACITY: usize = 40;

pub struct AppState {
    pub store: Arc<Store>,
    /// In-flight background jobs (suggestions, what-if sweeps…), so they can be cancelled.
    pub tasks: Mutex<HashMap<String, AbortHandle>>,
    scratch: Mutex<VecDeque<AnalysisResult>>,
}

impl AppState {
    pub fn new(store: Store) -> Self {
        Self { store: Arc::new(store), tasks: Mutex::new(HashMap::new()), scratch: Mutex::new(VecDeque::new()) }
    }

    pub fn remember(&self, analysis: AnalysisResult) {
        let mut scratch = self.scratch.lock().expect("scratch poisoned");
        scratch.retain(|a| a.id != analysis.id);
        scratch.push_front(analysis);
        scratch.truncate(SCRATCH_CAPACITY);
    }

    /// An analysis from the unsaved scratch area, or else from history.
    pub fn find_analysis(&self, id: &str) -> AppResult<AnalysisResult> {
        if let Some(a) = self.scratch.lock().expect("scratch poisoned").iter().find(|a| a.id == id) {
            return Ok(a.clone());
        }
        self.store.get_analysis(id)
    }

    pub fn track_task(&self, id: String, handle: AbortHandle) {
        let mut tasks = self.tasks.lock().expect("task map poisoned");
        tasks.retain(|_, h| !h.is_finished());
        tasks.insert(id, handle);
    }

    pub fn cancel_task(&self, id: &str) {
        if let Some(h) = self.tasks.lock().expect("task map poisoned").remove(id) {
            h.abort();
        }
    }
}
