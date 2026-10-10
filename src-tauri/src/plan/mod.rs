//! Engine EXPLAIN output → normalized `PlanNode` tree → scored and annotated.

mod analyze;
mod duckdb;
mod postgres;

use serde_json::Value;

use crate::error::AppResult;
use crate::model::{Engine, ExplainMode, Heat, PlanNode, PlanWarning, WarningKind, WarningSeverity};

pub struct ParsedPlan {
    pub root: PlanNode,
    pub planning_time_ms: Option<f64>,
    pub execution_time_ms: Option<f64>,
    pub total_cost: Option<f64>,
}

pub fn parse(engine: Engine, mode: ExplainMode, raw: &str) -> AppResult<ParsedPlan> {
    let mut plan = match engine {
        Engine::Postgres => postgres::parse(raw)?,
        Engine::Duckdb => duckdb::parse(raw, mode)?,
    };
    analyze::finalize(&mut plan.root);
    Ok(plan)
}

/// Distinct relation names referenced anywhere in the plan, in first-seen order.
pub fn relations(root: &PlanNode) -> Vec<String> {
    let mut out = Vec::new();
    walk(root, &mut |n| {
        if let Some(r) = &n.relation {
            if !out.contains(r) {
                out.push(r.clone());
            }
        }
    });
    out
}

pub fn count_nodes(root: &PlanNode) -> u32 {
    let mut count = 0;
    walk(root, &mut |_| count += 1);
    count
}

pub fn count_warnings(root: &PlanNode) -> u32 {
    let mut count = 0;
    walk(root, &mut |n| count += n.warnings.len() as u32);
    count
}

pub fn walk<'a>(node: &'a PlanNode, f: &mut impl FnMut(&'a PlanNode)) {
    f(node);
    for c in &node.children {
        walk(c, f);
    }
}

pub(crate) fn blank_node(id: String, node_type: String) -> PlanNode {
    PlanNode {
        id,
        node_type,
        relation: None,
        alias: None,
        index_name: None,
        detail: None,
        estimated_rows: None,
        actual_rows: None,
        loops: None,
        startup_cost: None,
        total_cost: None,
        total_time_ms: None,
        self_time_ms: None,
        self_cost: None,
        share: 0.0,
        heat: Heat::Low,
        buffers: None,
        warnings: Vec::new(),
        properties: Vec::new(),
        children: Vec::new(),
    }
}

pub(crate) fn warning(kind: WarningKind, severity: WarningSeverity, message: String) -> PlanWarning {
    PlanWarning { kind, severity, message }
}

/// Render a JSON scalar/array as a single readable line.
pub(crate) fn fmt_value(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Array(items) => items.iter().map(fmt_value).collect::<Vec<_>>().join(", "),
        Value::Null => "null".into(),
        Value::Number(n) => match n.as_f64() {
            Some(f) if f.fract() == 0.0 && f.abs() < 1e15 => format!("{}", f as i64),
            _ => n.to_string(),
        },
        other => other.to_string(),
    }
}

/// 1234 → "1.2k", 2_500_000 → "2.5M".
pub(crate) fn fmt_count(n: f64) -> String {
    let abs = n.abs();
    if abs >= 1e9 {
        format!("{:.1}B", n / 1e9)
    } else if abs >= 1e6 {
        format!("{:.1}M", n / 1e6)
    } else if abs >= 1e4 {
        format!("{:.0}k", n / 1e3)
    } else if abs >= 1e3 {
        format!("{:.1}k", n / 1e3)
    } else {
        format!("{n:.0}")
    }
}
