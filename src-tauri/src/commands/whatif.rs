use tauri::State;
use tauri::ipc::Channel;

use crate::error::AppResult;
use crate::model::{AnalysisResult, WhatIfEvent};
use crate::services::{analysis, whatif};
use crate::state::AppState;

/// Start a what-if sweep for an analysis; events (and the final report) arrive on
/// `on_event`. Returns a request id for `cancel_task`.
#[tauri::command]
pub async fn run_whatif(
    state: State<'_, AppState>,
    analysis_id: String,
    on_event: Channel<WhatIfEvent>,
) -> AppResult<String> {
    let baseline = state.find_analysis(&analysis_id)?;
    let request_id = uuid::Uuid::new_v4().to_string();
    let store = state.store.clone();
    let scratch = state.scratch.clone();
    let task = tokio::spawn(async move {
        let emit = |e: WhatIfEvent| {
            let _ = on_event.send(e);
        };
        let event = match whatif::sweep(&store, &scratch, &baseline, &emit).await {
            Ok(report) => WhatIfEvent::Done { report },
            Err(e) => WhatIfEvent::Error { message: e.message },
        };
        emit(event);
    });
    state.track_task(request_id.clone(), task.abort_handle());
    Ok(request_id)
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
