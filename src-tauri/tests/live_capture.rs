//! The capture proxy against the dev Postgres: a real client through the proxy,
//! then the report with plan checks.
//!
//!   QUERYLENS_PG_PORT=54329 cargo test --test live_capture -- --nocapture

use std::sync::Arc;

use querylens_lib::capture::{self, PlanDepth, ReportOptions, RunningCapture, StartOptions};
use querylens_lib::model::{CaptureSource, FindingKind};
use querylens_lib::services::target::Target;
use querylens_lib::storage::Store;

fn setup() -> Option<(Arc<Store>, Target)> {
    let port: u16 = std::env::var("QUERYLENS_PG_PORT").ok()?.parse().ok()?;
    let dir = std::env::temp_dir().join(format!("ql-capture-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let store = Arc::new(Store::open(&dir.join("q.db")).unwrap());
    let target = Target::from_url(&format!("postgres://querylens@localhost:{port}/shop?sslmode=disable")).unwrap();
    Some((store, target))
}

#[tokio::test]
async fn records_traffic_and_finds_the_n_plus_one() {
    let Some((store, target)) = setup() else { return };
    let opts = StartOptions {
        name: Some("live".into()),
        source: CaptureSource::Cli,
        collector: None,
        spool: None,
        proxy: Some("127.0.0.1:0".parse().unwrap()),
        collector_fallback: false,
    };
    let running = RunningCapture::start(store.clone(), Some(&target), opts).await.unwrap();
    let app_url = running.app_url().unwrap().to_string();
    println!("app url: {app_url}");

    let (client, conn) = tokio_postgres::connect(&app_url, tokio_postgres::NoTls).await.unwrap();
    tokio::spawn(conn);

    // Sequelize style: literals inline, simple protocol, trailing semicolon, tag comment.
    let orders = client
        .simple_query(r#"SELECT "id" FROM "orders" AS "Order" WHERE "Order"."user_id" = 42 /*file='src%2Forders.js%3A10'*/;"#)
        .await
        .unwrap();
    let ids: Vec<String> = orders
        .iter()
        .filter_map(|m| match m {
            tokio_postgres::SimpleQueryMessage::Row(r) => r.get(0).map(String::from),
            _ => None,
        })
        .collect();
    assert!(ids.len() >= 5, "user 42 should have orders, got {}", ids.len());
    for id in &ids {
        let sql = format!(
            r#"SELECT "order_id", "product_id", "quantity" FROM "order_items" AS "OrderItem" WHERE "OrderItem"."order_id" = '{id}' /*file='src%2Forders.js%3A14'*/;"#
        );
        client.simple_query(&sql).await.unwrap();
    }
    // Extended protocol with a bound parameter (binary int8).
    let row = client.query_one("SELECT count(*) FROM users WHERE id < $1", &[&100i64]).await.unwrap();
    assert_eq!(row.get::<_, i64>(0), 99);
    // Pipelined: both requests are in flight together.
    let (a, b) = tokio::join!(
        client.query_one("SELECT $1::text", &[&"a"]),
        client.query_one("SELECT pg_sleep(0.05)::text, $1::text", &[&"b"])
    );
    assert_eq!(a.unwrap().get::<_, String>(0), "a");
    assert_eq!(b.unwrap().get::<_, String>(1), "b");
    // A failing statement, then the connection keeps working.
    assert!(client.simple_query("SELECT * FROM missing_table").await.is_err());
    client.simple_query("SELECT 1").await.unwrap();

    let live = running.live();
    assert_eq!(live.open_connections, 1);
    drop(client);
    let summary = running.stop(&store).await.unwrap();
    println!("{} statements, {:.1} ms", summary.statements, summary.total_ms);
    for s in store.captured_statements(&summary.id).unwrap() {
        let sql: String = s.sql.chars().take(70).collect();
        println!("  #{} {:>8.2} ms rows={} err={} {sql}", s.seq, s.duration_ms, s.rows, s.error.is_some());
    }
    assert_eq!(summary.statements as usize, 1 + ids.len() + 1 + 2 + 1 + 1);

    let statements = store.captured_statements(&summary.id).unwrap();
    let counted = statements.iter().find(|s| s.sql.contains("count(*)")).unwrap();
    assert_eq!(counted.params, vec![Some("100".to_string())]);
    assert_eq!(counted.rows, 1.0);
    let failed = statements.iter().find(|s| s.sql.contains("missing_table")).unwrap();
    assert!(failed.error.as_deref().unwrap().contains("42P01"), "{:?}", failed.error);
    let item = statements.iter().find(|s| s.sql.contains("order_items")).unwrap();
    assert_eq!(item.origin.as_deref(), Some("src/orders.js:14"));
    assert!(!item.sql.contains("/*"), "tags are stripped from the stored SQL");
    let slept = statements.iter().find(|s| s.sql.contains("pg_sleep")).unwrap();
    assert!(slept.duration_ms >= 45.0, "{}", slept.duration_ms);

    let opts = ReportOptions { plans: PlanDepth::Explain, ..ReportOptions::default() };
    let report = capture::report::build(&store, &summary.id, Some(&target), &opts).await.unwrap();
    println!("{}", capture::render::markdown(&report));
    assert_eq!(report.orm, Some(querylens_lib::model::Orm::Sequelize));
    let n1 = report.findings.iter().find(|f| f.kind == FindingKind::NPlusOne).expect("N+1 finding");
    assert!(n1.parent_fingerprint.is_some());
    let fix = n1.fix.as_ref().unwrap();
    assert!(fix.code.as_deref().unwrap().contains("include: [{ model: OrderItem, separate: true }]"));
    // order_items.order_id has no index: the plan check finds the scan and tests one.
    let check = report.plan_checks.iter().find(|c| c.fingerprint == n1.fingerprint).unwrap();
    assert!(check.shape.contains("Seq Scan on order_items"), "{}", check.shape);
    let ix = check.index.as_ref().expect("index tested");
    assert!(ix.ddl.contains("\"order_items\" (\"order_id\")"), "{}", ix.ddl);
    assert!(ix.used && ix.after < ix.before);
    assert!(fix.ddl.is_some(), "the N+1 fix carries the index");
    assert!(report.findings.iter().any(|f| f.kind == FindingKind::QueryErrors));
}

/// SDK events over HTTP, and the same statements through the proxy: recorded once.
#[tokio::test]
async fn sdk_events_win_over_proxy_copies() {
    let Some((store, target)) = setup() else { return };
    let opts = StartOptions {
        name: Some("sdk".into()),
        source: CaptureSource::Cli,
        collector: Some("127.0.0.1:0".parse().unwrap()),
        spool: None,
        proxy: Some("127.0.0.1:0".parse().unwrap()),
        collector_fallback: false,
    };
    let running = RunningCapture::start(store.clone(), Some(&target), opts).await.unwrap();
    let collector = running.collector_url().unwrap();
    let http = reqwest::Client::new();
    let status: serde_json::Value = http.get(format!("{collector}/v1/status")).send().await.unwrap().json().await.unwrap();
    assert_eq!(status["capturing"], true);

    // What the SDK in the app reports…
    let now_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs_f64() * 1000.0;
    let event = serde_json::json!({
        "v": 1, "pid": 4242, "conn": 1, "at": now_ms, "durationMs": 3.5,
        "sql": "SELECT count(*) FROM users WHERE id < $1", "params": ["10"], "rows": 1,
        "origin": "src/users.js:7", "route": "GET /users", "unit": "r1"
    });
    let resp = http.post(format!("{collector}/v1/events")).body(format!("{event}
")).send().await.unwrap();
    assert_eq!(resp.status(), 202);

    // …and the same statement on the wire (tagged by the SDK), plus a plain one.
    let (client, conn) = tokio_postgres::connect(running.app_url().unwrap(), tokio_postgres::NoTls).await.unwrap();
    tokio::spawn(conn);
    client.simple_query("SELECT count(*) FROM users WHERE id < 10 /*file='src%2Fusers.js%3A7',ql_sdk='1'*/").await.unwrap();
    client.simple_query("SELECT 1").await.unwrap();
    drop(client);

    let summary = running.stop(&store).await.unwrap();
    let statements = store.captured_statements(&summary.id).unwrap();
    for s in &statements {
        println!("  conn={} origin={:?} {}", s.conn, s.origin, s.sql);
    }
    assert_eq!(statements.len(), 2, "the proxy copy of the SDK's statement is dropped");
    let from_sdk = statements.iter().find(|s| s.sql.contains("count(*)")).unwrap();
    assert_eq!(from_sdk.origin.as_deref(), Some("src/users.js:7"));
    assert_eq!(from_sdk.route.as_deref(), Some("GET /users"));
    assert_eq!(from_sdk.params, vec![Some("10".to_string())]);
    assert!(statements.iter().any(|s| s.sql == "SELECT 1"));
}
