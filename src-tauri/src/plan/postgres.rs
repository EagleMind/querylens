//! `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` / `EXPLAIN (FORMAT JSON)` parser.

use serde_json::{Map, Value};

use super::{ParsedPlan, blank_node, fmt_count, fmt_value, warning};
use crate::error::{AppError, AppResult};
use crate::model::{PlanBuffers, PlanNode, PlanProperty, WarningKind, WarningSeverity};

type Obj = Map<String, Value>;

const MISSING_INDEX_MIN_SCANNED: f64 = 10_000.0;
const MISSING_INDEX_DISCARD_RATIO: f64 = 0.9;
const LARGE_SCAN_ROWS: f64 = 100_000.0;
const NESTED_LOOP_INNER_LOOPS: f64 = 1_000.0;

/// Conditions shown on the node row, most informative first.
const DETAIL_KEYS: &[&str] = &[
    "Index Cond",
    "Hash Cond",
    "Merge Cond",
    "Join Filter",
    "Recheck Cond",
    "Filter",
    "One-Time Filter",
    "Sort Key",
    "Group Key",
    "Cache Key",
];

pub(super) fn parse(raw: &str) -> AppResult<ParsedPlan> {
    let value: Value = serde_json::from_str(raw)?;
    let top = value
        .as_array()
        .and_then(|a| a.first())
        .or(Some(&value))
        .and_then(Value::as_object)
        .ok_or_else(|| AppError::internal("Unexpected Postgres EXPLAIN output"))?;
    let plan = top
        .get("Plan")
        .and_then(Value::as_object)
        .ok_or_else(|| AppError::internal("Postgres EXPLAIN output has no \"Plan\""))?;

    let root = node(plan, "0".into(), 1.0);
    Ok(ParsedPlan {
        total_cost: root.total_cost,
        planning_time_ms: num(top, "Planning Time"),
        execution_time_ms: num(top, "Execution Time"),
        root,
    })
}

fn num(o: &Obj, k: &str) -> Option<f64> {
    o.get(k).and_then(Value::as_f64)
}

fn text<'a>(o: &'a Obj, k: &str) -> Option<&'a str> {
    o.get(k).and_then(Value::as_str)
}

/// `procs`: number of processes executing this subtree concurrently (under Gather).
fn node(o: &Obj, id: String, procs: f64) -> PlanNode {
    let raw_type = text(o, "Node Type").unwrap_or("?");
    let mut n = blank_node(id, display_type(o, raw_type));

    n.relation = text(o, "Relation Name")
        .or_else(|| text(o, "CTE Name"))
        .or_else(|| text(o, "Function Name"))
        .map(String::from);
    n.alias = text(o, "Alias").filter(|a| Some(*a) != n.relation.as_deref()).map(String::from);
    n.index_name = text(o, "Index Name").map(String::from);
    n.detail = detail(o);
    n.estimated_rows = num(o, "Plan Rows");
    n.startup_cost = num(o, "Startup Cost");
    n.total_cost = num(o, "Total Cost");

    if let Some(loops) = num(o, "Actual Loops") {
        n.loops = Some(loops);
        n.actual_rows = num(o, "Actual Rows");
        // `Actual Total Time` is per loop. Under Gather, loops counts parallel
        // processes rather than sequential repeats, so divide them back out.
        let per_loop = num(o, "Actual Total Time").unwrap_or(0.0);
        let repeats = if loops == 0.0 { 0.0 } else { (loops / procs).max(1.0) };
        n.total_time_ms = Some(per_loop * repeats);
    }

    if o.contains_key("Shared Hit Blocks") || o.contains_key("Shared Read Blocks") {
        n.buffers = Some(PlanBuffers {
            shared_hit: num(o, "Shared Hit Blocks").unwrap_or(0.0),
            shared_read: num(o, "Shared Read Blocks").unwrap_or(0.0),
            temp_read: num(o, "Temp Read Blocks").unwrap_or(0.0),
            temp_written: num(o, "Temp Written Blocks").unwrap_or(0.0),
        });
    }

    n.properties = o
        .iter()
        .filter(|(k, _)| k.as_str() != "Plans")
        .map(|(k, v)| PlanProperty { key: k.clone(), value: fmt_value(v) })
        .collect();

    let child_procs = if raw_type.starts_with("Gather") {
        let workers = num(o, "Workers Launched").or_else(|| num(o, "Workers Planned")).unwrap_or(0.0);
        workers + 1.0
    } else {
        procs
    };
    if let Some(plans) = o.get("Plans").and_then(Value::as_array) {
        n.children = plans
            .iter()
            .filter_map(Value::as_object)
            .enumerate()
            .map(|(i, c)| node(c, format!("{}.{i}", n.id), child_procs))
            .collect();
    }

    n.warnings = warnings(o, raw_type, &n);
    n
}

/// Mirrors the labels of Postgres' text EXPLAIN format ("Hash Left Join", "HashAggregate").
fn display_type(o: &Obj, raw: &str) -> String {
    let parallel = o.get("Parallel Aware").and_then(Value::as_bool).unwrap_or(false);
    let base = match raw {
        "Aggregate" => {
            let strategy = match text(o, "Strategy") {
                Some("Hashed") => "HashAggregate",
                Some("Sorted") => "GroupAggregate",
                Some("Mixed") => "MixedAggregate",
                _ => "Aggregate",
            };
            match text(o, "Partial Mode") {
                Some(mode @ ("Partial" | "Finalize")) => format!("{mode} {strategy}"),
                _ => strategy.to_string(),
            }
        }
        "Hash Join" | "Merge Join" | "Nested Loop" => match text(o, "Join Type") {
            Some(jt) if jt != "Inner" => {
                let stem = raw.trim_end_matches(" Join");
                format!("{stem} {jt} Join")
            }
            _ => raw.to_string(),
        },
        "Index Scan" | "Index Only Scan" if text(o, "Scan Direction") == Some("Backward") => {
            format!("{raw} Backward")
        }
        "ModifyTable" => text(o, "Operation").unwrap_or(raw).to_string(),
        _ => raw.to_string(),
    };
    if parallel { format!("Parallel {base}") } else { base }
}

fn detail(o: &Obj) -> Option<String> {
    let parts: Vec<String> = DETAIL_KEYS
        .iter()
        .filter_map(|k| o.get(*k).map(|v| format!("{k}: {}", fmt_value(v))))
        .take(2)
        .collect();
    (!parts.is_empty()).then(|| parts.join(" · "))
}

fn warnings(o: &Obj, raw_type: &str, n: &PlanNode) -> Vec<crate::model::PlanWarning> {
    let mut out = Vec::new();
    let rel = n.relation.as_deref().unwrap_or("table");

    if raw_type == "Seq Scan" {
        match (n.actual_rows, n.loops) {
            (Some(rows), Some(loops)) if loops > 0.0 => {
                let removed = num(o, "Rows Removed by Filter").unwrap_or(0.0);
                let per_loop_scanned = rows + removed;
                let scanned = per_loop_scanned * loops;
                let discard = if per_loop_scanned > 0.0 { removed / per_loop_scanned } else { 0.0 };
                if o.contains_key("Filter")
                    && scanned >= MISSING_INDEX_MIN_SCANNED
                    && discard >= MISSING_INDEX_DISCARD_RATIO
                {
                    let filter = text(o, "Filter").unwrap_or_default();
                    out.push(warning(
                        WarningKind::MissingIndex,
                        WarningSeverity::Error,
                        format!(
                            "Seq Scan on {rel} reads {} rows and discards {:.1}% of them with \
                             {filter}. An index on the filtered column(s) would avoid the full scan.",
                            fmt_count(scanned),
                            discard * 100.0
                        ),
                    ));
                } else if scanned >= LARGE_SCAN_ROWS {
                    out.push(warning(
                        WarningKind::SeqScanLarge,
                        WarningSeverity::Warning,
                        format!("Full scan of {rel} touches {} rows.", fmt_count(scanned)),
                    ));
                }
            }
            (None, _) if n.estimated_rows.unwrap_or(0.0) >= LARGE_SCAN_ROWS => {
                out.push(warning(
                    WarningKind::SeqScanLarge,
                    WarningSeverity::Warning,
                    format!(
                        "Planner expects a full scan of {rel} returning ~{} rows.",
                        fmt_count(n.estimated_rows.unwrap_or(0.0))
                    ),
                ));
            }
            _ => {}
        }
    }

    if text(o, "Sort Space Type") == Some("Disk") {
        let used = num(o, "Sort Space Used").map(|kb| format!("{} kB", fmt_count(kb))).unwrap_or_default();
        out.push(warning(
            WarningKind::SortSpill,
            WarningSeverity::Warning,
            format!(
                "Sort spilled {used} to disk. Raise work_mem for this query, or add an index \
                 matching the sort key so no sort is needed."
            ),
        ));
    }

    if let Some(batches) = num(o, "Hash Batches").filter(|b| *b > 1.0) {
        out.push(warning(
            WarningKind::HashSpill,
            WarningSeverity::Warning,
            format!(
                "Hash table needed {batches:.0} batches and spilled to disk. Raise work_mem, \
                 or reduce the rows feeding the hash."
            ),
        ));
    }

    if raw_type == "Nested Loop" {
        if let Some(inner_loops) = n.children.get(1).and_then(|c| c.loops) {
            if inner_loops >= NESTED_LOOP_INNER_LOOPS {
                out.push(warning(
                    WarningKind::NestedLoopBlowup,
                    WarningSeverity::Warning,
                    format!(
                        "Inner side of this Nested Loop ran {} times. If the outer row \
                         estimate is wrong, a hash join would be far cheaper.",
                        fmt_count(inner_loops)
                    ),
                ));
            }
        }
    }

    if raw_type == "Index Only Scan" {
        if let (Some(fetches), Some(rows), Some(loops)) = (num(o, "Heap Fetches"), n.actual_rows, n.loops) {
            let returned = rows * loops;
            if fetches > 1_000.0 && fetches > returned * 0.1 {
                out.push(warning(
                    WarningKind::HeapFetches,
                    WarningSeverity::Info,
                    format!(
                        "Index Only Scan still visited the heap {} times — the visibility map \
                         is stale. VACUUM {rel} to make this a true index-only scan.",
                        fmt_count(fetches)
                    ),
                ));
            }
        }
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{ExplainMode, Heat};
    use crate::plan;

    const HASH_JOIN: &str = r#"[{
      "Plan": {
        "Node Type": "Hash Join", "Join Type": "Inner", "Startup Cost": 3.2, "Total Cost": 25000.0,
        "Plan Rows": 100, "Actual Total Time": 410.0, "Actual Rows": 98, "Actual Loops": 1,
        "Hash Cond": "(o.user_id = u.id)",
        "Plans": [
          { "Node Type": "Seq Scan", "Relation Name": "orders", "Alias": "o",
            "Total Cost": 24000.0, "Plan Rows": 5, "Actual Total Time": 400.0, "Actual Rows": 980,
            "Actual Loops": 1, "Filter": "(user_id = 42)", "Rows Removed by Filter": 999020,
            "Shared Hit Blocks": 10, "Shared Read Blocks": 8000 },
          { "Node Type": "Hash", "Total Cost": 3.0, "Plan Rows": 1, "Actual Total Time": 0.05,
            "Actual Rows": 1, "Actual Loops": 1, "Hash Batches": 1,
            "Plans": [
              { "Node Type": "Index Scan", "Relation Name": "users", "Alias": "u",
                "Index Name": "users_pkey", "Total Cost": 2.9, "Plan Rows": 1,
                "Actual Total Time": 0.04, "Actual Rows": 1, "Actual Loops": 1,
                "Index Cond": "(id = 42)" }
            ] }
        ]
      },
      "Planning Time": 0.3, "Execution Time": 410.5
    }]"#;

    #[test]
    fn computes_self_time_and_heat() {
        let p = plan::parse(crate::model::Engine::Postgres, ExplainMode::Analyze, HASH_JOIN).unwrap();
        let root = &p.root;
        assert_eq!(p.execution_time_ms, Some(410.5));
        assert_eq!(root.node_type, "Hash Join");
        // 410 inclusive − 400 (scan) − 0.05 (hash) = 9.95 self
        assert!((root.self_time_ms.unwrap() - 9.95).abs() < 1e-6);
        let scan = &root.children[0];
        assert_eq!(scan.id, "0.0");
        assert_eq!(scan.heat, Heat::High);
        assert!(scan.share > 0.95);
        assert_eq!(root.children[1].children[0].heat, Heat::Low);
        assert_eq!(scan.buffers.as_ref().unwrap().shared_read, 8000.0);
    }

    #[test]
    fn flags_missing_index_and_misestimate() {
        let p = plan::parse(crate::model::Engine::Postgres, ExplainMode::Analyze, HASH_JOIN).unwrap();
        let scan = &p.root.children[0];
        let kinds: Vec<_> = scan.warnings.iter().map(|w| w.kind).collect();
        assert!(kinds.contains(&WarningKind::MissingIndex));
        assert!(kinds.contains(&WarningKind::RowEstimateError)); // est 5 vs 980 → 196×
        assert_eq!(plan::count_warnings(&p.root), 2);
        assert_eq!(plan::relations(&p.root), vec!["orders", "users"]);
    }

    #[test]
    fn loops_multiply_and_parallel_divides() {
        let raw = r#"[{"Plan": {
          "Node Type": "Gather", "Workers Launched": 2, "Total Cost": 100, "Plan Rows": 10,
          "Actual Total Time": 100.0, "Actual Rows": 10, "Actual Loops": 1,
          "Plans": [{
            "Node Type": "Nested Loop", "Parallel Aware": false, "Total Cost": 90, "Plan Rows": 3,
            "Actual Total Time": 95.0, "Actual Rows": 3, "Actual Loops": 3,
            "Plans": [
              {"Node Type": "Seq Scan", "Parallel Aware": true, "Relation Name": "a",
               "Total Cost": 10, "Plan Rows": 1000, "Actual Total Time": 5.0, "Actual Rows": 1000,
               "Actual Loops": 3},
              {"Node Type": "Index Scan", "Relation Name": "b", "Total Cost": 70, "Plan Rows": 1,
               "Actual Total Time": 0.03, "Actual Rows": 1, "Actual Loops": 3000}
            ]}]}}]"#;
        let p = plan::parse(crate::model::Engine::Postgres, ExplainMode::Analyze, raw).unwrap();
        let nl = &p.root.children[0];
        assert_eq!(nl.total_time_ms, Some(95.0)); // 3 loops across 3 processes → ×1
        assert_eq!(nl.children[0].node_type, "Parallel Seq Scan");
        // 3000 loops / 3 processes = 1000 sequential repeats × 0.03 ms
        assert!((nl.children[1].total_time_ms.unwrap() - 30.0).abs() < 1e-6);
        assert!(nl.warnings.iter().any(|w| w.kind == WarningKind::NestedLoopBlowup));
    }

    #[test]
    fn estimate_mode_scores_by_cost() {
        let raw = r#"[{"Plan": {"Node Type": "Aggregate", "Strategy": "Hashed", "Total Cost": 1000,
          "Plan Rows": 5, "Plans": [{"Node Type": "Seq Scan", "Relation Name": "big",
          "Total Cost": 900, "Plan Rows": 500000}]}}]"#;
        let p = plan::parse(crate::model::Engine::Postgres, ExplainMode::Estimate, raw).unwrap();
        assert_eq!(p.root.node_type, "HashAggregate");
        assert_eq!(p.root.self_cost, Some(100.0));
        assert!((p.root.children[0].share - 0.9).abs() < 1e-9);
        assert!(p.root.children[0].warnings.iter().any(|w| w.kind == WarningKind::SeqScanLarge));
        assert!(p.root.self_time_ms.is_none());
    }

    #[test]
    fn spills_are_flagged() {
        let raw = r#"[{"Plan": {"Node Type": "Sort", "Total Cost": 10, "Plan Rows": 10,
          "Actual Total Time": 50, "Actual Rows": 10, "Actual Loops": 1,
          "Sort Space Type": "Disk", "Sort Space Used": 20480, "Sort Key": ["created_at DESC"]}}]"#;
        let p = plan::parse(crate::model::Engine::Postgres, ExplainMode::Analyze, raw).unwrap();
        assert_eq!(p.root.warnings[0].kind, WarningKind::SortSpill);
        assert_eq!(p.root.detail.as_deref(), Some("Sort Key: created_at DESC"));
    }
}
