//! MCP server (JSON-RPC 2.0 over stdio) giving coding agents QueryLens's tools.
//!
//! Two ways in:
//! - `querylens mcp [--connection URL|NAME]`: for agents like Claude Code working on
//!   an application. Query tools plus capture tools (record the app's traffic,
//!   read the findings, compare before/after a fix).
//! - `querylens --mcp --connection <id>`: launched by QueryLens's own advisor,
//!   scoped to read-only, rolled-back query tools.
//!
//! stdout carries protocol messages exclusively; diagnostics go to stderr.

mod capture_tools;
mod query_tools;
mod tools;

use std::io::{BufRead, Write};
use std::sync::Arc;

use serde_json::{Value, json};

use crate::capture::CaptureRegistry;
use crate::error::{AppError, AppResult};
use crate::services::target::Target;
use crate::storage::Store;
use crate::paths;

const PROTOCOL_VERSION: &str = "2025-06-18";

/// Legacy entry point: `querylens --mcp --connection <connection-id>`.
pub fn run_from_args(args: &[String]) -> i32 {
    let connection_id = args.iter().position(|a| a == "--connection").and_then(|i| args.get(i + 1)).cloned();
    let Some(connection_id) = connection_id else {
        eprintln!("usage: querylens --mcp --connection <connection-id>");
        return 2;
    };
    let store = match paths::db_path().and_then(|p| Store::open(&p)) {
        Ok(s) => Arc::new(s),
        Err(e) => {
            eprintln!("querylens mcp: cannot open store: {e}");
            return 1;
        }
    };
    match Target::saved(&store, &connection_id) {
        Ok(target) => serve_with(Server { store, target, captures: None }),
        Err(e) => {
            eprintln!("querylens mcp: {e}");
            1
        }
    }
}

/// `querylens mcp`: query and capture tools on `target`.
pub fn serve(store: Arc<Store>, target: Target) -> i32 {
    serve_with(Server { store, target, captures: Some(CaptureRegistry::default()) })
}

fn serve_with(server: Server) -> i32 {
    let runtime = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
        Ok(r) => r,
        Err(e) => {
            eprintln!("querylens mcp: {e}");
            return 1;
        }
    };
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let response = match serde_json::from_str::<Value>(&line) {
            Ok(msg) => runtime.block_on(server.handle(msg)),
            Err(e) => Some(error_response(Value::Null, -32700, &format!("Parse error: {e}"))),
        };
        if let Some(resp) = response {
            if writeln!(stdout, "{resp}").and_then(|_| stdout.flush()).is_err() {
                break;
            }
        }
    }
    // The agent went away: don't leave proxies running.
    runtime.block_on(server.stop_captures());
    0
}

pub(crate) struct Server {
    store: Arc<Store>,
    target: Target,
    /// `None` in advisor mode: no capture tools.
    captures: Option<CaptureRegistry>,
}

fn error_response(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

impl Server {
    /// `None` for notifications (no `id`), which get no response.
    async fn handle(&self, msg: Value) -> Option<Value> {
        let id = msg.get("id").cloned()?;
        let method = msg.get("method").and_then(Value::as_str).unwrap_or_default();
        let params = msg.get("params").cloned().unwrap_or(Value::Null);
        let result = match method {
            "initialize" => Ok(json!({
                "protocolVersion": params.get("protocolVersion").and_then(Value::as_str).unwrap_or(PROTOCOL_VERSION),
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "querylens", "version": env!("CARGO_PKG_VERSION") },
                "instructions": tools::instructions(self.captures.is_some()),
            })),
            "ping" => Ok(json!({})),
            "tools/list" => Ok(json!({ "tools": tools::definitions(self.target.conn.engine, self.captures.is_some()) })),
            "tools/call" => Ok(self.call_tool(&params).await),
            _ => return Some(error_response(id, -32601, &format!("Method not found: {method}"))),
        };
        Some(match result {
            Ok(r) => json!({ "jsonrpc": "2.0", "id": id, "result": r }),
            Err::<Value, AppError>(e) => error_response(id, -32603, &e.message),
        })
    }

    async fn call_tool(&self, params: &Value) -> Value {
        let name = params.get("name").and_then(Value::as_str).unwrap_or_default();
        let args = params.get("arguments").cloned().unwrap_or(Value::Null);
        let outcome = match (name, &self.captures) {
            ("explain_query", _) => self.explain_query(&args).await,
            ("table_info", _) => self.table_info(&args).await,
            ("test_index", _) => self.test_index(&args).await,
            ("capture_start", Some(reg)) => self.capture_start(reg, &args).await,
            ("capture_stop", Some(reg)) => self.capture_stop(reg, &args).await,
            ("capture_report", Some(_)) => self.capture_report(&args).await,
            ("capture_statement", Some(_)) => self.capture_statement(&args).await,
            ("compare_captures", Some(_)) => self.compare_captures(&args).await,
            ("list_captures", Some(_)) => self.list_captures(),
            (other, _) => Err(AppError::validation(format!("Unknown tool: {other}"))),
        };
        match outcome {
            Ok(text) => json!({ "content": [{ "type": "text", "text": text }] }),
            Err(e) => json!({ "content": [{ "type": "text", "text": format!("Error: {}", e.message) }], "isError": true }),
        }
    }

    async fn stop_captures(&self) {
        if let Some(reg) = &self.captures {
            for id in reg.running_ids().await {
                if let Err(e) = reg.stop(&id, &self.store).await {
                    eprintln!("querylens mcp: stopping capture {id}: {e}");
                }
            }
        }
    }
}

/// A required string argument.
fn arg_str<'a>(args: &'a Value, key: &str) -> AppResult<&'a str> {
    args.get(key).and_then(Value::as_str).ok_or_else(|| AppError::validation(format!("`{key}` is required")))
}

/// A string, or an array of strings.
fn arg_list(args: &Value, key: &str) -> Vec<String> {
    match args.get(key) {
        Some(Value::String(s)) if !s.trim().is_empty() => vec![s.clone()],
        Some(Value::Array(items)) => items.iter().filter_map(Value::as_str).map(String::from).collect(),
        _ => Vec::new(),
    }
}
