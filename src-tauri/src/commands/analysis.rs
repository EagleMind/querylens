use tauri::State;

use crate::error::AppResult;
use crate::model::{AnalysisResult, ExplainMode};
use crate::services::analysis::{self, RunOptions};
use crate::state::AppState;

#[tauri::command]
pub async fn analyze_query(
    state: State<'_, AppState>,
    connection_id: String,
    sql: String,
    mode: ExplainMode,
    params: Option<Vec<Option<String>>>,
) -> AppResult<AnalysisResult> {
    let runs = state.store.get_settings()?.analysis.repeat_runs;
    let opts = RunOptions { persist: true, runs, params: params.unwrap_or_default(), ..RunOptions::new(mode) };
    analysis::run(&state.store, &connection_id, &sql, opts).await
}
