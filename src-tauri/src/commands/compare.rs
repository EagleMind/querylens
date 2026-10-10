use tauri::State;

use crate::error::AppResult;
use crate::model::PlanDiff;
use crate::plan;
use crate::state::AppState;

/// Compare two analyses (from history or the unsaved scratch area).
#[tauri::command]
pub async fn compare_analyses(state: State<'_, AppState>, before_id: String, after_id: String) -> AppResult<PlanDiff> {
    let before = state.find_analysis(&before_id)?;
    let after = state.find_analysis(&after_id)?;
    Ok(plan::diff::diff(&before, &after))
}
