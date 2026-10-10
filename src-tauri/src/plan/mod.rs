//! Engine EXPLAIN output → normalized `PlanNode` tree → scored and annotated.

mod analyze;
pub mod diff;
mod duckdb;
pub mod fingerprint;
mod mongo;
mod mysql;
mod postgres;

use serde_json::Value;

use crate::error::AppResult;
use crate::model::{Engine, ExplainMode, Heat, PlanNode, PlanProperty, PlanWarning, WarningKind, WarningSeverity};

pub struct ParsedPlan {
    pub root: PlanNode,
    pub planning_time_ms: Option<f64>,
    pub execution_time_ms: Option<f64>,
    pub total_cost: Option<f64>,
    pub jit_ms: Option<f64>,
    pub serialize_ms: Option<f64>,
    pub serialize_bytes: Option<f64>,
    pub planner_settings: Vec<PlanProperty>,
}

/// Plan-level warning thresholds (fractions of execution time).
const JIT_OVERHEAD_SHARE: f64 = 0.1;
const SERIALIZE_HEAVY_SHARE: f64 = 0.2;

pub fn parse(engine: Engine, mode: ExplainMode, raw: &str) -> AppResult<ParsedPlan> {
    parse_query(engine, mode, raw, "")
}

/// Like [`parse`], with the query text for engines whose plans name tables by alias (MySQL).
pub fn parse_query(engine: Engine, mode: ExplainMode, raw: &str, sql: &str) -> AppResult<ParsedPlan> {
    let mut plan = match engine {
        Engine::Postgres => postgres::parse(raw)?,
        Engine::Duckdb => duckdb::parse(raw, mode)?,
        Engine::Mysql => mysql::parse(raw, mode, sql)?,
        Engine::Mongodb => mongo::parse(raw, mode)?,
    };
    analyze::finalize(&mut plan.root, engine);
    plan_level_warnings(&mut plan);
    Ok(plan)
}

/// Costs that belong to the whole statement are reported on the root node.
fn plan_level_warnings(plan: &mut ParsedPlan) {
    let Some(exec) = plan.execution_time_ms.filter(|e| *e > 0.0) else { return };
    if let Some(jit) = plan.jit_ms.filter(|j| j / exec >= JIT_OVERHEAD_SHARE) {
        plan.root.warnings.push(warning(
            WarningKind::JitOverhead,
            WarningSeverity::Warning,
            format!(
                "JIT compilation took {jit:.0} ms ({:.0}% of execution). For short queries it rarely \
                 pays off: try SET jit = off, or raise jit_above_cost.",
                jit / exec * 100.0
            ),
        ));
    }
    if let Some(ser) = plan.serialize_ms.filter(|s| s / exec >= SERIALIZE_HEAVY_SHARE) {
        let size = plan.serialize_bytes.map(|b| format!(" ({} kB)", fmt_count(b / 1024.0))).unwrap_or_default();
        plan.root.warnings.push(warning(
            WarningKind::SerializeHeavy,
            WarningSeverity::Info,
            format!(
                "Sending the results{size} took {ser:.0} ms, {:.0}% of execution. Return fewer rows \
                 or columns, or paginate.",
                ser / exec * 100.0
            ),
        ));
    }
}

/// Whole-word containment (identifiers: letters, digits, underscore).
pub fn mentions(haystack: &str, word: &str) -> bool {
    let is_ident = |c: char| c.is_ascii_alphanumeric() || c == '_';
    haystack.match_indices(word).any(|(i, _)| {
        let before = haystack[..i].chars().next_back();
        let after = haystack[i + word.len()..].chars().next();
        !before.is_some_and(is_ident) && !after.is_some_and(is_ident)
    })
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
        io_time_ms: None,
        self_io_ms: None,
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
