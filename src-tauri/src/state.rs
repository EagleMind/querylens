use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

use tokio::task::AbortHandle;

use crate::error::AppResult;
use crate::model::AnalysisResult;
use crate::storage::Store;

/// Unsaved analyses (fix previews) kept so they can be compared.
const SCRATCH_CAPACITY: usize = 40;

/// Recent unsaved analyses, newest first.
#[derive(Default)]
pub struct Scratch(Mutex<VecDeque<AnalysisResult>>);

impl Scratch {
    pub fn remember(&self, analysis: AnalysisResult) {
        let mut items = self.0.lock().expect("scratch poisoned");
        items.retain(|a| a.id != analysis.id);
        items.push_front(analysis);
        items.truncate(SCRATCH_CAPACITY);
    }

    pub fn get(&self, id: &str) -> Option<AnalysisResult> {
        self.0.lock().expect("scratch poisoned").iter().find(|a| a.id == id).cloned()
    }
}

pub struct AppState {
    pub store: Arc<Store>,
    pub scratch: Arc<Scratch>,
    /// In-flight background jobs (AI suggestions), so they can be cancelled.
    pub tasks: Mutex<HashMap<String, AbortHandle>>,
}

impl AppState {
    pub fn new(store: Store) -> Self {
        Self { store: Arc::new(store), scratch: Arc::default(), tasks: Mutex::new(HashMap::new()) }
    }

    /// An analysis from the unsaved scratch area, or else from history.
    pub fn find_analysis(&self, id: &str) -> AppResult<AnalysisResult> {
        match self.scratch.get(id) {
            Some(a) => Ok(a),
            None => self.store.get_analysis(id),
        }
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
