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
) -> AppResult<AnalysisResult> {
    analysis::run(
        &state.store,
        &connection_id,
        &sql,
        RunOptions { mode, persist: true, setup_sql: None, read_only: false },
    )
    .await
}
