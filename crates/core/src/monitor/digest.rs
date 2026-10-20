//! A whole envelope → everything the backend needs to store and broadcast: each request's
//! statements (fingerprinted) with its findings and fixes, and per-shape statistics.
//! This is what the Cloudflare backend calls through WebAssembly; storage stays on its side.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::envelope::{self, Stats};
use super::evaluate::{Found, evaluate};
use super::model::{ProjectSettings, SourceSnippet};
use crate::capture::detect::Thresholds;
use crate::capture::sql::{comments, shape};
use crate::fingerprint;
use crate::model::{CapturedStatement, Orm, StatementKind};

#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DigestRequest {
    /// The envelope as received (newline-separated JSON).
    pub body: String,
    /// What earlier traffic of the project showed.
    #[serde(default)]
    pub orm: Option<Orm>,
    #[serde(default)]
    pub settings: ProjectSettings,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Digest {
    pub sdk: Option<String>,
    pub environment: String,
    pub release: Option<String>,
    pub transactions: Vec<DigestedTransaction>,
    pub stats: Vec<StatRow>,
    /// Application code around origins, from SDKs with source context on.
    pub sources: Vec<SourceSnippet>,
    /// Recognised in this envelope, when it differs from the request's.
    pub orm: Option<Orm>,
    /// Lines that weren't valid items.
    pub skipped: u32,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DigestedTransaction {
    pub name: String,
    /// Start, epoch milliseconds.
    pub start: f64,
    pub duration_ms: f64,
    /// Total statement time, ms.
    pub db_ms: f64,
    pub statements: Vec<CapturedStatement>,
    pub findings: Vec<Found>,
}

/// One statement shape's totals over one SDK reporting period.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct StatRow {
    pub fingerprint: String,
    pub sample_sql: String,
    pub kind: StatementKind,
    pub tables: Vec<String>,
    /// Start of the period, epoch milliseconds.
    pub start: f64,
    pub period_ms: f64,
    pub calls: u32,
    pub total_ms: f64,
    pub max_ms: f64,
    pub errors: u32,
    pub rows: f64,
}

pub fn thresholds(s: &ProjectSettings) -> Thresholds {
    Thresholds {
        slow_ms: s.slow_ms.max(1.0),
        loop_min: s.loop_min.max(2),
        chatty: s.chatty.max(2),
        large_rows: s.large_rows.max(1.0),
        ..Thresholds::default()
    }
}

pub fn digest(req: &DigestRequest) -> Digest {
    let env = envelope::parse(&req.body);
    let t = thresholds(&req.settings);
    let mut orm = req.orm;
    let mut learned = None;
    let transactions = env
        .transactions
        .iter()
        .filter_map(|txn| {
            let statements = txn.statements();
            if statements.is_empty() {
                return None;
            }
            let evaluated = evaluate(&statements, orm, &t);
            if let Some(seen) = evaluated.orm.filter(|o| Some(*o) != orm) {
                orm = Some(seen);
                learned = Some(seen);
            }
            Some(DigestedTransaction {
                name: txn.name(),
                start: txn.start,
                duration_ms: txn.duration_ms.max(0.0),
                db_ms: statements.iter().map(|s| s.duration_ms).sum(),
                findings: evaluated.findings,
                statements,
            })
        })
        .collect();
    Digest {
        sdk: env.sdk,
        environment: env.environment,
        release: env.release,
        transactions,
        stats: stat_rows(&env.stats),
        sources: env.sources.iter().filter_map(|s| s.snippet()).collect(),
        orm: learned,
        skipped: env.skipped as u32,
    }
}

/// SDK statistics as rows to add up, fingerprinted like everything else.
fn stat_rows(stats: &[Stats]) -> Vec<StatRow> {
    stats
        .iter()
        .flat_map(|s| {
            s.queries.iter().filter(|q| q.calls > 0).map(move |q| {
                let (sql, _) = comments::extract(&q.sql);
                StatRow {
                    fingerprint: fingerprint::query_fp(&sql),
                    kind: shape::kind(&sql),
                    tables: shape::tables(&sql).into_iter().map(|t| t.name).collect(),
                    sample_sql: sql.trim().to_string(),
                    start: s.start,
                    period_ms: s.period_ms.clamp(1000.0, 3_600_000.0),
                    calls: q.calls,
                    total_ms: q.total_ms.max(0.0),
                    max_ms: q.max_ms.max(0.0),
                    errors: q.errors,
                    rows: q.rows.max(0.0),
                }
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::FindingKind;

    #[test]
    fn digests_transactions_and_stats() {
        let mut queries = vec![r#"{"at":0,"durationMs":2,"sql":"SELECT \"id\" FROM \"orders\" AS \"Order\";","rows":8}"#.to_string()];
        for i in 0..8 {
            queries.push(format!(
                r#"{{"at":{},"durationMs":1,"sql":"SELECT \"id\" FROM \"order_items\" AS \"OrderItem\" WHERE \"OrderItem\".\"order_id\" = ?;","vh":"{i}","rows":1}}"#,
                1 + i
            ));
        }
        let body = [
            r#"{"type":"header","environment":"staging","release":"r1"}"#.to_string(),
            format!(r#"{{"type":"transaction","name":"GET /orders","start":1000,"durationMs":15,"queries":[{}]}}"#, queries.join(",")),
            r#"{"type":"stats","start":7200000,"queries":[{"sql":"SELECT * FROM \"users\" WHERE id = ? /*file='x'*/","calls":4,"totalMs":8,"maxMs":3},{"sql":"SELECT 1","calls":0,"totalMs":0}]}"#.to_string(),
        ]
        .join("\n");
        let d = digest(&DigestRequest { body, orm: None, settings: ProjectSettings::default() });
        assert_eq!((d.environment.as_str(), d.release.as_deref(), d.orm), ("staging", Some("r1"), Some(Orm::Sequelize)));
        let t = &d.transactions[0];
        assert_eq!((t.name.as_str(), t.statements.len(), t.db_ms), ("GET /orders", 9, 10.0));
        assert!(t.findings.iter().any(|f| f.finding.kind == FindingKind::NPlusOne));
        assert_eq!(d.stats.len(), 1, "empty entries dropped");
        assert_eq!((d.stats[0].kind, d.stats[0].calls), (StatementKind::Select, 4));
        assert_eq!(d.stats[0].sample_sql, r#"SELECT * FROM "users" WHERE id = ?"#);
        assert_eq!(d.stats[0].tables, vec!["users".to_string()]);
    }

    /// SQLite, as Sequelize and Drizzle write it (backticks, `?` and `?1` placeholders):
    /// recognised and evaluated like PostgreSQL and MySQL.
    #[test]
    fn sqlite_statements_are_evaluated_like_the_others() {
        let n_plus_one = |parent: &str, child: &str| {
            let mut queries = vec![serde_json::json!({ "at": 0, "durationMs": 1, "sql": parent, "vh": "p", "rows": 6 })];
            for i in 0..6 {
                queries.push(serde_json::json!({ "at": 1 + i, "durationMs": 1, "sql": child, "vh": format!("c{i}"), "rows": 2 }));
            }
            let txn = serde_json::json!({ "type": "transaction", "name": "GET /orders", "start": 0, "queries": queries });
            digest(&DigestRequest { body: txn.to_string(), orm: None, settings: ProjectSettings::default() })
        };
        let sequelize = n_plus_one(
            "SELECT `id`, `userId` FROM `Orders` AS `Order` WHERE `Order`.`userId` = ?;",
            "SELECT `id`, `orderId` FROM `OrderItems` AS `OrderItem` WHERE `OrderItem`.`orderId` = ?;",
        );
        assert_eq!(sequelize.orm, Some(Orm::Sequelize));
        assert!(sequelize.transactions[0].findings.iter().any(|f| f.finding.kind == FindingKind::NPlusOne));
        let drizzle = n_plus_one(
            r#"select "id", "user_id" from "orders" where "orders"."user_id" = ?1"#,
            r#"select "id", "order_id" from "order_items" where "order_items"."order_id" = ?1"#,
        );
        assert_eq!(drizzle.orm, Some(Orm::Drizzle));
        assert!(drizzle.transactions[0].findings.iter().any(|f| f.finding.kind == FindingKind::NPlusOne));
    }

    #[test]
    fn settings_tune_detection() {
        let queries: Vec<String> = (0..3)
            .map(|i| format!(r#"{{"at":{i},"durationMs":1,"sql":"SELECT * FROM items WHERE id = ?","vh":"{i}"}}"#))
            .collect();
        let body = format!(r#"{{"type":"transaction","name":"GET /x","start":0,"queries":[{}]}}"#, queries.join(","));
        let strict = ProjectSettings { loop_min: 3, ..ProjectSettings::default() };
        let found = |settings| digest(&DigestRequest { body: body.clone(), orm: None, settings }).transactions[0].findings.len();
        assert_eq!(found(ProjectSettings::default()), 0);
        assert_eq!(found(strict), 1);
    }
}
