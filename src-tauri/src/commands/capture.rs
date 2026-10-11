use tauri::State;

use crate::capture::ingest::collector;
use crate::capture::{PlanDepth, ReportOptions, StartOptions, report};
use crate::error::{AppError, AppResult};
use crate::model::{CaptureLive, CaptureReport, CaptureSource, CaptureSummary, CapturedStatement};
use crate::services::target::Target;
use crate::state::AppState;

/// Start recording for a saved PostgreSQL connection: SDK events on the default
/// collector port (where apps with querylens-node report by themselves), and a proxy
/// for apps without it.
#[tauri::command]
pub async fn start_capture(
    state: State<'_, AppState>,
    connection_id: String,
    port: Option<u16>,
    name: Option<String>,
) -> AppResult<CaptureLive> {
    let target = Target::saved(&state.store, &connection_id)?;
    let opts = StartOptions {
        name,
        source: CaptureSource::App,
        collector: Some(([127, 0, 0, 1], collector::DEFAULT_PORT).into()),
        spool: None,
        proxy: Some(([127, 0, 0, 1], port.unwrap_or(6543)).into()),
        collector_fallback: true,
    };
    state.captures.start(state.store.clone(), Some(&target), opts).await
}

/// Stop a running capture and analyze it (plans checked on its connection).
#[tauri::command]
pub async fn stop_capture(state: State<'_, AppState>, id: String) -> AppResult<CaptureReport> {
    let summary = state.captures.stop(&id, &state.store).await?;
    build_report(&state, &summary, false).await
}

#[tauri::command]
pub async fn running_captures(state: State<'_, AppState>) -> AppResult<Vec<CaptureLive>> {
    Ok(state.captures.running().await)
}

#[tauri::command]
pub async fn capture_live(state: State<'_, AppState>, id: String) -> AppResult<Option<CaptureLive>> {
    Ok(state.captures.live(&id).await)
}

#[tauri::command]
pub async fn list_captures(state: State<'_, AppState>) -> AppResult<Vec<CaptureSummary>> {
    state.store.list_captures(30)
}

/// The stored report; rebuilt when missing or when `profile` asks for measured plans.
#[tauri::command]
pub async fn capture_report(state: State<'_, AppState>, id: String, profile: Option<bool>) -> AppResult<CaptureReport> {
    let profile = profile.unwrap_or(false);
    if !profile && let Some(r) = state.store.capture_report(&id)? {
        return Ok(r);
    }
    let summary = state.store.get_capture(&id)?;
    if summary.stopped_at.is_none() {
        return Err(AppError::validation("This capture is still running. Stop it to see the report."));
    }
    build_report(&state, &summary, profile).await
}

async fn build_report(state: &AppState, summary: &CaptureSummary, profile: bool) -> AppResult<CaptureReport> {
    // Re-plan on the capture's connection when it still exists.
    let target = summary.connection_id.as_deref().and_then(|id| Target::saved(&state.store, id).ok());
    let opts = ReportOptions { plans: if profile { PlanDepth::Profile } else { PlanDepth::Explain }, ..ReportOptions::default() };
    report::build(&state.store, &summary.id, target.as_ref(), &opts).await
}

/// Executions of one statement, slowest first.
#[tauri::command]
pub async fn capture_executions(
    state: State<'_, AppState>,
    id: String,
    fingerprint: String,
    limit: Option<u32>,
) -> AppResult<Vec<CapturedStatement>> {
    let mut rows: Vec<CapturedStatement> =
        state.store.captured_statements(&id)?.into_iter().filter(|s| s.fingerprint == fingerprint).collect();
    rows.sort_by(|a, b| b.duration_ms.total_cmp(&a.duration_ms));
    rows.truncate(limit.unwrap_or(100) as usize);
    Ok(rows)
}

#[tauri::command]
pub async fn delete_capture(state: State<'_, AppState>, id: String) -> AppResult<()> {
    if state.captures.live(&id).await.is_some() {
        state.captures.stop(&id, &state.store).await?;
    }
    state.store.delete_capture(&id)
}
