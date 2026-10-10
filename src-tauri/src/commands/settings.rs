use tauri::State;

use crate::error::{AppError, AppResult};
use crate::llm;
use crate::model::{LlmSettings, LlmTestResult, Settings};
use crate::secrets;
use crate::services::suggestions;
use crate::state::AppState;

#[tauri::command]
pub async fn get_settings(state: State<'_, AppState>) -> AppResult<Settings> {
    let mut settings = state.store.get_settings()?;
    settings.llm = suggestions::llm_settings(&state.store)?;
    Ok(settings)
}

/// `api_key`: `null` keeps the stored key, `""` removes it, otherwise replaces it.
#[tauri::command]
pub async fn save_settings(
    state: State<'_, AppState>,
    settings: Settings,
    api_key: Option<String>,
) -> AppResult<Settings> {
    if !(0.0..=2.0).contains(&settings.llm.temperature) {
        return Err(AppError::validation("Temperature must be between 0 and 2."));
    }
    if !(1_000..=600_000).contains(&settings.analysis.statement_timeout_ms) {
        return Err(AppError::validation("Statement timeout must be between 1 and 600 seconds."));
    }
    if !(1..=10).contains(&settings.analysis.repeat_runs) {
        return Err(AppError::validation("Profile runs must be between 1 and 10."));
    }
    if !(1_000..=60_000).contains(&settings.analysis.lock_timeout_ms) {
        return Err(AppError::validation("Lock timeout must be between 1 and 60 seconds."));
    }
    if let Some(key) = api_key {
        secrets::set(&secrets::llm_account(settings.llm.provider), key.trim())?;
    }
    state.store.save_settings(&settings)?;
    get_settings(state).await
}

/// Models offered by the provider described by `llm` (unsaved form values are fine).
#[tauri::command]
pub async fn list_llm_models(llm: LlmSettings) -> AppResult<Vec<String>> {
    llm::list_models(&llm).await
}

#[tauri::command]
pub async fn test_llm(state: State<'_, AppState>) -> AppResult<LlmTestResult> {
    suggestions::test(&state.store).await
}
