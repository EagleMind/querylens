//! One transaction's statements → findings with fixes, using the same detection and
//! ORM advice as a capture report (minus plan checks, which need the database). Pure.

use std::collections::HashMap;

use serde::Serialize;
use ts_rs::TS;

use crate::capture::detect::Thresholds;
use crate::capture::detect;
use crate::capture::orm::{self, HintContext};
use crate::model::{CaptureFinding, CapturedStatement, FingerprintStat, Orm};

#[derive(Debug, Clone)]
pub struct Evaluated {
    pub findings: Vec<Found>,
    /// Recognised from this transaction alone, if it says enough.
    pub orm: Option<Orm>,
}

/// A finding with the statements it's about, as the backend stores it.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Found {
    pub finding: CaptureFinding,
    pub sample_sql: String,
    pub parent_sql: Option<String>,
}

/// `known_orm`: what earlier traffic of the project showed, used when this transaction
/// alone is too small to recognise the ORM. MongoDB operations are advised for by how
/// they were issued (Mongoose or the driver), whatever the app's SQL ORM.
pub fn evaluate(statements: &[CapturedStatement], known_orm: Option<Orm>, t: &Thresholds) -> Evaluated {
    let detection = detect::detect(statements, t);
    let sql_orm = orm::recognize(&detection.fingerprints);
    let orm = sql_orm.or_else(|| orm::recognize_mongo(&detection.fingerprints));
    let known_sql = known_orm.filter(|o| !matches!(o, Orm::Mongoose | Orm::MongoDb));
    let sql_advisor = orm::advisor(sql_orm.or(known_sql));
    let stats: HashMap<&str, &FingerprintStat> = detection.fingerprints.iter().map(|f| (f.fingerprint.as_str(), f)).collect();
    let findings = detection
        .findings
        .into_iter()
        .filter_map(|mut finding| {
            let stat = *stats.get(finding.fingerprint.as_str())?;
            let parent = finding.parent_fingerprint.as_deref().and_then(|p| stats.get(p).copied());
            let ctx = HintContext { stat, parent, plan: None };
            finding.fix = match orm::mongo_api(&stat.sample_sql) {
                Some(api) => orm::advisor(Some(api)).fix(&finding, &ctx),
                None => sql_advisor.fix(&finding, &ctx),
            };
            Some(Found { sample_sql: stat.sample_sql.clone(), parent_sql: parent.map(|p| p.sample_sql.clone()), finding })
        })
        .collect();
    Evaluated { findings, orm }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::FindingKind;
    use crate::monitor::envelope;

    /// A Sequelize N+1 as the SDK sends it in production: scrubbed SQL, value hashes.
    #[test]
    fn scrubbed_n_plus_one_gets_a_sequelize_fix() {
        let mut queries = vec![format!(
            r#"{{"at":0,"durationMs":2,"sql":"SELECT \"id\" FROM \"orders\" AS \"Order\" WHERE \"Order\".\"user_id\" = ?;","vh":"p","rows":12,"origin":"src/orders.js:10"}}"#
        )];
        for i in 0..12 {
            queries.push(format!(
                r#"{{"at":{},"durationMs":1,"sql":"SELECT \"id\", \"order_id\" FROM \"order_items\" AS \"OrderItem\" WHERE \"OrderItem\".\"order_id\" = ?;","vh":"v{i}","rows":2,"origin":"src/orders.js:13"}}"#,
                3 + i
            ));
        }
        let body = format!(
            r#"{{"type":"transaction","name":"GET /orders","start":0,"durationMs":30,"queries":[{}]}}"#,
            queries.join(",")
        );
        let env = envelope::parse(&body);
        let statements = env.transactions[0].statements();
        let out = evaluate(&statements, None, &Thresholds::default());
        assert_eq!(out.orm, Some(Orm::Sequelize));
        let n1 = out.findings.iter().find(|f| f.finding.kind == FindingKind::NPlusOne).expect("an N+1");
        assert_eq!(n1.finding.origins[0].origin, "src/orders.js:13");
        assert!(n1.parent_sql.as_deref().unwrap().contains("\"orders\""));
        let fix = n1.finding.fix.as_ref().expect("a fix");
        assert_eq!(fix.orm, Some(Orm::Sequelize));
        assert!(fix.code.as_deref().unwrap_or_default().contains("include"), "{fix:?}");
    }

    /// The same N+1 from Sequelize on MySQL: backtick identifiers, `?` placeholders.
    #[test]
    fn mysql_n_plus_one_gets_a_sequelize_fix() {
        let mut queries = vec![
            r#"{"at":0,"durationMs":2,"sql":"SELECT `id` FROM `orders` AS `Order` WHERE `Order`.`user_id` = ?;","vh":"p","rows":8}"#.to_string(),
        ];
        for i in 0..8 {
            queries.push(format!(
                r#"{{"at":{},"durationMs":1,"sql":"SELECT `id`, `order_id` FROM `order_items` AS `OrderItem` WHERE `OrderItem`.`order_id` = ?;","vh":"v{i}","rows":2}}"#,
                1 + i
            ));
        }
        let body = format!(r#"{{"type":"transaction","name":"GET /orders","start":0,"queries":[{}]}}"#, queries.join(","));
        let statements = envelope::parse(&body).transactions[0].statements();
        let out = evaluate(&statements, None, &Thresholds::default());
        assert_eq!(out.orm, Some(Orm::Sequelize));
        let n1 = out.findings.iter().find(|f| f.finding.kind == FindingKind::NPlusOne).expect("an N+1");
        assert!(n1.finding.title.contains("SELECT on order_items"), "{}", n1.finding.title);
        let code = n1.finding.fix.as_ref().and_then(|f| f.code.clone()).unwrap_or_default();
        assert!(code.contains("include: [{ model: OrderItem"), "{code}");
    }

    /// A Drizzle N+1 (a core `select` per order): recognized, and fixed with `with`.
    #[test]
    fn drizzle_n_plus_one_gets_a_drizzle_fix() {
        let mut queries = vec![
            r#"{"at":0,"durationMs":2,"sql":"select \"id\", \"user_id\" from \"orders\" where \"orders\".\"user_id\" = $1","vh":"p","rows":8}"#.to_string(),
        ];
        for i in 0..8 {
            queries.push(format!(
                r#"{{"at":{},"durationMs":1,"sql":"select \"id\", \"order_id\", \"quantity\" from \"order_items\" where \"order_items\".\"order_id\" = $1","vh":"v{i}","rows":2}}"#,
                1 + i
            ));
        }
        let body = format!(r#"{{"type":"transaction","name":"GET /orders","start":0,"queries":[{}]}}"#, queries.join(","));
        let statements = envelope::parse(&body).transactions[0].statements();
        let out = evaluate(&statements, None, &Thresholds::default());
        assert_eq!(out.orm, Some(Orm::Drizzle));
        let n1 = out.findings.iter().find(|f| f.finding.kind == FindingKind::NPlusOne).expect("an N+1");
        let code = n1.finding.fix.as_ref().and_then(|f| f.code.clone()).unwrap_or_default();
        assert!(code.contains("db.query.orders.findMany({"), "{code}");
        assert!(code.contains("with: { orderItems: true }"), "{code}");
    }

    /// A Mongoose N+1 as the SDK writes it: recognised, and fixed with `$in` or a virtual.
    #[test]
    fn mongoose_n_plus_one_gets_a_mongoose_fix() {
        let mut queries = vec![serde_json::json!({ "at": 0, "durationMs": 2, "sql": r#"Order.find({"customer": ?})"#, "vh": "p", "rows": 9 })];
        for i in 0..9 {
            queries.push(serde_json::json!({ "at": 3 + i, "durationMs": 1, "sql": r#"OrderItem.find({"order": ?})"#, "vh": format!("v{i}"), "rows": 2, "origin": "src/orders.js:21" }));
        }
        let body = serde_json::json!({ "type": "transaction", "name": "GET /orders", "start": 0, "queries": queries }).to_string();
        let statements = envelope::parse(&body).transactions[0].statements();
        let out = evaluate(&statements, Some(Orm::Prisma), &Thresholds::default());
        assert_eq!(out.orm, Some(Orm::Mongoose));
        let n1 = out.findings.iter().find(|f| f.finding.kind == FindingKind::NPlusOne).expect("an N+1");
        assert!(n1.finding.title.contains("find on OrderItem"), "{}", n1.finding.title);
        let fix = n1.finding.fix.as_ref().expect("a fix");
        assert_eq!(fix.orm, Some(Orm::Mongoose), "MongoDB operations aren't advised as the project's SQL ORM");
        assert!(fix.code.as_deref().unwrap_or_default().contains("populate('orderItems')"), "{fix:?}");
    }

    #[test]
    fn identical_values_are_a_duplicate_not_an_n_plus_one() {
        let statements: Vec<CapturedStatement> = (0..6)
            .map(|i| {
                let mut s = crate::capture::detect::tests::stmt(i as f64, "", "SELECT * FROM settings WHERE key = ?", 1.0);
                s.fingerprint = crate::fingerprint::query_fp(&s.sql);
                s.params = vec![Some("#same".into())];
                s
            })
            .collect();
        let out = evaluate(&statements, None, &Thresholds::default());
        assert!(out.findings.iter().any(|f| f.finding.kind == FindingKind::DuplicateQuery));
        assert!(!out.findings.iter().any(|f| f.finding.kind == FindingKind::NPlusOne));
    }
}
