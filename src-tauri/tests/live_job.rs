//! Join Order Benchmark (IMDB) stress test for the plan pipeline.
//!
//! Skipped unless set (see docs/architecture.md §10 for loading the data):
//!   QUERYLENS_PG_PORT=54329 QUERYLENS_JOB_DIR=/path/to/join-order-benchmark \
//!     cargo test --release --test live_job -- --nocapture
//! Optional: QUERYLENS_JOB_QUERIES="13d,16b,17a" (default: all queries).

use std::collections::BTreeMap;

use querylens_lib::engines::ConnectSpec;
use querylens_lib::model::{Connection, Engine, ExplainMode, SslMode};
use querylens_lib::plan;
use querylens_lib::services::analysis::{Limits, RunOptions, explain};

#[tokio::test]
async fn job_queries_parse_and_score() {
    let (Ok(port), Ok(dir)) = (std::env::var("QUERYLENS_PG_PORT"), std::env::var("QUERYLENS_JOB_DIR")) else {
        return;
    };
    let conn = Connection {
        id: "job".into(),
        name: "imdb".into(),
        engine: Engine::Postgres,
        color: String::new(),
        host: Some("localhost".into()),
        port: Some(port.parse().unwrap()),
        database: Some("imdb".into()),
        username: Some("querylens".into()),
        ssl_mode: SslMode::Disable,
        file_path: None,
        has_password: false,
        created_at: String::new(),
        last_used_at: None,
    };
    let spec = ConnectSpec {
        engine: Engine::Postgres,
        host: conn.host.clone(),
        port: conn.port,
        database: conn.database.clone(),
        username: conn.username.clone(),
        password: None,
        ssl_mode: SslMode::Disable,
        file_path: None,
    };

    let mut names: Vec<String> = match std::env::var("QUERYLENS_JOB_QUERIES") {
        Ok(list) => list.split(',').map(|s| s.trim().to_string()).collect(),
        Err(_) => std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter_map(|e| e.file_name().to_str().map(String::from))
            .filter(|n| n.ends_with(".sql") && n.starts_with(|c: char| c.is_ascii_digit()))
            .map(|n| n.trim_end_matches(".sql").to_string())
            .collect(),
    };
    names.sort_by_key(|n| (n[..n.len() - 1].parse::<u32>().unwrap_or(0), n.clone()));

    let opts = RunOptions { read_only: true, ..RunOptions::new(ExplainMode::Analyze) };
    let limits = Limits { timeout_ms: 120_000, lock_timeout_ms: 5_000 };
    let mut failures = Vec::new();
    let mut warning_totals: BTreeMap<String, u32> = BTreeMap::new();
    println!("{:<5} {:>10} {:>5} {:>4}  {:<44} {}", "query", "exec", "ops", "warn", "hottest operator", "share");

    for name in &names {
        let sql = std::fs::read_to_string(format!("{dir}/{name}.sql")).unwrap();
        match explain(&conn, &spec, &sql, &opts, limits).await {
            Ok(a) => {
                let mut hottest = &a.root;
                let mut share_sum = 0.0;
                plan::walk(&a.root, &mut |n| {
                    share_sum += n.share;
                    if n.share > hottest.share {
                        hottest = n;
                    }
                    for w in &n.warnings {
                        *warning_totals.entry(format!("{:?}", w.kind)).or_default() += 1;
                    }
                });
                // Invariants the UI relies on.
                assert!((share_sum - 1.0).abs() < 1e-6, "{name}: shares sum to {share_sum}");
                plan::walk(&a.root, &mut |n| {
                    assert!(n.self_time_ms.unwrap_or(0.0) >= 0.0, "{name}: negative self time at {}", n.id);
                });
                let label = match &hottest.relation {
                    Some(r) => format!("{} on {r}", hottest.node_type),
                    None => hottest.node_type.clone(),
                };
                println!(
                    "{name:<5} {:>8.1}ms {:>5} {:>4}  {label:<44} {:>4.0}%",
                    a.execution_time_ms.unwrap_or(0.0),
                    a.node_count,
                    a.warnings_count,
                    hottest.share * 100.0
                );
            }
            Err(e) => {
                println!("{name:<5} ERROR {}", e.message);
                failures.push(name.clone());
            }
        }
    }
    println!("\nwarnings by kind: {warning_totals:?}");
    assert!(failures.is_empty(), "failed: {failures:?}");
}

