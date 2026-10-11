//! Application logic, independent of Tauri so it can be reused by the MCP server,
//! the CLI, and exercised in tests.

pub mod analysis;
pub mod index_test;
pub mod sensitivity;
pub mod suggestions;
pub mod target;
