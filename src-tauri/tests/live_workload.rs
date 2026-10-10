//! Workload features against the dev Postgres (skewed `events` table, pg_stat_statements).
//!
//!   QUERYLENS_PG_PORT=54329 cargo test --test live_workload -- --nocapture

use querylens_lib::engines::{self, ConnectSpec};
use querylens_lib::model::{ConnectionInput, Engine, ExplainMode, SslMode, TopQueryOrder};
use querylens_lib::services::{analysis, sensitivity};
use querylens_lib::storage::Store;

fn setup() -> Option<(Store, ConnectSpec)> {
    let port: u16 = std::env::var("QUERYLENS_PG_PORT").ok()?.parse().ok()?;
    let dir = std::env::temp_dir().join(format!("ql-workload-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let store = Store::open(&dir.join("q.db")).unwrap();
    let input = ConnectionInput {
        id: None,
        name: "shop".into(),
        engine: Engine::Postgres,
        color: String::new(),
        host: Some("localhost".into()),
        port: Some(port),
        database: Some("shop".into()),
        username: Some("querylens".into()),
        ssl_mode: SslMode::Disable,
        file_path: None,
        password: None,
    };
    let conn = store.upsert_connection("shop", &input, false).unwrap();
    let spec = analysis::spec_for(&conn).unwrap();
    Some((store, spec))
}

#[tokio::test]
async fn parameterized_query_and_plan_flip() {
    let Some((store, _)) = setup() else { return };
    let sql = "SELECT * FROM events WHERE kind = $1";

    // Missing values are a clear validation error, not a Postgres one.
    let err = analysis::run(&store, "shop", sql, analysis::RunOptions::new(ExplainMode::Estimate)).await.unwrap_err();
    assert!(err.message.contains("Parameters"), "{}", err.message);

    let opts = analysis::RunOptions {
        persist: true,
        params: vec![Some("refund".into())],
        ..analysis::RunOptions::new(ExplainMode::Analyze)
    };
    let a = analysis::run(&store, "shop", sql, opts).await.unwrap();
    assert_eq!(a.params, vec![Some("refund".to_string())]);

    let reports = sensitivity::sensitivity(&store, &a).await.unwrap();
    let r = &reports[0];
    for row in &r.rows {
        println!("{:<14} {:<12} {:?}  {}", row.label, format!("{:?}", row.value), row.frequency, row.shape);
    }
    println!("{}", r.summary);
    assert_eq!(r.column.as_deref(), Some("kind"));
    assert!(r.flips, "rare 'refund' vs common 'view' should plan differently");
    assert!(r.rows.iter().any(|row| row.generic));
    let common = r.rows.iter().find(|row| row.label == "most common").unwrap();
    assert_eq!(common.value.as_deref(), Some("view"));
    assert!(common.shape.contains("Seq Scan"), "{}", common.shape);
}

#[tokio::test]
async fn top_queries_reads_pg_stat_statements() {
    let Some((_, spec)) = setup() else { return };
    // Generate some recognisable workload.
    let (client, conn) = tokio_postgres::connect(
        &format!("host=localhost port={} dbname=shop user=querylens", spec.port.unwrap()),
        tokio_postgres::NoTls,
    )
    .await
    .unwrap();
    tokio::spawn(conn);
    for i in 0..5 {
        client.query("SELECT count(*) FROM events WHERE user_id = $1", &[&(i as i64)]).await.unwrap();
    }
    let mut session = engines::open(&spec).await.unwrap();
    let top = session.top_queries(TopQueryOrder::Calls, 50).await.unwrap();
    for q in top.iter().take(5) {
        println!("{:>6} calls {:>9.1} ms  {:.0}%  {}", q.calls, q.total_ms, q.share * 100.0, q.query.replace('\n', " "));
    }
    let ours = top.iter().find(|q| q.query.contains("FROM events WHERE user_id = $1")).expect("workload query listed");
    assert!(ours.calls >= 5.0);
    assert!(top.iter().all(|q| !q.query.to_lowercase().starts_with("explain")), "QueryLens' own EXPLAINs are hidden");
}
