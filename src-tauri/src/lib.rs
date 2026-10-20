//! QueryLens core. `run()` starts the desktop app (feature `gui`); `cli::main` runs
//! the command line (capture, check, report, mcp), which builds without the GUI.

pub mod capture;
pub mod cli;
#[cfg(feature = "gui")]
pub mod commands;
pub mod engines;
pub mod error;
pub use querylens_core::format;
pub mod llm;
pub mod mcp;
pub mod model;
pub mod paths;
pub mod plan;
pub mod secrets;
pub mod services;
pub mod state;
pub mod storage;

#[cfg(feature = "gui")]
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    use tauri::Manager;

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default().level(log::LevelFilter::Info).build(),
                )?;
            }
            let store = storage::Store::open(&paths::db_path()?)?;
            // Captures left "running" by a process that ended (app closed, CLI killed).
            store.close_abandoned_captures(&[])?;
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
            commands::compare::preview_fix,
            commands::workload::top_queries,
            commands::workload::parameter_sensitivity,
            commands::capture::start_capture,
            commands::capture::stop_capture,
            commands::capture::running_captures,
            commands::capture::capture_live,
            commands::capture::list_captures,
            commands::capture::capture_report,
            commands::capture::capture_executions,
            commands::capture::delete_capture,
        ])
        .run(tauri::generate_context!())
        .expect("error while running QueryLens");
}
