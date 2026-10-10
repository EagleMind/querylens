use tauri::State;

use crate::engines;
use crate::error::{AppError, AppResult};
use crate::model::{Connection, ConnectionInput, ConnectionTestResult, Engine};
use crate::secrets;
use crate::services::analysis::spec_for_input;
use crate::state::AppState;

fn validate(input: &ConnectionInput) -> AppResult<()> {
    if input.name.trim().is_empty() {
        return Err(AppError::validation("Give the connection a name."));
    }
    match input.engine {
        e if e.is_server() && input.host.as_deref().is_none_or(|h| h.trim().is_empty()) => {
            Err(AppError::validation(format!("Host is required for {}.", e.label())))
        }
        Engine::Duckdb if input.file_path.as_deref().is_none_or(|p| p.trim().is_empty()) => {
            Err(AppError::validation("Choose a DuckDB file, or use :memory:."))
        }
        _ => Ok(()),
    }
}

#[tauri::command]
pub async fn list_connections(state: State<'_, AppState>) -> AppResult<Vec<Connection>> {
    state.store.list_connections()
}

#[tauri::command]
pub async fn save_connection(state: State<'_, AppState>, input: ConnectionInput) -> AppResult<Connection> {
    validate(&input)?;
    let id = input.id.clone().unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let account = secrets::connection_account(&id);
    let has_password = match (input.engine, input.password.as_deref()) {
        (Engine::Duckdb, _) => {
            secrets::delete(&account)?;
            false
        }
        // Not provided: keep whatever is stored.
        (_, None) => state.store.get_connection(&id).is_ok_and(|c| c.has_password),
        (_, Some(pw)) => {
            secrets::set(&account, pw)?;
            !pw.is_empty()
        }
    };
    state.store.upsert_connection(&id, &input, has_password)
}

#[tauri::command]
pub async fn delete_connection(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.store.delete_connection(&id)?;
    secrets::delete(&secrets::connection_account(&id))
}

#[tauri::command]
pub async fn test_connection(input: ConnectionInput) -> AppResult<ConnectionTestResult> {
    validate(&input)?;
    let mut session = engines::open(&spec_for_input(&input)?).await?;
    session.test().await
}
