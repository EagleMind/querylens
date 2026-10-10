//! End-to-end: real Postgres → analysis → Claude Code CLI → QueryLens MCP tools → suggestions.
//!
//! Skipped unless both are set (dev Postgres from dev/docker-compose.yml uses trust auth):
//!   QUERYLENS_PG_PORT=54329 QUERYLENS_CLAUDE_PATH=/path/to/claude \
//!     cargo test --test live_claude -- --nocapture
//! Optional: QUERYLENS_CLAUDE_MODEL (default "sonnet").

use std::sync::Mutex;

use querylens_lib::llm::EventSink;
use querylens_lib::model::*;
use querylens_lib::paths;
use querylens_lib::services::{analysis, suggestions};
use querylens_lib::storage::Store;

#[derive(Default)]
struct Collect(Mutex<Vec<SuggestionEvent>>);

impl EventSink for Collect {
    fn emit(&self, event: SuggestionEvent) {
        if let SuggestionEvent::Activity { label, detail } = &event {
            println!("· {label}{}", detail.as_deref().map(|d| format!("\n    {}", d.replace('\n', "\n    "))).unwrap_or_default());
        }
        self.0.lock().unwrap().push(event);
    }
}

#[tokio::test]
async fn claude_suggests_and_verifies_with_mcp() {
    let (Ok(port), Ok(claude)) = (std::env::var("QUERYLENS_PG_PORT"), std::env::var("QUERYLENS_CLAUDE_PATH")) else {
        return;
    };
    let dir = std::env::temp_dir().join(format!("querylens-it-{}", uuid::Uuid::new_v4()));
    // SAFETY: single-threaded test setup, before any other thread reads the env.
    unsafe {
        std::env::set_var(paths::DATA_DIR_ENV, &dir);
        std::env::set_var("QUERYLENS_MCP_EXE", env!("CARGO_BIN_EXE_querylens"));
    }
    let store = Store::open(&paths::db_path().unwrap()).unwrap();

    let input = ConnectionInput {
        id: None,
        name: "dev-shop".into(),
        engine: Engine::Postgres,
        color: "#2dd4bf".into(),
        host: Some("localhost".into()),
        port: Some(port.parse().unwrap()),
        database: Some("shop".into()),
        username: Some("querylens".into()),
        ssl_mode: SslMode::Disable,
        file_path: None,
        password: None,
    };
    store.upsert_connection("it-conn", &input, false).unwrap();

    let mut settings = store.get_settings().unwrap();
    settings.llm.provider = LlmProviderKind::ClaudeCode;
    settings.llm.claude_path = claude;
    settings.llm.model = std::env::var("QUERYLENS_CLAUDE_MODEL").unwrap_or_else(|_| "sonnet".into());
    settings.llm.verify_with_tools = true;
    store.save_settings(&settings).unwrap();

    let sql = "SELECT * FROM orders WHERE user_id = 4242 ORDER BY created_at DESC LIMIT 10";
    let opts = analysis::RunOptions { mode: ExplainMode::Analyze, persist: true, setup_sql: None, read_only: false };
    let a = analysis::run(&store, "it-conn", sql, opts).await.unwrap();

    let sink = Collect::default();
    let set = suggestions::generate(&store, &a.id, &sink).await.unwrap();
    println!("\nSUMMARY: {}", set.summary);
    for s in &set.suggestions {
        println!("[{:?}{}] {} (node {:?})\n  {}\n  {:?}", s.severity, if s.verified { ", verified" } else { "" }, s.title, s.node_id, s.explanation, s.sql_fix);
    }

    assert!(!set.suggestions.is_empty());
    let events = sink.0.lock().unwrap();
    assert!(events.iter().any(|e| matches!(e, SuggestionEvent::Delta { .. })), "expected streamed text");
    // The stored analysis now carries the suggestions.
    assert!(store.get_analysis(&a.id).unwrap().suggestions.is_some());
    let _ = std::fs::remove_dir_all(&dir);
}
