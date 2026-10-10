//! End-to-end checks against the dev MongoDB from `dev/docker-compose.yml`.
//!
//! Skipped unless `QUERYLENS_MONGO_PORT` is set:
//!   QUERYLENS_MONGO_PORT=27019 cargo test --test live_mongo -- --nocapture

use querylens_lib::engines::{self, ConnectSpec};
use querylens_lib::error::ErrorKind;
use querylens_lib::model::{Connection, Engine, ExplainMode, SslMode, WarningKind};
use querylens_lib::plan;
use querylens_lib::services::analysis::{Limits, RunOptions, explain};

const LIMITS: Limits = Limits { timeout_ms: 60_000, lock_timeout_ms: 2_000 };

fn setup() -> Option<(Connection, ConnectSpec)> {
    let port: u16 = std::env::var("QUERYLENS_MONGO_PORT").ok()?.parse().ok()?;
    let conn = Connection {
        id: "live-mongo".into(),
        name: "dev-mongo".into(),
        engine: Engine::Mongodb,
        color: "#2dd4bf".into(),
        host: Some("localhost".into()),
        port: Some(port),
        database: Some("shop".into()),
        username: None,
        ssl_mode: SslMode::Disable,
        file_path: None,
        has_password: false,
        created_at: String::new(),
        last_used_at: None,
    };
    let spec = ConnectSpec {
        engine: Engine::Mongodb,
        host: conn.host.clone(),
        port: conn.port,
        database: conn.database.clone(),
        username: None,
        password: None,
        ssl_mode: SslMode::Disable,
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
async fn find_without_index_is_a_collection_scan() {
    let Some((conn, spec)) = setup() else { return };
    let q = r#"db.orders.find({ userId: 4242 }).sort({ total: -1 }).limit(20)"#;
    let a = explain(&conn, &spec, q, &RunOptions { runs: 2, ..RunOptions::new(ExplainMode::Analyze) }, LIMITS)
        .await
        .unwrap();
    println!("{}", querylens_lib::llm::prompt::user(&a));
    assert!(a.execution_time_ms.is_some());
    assert!(kinds(&a.root).contains(&WarningKind::MissingIndex), "{:?}", kinds(&a.root));
    let orders = a.tables.iter().find(|t| t.name == "orders").expect("collection context");
    assert!(orders.row_estimate.unwrap() >= 300_000.0);
    assert!(orders.columns.iter().any(|c| c.name == "userId"));
    assert!(orders.indexes.iter().any(|i| i.name == "_id_"));

    let est = explain(&conn, &spec, q, &RunOptions::new(ExplainMode::Estimate), LIMITS).await.unwrap();
    assert!(est.root.actual_rows.is_none());
}

#[tokio::test]
async fn indexed_lookup_and_pipeline() {
    let Some((conn, spec)) = setup() else { return };
    let a = explain(&conn, &spec, "db.events.find({ kind: 'refund' })", &RunOptions::new(ExplainMode::Analyze), LIMITS)
        .await
        .unwrap();
    let mut indexes = Vec::new();
    plan::walk(&a.root, &mut |n| indexes.extend(n.index_name.clone()));
    assert_eq!(indexes, ["kind_1"], "{}", querylens_lib::llm::prompt::compact_plan(&a.root));

    let pipeline = r#"db.orders.aggregate([
        { $match: { status: "paid" } },
        { $group: { _id: "$userId", spent: { $sum: "$total" } } },
        { $sort: { spent: -1 } }, { $limit: 5 },
        { $lookup: { from: "events", localField: "_id", foreignField: "userId", as: "events" } }
    ])"#;
    let p = explain(&conn, &spec, pipeline, &RunOptions::new(ExplainMode::Analyze), LIMITS).await.unwrap();
    println!("{}", querylens_lib::llm::prompt::compact_plan(&p.root));
    assert!(plan::relations(&p.root).contains(&"events".to_string()));
    assert!(kinds(&p.root).contains(&WarningKind::MissingIndex), "unindexed $lookup: {:?}", kinds(&p.root));
}

#[tokio::test]
async fn writes_are_explained_but_never_applied() {
    let Some((conn, spec)) = setup() else { return };
    let q = r#"db.orders.updateMany({ _id: { $lt: 10 } }, { $set: { status: "explained" } })"#;
    explain(&conn, &spec, q, &RunOptions::new(ExplainMode::Analyze), LIMITS).await.unwrap();
    let check = explain(&conn, &spec, r#"db.orders.find({ status: "explained" })"#, &RunOptions::new(ExplainMode::Analyze), LIMITS)
        .await
        .unwrap();
    assert_eq!(check.root.actual_rows, Some(0.0));
    let err = explain(&conn, &spec, r#"db.orders.aggregate([{ $out: "copy" }])"#, &RunOptions::new(ExplainMode::Analyze), LIMITS)
        .await
        .unwrap_err();
    assert!(err.message.contains("$out"));
}

#[tokio::test]
async fn timeouts_use_max_time_ms() {
    let Some((conn, spec)) = setup() else { return };
    let limits = Limits { timeout_ms: 50, ..LIMITS };
    // A $where with sleep() runs per document: far longer than 50 ms.
    let q = "db.orders.find({ $where: 'sleep(1) || true' })";
    let err = explain(&conn, &spec, q, &RunOptions::new(ExplainMode::Analyze), limits).await.unwrap_err();
    assert_eq!(err.kind, ErrorKind::Timeout, "{}", err.message);
    let mut session = engines::open(&spec).await.unwrap();
    assert!(session.test().await.unwrap().server_version.starts_with("MongoDB"));
}
