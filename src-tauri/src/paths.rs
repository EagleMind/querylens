//! Filesystem locations shared by GUI mode and `--mcp` mode.
//!
//! Deliberately not using Tauri's path resolver: the MCP server runs without an
//! `AppHandle`, and both modes must agree on where the database lives.

use std::path::PathBuf;

use crate::error::{AppError, AppResult};

/// Must match `identifier` in tauri.conf.json.
pub const APP_ID: &str = "dev.querylens.app";

pub fn data_dir() -> AppResult<PathBuf> {
    let dir = dirs::data_dir()
        .ok_or_else(|| AppError::internal("Could not determine the OS data directory"))?
        .join(APP_ID);
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

pub fn db_path() -> AppResult<PathBuf> {
    Ok(data_dir()?.join("querylens.db"))
}

/// Scratch space for per-request files (MCP configs, Claude working dir).
pub fn runtime_dir() -> AppResult<PathBuf> {
    let dir = data_dir()?.join("runtime");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}
