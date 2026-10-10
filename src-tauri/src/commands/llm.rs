use tauri::State;
use tauri::ipc::Channel;

use crate::error::AppResult;
use crate::llm::EventSink;
use crate::model::SuggestionEvent;
use crate::services::suggestions;
use crate::state::AppState;

struct ChannelSink(Channel<SuggestionEvent>);

impl EventSink for ChannelSink {
    fn emit(&self, event: SuggestionEvent) {
        // The webview may have navigated away; nothing useful to do on failure.
        let _ = self.0.send(event);
    }
}

/// Starts generation in the background and returns a request id for cancellation.
/// Progress, the final result and errors all arrive on `on_event`.
#[tauri::command]
pub async fn get_suggestions(
    state: State<'_, AppState>,
    analysis_id: String,
    on_event: Channel<SuggestionEvent>,
) -> AppResult<String> {
    let request_id = uuid::Uuid::new_v4().to_string();
    let store = state.store.clone();
    let sink = ChannelSink(on_event);

    let task = tokio::spawn(async move {
        let event = match suggestions::generate(&store, &analysis_id, &sink).await {
            Ok(result) => SuggestionEvent::Done { result },
            Err(e) => SuggestionEvent::Error { message: e.message },
        };
        sink.emit(event);
    });

    state.track_task(request_id.clone(), task.abort_handle());
    Ok(request_id)
}

/// Cancel any background job (suggestions, what-if sweep, sensitivity). Aborting drops
/// in-flight HTTP streams / kills the `claude` child process / abandons DB work.
#[tauri::command]
pub async fn cancel_task(state: State<'_, AppState>, request_id: String) -> AppResult<()> {
    state.cancel_task(&request_id);
    Ok(())
}
