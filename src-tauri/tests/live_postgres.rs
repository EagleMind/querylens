//! End-to-end checks against the dev Postgres from `dev/docker-compose.yml`.
//!
//! Skipped unless `QUERYLENS_PG_PORT` is set:
//!   QUERYLENS_PG_PORT=54329 cargo test --test live_postgres -- --nocapture
//! With `QUERYLENS_WRITE_FIXTURE=1` the analysis is also written to
//! `src/dev/fixtures/` for the browser-only mock backend.

use querylens_lib::engines::ConnectSpec;
use querylens_lib::model::{Connection, Engine, ExplainMode, SslMode, WarningKind};
use querylens_lib::plan;
use querylens_lib::services::analysis::{Limits, RunOptions, explain};

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

const LIMITS: Limits = Limits { timeout_ms: 60_000, lock_timeout_ms: 2_000 };

fn opts(mode: ExplainMode) -> RunOptions {
    RunOptions::new(mode)
}

#[tokio::test]
async fn analyzes_slow_join_and_finds_missing_index() {
    let Some((conn, spec)) = setup() else { return };
    let profile = RunOptions { runs: 3, ..opts(ExplainMode::Analyze) };
    let a = explain(&conn, &spec, SLOW_QUERY, &profile, LIMITS).await.unwrap();

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
    explain(&conn, &spec, sql, &opts(ExplainMode::Analyze), LIMITS).await.unwrap();
    let check = "SELECT * FROM users WHERE id = 1 AND country = 'XX'";
    let a = explain(&conn, &spec, check, &opts(ExplainMode::Analyze), LIMITS).await.unwrap();
    assert_eq!(a.root.actual_rows, Some(0.0), "the UPDATE must have been rolled back");
}

#[tokio::test]
async fn read_only_blocks_model_writes_and_setup_index_is_measured() {
    let Some((conn, spec)) = setup() else { return };
    let mut ro = opts(ExplainMode::Analyze);
    ro.read_only = true;
    let err = explain(&conn, &spec, "DELETE FROM users WHERE id = 1", &ro, LIMITS).await.unwrap_err();
    assert!(err.message.contains("read-only"), "{}", err.message);

    let lookup = "SELECT * FROM orders WHERE user_id = 4242";
    let before = explain(&conn, &spec, lookup, &ro, LIMITS).await.unwrap();
    ro.setup = vec!["CREATE INDEX CONCURRENTLY ON orders (user_id)".into()];
    let after = explain(&conn, &spec, lookup, &ro, LIMITS).await.unwrap();
    println!("before {:?} ms, after {:?} ms", before.execution_time_ms, after.execution_time_ms);
    assert!(shape(&after.root).contains("Index"), "got {}", shape(&after.root));
    // …and the index must not exist afterwards.
    let again = explain(&conn, &spec, lookup, &opts(ExplainMode::Estimate), LIMITS).await.unwrap();
    assert!(!shape(&again.root).contains("Index"), "index leaked: {}", shape(&again.root));
}

#[tokio::test]
async fn multiple_statements_are_rejected() {
    let Some((conn, spec)) = setup() else { return };
    let err = explain(&conn, &spec, "SELECT 1; DROP TABLE users", &opts(ExplainMode::Analyze), LIMITS)
        .await
        .unwrap_err();
    assert!(err.message.to_lowercase().contains("single statement") || err.message.contains("syntax"), "{}", err.message);
}

async fn raw_client(port: u16) -> tokio_postgres::Client {
    let (client, conn) = tokio_postgres::connect(
        &format!("host=localhost port={port} dbname=shop user=querylens"),
        tokio_postgres::NoTls,
    )
    .await
    .unwrap();
    tokio::spawn(async move {
        let _ = conn.await;
    });
    client
}

#[tokio::test]
async fn detects_server_and_reports_io_time_and_repeat_runs() {
    let Some((conn, spec)) = setup() else { return };
    let repeated = RunOptions { runs: 3, ..opts(ExplainMode::Analyze) };
    let a = explain(&conn, &spec, SLOW_QUERY, &repeated, LIMITS).await.unwrap();
    assert!(a.server.version_num >= 170_000, "{:?}", a.server);
    assert!(a.server.hypopg && a.server.pg_stat_statements && a.server.io_timing);

    let t = a.timing.expect("repeat-run stats");
    assert!(t.execution_ms.len() >= 2, "{t:?}");
    assert!(t.min_ms <= t.median_ms && t.median_ms <= t.max_ms);
    assert_eq!(a.execution_time_ms, Some(t.median_ms), "displayed plan is the median run");

    let mut io_nodes = 0;
    plan::walk(&a.root, &mut |n| io_nodes += n.io_time_ms.is_some() as u32);
    assert!(io_nodes > 0, "track_io_timing=on should yield per-node I/O time");
    // SETTINGS lists only non-default planner settings: change one and it shows up.
    let tuned = RunOptions { setup: vec!["SET work_mem = '64MB'".into()], ..opts(ExplainMode::Estimate) };
    let b = explain(&conn, &spec, SLOW_QUERY, &tuned, LIMITS).await.unwrap();
    assert!(b.planner_settings.iter().any(|p| p.key == "work_mem"), "{:?}", b.planner_settings);
    // Column statistics come back for analyzed tables.
    let orders = a.tables.iter().find(|t| t.name == "orders").unwrap();
    let status = orders.columns.iter().find(|c| c.name == "status").unwrap();
    assert!(status.stats.as_ref().is_some_and(|s| !s.common_values.is_empty()), "{status:?}");
}

#[tokio::test]
async fn hypothetical_index_is_planned_and_leaves_nothing_behind() {
    let Some((conn, spec)) = setup() else { return };
    let lookup = "SELECT * FROM orders WHERE user_id = 4242";
    let opts = RunOptions {
        hypothetical: vec!["CREATE INDEX ON orders (user_id)".into()],
        ..opts(ExplainMode::Analyze)
    };
    let a = explain(&conn, &spec, lookup, &opts, LIMITS).await.unwrap();
    assert_eq!(a.mode, ExplainMode::Estimate, "hypothetical indexes force a plain EXPLAIN");
    assert!(shape(&a.root).contains("Index"), "got {}", shape(&a.root));
    let again = explain(&conn, &spec, lookup, &opts_estimate(), LIMITS).await.unwrap();
    assert!(!shape(&again.root).contains("Index"), "hypothetical index leaked: {}", shape(&again.root));
}

fn opts_estimate() -> RunOptions {
    opts(ExplainMode::Estimate)
}

#[tokio::test]
async fn extended_statistics_setup_is_rolled_back() {
    let Some((conn, spec)) = setup() else { return };
    let port = spec.port.unwrap();
    let opts = RunOptions {
        setup: vec![
            "CREATE STATISTICS ql_tmp_stats (dependencies, ndistinct) ON status, user_id FROM orders".into(),
            "ANALYZE orders".into(),
        ],
        ..opts(ExplainMode::Estimate)
    };
    explain(&conn, &spec, "SELECT * FROM orders WHERE status = 'paid' AND user_id = 7", &opts, LIMITS)
        .await
        .unwrap();
    let client = raw_client(port).await;
    let left: i64 = client
        .query_one("SELECT count(*) FROM pg_statistic_ext WHERE stxname = 'ql_tmp_stats'", &[])
        .await
        .unwrap()
        .get(0);
    assert_eq!(left, 0, "CREATE STATISTICS must be rolled back");
}

#[tokio::test]
async fn lock_timeout_fails_fast_with_a_clear_message() {
    let Some((conn, spec)) = setup() else { return };
    let holder = raw_client(spec.port.unwrap()).await;
    holder.batch_execute("BEGIN; SELECT * FROM users WHERE id = 2 FOR UPDATE").await.unwrap();

    let started = std::time::Instant::now();
    let err = explain(&conn, &spec, "UPDATE users SET country = 'XX' WHERE id = 2", &opts(ExplainMode::Analyze), LIMITS)
        .await
        .unwrap_err();
    holder.batch_execute("ROLLBACK").await.unwrap();
    assert!(err.message.contains("lock"), "{}", err.message);
    assert!(started.elapsed() < std::time::Duration::from_secs(10), "should give up after lock_timeout");
}
