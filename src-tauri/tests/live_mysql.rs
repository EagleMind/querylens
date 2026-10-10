//! End-to-end checks against the dev MySQL from `dev/docker-compose.yml`.
//!
//! Skipped unless `QUERYLENS_MYSQL_PORT` is set:
//!   QUERYLENS_MYSQL_PORT=33069 cargo test --test live_mysql -- --nocapture

use querylens_lib::engines::{self, ConnectSpec};
use querylens_lib::error::ErrorKind;
use querylens_lib::model::{Connection, Engine, ExplainMode, SslMode, TopQueryOrder, WarningKind};
use querylens_lib::plan;
use querylens_lib::services::analysis::{Limits, RunOptions, explain};

const LIMITS: Limits = Limits { timeout_ms: 60_000, lock_timeout_ms: 2_000 };

fn setup() -> Option<(Connection, ConnectSpec)> {
    let port: u16 = std::env::var("QUERYLENS_MYSQL_PORT").ok()?.parse().ok()?;
    let conn = Connection {
        id: "live-mysql".into(),
        name: "dev-mysql".into(),
        engine: Engine::Mysql,
        color: "#2dd4bf".into(),
        host: Some("localhost".into()),
        port: Some(port),
        database: Some("shop".into()),
        username: Some("querylens".into()),
        ssl_mode: SslMode::Prefer,
        file_path: None,
        has_password: true,
        created_at: String::new(),
        last_used_at: None,
    };
    let spec = ConnectSpec {
        engine: Engine::Mysql,
        host: conn.host.clone(),
        port: conn.port,
        database: conn.database.clone(),
        username: conn.username.clone(),
        password: Some("querylens".into()),
        ssl_mode: conn.ssl_mode,
        file_path: None,
    };
    Some((conn, spec))
}

fn kinds(root: &querylens_lib::model::PlanNode) -> Vec<WarningKind> {
    let mut out = Vec::new();
    plan::walk(root, &mut |n| out.extend(n.warnings.iter().map(|w| w.kind)));
    out
}

#[tokio::test]
async fn profiles_a_join_and_flags_the_unindexed_lookup() {
    let Some((conn, spec)) = setup() else { return };
    let sql = "SELECT u.email, count(*) AS orders, sum(o.total) AS spent
               FROM orders o JOIN users u ON u.id = o.user_id
               WHERE o.user_id BETWEEN 100 AND 120
               GROUP BY u.email ORDER BY spent DESC LIMIT 20";
    let a = explain(&conn, &spec, sql, &RunOptions { runs: 2, ..RunOptions::new(ExplainMode::Analyze) }, LIMITS)
        .await
        .unwrap();
    println!("{}", querylens_lib::llm::prompt::user(&a));
    assert!(a.execution_time_ms.unwrap() > 0.0);
    assert!(a.timing.is_some(), "repeat runs");
    assert!(kinds(&a.root).contains(&WarningKind::MissingIndex), "{:?}", kinds(&a.root));
    let mut relations = plan::relations(&a.root);
    relations.sort();
    assert!(relations.contains(&"orders".to_string()) && relations.contains(&"users".to_string()), "{relations:?}");
    let users = a.tables.iter().find(|t| t.name == "users").expect("schema for users");
    assert!(users.indexes.iter().any(|i| i.definition.starts_with("PRIMARY KEY")));
    assert!(users.row_estimate.unwrap() > 50_000.0);

    let est = explain(&conn, &spec, sql, &RunOptions::new(ExplainMode::Estimate), LIMITS).await.unwrap();
    assert!(est.total_cost.unwrap() > 0.0);
    assert!(est.execution_time_ms.is_none());
}

#[tokio::test]
async fn writes_are_refused_and_nothing_changes() {
    let Some((conn, spec)) = setup() else { return };
    let err = explain(
        &conn,
        &spec,
        "UPDATE orders SET status = 'x' WHERE id = 1",
        &RunOptions::new(ExplainMode::Analyze),
        LIMITS,
    )
    .await
    .unwrap_err();
    assert!(err.message.contains("Profile only runs queries that read"), "{}", err.message);
    // Explain (no execution) of a multi-table UPDATE works; single-table ones get a clear message.
    explain(
        &conn,
        &spec,
        "UPDATE orders o JOIN users u ON u.id = o.user_id SET o.status = 'x' WHERE u.id = 1",
        &RunOptions::new(ExplainMode::Estimate),
        LIMITS,
    )
    .await
    .unwrap();
    let err = explain(&conn, &spec, "UPDATE orders SET status = 'x' WHERE id = 1", &RunOptions::new(ExplainMode::Estimate), LIMITS)
        .await
        .unwrap_err();
    assert!(err.message.contains("SELECT with the same WHERE"), "{}", err.message);
    let check = explain(&conn, &spec, "SELECT status FROM orders WHERE id = 1 AND status = 'x'", &RunOptions::new(ExplainMode::Analyze), LIMITS)
        .await
        .unwrap();
    assert_eq!(check.root.actual_rows, Some(0.0), "the UPDATE did not run");
}

#[tokio::test]
async fn timeouts_are_reported_with_the_limit() {
    let Some((conn, spec)) = setup() else { return };
    let limits = Limits { timeout_ms: 1_000, ..LIMITS };
    let started = std::time::Instant::now();
    let slow = "SELECT count(*) FROM orders a JOIN orders b ON a.total + b.total > 1999";
    let err = explain(&conn, &spec, slow, &RunOptions::new(ExplainMode::Analyze), limits)
        .await
        .unwrap_err();
    assert_eq!(err.kind, ErrorKind::Timeout, "{}", err.message);
    assert!(err.message.contains("after 1 s"), "{}", err.message);
    assert!(started.elapsed() < std::time::Duration::from_secs(5));
}

#[tokio::test]
async fn top_queries_reads_performance_schema() {
    let Some((conn, spec)) = setup() else { return };
    for _ in 0..3 {
        explain(&conn, &spec, "SELECT count(*) FROM events WHERE kind = 'refund'", &RunOptions::new(ExplainMode::Analyze), LIMITS)
            .await
            .unwrap();
    }
    let mut session = engines::open(&spec).await.unwrap();
    let top = session.top_queries(TopQueryOrder::Total, 50).await.unwrap();
    for q in top.iter().take(5) {
        println!("{:>6} calls {:>9.1} ms  {:.0}%  {}", q.calls, q.total_ms, q.share * 100.0, q.query);
    }
    assert!(top.iter().all(|q| !q.query.to_uppercase().starts_with("EXPLAIN")), "QueryLens' own statements are hidden");
    assert!(session.test().await.unwrap().server_version.starts_with("MySQL 8"));
}
