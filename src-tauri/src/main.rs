// Prevents an additional console window on Windows in release. DO NOT REMOVE.
#![cfg_attr(all(not(debug_assertions), feature = "gui"), windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if let Some(code) = querylens_lib::cli::main(&args) {
        std::process::exit(code);
    }
    #[cfg(feature = "gui")]
    querylens_lib::run();
}
