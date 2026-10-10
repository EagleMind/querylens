use tauri::State;

use crate::error::AppResult;
use crate::model::{AnalysisResult, PlanDiff};
use crate::plan;
use crate::services::analysis;
use crate::state::AppState;

/// Compare two analyses (from history or the unsaved scratch area).
#[tauri::command]
pub async fn compare_analyses(state: State<'_, AppState>, before_id: String, after_id: String) -> AppResult<PlanDiff> {
    let before = state.find_analysis(&before_id)?;
    let after = state.find_analysis(&after_id)?;
    Ok(plan::diff::diff(&before, &after))
}

/// Re-run an analysis with a suggested fix applied (rolled back). The result is kept in
/// the scratch store so it can be compared against the original.
#[tauri::command]
pub async fn preview_fix(state: State<'_, AppState>, analysis_id: String, fix: String) -> AppResult<AnalysisResult> {
    let baseline = state.find_analysis(&analysis_id)?;
    let result = analysis::preview_fix(&state.store, &baseline, &fix).await?;
    state.scratch.remember(result.clone());
    Ok(result)
}
