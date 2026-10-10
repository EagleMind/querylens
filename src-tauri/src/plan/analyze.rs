//! Engine-agnostic scoring: exclusive time / cost, share of total, heat, and
//! the warnings that only need normalized fields.

use crate::model::{Engine, Heat, PlanNode, WarningKind, WarningSeverity};

use super::{fmt_count, warning};

const HIGH_SHARE: f64 = 0.25;
const MEDIUM_SHARE: f64 = 0.05;
const ESTIMATE_ERROR_RATIO: f64 = 10.0;
const IO_BOUND_SHARE: f64 = 0.5;
const ESTIMATE_ERROR_MIN_ROWS: f64 = 100.0;
/// A node's misestimate must be this many times worse than its inputs' to count as its own.
const ORIGIN_FACTOR: f64 = 3.0;

pub(super) fn finalize(root: &mut PlanNode, engine: Engine) {
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
    score(root, basis, false, engine);
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
    if let Some(io) = node.io_time_ms {
        let child_io: f64 = node.children.iter().filter_map(|c| c.io_time_ms).sum();
        // Exclusive I/O can't exceed exclusive time (parallel workers sum their waits).
        let cap = node.self_time_ms.unwrap_or(f64::INFINITY);
        node.self_io_ms = Some((io - child_io).clamp(0.0, cap));
    }
}

fn sum(node: &PlanNode, get: &impl Fn(&PlanNode) -> Option<f64>) -> f64 {
    get(node).unwrap_or(0.0) + node.children.iter().map(|c| sum(c, get)).sum::<f64>()
}

/// Operators that stop pulling rows early, so nodes below them legitimately
/// produce fewer rows than estimated.
const EARLY_STOP: &[&str] = &["Limit", "LIMIT", "STREAMING_LIMIT", "TOP_N"];

fn score(node: &mut PlanNode, basis: Basis, under_limit: bool, engine: Engine) {
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
    row_estimate_warning(node, under_limit, engine);
    io_bound_warning(node);
    let under_limit = under_limit || EARLY_STOP.contains(&node.node_type.as_str());
    for c in &mut node.children {
        score(c, basis, under_limit, engine);
    }
}

/// Estimated-vs-actual rows factor (≥ 1), when both are known and the node ran.
fn estimate_ratio(node: &PlanNode) -> Option<f64> {
    let (est, actual) = (node.estimated_rows?, node.actual_rows?);
    if node.loops == Some(0.0) || est <= 0.0 {
        return None;
    }
    Some(est.max(actual) / est.min(actual).max(1.0))
}

/// A hot operator that mostly waits on disk: more memory/cache or fewer pages read
/// help more than CPU-side changes.
fn io_bound_warning(node: &mut PlanNode) {
    let (Some(io), Some(own)) = (node.self_io_ms, node.self_time_ms) else { return };
    if node.heat != Heat::High || own <= 0.0 || io / own < IO_BOUND_SHARE {
        return;
    }
    node.warnings.push(warning(
        WarningKind::IoBound,
        WarningSeverity::Info,
        format!(
            "{:.0}% of this operator's {own:.0} ms is spent waiting on reads. It is I/O-bound: \
             an index that reads fewer pages, or a warmer cache, helps more than CPU tuning.",
            io / own * 100.0
        ),
    ));
}

fn row_estimate_warning(node: &mut PlanNode, under_limit: bool, engine: Engine) {
    // Hash / Materialize just mirror their child's rows; warning there is noise.
    if matches!(node.node_type.as_str(), "Hash" | "Materialize" | "Memoize") {
        return;
    }
    let Some(ratio) = estimate_ratio(node) else { return };
    let (est, actual) = (node.estimated_rows.unwrap_or(0.0), node.actual_rows.unwrap_or(0.0));
    if ratio < ESTIMATE_ERROR_RATIO || est.max(actual) < ESTIMATE_ERROR_MIN_ROWS {
        return;
    }
    // Misestimates propagate upward through every join above them. Flag only the
    // operator where the error originates (clearly worse than any of its inputs).
    let worst_input = node.children.iter().filter_map(estimate_ratio).fold(1.0, f64::max);
    if ratio < worst_input * ORIGIN_FACTOR {
        return;
    }
    // Below a LIMIT, "fewer rows than estimated" is early termination, not bad stats.
    if under_limit && actual < est {
        return;
    }
    let direction = if actual > est { "under" } else { "over" };
    let severity = if ratio >= 100.0 { WarningSeverity::Error } else { WarningSeverity::Warning };
    let fix = match engine {
        Engine::Mysql => {
            "Refresh statistics with ANALYZE TABLE, or add a histogram on the filtered columns \
             (ANALYZE TABLE … UPDATE HISTOGRAM ON …)."
        }
        _ => {
            "Stale or missing statistics — try ANALYZE on the table, or extended statistics \
             for correlated columns."
        }
    };
    node.warnings.push(warning(
        WarningKind::RowEstimateError,
        severity,
        format!(
            "Planner {direction}estimated rows {ratio:.0}× (estimated {}, actual {}). {fix}",
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
