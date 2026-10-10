//! Minimal MCP server (JSON-RPC 2.0 over stdio) used by the Claude Code provider.
//!
//! Launched as `querylens --mcp --connection <id>` by Claude Code itself. It is scoped
//! to that one connection and exposes read-only, rolled-back EXPLAIN tooling only.
//! stdout carries protocol messages exclusively; diagnostics go to stderr.

use std::io::{BufRead, Write};

use serde_json::{Value, json};

use crate::error::{AppError, AppResult};
use crate::model::ExplainMode;
use crate::services::analysis::{self, RunOptions};
use crate::storage::Store;
use crate::{engines, llm::prompt, paths};

const PROTOCOL_VERSION: &str = "2025-06-18";

/// Entry point from `main`. Returns the process exit code.
pub fn run_from_args(args: &[String]) -> i32 {
    let connection_id = args
        .iter()
        .position(|a| a == "--connection")
        .and_then(|i| args.get(i + 1))
        .cloned();
    let Some(connection_id) = connection_id else {
        eprintln!("usage: querylens --mcp --connection <connection-id>");
        return 2;
    };
    let store = match paths::db_path().and_then(|p| Store::open(&p)) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("querylens mcp: cannot open store: {e}");
            return 1;
        }
    };
    let runtime = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
        Ok(r) => r,
        Err(e) => {
            eprintln!("querylens mcp: {e}");
            return 1;
        }
    };
    let server = Server { store, connection_id };

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
    0
}

struct Server {
    store: Store,
    connection_id: String,
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
            })),
            "ping" => Ok(json!({})),
            "tools/list" => Ok(json!({ "tools": tool_definitions() })),
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
        let outcome = match name {
            "explain_query" => self.explain_query(&args).await,
            "table_info" => self.table_info(&args).await,
            "test_index" => self.test_index(&args).await,
            other => Err(AppError::validation(format!("Unknown tool: {other}"))),
        };
        match outcome {
            Ok(text) => json!({ "content": [{ "type": "text", "text": text }] }),
            Err(e) => json!({ "content": [{ "type": "text", "text": format!("Error: {}", e.message) }], "isError": true }),
        }
    }

    async fn explain_query(&self, args: &Value) -> AppResult<String> {
        let sql = args
            .get("sql")
            .and_then(Value::as_str)
            .ok_or_else(|| AppError::validation("`sql` is required"))?;
        let analyze = args.get("analyze").and_then(Value::as_bool).unwrap_or(true);
        // A single statement, or several (e.g. CREATE STATISTICS + ANALYZE).
        let setup: Vec<String> = match args.get("setup_sql") {
            Some(Value::String(s)) if !s.trim().is_empty() => vec![s.clone()],
            Some(Value::Array(items)) => items.iter().filter_map(Value::as_str).map(String::from).collect(),
            _ => Vec::new(),
        };
        let mode = if analyze { ExplainMode::Analyze } else { ExplainMode::Estimate };
        let runs = self.store.get_settings()?.analysis.repeat_runs;
        let result = analysis::run(
            &self.store,
            &self.connection_id,
            sql,
            RunOptions { setup: setup.clone(), read_only: true, runs, ..RunOptions::new(mode) },
        )
        .await?;

        let mut out = String::new();
        if !setup.is_empty() {
            out.push_str(&format!("(setup, rolled back afterwards: {})\n", setup.join("; ")));
        }
        match (&result.timing, result.execution_time_ms) {
            (Some(t), _) => out.push_str(&format!(
                "Execution time: median {} over {} runs (first run {}, range {}–{})\n",
                prompt::fmt_ms(t.median_ms),
                t.execution_ms.len(),
                prompt::fmt_ms(t.first_ms),
                prompt::fmt_ms(t.min_ms),
                prompt::fmt_ms(t.max_ms)
            )),
            (None, Some(ms)) => out.push_str(&format!("Execution time: {}\n", prompt::fmt_ms(ms))),
            (None, None) => out.push_str("Estimate only (not executed)\n"),
        }
        if let Some(c) = result.total_cost {
            out.push_str(&format!("Total estimated cost: {c:.0}\n"));
        }
        out.push_str(&prompt::compact_plan(&result.root));
        Ok(out)
    }

    /// Compare the plan with and without candidate indexes. Uses HypoPG hypothetical
    /// indexes when installed (instant, no locks: an *estimate*); otherwise builds them
    /// inside the rolled-back transaction and profiles (*measured*).
    async fn test_index(&self, args: &Value) -> AppResult<String> {
        let sql = args.get("sql").and_then(Value::as_str).ok_or_else(|| AppError::validation("`sql` is required"))?;
        let indexes: Vec<String> = match args.get("indexes") {
            Some(Value::String(s)) => vec![s.clone()],
            Some(Value::Array(items)) => items.iter().filter_map(Value::as_str).map(String::from).collect(),
            _ => Vec::new(),
        };
        if indexes.is_empty() {
            return Err(AppError::validation("`indexes` must list at least one CREATE INDEX statement"));
        }
        for ddl in &indexes {
            let lower = ddl.trim().to_ascii_lowercase();
            if !(lower.starts_with("create index") || lower.starts_with("create unique index")) {
                return Err(AppError::validation("`indexes` may only contain CREATE [UNIQUE] INDEX statements"));
            }
        }
        let conn = self.store.get_connection(&self.connection_id)?;
        let spec = analysis::spec_for(&conn)?;
        let limits = analysis::Limits::from_settings(&self.store.get_settings()?.analysis);
        let runs = self.store.get_settings()?.analysis.repeat_runs;

        // Detect HypoPG with a cheap estimate (also the "before" for the estimate path).
        let before_est = analysis::explain(&conn, &spec, sql, &RunOptions { read_only: true, ..RunOptions::new(ExplainMode::Estimate) }, limits).await?;
        let mut out = String::new();
        if before_est.server.hypopg {
            let opts = RunOptions { hypothetical: indexes.clone(), read_only: true, ..RunOptions::new(ExplainMode::Estimate) };
            let after = analysis::explain(&conn, &spec, sql, &opts, limits).await?;
            let mut used = Vec::new();
            crate::plan::walk(&after.root, &mut |n| {
                if let Some(i) = n.index_name.as_deref().filter(|i| i.contains('<')) {
                    used.push(format!("{} on {}", i, n.relation.as_deref().unwrap_or("?")));
                }
            });
            out.push_str("EVIDENCE: estimated (HypoPG hypothetical index; planner cost only, nothing was executed)\n");
            out.push_str(&format!(
                "Total estimated cost: {:.0} → {:.0}\n",
                before_est.total_cost.unwrap_or(0.0),
                after.total_cost.unwrap_or(0.0)
            ));
            if used.is_empty() {
                out.push_str("The planner does NOT use the hypothetical index(es) for this query.\n");
            } else {
                out.push_str(&format!("The planner uses: {}\n", used.join(", ")));
            }
            out.push_str("Plan with the index:\n");
            out.push_str(&prompt::compact_plan(&after.root));
        } else {
            let profile = |setup: Vec<String>| RunOptions { setup, read_only: true, runs, ..RunOptions::new(ExplainMode::Analyze) };
            let before = analysis::explain(&conn, &spec, sql, &profile(vec![]), limits).await?;
            let after = analysis::explain(&conn, &spec, sql, &profile(indexes.clone()), limits).await?;
            let ms = |a: &crate::model::AnalysisResult| a.timing.as_ref().map(|t| t.median_ms).or(a.execution_time_ms).unwrap_or(0.0);
            out.push_str("EVIDENCE: measured (index built inside a rolled-back transaction, query executed)\n");
            out.push_str(&format!("Execution time (median): {} → {}\n", prompt::fmt_ms(ms(&before)), prompt::fmt_ms(ms(&after))));
            out.push_str("Plan with the index:\n");
            out.push_str(&prompt::compact_plan(&after.root));
        }
        Ok(out)
    }

    async fn table_info(&self, args: &Value) -> AppResult<String> {
        let table = args
            .get("table")
            .and_then(Value::as_str)
            .ok_or_else(|| AppError::validation("`table` is required"))?;
        let conn = self.store.get_connection(&self.connection_id)?;
        let mut session = engines::open(&analysis::spec_for(&conn)?).await?;
        let tables = session.table_context(&[table.to_string()]).await?;
        Ok(match tables.first() {
            Some(t) => prompt::table_summary(t, None),
            None => format!("Table {table} not found."),
        })
    }
}

fn tool_definitions() -> Value {
    json!([
        {
            "name": "explain_query",
            "description": "Run EXPLAIN on a SQL query against the user's database, inside a \
                transaction that is always rolled back (read-only after setup). Returns \
                execution time and the annotated plan tree. Use it to measure a rewrite, or \
                pass setup_sql to measure the effect of a candidate index or setting.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "sql": { "type": "string", "description": "A single SELECT (or other explainable) statement." },
                    "analyze": { "type": "boolean", "description": "Execute for real timings (default true). false = planner estimate only." },
                    "setup_sql": { "description": "Optional statement(s) run first in the same rolled-back transaction (PostgreSQL only): CREATE [UNIQUE] INDEX, CREATE STATISTICS, SET or ANALYZE. A string or an array of strings.", "anyOf": [ { "type": "string" }, { "type": "array", "items": { "type": "string" } } ] }
                },
                "required": ["sql"]
            }
        },
        {
            "name": "test_index",
            "description": "Test candidate indexes for a query. With HypoPG installed it plans with hypothetical \
                indexes: instant and lock-free, but an estimate. Otherwise it builds them inside a rolled-back \
                transaction and measures. The output starts with an EVIDENCE line saying which.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "sql": { "type": "string", "description": "The query to plan." },
                    "indexes": { "type": "array", "items": { "type": "string" }, "description": "CREATE [UNIQUE] INDEX statements to test together." }
                },
                "required": ["sql", "indexes"]
            }
        },
        {
            "name": "table_info",
            "description": "Columns, indexes, row estimate, size and statistics freshness for a table.",
            "inputSchema": {
                "type": "object",
                "properties": { "table": { "type": "string", "description": "Table name, optionally schema-qualified." } },
                "required": ["table"]
            }
        }
    ])
}
