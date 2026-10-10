//! QueryLens core. `run()` starts the desktop app; `mcp::run_from_args` starts the
//! stdio MCP server used by the Claude Code provider (same binary, `--mcp`).

pub mod commands;
pub mod engines;
pub mod error;
pub mod llm;
pub mod mcp;
pub mod model;
pub mod paths;
pub mod plan;
pub mod secrets;
pub mod services;
pub mod state;
pub mod storage;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default().level(log::LevelFilter::Info).build(),
                )?;
            }
            let store = storage::Store::open(&paths::db_path()?)?;
            app.manage(state::AppState::new(store));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::connections::list_connections,
            commands::connections::save_connection,
            commands::connections::delete_connection,
            commands::connections::test_connection,
            commands::analysis::analyze_query,
            commands::history::list_history,
            commands::history::get_analysis,
            commands::history::delete_analysis,
            commands::history::clear_history,
            commands::settings::get_settings,
            commands::settings::save_settings,
            commands::settings::list_llm_models,
            commands::settings::test_llm,
            commands::llm::get_suggestions,
            commands::llm::cancel_task,
            commands::compare::compare_analyses,
            commands::whatif::run_whatif,
            commands::whatif::preview_fix,
            commands::workload::top_queries,
            commands::workload::parameter_sensitivity,
        ])
        .run(tauri::generate_context!())
        .expect("error while running QueryLens");
}
