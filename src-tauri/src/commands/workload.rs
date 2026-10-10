use tauri::State;

use crate::engines;
use crate::error::AppResult;
use crate::model::{SensitivityReport, TopQuery, TopQueryOrder};
use crate::services::{analysis, sensitivity};
use crate::state::AppState;

/// Most expensive statements on a connection (pg_stat_statements).
#[tauri::command]
pub async fn top_queries(
    state: State<'_, AppState>,
    connection_id: String,
    order_by: TopQueryOrder,
    limit: Option<u32>,
) -> AppResult<Vec<TopQuery>> {
    let conn = state.store.get_connection(&connection_id)?;
    let mut session = engines::open(&analysis::spec_for(&conn)?).await?;
    session.top_queries(order_by, limit.unwrap_or(50)).await
}

/// Plan a parameterized analysis with representative values for each parameter.
#[tauri::command]
pub async fn parameter_sensitivity(state: State<'_, AppState>, analysis_id: String) -> AppResult<Vec<SensitivityReport>> {
    let baseline = state.find_analysis(&analysis_id)?;
    sensitivity::sensitivity(&state.store, &baseline).await
}
