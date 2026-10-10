//! Engine-agnostic scoring: exclusive time / cost, share of total, heat, and
//! the warnings that only need normalized fields.

use crate::model::{Heat, PlanNode, WarningKind, WarningSeverity};

use super::{fmt_count, warning};

const HIGH_SHARE: f64 = 0.25;
const MEDIUM_SHARE: f64 = 0.05;
const ESTIMATE_ERROR_RATIO: f64 = 10.0;
const ESTIMATE_ERROR_MIN_ROWS: f64 = 100.0;

pub(super) fn finalize(root: &mut PlanNode) {
    fill_times(root);

    let total_self_time = sum(root, &|n| n.self_time_ms);
    let total_self_cost = sum(root, &|n| n.self_cost);
    let basis = if total_self_time > 0.0 {
        Basis::Time(total_self_time)
    } else if total_self_cost > 0.0 {
        Basis::Cost(total_self_cost)
    } else {
        Basis::None
    };
    score(root, basis, false);
}

#[derive(Clone, Copy)]
enum Basis {
    Time(f64),
    Cost(f64),
    None,
}

/// Post-order: derive whichever of inclusive/exclusive time the parser didn't provide,
/// and exclusive cost from inclusive `Total Cost`.
fn fill_times(node: &mut PlanNode) {
    for c in &mut node.children {
        fill_times(c);
    }
    let child_time: f64 = node.children.iter().filter_map(|c| c.total_time_ms).sum();
    match (node.total_time_ms, node.self_time_ms) {
        // Postgres: inclusive time known. Clamp — parallel workers and CTEs can make
        // children "longer" than their parent.
        (Some(total), None) => node.self_time_ms = Some((total - child_time).max(0.0)),
        // DuckDB: exclusive operator timing known.
        (None, Some(own)) => node.total_time_ms = Some(own + child_time),
        _ => {}
    }
    if let Some(total) = node.total_cost {
        let child_cost: f64 = node.children.iter().filter_map(|c| c.total_cost).sum();
        node.self_cost = Some((total - child_cost).max(0.0));
    }
}

fn sum(node: &PlanNode, get: &impl Fn(&PlanNode) -> Option<f64>) -> f64 {
    get(node).unwrap_or(0.0) + node.children.iter().map(|c| sum(c, get)).sum::<f64>()
}

/// Operators that stop pulling rows early, so nodes below them legitimately
/// produce fewer rows than estimated.
const EARLY_STOP: &[&str] = &["Limit", "LIMIT", "STREAMING_LIMIT", "TOP_N"];

fn score(node: &mut PlanNode, basis: Basis, under_limit: bool) {
    node.share = match basis {
        Basis::Time(total) => node.self_time_ms.unwrap_or(0.0) / total,
        Basis::Cost(total) => node.self_cost.unwrap_or(0.0) / total,
        Basis::None => 0.0,
    };
    node.heat = if node.share >= HIGH_SHARE {
        Heat::High
    } else if node.share >= MEDIUM_SHARE {
        Heat::Medium
    } else {
        Heat::Low
    };
    row_estimate_warning(node, under_limit);
    let under_limit = under_limit || EARLY_STOP.contains(&node.node_type.as_str());
    for c in &mut node.children {
        score(c, basis, under_limit);
    }
}

fn row_estimate_warning(node: &mut PlanNode, under_limit: bool) {
    // Hash / Materialize just mirror their child's rows; warning there is noise.
    if matches!(node.node_type.as_str(), "Hash" | "Materialize" | "Memoize") {
        return;
    }
    let (Some(est), Some(actual)) = (node.estimated_rows, node.actual_rows) else { return };
    if node.loops == Some(0.0) || est <= 0.0 {
        return;
    }
    let hi = est.max(actual);
    let lo = est.min(actual).max(1.0);
    let ratio = hi / lo;
    if ratio < ESTIMATE_ERROR_RATIO || hi < ESTIMATE_ERROR_MIN_ROWS {
        return;
    }
    // Below a LIMIT, "fewer rows than estimated" is early termination, not bad stats.
    if under_limit && actual < est {
        return;
    }
    let direction = if actual > est { "under" } else { "over" };
    let severity = if ratio >= 100.0 { WarningSeverity::Error } else { WarningSeverity::Warning };
    node.warnings.push(warning(
        WarningKind::RowEstimateError,
        severity,
        format!(
            "Planner {direction}estimated rows {ratio:.0}× (estimated {}, actual {}). \
             Stale or missing statistics — try ANALYZE on the table, or extended statistics \
             for correlated columns.",
            fmt_count(est),
            fmt_count(actual),
        ),
    ));
}

#[cfg(test)]
mod tests {
    use crate::model::{Engine, ExplainMode, WarningKind};
    use crate::plan;

    #[test]
    fn no_overestimate_warning_below_limit() {
        let raw = r#"[{"Plan": {"Node Type": "Limit", "Total Cost": 10, "Plan Rows": 20,
          "Actual Total Time": 1, "Actual Rows": 20, "Actual Loops": 1,
          "Plans": [{"Node Type": "Sort", "Total Cost": 9, "Plan Rows": 16000,
            "Actual Total Time": 1, "Actual Rows": 20, "Actual Loops": 1}]}}]"#;
        let p = plan::parse(Engine::Postgres, ExplainMode::Analyze, raw).unwrap();
        assert!(p.root.children[0].warnings.iter().all(|w| w.kind != WarningKind::RowEstimateError));
    }
}
