//! Finding problems in captured traffic. Pure: statements in, statistics and
//! findings out. Plan-based findings and ORM-specific fixes are added later by
//! [`crate::capture::report`].

mod loops;
mod rules;
mod stats;

use std::collections::{HashMap, HashSet};

pub use rules::subject;
pub use stats::origins;

use crate::format::{fmt_count, fmt_ms};
use crate::model::{CaptureFinding, CapturedStatement, FindingKind, FingerprintStat, StatementKind, SuggestionSeverity};

/// Detection sensitivity.
#[derive(Debug, Clone, Copy)]
pub struct Thresholds {
    /// Executions in a row that make a loop.
    pub loop_min: u32,
    /// Other statements allowed between two executions of one loop.
    pub loop_max_between: usize,
    /// Pause allowed between two executions of one loop, ms.
    pub loop_max_gap_ms: f64,
    pub slow_ms: f64,
    pub large_rows: f64,
    pub large_bytes: f64,
    /// Statements in one request that make it chatty.
    pub chatty: u32,
}

impl Default for Thresholds {
    fn default() -> Self {
        Self {
            loop_min: 5,
            loop_max_between: 8,
            loop_max_gap_ms: 500.0,
            slow_ms: 100.0,
            large_rows: 1000.0,
            large_bytes: 1024.0 * 1024.0,
            chatty: 50,
        }
    }
}

pub struct Detection {
    pub fingerprints: Vec<FingerprintStat>,
    pub findings: Vec<CaptureFinding>,
    /// Distinct requests / traces tagged in the SQL.
    pub units: u32,
}

/// `statements` must be in start order (as storage returns them).
pub fn detect(statements: &[CapturedStatement], t: &Thresholds) -> Detection {
    let fingerprints = stats::fingerprints(statements);
    let by_fp: HashMap<&str, &FingerprintStat> = fingerprints.iter().map(|f| (f.fingerprint.as_str(), f)).collect();

    let mut findings = Vec::new();
    for (fp, l) in loops::find(statements, t) {
        if let Some(stat) = by_fp.get(fp.as_str()) {
            findings.push(loop_finding(stat, &l, statements, &by_fp));
        }
    }
    for stat in &fingerprints {
        findings.extend(rules::slow(stat, t));
        findings.extend(rules::large_result(stat, t));
        findings.extend(rules::errors(stat, statements));
    }
    findings.extend(rules::chatty(statements, &by_fp, t));
    sort(&mut findings);

    let units = statements.iter().filter_map(|s| s.unit.as_deref()).collect::<HashSet<_>>().len() as u32;
    Detection { fingerprints, findings, units }
}

/// Most severe first, then most time; on a tie the root cause first (an N+1 before
/// the plan issue of the same statement).
pub fn sort(findings: &mut [CaptureFinding]) {
    let rank = |s: SuggestionSeverity| match s {
        SuggestionSeverity::High => 0,
        SuggestionSeverity::Medium => 1,
        SuggestionSeverity::Low => 2,
    };
    let cause = |k: FindingKind| match k {
        FindingKind::NPlusOne => 0,
        FindingKind::LoopedWrites => 1,
        FindingKind::DuplicateQuery => 2,
        FindingKind::PlanIssue => 3,
        FindingKind::LargeResult => 4,
        FindingKind::ChattyRequest => 5,
        FindingKind::SlowQuery => 6,
        FindingKind::QueryErrors => 7,
    };
    // Whole milliseconds: the same time summed in a different order must tie.
    let impact = |f: &CaptureFinding| f.impact_ms.round() as i64;
    findings.sort_by(|a, b| {
        rank(a.severity)
            .cmp(&rank(b.severity))
            .then_with(|| impact(b).cmp(&impact(a)))
            .then_with(|| cause(a.kind).cmp(&cause(b.kind)))
            .then_with(|| a.id.cmp(&b.id))
    });
}

/// A finding about one fingerprint, with a stable id (`kind:fingerprint`).
pub(crate) fn finding(
    kind: FindingKind,
    stat: &FingerprintStat,
    severity: SuggestionSeverity,
    title: String,
    detail: String,
    impact_ms: f64,
    occurrences: u32,
) -> CaptureFinding {
    CaptureFinding {
        id: format!("{}:{}", kind.as_str(), stat.fingerprint),
        kind,
        severity,
        title,
        detail,
        fingerprint: stat.fingerprint.clone(),
        parent_fingerprint: None,
        impact_ms,
        occurrences,
        origins: stat.origins.clone(),
        fix: None,
    }
}

fn loop_finding(
    stat: &FingerprintStat,
    l: &loops::LoopStats,
    statements: &[CapturedStatement],
    by_fp: &HashMap<&str, &FingerprintStat>,
) -> CaptureFinding {
    let parent = l.main_parent().and_then(|fp| by_fp.get(fp).copied());
    let (kind, severity) = match stat.kind {
        StatementKind::Select if l.varying_values => {
            let high = l.longest >= 20 || l.time_ms >= 200.0;
            (FindingKind::NPlusOne, if high { SuggestionSeverity::High } else { SuggestionSeverity::Medium })
        }
        StatementKind::Select | StatementKind::Other => {
            (FindingKind::DuplicateQuery, if l.longest >= 10 { SuggestionSeverity::Medium } else { SuggestionSeverity::Low })
        }
        _ => (FindingKind::LoopedWrites, if l.longest >= 50 { SuggestionSeverity::High } else { SuggestionSeverity::Medium }),
    };
    let subject = subject(stat);
    let title = match kind {
        FindingKind::NPlusOne => format!("N+1: {subject}, once per row (up to {}× in a row)", l.longest),
        FindingKind::DuplicateQuery => format!("The same {subject} repeated {}× in a row", l.longest),
        _ => format!("{} one row at a time (up to {}× in a row)", rules::capitalize(&subject), l.longest),
    };
    let mut detail = match (kind, parent) {
        (FindingKind::NPlusOne, Some(p)) => format!(
            "Runs right after {} (which returned up to {} rows), once for each row. ",
            rules::subject(p),
            fmt_count(l.parent_rows)
        ),
        _ => String::new(),
    };
    detail.push_str(&format!(
        "{} {} in this capture, {} executions, {} in total.",
        l.loops,
        if l.loops == 1 { "loop" } else { "loops" },
        fmt_count(l.executions as f64),
        fmt_ms(l.time_ms)
    ));
    let mut f = finding(kind, stat, severity, title, detail, l.time_ms, l.loops);
    f.parent_fingerprint = parent.map(|p| p.fingerprint.clone());
    f.origins = origins(l.members.iter().map(|&i| &statements[i]));
    f
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) fn stmt(at_ms: f64, fp: &str, sql: &str, rows: f64) -> CapturedStatement {
        CapturedStatement {
            seq: 0,
            conn: 1,
            at_ms,
            duration_ms: 0.5,
            fingerprint: fp.into(),
            sql: sql.into(),
            params: Vec::new(),
            rows,
            bytes: rows * 50.0,
            error: None,
            unit: None,
            origin: Some("src/orders.js:12".into()),
            route: None,
        }
    }

    #[test]
    fn n_plus_one_with_parent_and_looped_inserts() {
        let mut s = vec![stmt(0.0, "orders", r#"SELECT "id" FROM "orders" AS "Order" WHERE "Order"."user_id" = 7;"#, 30.0)];
        for i in 0..30 {
            let sql = format!(r#"SELECT * FROM "order_items" AS "OrderItem" WHERE "OrderItem"."order_id" = {i};"#);
            s.push(stmt(1.0 + i as f64, "items", &sql, 2.0));
        }
        for i in 0..6 {
            s.push(stmt(100.0 + i as f64, "ins", &format!("INSERT INTO \"events\" (\"kind\") VALUES ('v{i}')"), 1.0));
        }
        let d = detect(&s, &Thresholds::default());
        let n1 = d.findings.iter().find(|f| f.kind == FindingKind::NPlusOne).unwrap();
        assert_eq!(n1.id, "n_plus_one:items");
        assert_eq!(n1.severity, SuggestionSeverity::High);
        assert_eq!(n1.parent_fingerprint.as_deref(), Some("orders"));
        assert!(n1.title.contains("SELECT on order_items"), "{}", n1.title);
        assert!(n1.detail.contains("SELECT on orders"), "{}", n1.detail);
        assert_eq!(n1.origins[0].origin, "src/orders.js:12");
        let writes = d.findings.iter().find(|f| f.kind == FindingKind::LoopedWrites).unwrap();
        assert!(writes.title.starts_with("INSERT into events one row at a time"), "{}", writes.title);
        // Most severe first.
        assert_eq!(d.findings[0].kind, FindingKind::NPlusOne);
    }

    #[test]
    fn slow_large_and_failing_statements() {
        let mut s = vec![stmt(0.0, "big", "SELECT * FROM events", 50_000.0)];
        s[0].duration_ms = 900.0;
        let mut bad = stmt(1.0, "dup", "INSERT INTO users (id) VALUES (1)", 0.0);
        bad.error = Some("ERROR: duplicate key value violates unique constraint (23505)".into());
        s.push(bad);
        let d = detect(&s, &Thresholds::default());
        let kinds: Vec<FindingKind> = d.findings.iter().map(|f| f.kind).collect();
        assert!(kinds.contains(&FindingKind::SlowQuery));
        assert!(kinds.contains(&FindingKind::LargeResult));
        let err = d.findings.iter().find(|f| f.kind == FindingKind::QueryErrors).unwrap();
        assert!(err.detail.contains("23505"));
        assert_eq!(d.fingerprints[0].fingerprint, "big");
    }

    #[test]
    fn chatty_requests_are_grouped_by_route() {
        let mut s = Vec::new();
        for i in 0..60 {
            let mut x = stmt(i as f64 * 1000.0, &format!("q{}", i % 3), "SELECT 1", 1.0);
            x.unit = Some("r1".into());
            x.route = Some("GET /orders".into());
            s.push(x);
        }
        let d = detect(&s, &Thresholds::default());
        let chatty = d.findings.iter().find(|f| f.kind == FindingKind::ChattyRequest).unwrap();
        assert_eq!(chatty.id, "chatty_request:GET /orders");
        assert!(chatty.title.starts_with("GET /orders runs 60 statements"), "{}", chatty.title);
        assert_eq!(d.units, 1);
    }
}
