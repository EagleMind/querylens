//! Thin `#[tauri::command]` adapters: deserialize, call a service, map errors.

pub mod analysis;
pub mod compare;
pub mod connections;
pub mod history;
pub mod llm;
pub mod settings;
pub mod whatif;
