//! Re-planning captured statements with the values they ran with, and testing an
//! index where the plan scans a large table to find a few rows.

use crate::capture::sql::shape;
use crate::engines;
use crate::model::{
    AnalysisResult, ExplainMode, FingerprintStat, IndexCheck, PlanCheck, PlanNode, PlanWarning, StatementKind,
    WarningKind, WarningSeverity,
};
use crate::plan;
use crate::services::analysis::{self, Limits, RunOptions};
use crate::services::index_test::{self, IndexTestOptions};
use crate::services::target::Target;

/// How far plan checks go.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlanDepth {
    Off,
    /// Planner estimates only: nothing is executed.
    Explain,
    /// SELECTs are executed once more (read-only, rolled back) for real timings and
    /// row counts; writes are still only explained.
    Profile,
}

/// A table this large scanned to return a small fraction of it wants an index.
const LARGE_TABLE_ROWS: f64 = 10_000.0;
/// Size that counts as large when the table has no statistics (never analyzed).
const LARGE_TABLE_BYTES: f64 = 8.0 * 1024.0 * 1024.0;
const SMALL_FRACTION: f64 = 0.01;
/// Rows kept that still count as "a few" when the table size in rows is unknown.
const FEW_ROWS: f64 = 10_000.0;
/// Don't build a test index (no HypoPG) on tables larger than this.
const BUILD_LIMIT_ROWS: f64 = 5_000_000.0;

pub async fn check_all(target: &Target, limits: Limits, stats: &[&FingerprintStat], depth: PlanDepth) -> Vec<PlanCheck> {
    let mut out = Vec::with_capacity(stats.len());
    for stat in stats {
        out.push(check(target, limits, stat, depth).await);
    }
    out
}

async fn check(target: &Target, limits: Limits, stat: &FingerprintStat, depth: PlanDepth) -> PlanCheck {
    let mode = if depth == PlanDepth::Profile && stat.kind == StatementKind::Select {
        ExplainMode::Analyze
    } else {
        ExplainMode::Estimate
    };
    let mut check = PlanCheck {
        fingerprint: stat.fingerprint.clone(),
        mode,
        shape: String::new(),
        plan_fp: String::new(),
        total_cost: None,
        execution_ms: None,
        warnings: Vec::new(),
        index: None,
        error: None,
    };
    if engines::placeholder_count(&stat.sample_sql) > stat.sample_params.len() {
        check.error = Some("The parameter values of this statement weren't captured (binary format), so it can't be re-planned.".into());
        return check;
    }
    let opts = RunOptions { read_only: true, params: stat.sample_params.clone(), ..RunOptions::new(mode) };
    let analysis = match analysis::explain(&target.conn, &target.spec, &stat.sample_sql, &opts, limits).await {
        Ok(a) => a,
        Err(e) => {
            check.error = Some(e.message);
            return check;
        }
    };
    check.shape = shape_of(&analysis.root);
    check.plan_fp = analysis.plan_fp.clone();
    check.total_cost = analysis.total_cost;
    check.execution_ms = analysis.execution_time_ms;
    check.warnings = warnings(&analysis);

    if let Some(ddl) = index_candidate(&analysis, &stat.sample_sql) {
        let rows = table_rows(&analysis, &ddl);
        let opts = IndexTestOptions {
            params: stat.sample_params.clone(),
            runs: 1,
            allow_build: depth == PlanDepth::Profile && rows <= BUILD_LIMIT_ROWS,
        };
        match index_test::test(target, limits, &stat.sample_sql, std::slice::from_ref(&ddl), opts).await {
            Ok(t) => {
                let used = !t.used.is_empty() && t.after < t.before;
                check.index = Some(IndexCheck { ddl, evidence: t.evidence, before: t.before, after: t.after, used });
            }
            Err(e) => log::debug!("index test skipped for {}: {}", stat.fingerprint, e.message),
        }
    }
    check
}

/// Data access steps, outermost first: "Seq Scan on order_items · Index Scan on orders (orders_pkey)".
fn shape_of(root: &PlanNode) -> String {
    let mut steps = Vec::new();
    plan::walk(root, &mut |n| {
        if let Some(rel) = &n.relation {
            steps.push(match &n.index_name {
                Some(idx) => format!("{} on {rel} ({idx})", n.node_type),
                None => format!("{} on {rel}", n.node_type),
            });
        }
    });
    if steps.is_empty() {
        steps.push(root.node_type.clone());
    }
    steps.truncate(4);
    steps.join(" · ")
}

/// The plan's own warnings, plus a missing-index warning the estimate can't give:
/// a sequential scan of a large table expected to keep only a few rows.
fn warnings(a: &AnalysisResult) -> Vec<PlanWarning> {
    let mut out: Vec<PlanWarning> = Vec::new();
    plan::walk(&a.root, &mut |n| out.extend(n.warnings.iter().cloned()));
    if !out.iter().any(|w| w.kind == WarningKind::MissingIndex)
        && let Some(scan) = selective_seq_scan(a)
    {
        let size = match scan.table_rows {
            Some(rows) => format!("all ~{} rows", plan::fmt_count(rows)),
            None => format!("the whole table ({}, never analyzed)", crate::format::fmt_bytes(scan.table_bytes)),
        };
        out.push(PlanWarning {
            kind: WarningKind::MissingIndex,
            severity: WarningSeverity::Error,
            message: format!(
                "Seq Scan on {} reads {size} to keep ~{}. An index on the filtered column(s) would find them directly.",
                scan.relation,
                plan::fmt_count(scan.kept)
            ),
        });
        if scan.table_rows.is_none() {
            out.push(PlanWarning {
                kind: WarningKind::RowEstimateError,
                severity: WarningSeverity::Warning,
                message: format!(
                    "{} has no planner statistics, so every row estimate on it is a guess. Run ANALYZE {}.",
                    scan.relation, scan.relation
                ),
            });
        }
    }
    out
}

struct SelectiveScan {
    relation: String,
    table_rows: Option<f64>,
    table_bytes: f64,
    kept: f64,
}

/// The first Seq Scan with a filter that keeps a small fraction of a large table.
fn selective_seq_scan(a: &AnalysisResult) -> Option<SelectiveScan> {
    let mut found = None;
    plan::walk(&a.root, &mut |n| {
        if found.is_some() || !n.node_type.ends_with("Seq Scan") || !n.properties.iter().any(|p| p.key == "Filter") {
            return;
        }
        let Some(rel) = n.relation.as_deref() else { return };
        let Some(table) = a.tables.iter().find(|t| t.name.rsplit('.').next() == Some(rel)) else { return };
        let kept = n.actual_rows.or(n.estimated_rows).unwrap_or(0.0);
        let bytes = table.size_bytes.unwrap_or(0.0);
        let (large, selective) = match table.row_estimate {
            Some(rows) => (rows >= LARGE_TABLE_ROWS, kept <= rows * SMALL_FRACTION),
            None => (bytes >= LARGE_TABLE_BYTES, kept <= FEW_ROWS),
        };
        if large && selective {
            found = Some(SelectiveScan { relation: rel.to_string(), table_rows: table.row_estimate, table_bytes: bytes, kept });
        }
    });
    found
}

/// `CREATE INDEX ON "t" ("a", "b")` for the first scanned-but-filtered table: its
/// equality columns, then one range column. None if an index already leads with them.
fn index_candidate(a: &AnalysisResult, sql: &str) -> Option<String> {
    let scanned: Vec<String> = {
        let mut v = Vec::new();
        plan::walk(&a.root, &mut |n| {
            let flagged = n.warnings.iter().any(|w| matches!(w.kind, WarningKind::MissingIndex | WarningKind::SeqScanLarge));
            if n.node_type.ends_with("Seq Scan") && flagged {
                v.extend(n.relation.clone());
            }
        });
        v.extend(selective_seq_scan(a).map(|s| s.relation));
        v
    };
    let filters = shape::filters(sql);
    for rel in scanned {
        let on_rel = |f: &&shape::Filter| f.table.as_deref() == Some(rel.as_str());
        let mut columns: Vec<&str> = filters.iter().filter(on_rel).filter(|f| f.equality).map(|f| f.column.as_str()).take(2).collect();
        if let Some(range) = filters.iter().filter(on_rel).find(|f| !f.equality) {
            columns.push(&range.column);
        }
        let Some(first) = columns.first() else { continue };
        let already = a
            .tables
            .iter()
            .filter(|t| t.name.rsplit('.').next() == Some(rel.as_str()))
            .flat_map(|t| &t.indexes)
            .any(|i| leading_column(&i.definition).is_some_and(|c| c == *first));
        if already {
            continue;
        }
        let cols: Vec<String> = columns.iter().map(|c| format!("\"{c}\"")).collect();
        return Some(format!("CREATE INDEX ON \"{rel}\" ({})", cols.join(", ")));
    }
    None
}

/// First column of `CREATE INDEX … USING btree (col, …)`.
fn leading_column(definition: &str) -> Option<&str> {
    let cols = definition.rsplit_once('(')?.1;
    let first = cols.split([',', ')']).next()?.trim();
    Some(first.trim_matches('"'))
}

fn table_rows(a: &AnalysisResult, ddl: &str) -> f64 {
    let rel = ddl.split('"').nth(1).unwrap_or_default();
    a.tables.iter().find(|t| t.name.rsplit('.').next() == Some(rel)).and_then(|t| t.row_estimate).unwrap_or(f64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn leading_columns() {
        assert_eq!(leading_column("CREATE INDEX events_kind_idx ON public.events USING btree (kind)"), Some("kind"));
        assert_eq!(leading_column(r#"CREATE UNIQUE INDEX x ON t USING btree ("userId", b)"#), Some("userId"));
    }
}
