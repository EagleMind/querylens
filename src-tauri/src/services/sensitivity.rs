//! Parameter sensitivity: plan the same parameterized statement with representative
//! values (common, rare, absent) and with the generic plan a prepared statement would
//! reuse, to find plans that flip with the data.
//!
//! Estimates only (plain EXPLAIN): nothing is executed, so it's fast and safe.

use std::collections::BTreeSet;

use crate::error::{AppError, AppResult};
use crate::model::{AnalysisResult, ColumnInfo, ExplainMode, PlanNode, SensitivityReport, SensitivityRow};
use crate::plan;
use crate::services::analysis::{self, Limits, RunOptions};
use crate::storage::Store;

const ABSENT_TEXT: &str = "__querylens_absent__";
const ABSENT_NUMBER: &str = "-987654321";

/// The column compared with `$n`: `col = $n`, `t.col >= $n`, `$n = col`, `col IN ($n…)`,
/// `col LIKE $n`. Lowercase, without the table alias.
pub fn param_column(sql: &str, n: usize) -> Option<String> {
    let lower = sql.to_ascii_lowercase();
    let needle = format!("${n}");
    let is_ident = |c: char| c.is_ascii_alphanumeric() || c == '_' || c == '.';
    for (pos, _) in lower.match_indices(&needle) {
        if lower[pos + needle.len()..].starts_with(|c: char| c.is_ascii_digit()) {
            continue; // $1 inside $12
        }
        // Left side: `<ident> <op> [ ( ] $n`
        let left = lower[..pos].trim_end().trim_end_matches('(').trim_end();
        let ops = ["<>", "!=", ">=", "<=", "=", "<", ">", " not like", " ilike", " like", " not in", " in"];
        if let Some(op) = ops.iter().find(|o| left.ends_with(*o)) {
            let before = left[..left.len() - op.len()].trim_end();
            let ident: String = before.chars().rev().take_while(|c| is_ident(*c)).collect::<Vec<_>>().into_iter().rev().collect();
            if let Some(col) = ident.rsplit('.').next().filter(|c| !c.is_empty() && !c.starts_with(|ch: char| ch.is_ascii_digit())) {
                return Some(col.to_string());
            }
        }
        // Right side: `$n <op> <ident>`
        let right = lower[pos + needle.len()..].trim_start();
        if let Some(op) = ["<>", "!=", ">=", "<=", "=", "<", ">"].iter().find(|o| right.starts_with(*o)) {
            let ident: String = right[op.len()..].trim_start().chars().take_while(|c| is_ident(*c)).collect();
            if let Some(col) = ident.rsplit('.').next().filter(|c| !c.is_empty()) {
                return Some(col.to_string());
            }
        }
    }
    None
}

/// "Index Scan using events_kind_idx on events + Hash Join" style summary of how the
/// plan reaches the data.
fn shape(root: &PlanNode) -> String {
    let mut parts: Vec<String> = Vec::new();
    plan::walk(root, &mut |n| {
        let part = match (&n.relation, &n.index_name) {
            (Some(r), Some(i)) => format!("{} using {i} on {r}", n.node_type),
            (Some(r), None) => format!("{} on {r}", n.node_type),
            _ if n.node_type.contains("Join") || n.node_type.contains("Nested Loop") => n.node_type.clone(),
            _ => return,
        };
        if !parts.contains(&part) {
            parts.push(part);
        }
    });
    parts.truncate(3);
    parts.join(" + ")
}

fn absent_value(col: &ColumnInfo) -> Option<&'static str> {
    let t = col.data_type.to_ascii_lowercase();
    if ["int", "numeric", "double", "real", "decimal", "serial"].iter().any(|k| t.contains(k)) {
        Some(ABSENT_NUMBER)
    } else if ["text", "char", "uuid"].iter().any(|k| t.contains(k)) && !t.contains("uuid") {
        Some(ABSENT_TEXT)
    } else {
        None
    }
}

struct Candidate {
    label: String,
    value: Option<String>,
    frequency: Option<f64>,
}

fn candidates(current: Option<&String>, col: Option<&ColumnInfo>) -> Vec<Candidate> {
    let mut out = vec![Candidate { label: "your value".into(), value: current.cloned(), frequency: None }];
    if let Some(stats) = col.and_then(|c| c.stats.as_ref()) {
        let freq_of = |v: &str| stats.common_values.iter().position(|c| c == v).and_then(|i| stats.common_freqs.get(i).copied());
        out[0].frequency = current.and_then(|v| freq_of(v));
        if let Some(v) = stats.common_values.first() {
            out.push(Candidate { label: "most common".into(), value: Some(v.clone()), frequency: stats.common_freqs.first().copied() });
        }
        if stats.common_values.len() > 1 {
            let i = stats.common_values.len() - 1;
            out.push(Candidate { label: "less common".into(), value: Some(stats.common_values[i].clone()), frequency: stats.common_freqs.get(i).copied() });
        }
        if let Some(v) = stats.histogram.get(stats.histogram.len() / 2) {
            out.push(Candidate { label: "rare".into(), value: Some(v.clone()), frequency: None });
        }
    }
    if let Some(v) = col.and_then(absent_value) {
        out.push(Candidate { label: "absent".into(), value: Some(v.into()), frequency: Some(0.0) });
    }
    // Drop duplicate values, keeping the first label.
    let mut seen = BTreeSet::new();
    out.retain(|c| seen.insert(c.value.clone()));
    out
}

pub async fn sensitivity(store: &Store, baseline: &AnalysisResult) -> AppResult<Vec<SensitivityReport>> {
    if baseline.params.is_empty() {
        return Err(AppError::validation("This query has no $n parameters to vary."));
    }
    let conn = store.get_connection(&baseline.connection_id)?;
    let spec = analysis::spec_for(&conn)?;
    let limits = Limits::from_settings(&store.get_settings()?.analysis);
    let plan_with = |params: Vec<Option<String>>, generic: bool| RunOptions {
        params,
        generic_plan: generic,
        read_only: true,
        ..RunOptions::new(ExplainMode::Estimate)
    };

    // The generic plan doesn't depend on the values; plan it once.
    let generic = analysis::explain(&conn, &spec, &baseline.sql, &plan_with(baseline.params.clone(), true), limits).await?;

    let mut reports = Vec::new();
    for (i, current) in baseline.params.iter().enumerate() {
        let column = param_column(&baseline.sql, i + 1);
        let col_info = column
            .as_ref()
            .and_then(|c| baseline.tables.iter().flat_map(|t| &t.columns).find(|ci| ci.name.eq_ignore_ascii_case(c)));
        let mut rows = Vec::new();
        for cand in candidates(current.as_ref(), col_info) {
            let mut params = baseline.params.clone();
            params[i] = cand.value.clone();
            let est = analysis::explain(&conn, &spec, &baseline.sql, &plan_with(params, false), limits).await?;
            rows.push(SensitivityRow {
                label: cand.label,
                value: cand.value,
                frequency: cand.frequency,
                plan_fp: est.plan_fp.clone(),
                shape: shape(&est.root),
                cost: est.total_cost,
                generic: false,
            });
        }
        let shapes: BTreeSet<&str> = rows.iter().map(|r| r.plan_fp.as_str()).collect();
        let flips = shapes.len() > 1;
        let generic_differs = rows.first().is_some_and(|r| r.plan_fp != generic.plan_fp);
        rows.push(SensitivityRow {
            label: "generic plan".into(),
            value: None,
            frequency: None,
            plan_fp: generic.plan_fp.clone(),
            shape: shape(&generic.root),
            cost: generic.total_cost,
            generic: true,
        });
        let summary = summarize(i + 1, column.as_deref(), &rows, flips, generic_differs);
        reports.push(SensitivityReport { param: (i + 1) as u32, column, rows, flips, summary });
    }
    Ok(reports)
}

fn summarize(n: usize, column: Option<&str>, rows: &[SensitivityRow], flips: bool, generic_differs: bool) -> String {
    let target = column.map(|c| format!("${n} ({c})")).unwrap_or_else(|| format!("${n}"));
    let generic = rows.iter().find(|r| r.generic);
    let mut s = if flips {
        let mut by_shape: Vec<(String, Vec<&str>)> = Vec::new();
        for r in rows.iter().filter(|r| !r.generic) {
            match by_shape.iter_mut().find(|(sh, _)| *sh == r.shape) {
                Some((_, labels)) => labels.push(&r.label),
                None => by_shape.push((r.shape.clone(), vec![&r.label])),
            }
        }
        let parts: Vec<String> = by_shape.iter().map(|(sh, l)| format!("{sh} for {} values", l.join("/"))).collect();
        format!("The plan flips with {target}: {}.", parts.join("; "))
    } else {
        format!("Same plan for every value of {target} that was tried.")
    };
    if let Some(g) = generic {
        if generic_differs || flips {
            s.push_str(&format!(
                " A prepared statement's generic plan (used after 5 executions) is {}, the same for every value. If \
                 that is wrong for common values, consider plan_cache_mode = force_custom_plan for this query.",
                g.shape
            ));
        }
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_parameters_to_columns() {
        assert_eq!(param_column("select * from events e where e.kind = $1", 1).as_deref(), Some("kind"));
        assert_eq!(param_column("select * from t where $2 <= created_at and a = $1", 2).as_deref(), Some("created_at"));
        assert_eq!(param_column("select * from t where status in ($1, $2)", 1).as_deref(), Some("status"));
        assert_eq!(param_column("select * from t where name like $3", 3).as_deref(), Some("name"));
        assert_eq!(param_column("select * from t where a = $12", 1), None);
        assert_eq!(param_column("select $1", 1), None);
    }
}
