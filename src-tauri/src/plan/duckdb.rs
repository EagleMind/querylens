//! DuckDB `EXPLAIN (ANALYZE, FORMAT JSON)` / `EXPLAIN (FORMAT JSON)` parser.
//!
//! Analyze output is a profiling tree: `{ latency, children: [EXPLAIN_ANALYZE { children: [...] }] }`
//! with exclusive `operator_timing` in seconds. Estimate output is an array of
//! `{ name, extra_info, children }`.

use serde_json::{Map, Value};

use super::{ParsedPlan, blank_node, fmt_count, fmt_value, warning};
use crate::error::{AppError, AppResult};
use crate::model::{ExplainMode, PlanNode, PlanProperty, WarningKind, WarningSeverity};

type Obj = Map<String, Value>;

const LARGE_SCAN_ROWS: f64 = 10_000_000.0;
const SELECTIVE_FILTER_MIN_ROWS: f64 = 1_000_000.0;

const DETAIL_KEYS: &[&str] =
    &["Conditions", "Filters", "Join Type", "Groups", "Aggregates", "Order By", "Function"];

/// Wrapper operators DuckDB adds around the real plan.
const WRAPPERS: &[&str] = &["EXPLAIN_ANALYZE", "QUERY", "RESULT_COLLECTOR"];

pub(super) fn parse(raw: &str, mode: ExplainMode) -> AppResult<ParsedPlan> {
    let value: Value = serde_json::from_str(raw)?;
    let bad = || AppError::internal("Unexpected DuckDB EXPLAIN output");

    let (mut top, execution_time_ms) = match &value {
        Value::Array(items) => (items.first().and_then(Value::as_object).ok_or_else(bad)?, None),
        Value::Object(o) => {
            let latency = o.get("latency").and_then(Value::as_f64).map(|s| s * 1000.0);
            let first = o
                .get("children")
                .and_then(Value::as_array)
                .and_then(|c| c.first())
                .and_then(Value::as_object)
                .ok_or_else(bad)?;
            (first, latency)
        }
        _ => return Err(bad()),
    };
    while WRAPPERS.contains(&op_name(top)) {
        match top.get("children").and_then(Value::as_array).and_then(|c| c.first()).and_then(Value::as_object) {
            Some(child) => top = child,
            None => break,
        }
    }

    let root = node(top, "0".into(), mode);
    Ok(ParsedPlan {
        root,
        planning_time_ms: None,
        execution_time_ms,
        total_cost: None,
        jit_ms: None,
        serialize_ms: None,
        serialize_bytes: None,
        planner_settings: Vec::new(),
    })
}

fn op_name(o: &Obj) -> &str {
    o.get("operator_name")
        .or_else(|| o.get("name"))
        .or_else(|| o.get("operator_type"))
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("?")
}

fn extra_num(extra: Option<&Obj>, key: &str) -> Option<f64> {
    let v = extra?.get(key)?;
    v.as_f64().or_else(|| v.as_str().and_then(|s| s.trim().replace(',', "").parse().ok()))
}

fn node(o: &Obj, id: String, mode: ExplainMode) -> PlanNode {
    let name = op_name(o).to_string();
    let extra = o.get("extra_info").and_then(Value::as_object);
    let mut n = blank_node(id, name.clone());

    if let Some(table) = extra.and_then(|e| e.get("Table")).and_then(Value::as_str) {
        // "memory.main.orders" → "orders"
        n.relation = Some(table.rsplit('.').next().unwrap_or(table).to_string());
    }
    n.estimated_rows = extra_num(extra, "Estimated Cardinality");
    n.detail = extra.and_then(|e| {
        let parts: Vec<String> = DETAIL_KEYS
            .iter()
            .filter_map(|k| e.get(*k).map(|v| format!("{k}: {}", fmt_value(v))))
            .take(2)
            .collect();
        (!parts.is_empty()).then(|| parts.join(" · "))
    });

    if mode == ExplainMode::Analyze {
        n.actual_rows = o.get("operator_cardinality").and_then(Value::as_f64);
        n.loops = Some(1.0);
        n.self_time_ms = o.get("operator_timing").and_then(Value::as_f64).map(|s| s * 1000.0);
    }

    let mut props: Vec<PlanProperty> = extra
        .into_iter()
        .flatten()
        .map(|(k, v)| PlanProperty { key: k.clone(), value: fmt_value(v) })
        .collect();
    for key in ["operator_rows_scanned", "result_set_size", "cpu_time", "operator_timing"] {
        if let Some(v) = o.get(key) {
            props.push(PlanProperty { key: key.into(), value: fmt_value(v) });
        }
    }
    n.properties = props;

    if let Some(children) = o.get("children").and_then(Value::as_array) {
        n.children = children
            .iter()
            .filter_map(Value::as_object)
            .enumerate()
            .map(|(i, c)| node(c, format!("{}.{i}", n.id), mode))
            .collect();
    }

    if name.contains("SCAN") {
        let scanned = o.get("operator_rows_scanned").and_then(Value::as_f64).unwrap_or(0.0);
        let rel = n.relation.as_deref().unwrap_or("table");
        let has_filter = extra.is_some_and(|e| e.contains_key("Filters"));
        let kept = n.actual_rows.unwrap_or(0.0);
        if has_filter && scanned >= SELECTIVE_FILTER_MIN_ROWS && kept < scanned * 0.01 {
            n.warnings.push(warning(
                WarningKind::SeqScanLarge,
                WarningSeverity::Info,
                format!(
                    "Scanned {} rows of {rel} to keep {}. DuckDB prunes with min/max zonemaps: \
                     storing the data sorted by the filter column lets it skip row groups.",
                    fmt_count(scanned),
                    fmt_count(kept)
                ),
            ));
        } else if scanned >= LARGE_SCAN_ROWS {
            n.warnings.push(warning(
                WarningKind::SeqScanLarge,
                WarningSeverity::Info,
                format!("Full scan of {} rows of {rel}.", fmt_count(scanned)),
            ));
        }
    }
    n
}

#[cfg(test)]
mod tests {
    use crate::model::{Engine, ExplainMode};
    use crate::plan;

    const ANALYZE: &str = r##"{
      "latency": 0.0068, "rows_returned": 10,
      "children": [{ "operator_name": "EXPLAIN_ANALYZE", "operator_type": "EXPLAIN_ANALYZE",
        "operator_timing": 0.0, "operator_cardinality": 0, "extra_info": {},
        "children": [{ "operator_name": "TOP_N", "operator_timing": 0.0003, "operator_cardinality": 10,
          "extra_info": {"Top": "10", "Order By": "sum(o.amount) DESC"},
          "children": [{ "operator_name": "HASH_GROUP_BY", "operator_timing": 0.0064,
            "operator_cardinality": 798,
            "extra_info": {"Groups": "#0", "Aggregates": "sum(#1)", "Estimated Cardinality": "523"},
            "children": [{ "operator_name": "TABLE_SCAN", "operator_timing": 0.0001,
              "operator_cardinality": 159600, "operator_rows_scanned": 200000,
              "extra_info": {"Table": "memory.main.orders", "Type": "Sequential Scan",
                             "Filters": "amount>100", "Estimated Cardinality": "40000"},
              "children": [] }] }] }] }]
    }"##;

    #[test]
    fn unwraps_and_scores_profile_tree() {
        let p = plan::parse(Engine::Duckdb, ExplainMode::Analyze, ANALYZE).unwrap();
        assert_eq!(p.root.node_type, "TOP_N");
        assert!((p.execution_time_ms.unwrap() - 6.8).abs() < 1e-9);
        let group = &p.root.children[0];
        assert_eq!(group.node_type, "HASH_GROUP_BY");
        assert!((group.self_time_ms.unwrap() - 6.4).abs() < 1e-9);
        assert_eq!(group.heat, crate::model::Heat::High);
        let scan = &group.children[0];
        assert_eq!(scan.relation.as_deref(), Some("orders"));
        assert_eq!(scan.estimated_rows, Some(40000.0));
        assert_eq!(scan.detail.as_deref(), Some("Filters: amount>100"));
        // inclusive time is rebuilt bottom-up from exclusive operator timings
        assert!((p.root.total_time_ms.unwrap() - 6.8).abs() < 1e-9);
    }

    #[test]
    fn parses_estimate_array() {
        let raw = r#"[{"name": "SEQ_SCAN ", "children": [], "extra_info": {"Table": "memory.main.orders",
          "Type": "Sequential Scan", "Filters": "id=5", "Estimated Cardinality": "2"}}]"#;
        let p = plan::parse(Engine::Duckdb, ExplainMode::Estimate, raw).unwrap();
        assert_eq!(p.root.node_type, "SEQ_SCAN");
        assert_eq!(p.root.estimated_rows, Some(2.0));
        assert!(p.root.actual_rows.is_none());
        assert_eq!(p.root.share, 0.0);
    }
}
