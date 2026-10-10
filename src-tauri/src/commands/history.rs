use tauri::State;

use crate::error::AppResult;
use crate::model::{AnalysisResult, HistoryEntry};
use crate::state::AppState;

#[tauri::command]
pub async fn list_history(
    state: State<'_, AppState>,
    search: Option<String>,
    limit: Option<u32>,
) -> AppResult<Vec<HistoryEntry>> {
    state.store.list_history(search.as_deref(), limit.unwrap_or(200).min(500))
}

#[tauri::command]
pub async fn get_analysis(state: State<'_, AppState>, id: String) -> AppResult<AnalysisResult> {
    state.store.get_analysis(&id)
}

#[tauri::command]
pub async fn delete_analysis(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.store.delete_analysis(&id)
}

#[tauri::command]
pub async fn clear_history(state: State<'_, AppState>) -> AppResult<()> {
    state.store.clear_history()
}
