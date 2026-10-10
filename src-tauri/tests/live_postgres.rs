//! End-to-end checks against the dev Postgres from `dev/docker-compose.yml`.
//!
//! Skipped unless `QUERYLENS_PG_PORT` is set:
//!   QUERYLENS_PG_PORT=54329 cargo test --test live_postgres -- --nocapture
//! With `QUERYLENS_WRITE_FIXTURE=1` the analysis is also written to
//! `src/dev/fixtures/` for the browser-only mock backend.

use querylens_lib::engines::ConnectSpec;
use querylens_lib::model::{Connection, Engine, ExplainMode, SslMode, WarningKind};
use querylens_lib::plan;
use querylens_lib::services::analysis::{RunOptions, explain};

const SLOW_QUERY: &str = "SELECT u.email, count(*) AS orders, sum(o.total) AS spent
FROM orders o
JOIN users u ON u.id = o.user_id
WHERE o.status = 'paid' AND u.country = 'TN'
GROUP BY u.email
ORDER BY spent DESC
LIMIT 20";

fn setup() -> Option<(Connection, ConnectSpec)> {
    let port: u16 = std::env::var("QUERYLENS_PG_PORT").ok()?.parse().ok()?;
    let conn = Connection {
        id: "live".into(),
        name: "dev-shop".into(),
        engine: Engine::Postgres,
        color: "#2dd4bf".into(),
        host: Some("localhost".into()),
        port: Some(port),
        database: Some("shop".into()),
        username: Some("querylens".into()),
        ssl_mode: SslMode::Disable,
        file_path: None,
        has_password: true,
        created_at: String::new(),
        last_used_at: None,
    };
    let spec = ConnectSpec {
        engine: Engine::Postgres,
        host: conn.host.clone(),
        port: conn.port,
        database: conn.database.clone(),
        username: conn.username.clone(),
        password: Some("querylens".into()),
        ssl_mode: SslMode::Disable,
        file_path: None,
    };
    Some((conn, spec))
}

/// All operator names in the plan, e.g. "Gather > Parallel Seq Scan".
fn shape(root: &querylens_lib::model::PlanNode) -> String {
    let mut names = Vec::new();
    plan::walk(root, &mut |n| names.push(n.node_type.clone()));
    names.join(" > ")
}

fn opts(mode: ExplainMode) -> RunOptions {
    RunOptions { mode, persist: false, setup_sql: None, read_only: false }
}

#[tokio::test]
async fn analyzes_slow_join_and_finds_missing_index() {
    let Some((conn, spec)) = setup() else { return };
    let a = explain(&conn, &spec, SLOW_QUERY, &opts(ExplainMode::Analyze), 60_000).await.unwrap();

    assert!(a.execution_time_ms.unwrap() > 0.0);
    let mut kinds = Vec::new();
    plan::walk(&a.root, &mut |n| kinds.extend(n.warnings.iter().map(|w| w.kind)));
    println!("{}", querylens_lib::llm::prompt::user(&a));
    assert!(kinds.contains(&WarningKind::MissingIndex) || kinds.contains(&WarningKind::SeqScanLarge));
    let orders = a.tables.iter().find(|t| t.name == "orders").expect("table context for orders");
    assert!(orders.indexes.iter().any(|i| i.name == "orders_pkey"));

    if std::env::var("QUERYLENS_WRITE_FIXTURE").is_ok() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/dev/fixtures");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("postgres-analysis.json"), serde_json::to_string_pretty(&a).unwrap()).unwrap();
    }
}

#[tokio::test]
async fn dml_is_rolled_back() {
    let Some((conn, spec)) = setup() else { return };
    let sql = "UPDATE users SET country = 'XX' WHERE id = 1";
    explain(&conn, &spec, sql, &opts(ExplainMode::Analyze), 60_000).await.unwrap();
    let check = "SELECT * FROM users WHERE id = 1 AND country = 'XX'";
    let a = explain(&conn, &spec, check, &opts(ExplainMode::Analyze), 60_000).await.unwrap();
    assert_eq!(a.root.actual_rows, Some(0.0), "the UPDATE must have been rolled back");
}

#[tokio::test]
async fn read_only_blocks_model_writes_and_setup_index_is_measured() {
    let Some((conn, spec)) = setup() else { return };
    let mut ro = opts(ExplainMode::Analyze);
    ro.read_only = true;
    let err = explain(&conn, &spec, "DELETE FROM users WHERE id = 1", &ro, 60_000).await.unwrap_err();
    assert!(err.message.contains("read-only"), "{}", err.message);

    let lookup = "SELECT * FROM orders WHERE user_id = 4242";
    let before = explain(&conn, &spec, lookup, &ro, 60_000).await.unwrap();
    ro.setup_sql = Some("CREATE INDEX CONCURRENTLY ON orders (user_id)".into());
    let after = explain(&conn, &spec, lookup, &ro, 60_000).await.unwrap();
    println!("before {:?} ms, after {:?} ms", before.execution_time_ms, after.execution_time_ms);
    assert!(shape(&after.root).contains("Index"), "got {}", shape(&after.root));
    // …and the index must not exist afterwards.
    let again = explain(&conn, &spec, lookup, &opts(ExplainMode::Estimate), 60_000).await.unwrap();
    assert!(!shape(&again.root).contains("Index"), "index leaked: {}", shape(&again.root));
}

#[tokio::test]
async fn multiple_statements_are_rejected() {
    let Some((conn, spec)) = setup() else { return };
    let err = explain(&conn, &spec, "SELECT 1; DROP TABLE users", &opts(ExplainMode::Analyze), 60_000)
        .await
        .unwrap_err();
    assert!(err.message.to_lowercase().contains("single statement") || err.message.contains("syntax"), "{}", err.message);
}
