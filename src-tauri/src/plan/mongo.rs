//! MongoDB `explain` output (relaxed extended JSON) → plan tree.
//!
//! Three shapes:
//! * classic engine: `executionStats.executionStages` is the plan tree with stats inline;
//! * slot-based engine (SBE, 7.0+ for many queries): the readable tree is
//!   `winningPlan.queryPlan`, and `executionStages` holds low-level SBE stages that point
//!   back to it through `planNodeId`;
//! * aggregation pipelines that aren't fully pushed down: `stages: [{$cursor: …}, {$sort: …}, …]`,
//!   each with cumulative `executionTimeMillisEstimate`.
//!
//! `executionTimeMillisEstimate` is inclusive (it counts the stage's inputs), so the
//! generic scorer derives exclusive time as for PostgreSQL.

use std::collections::HashMap;

use serde_json::{Map, Value};

use super::{ParsedPlan, blank_node, fmt_count, fmt_value, warning};
use crate::error::{AppError, AppResult};
use crate::model::{ExplainMode, PlanNode, PlanProperty, WarningKind, WarningSeverity};

type Obj = Map<String, Value>;

const SELECTIVE_SHARE: f64 = 0.1;
const SELECTIVE_MIN_DOCS: f64 = 1_000.0;
const LARGE_SCAN_DOCS: f64 = 100_000.0;
const BLOCKING_SORT_MIN_DOCS: f64 = 1_000.0;

/// Stages that read a collection (directly or through an index).
const COLLECTION_STAGES: &[&str] = &[
    "COLLSCAN", "IXSCAN", "FETCH", "IDHACK", "COUNT_SCAN", "DISTINCT_SCAN", "EXPRESS_IXSCAN",
    "EXPRESS_CLUSTERED_IXSCAN", "EXPRESS_UPDATE", "EXPRESS_DELETE", "CLUSTERED_IXSCAN", "TEXT_MATCH",
];

/// Stats per SBE `planNodeId`: inclusive time and rows of its topmost stage, and the
/// documents/keys its stages read.
#[derive(Default, Clone)]
struct SbeStats {
    time_ms: Option<f64>,
    returned: Option<f64>,
    docs: f64,
    keys: f64,
    used_disk: bool,
}

pub(super) fn parse(raw: &str, mode: ExplainMode) -> AppResult<ParsedPlan> {
    let value: Value = serde_json::from_str(raw)?;
    let top = value.as_object().ok_or_else(bad)?;
    let analyze = mode == ExplainMode::Analyze;

    let (root, execution_time_ms, planning_time_ms) = if let Some(stages) = top.get("stages").and_then(Value::as_array) {
        pipeline(stages, analyze)?
    } else if top.contains_key("queryPlanner") {
        let ns = namespace(top);
        let root = cursor_plan(top, &ns, analyze, "0")?;
        let exec = at(top, &["executionStats", "executionTimeMillis"]).and_then(Value::as_f64);
        (root, exec, optimization_ms(top))
    } else if top.contains_key("shards") {
        return Err(AppError::validation(
            "Sharded explain output isn't supported yet. Connect to a single shard (or a replica set member) to \
             profile the query there.",
        ));
    } else {
        return Err(bad());
    };
    Ok(ParsedPlan {
        root,
        planning_time_ms,
        execution_time_ms,
        total_cost: None,
        jit_ms: None,
        serialize_ms: None,
        serialize_bytes: None,
        planner_settings: Vec::new(),
    })
}

fn bad() -> AppError {
    AppError::internal("Unexpected MongoDB explain output")
}

/// Nested lookup without cloning: `at(o, &["a", "b"])` is `o.a.b`.
fn at<'a>(o: &'a Obj, path: &[&str]) -> Option<&'a Value> {
    let (first, rest) = path.split_first()?;
    rest.iter().try_fold(o.get(*first)?, |v, k| v.get(*k))
}

fn namespace(o: &Obj) -> String {
    let ns = at(o, &["queryPlanner", "namespace"]).and_then(Value::as_str).unwrap_or_default().to_string();
    // "shop.orders" → "orders" (collection names may contain dots; the db name can't).
    ns.split_once('.').map(|(_, c)| c.to_string()).unwrap_or(ns)
}

fn optimization_ms(o: &Obj) -> Option<f64> {
    o.get("queryPlanner").and_then(|q| q.get("optimizationTimeMillis")).and_then(Value::as_f64)
}

/// An aggregation pipeline: each stage feeds the next, so the last stage is the root.
fn pipeline(stages: &[Value], analyze: bool) -> AppResult<(PlanNode, Option<f64>, Option<f64>)> {
    let mut prev: Option<PlanNode> = None;
    let mut planning = None;
    for (i, st) in stages.iter().enumerate() {
        let st = st.as_object().ok_or_else(bad)?;
        let id = format!("s{i}");
        let mut n = if let Some(cursor) = st.get("$cursor").and_then(Value::as_object) {
            let collection = namespace(cursor);
            planning = optimization_ms(cursor);
            cursor_plan(cursor, &collection, analyze, &id)?
        } else {
            stage_node(st, &id)
        };
        if let Some(p) = prev.take() {
            n.children.insert(0, p);
        }
        pipeline_warnings(&mut n);
        prev = Some(n);
    }
    let root = prev.ok_or_else(bad)?;
    let exec = root.total_time_ms;
    Ok((root, exec, planning))
}

/// A pipeline stage after the cursor: `{ "$sort": {…}, nReturned, executionTimeMillisEstimate, … }`.
fn stage_node(st: &Obj, id: &str) -> PlanNode {
    let (name, spec) = st.iter().find(|(k, _)| k.starts_with('$')).map(|(k, v)| (k.clone(), v.clone())).unwrap_or_default();
    let mut n = blank_node(id.to_string(), name.clone());
    n.detail = Some(compact(&spec));
    n.actual_rows = st.get("nReturned").and_then(Value::as_f64);
    n.loops = n.actual_rows.map(|_| 1.0);
    n.total_time_ms = st.get("executionTimeMillisEstimate").and_then(Value::as_f64);
    if name == "$lookup" {
        n.relation = spec.get("from").and_then(Value::as_str).map(String::from);
    } else if name == "$unionWith" {
        n.relation = spec.get("coll").and_then(Value::as_str).or(spec.as_str()).map(String::from);
    }
    for (k, v) in st {
        if !k.starts_with('$') {
            n.properties.push(PlanProperty { key: k.clone(), value: fmt_value(v) });
        }
    }
    n
}

fn pipeline_warnings(n: &mut PlanNode) {
    let props: HashMap<&str, &str> = n.properties.iter().map(|p| (p.key.as_str(), p.value.as_str())).collect();
    let num = |k: &str| props.get(k).and_then(|v| v.parse::<f64>().ok()).unwrap_or(0.0);
    let used_disk = props.get("usedDisk") == Some(&"true");
    match n.node_type.as_str() {
        "$lookup" if num("collectionScans") > 0.0 => {
            let from = n.relation.clone().unwrap_or_else(|| "the joined collection".into());
            let field = n.detail.as_deref().and_then(|d| field_after(d, "foreignField")).unwrap_or_else(|| "the foreign field".into());
            n.warnings.push(warning(
                WarningKind::MissingIndex,
                WarningSeverity::Error,
                format!(
                    "$lookup scanned all of {from} {} times ({} documents examined). An index on {from}.{field} \
                     turns each lookup into an index seek.",
                    fmt_count(num("collectionScans")),
                    fmt_count(num("totalDocsExamined"))
                ),
            ));
        }
        "$sort" => {
            let input = n.children.first().and_then(|c| c.actual_rows).unwrap_or(0.0);
            // Only sorts on stored fields can use an index; after $group/$project the keys
            // are computed and the in-memory sort is unavoidable.
            let on_stored_fields = n.children.first().is_some_and(|c| {
                !c.node_type.starts_with('$') && !matches!(c.node_type.as_str(), "GROUP" | "PROJECTION_DEFAULT")
            });
            let key = n
                .detail
                .as_deref()
                .and_then(|d| serde_json::from_str::<Value>(d).ok())
                .and_then(|v| v.get("sortKey").map(compact))
                .unwrap_or_else(|| "the sort key".into());
            if used_disk {
                n.warnings.push(warning(
                    WarningKind::SortSpill,
                    WarningSeverity::Warning,
                    "The sort spilled to disk: it exceeded the 100 MB in-memory limit.".into(),
                ));
            } else if input >= BLOCKING_SORT_MIN_DOCS && on_stored_fields {
                n.warnings.push(blocking_sort(input, &key));
            }
        }
        "$group" | "$bucket" | "$setWindowFields" if used_disk => n.warnings.push(warning(
            WarningKind::HashSpill,
            WarningSeverity::Warning,
            format!("{} spilled to disk: its state didn't fit in memory.", n.node_type),
        )),
        _ => {}
    }
}

/// Value of `"key": "value"` inside a compact JSON detail string.
fn field_after(detail: &str, key: &str) -> Option<String> {
    let v: Value = serde_json::from_str(detail).ok()?;
    v.get(key).and_then(Value::as_str).map(String::from)
}

/// The plan of a `find` explain or a pipeline's `$cursor` stage.
fn cursor_plan(o: &Obj, collection: &str, analyze: bool, id: &str) -> AppResult<PlanNode> {
    let winning = o.get("queryPlanner").and_then(|q| q.get("winningPlan")).and_then(Value::as_object).ok_or_else(bad)?;
    if winning.contains_key("shards") {
        return Err(AppError::validation("Sharded explain output isn't supported yet."));
    }
    let exec = at(o, &["executionStats", "executionStages"]).and_then(Value::as_object).filter(|_| analyze);
    let mut root = match (winning.get("queryPlan").and_then(Value::as_object), exec) {
        // SBE: readable tree from queryPlan, stats from the SBE stages via planNodeId.
        (Some(query_plan), exec) => {
            let mut stats = HashMap::new();
            if let Some(e) = exec {
                collect_sbe(e, &mut stats);
            }
            tree(query_plan, id.to_string(), collection, &|s| sbe_stats(s, &stats), exec.is_some())
        }
        // Classic engine with stats: executionStages has the same shape as the plan.
        (None, Some(e)) => tree(e, id.to_string(), collection, &classic_stats, true),
        (None, None) => tree(winning, id.to_string(), collection, &classic_stats, false),
    };
    if let Some(rejected) = at(o, &["queryPlanner", "rejectedPlans"]).and_then(|v| v.as_array().map(Vec::len)) {
        if rejected > 0 {
            root.properties.push(PlanProperty { key: "rejectedPlans".into(), value: rejected.to_string() });
        }
    }
    Ok(root)
}

/// Stats read straight off a classic stage.
fn classic_stats(s: &Obj) -> SbeStats {
    let f = |k: &str| s.get(k).and_then(Value::as_f64);
    SbeStats {
        time_ms: f("executionTimeMillisEstimate"),
        returned: f("nReturned"),
        docs: f("docsExamined").unwrap_or(0.0),
        keys: f("keysExamined").unwrap_or(0.0),
        used_disk: s.get("usedDisk").and_then(Value::as_bool).unwrap_or(false),
    }
}

fn sbe_stats(s: &Obj, by_id: &HashMap<i64, SbeStats>) -> SbeStats {
    s.get("planNodeId").and_then(Value::as_i64).and_then(|id| by_id.get(&id)).cloned().unwrap_or_default()
}

/// Pre-order over SBE stages: the first stage seen for a planNodeId is its topmost one.
fn collect_sbe(s: &Obj, out: &mut HashMap<i64, SbeStats>) {
    if let Some(id) = s.get("planNodeId").and_then(Value::as_i64) {
        let e = out.entry(id).or_default();
        let f = |k: &str| s.get(k).and_then(Value::as_f64);
        if e.time_ms.is_none() {
            e.time_ms = f("executionTimeMillisEstimate");
            e.returned = f("nReturned");
        }
        let stage = s.get("stage").and_then(Value::as_str).unwrap_or_default();
        if stage.contains("ix") {
            e.keys += f("numReads").or(f("keysExamined")).unwrap_or(0.0);
        } else {
            e.docs += f("numReads").unwrap_or(0.0);
        }
        e.used_disk |= s.get("usedDisk").and_then(Value::as_bool).unwrap_or(false);
    }
    for key in ["inputStage", "outerStage", "innerStage", "thenStage", "elseStage"] {
        if let Some(c) = s.get(key).and_then(Value::as_object) {
            collect_sbe(c, out);
        }
    }
    for c in s.get("inputStages").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_object) {
        collect_sbe(c, out);
    }
}

fn children_of(s: &Obj) -> Vec<&Obj> {
    let mut out: Vec<&Obj> = Vec::new();
    for key in ["inputStage", "outerStage", "innerStage", "thenStage", "elseStage"] {
        if let Some(c) = s.get(key).and_then(Value::as_object) {
            out.push(c);
        }
    }
    out.extend(s.get("inputStages").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_object));
    out
}

fn tree(s: &Obj, id: String, collection: &str, stats_of: &dyn Fn(&Obj) -> SbeStats, timed: bool) -> PlanNode {
    let stage = s.get("stage").and_then(Value::as_str).unwrap_or("?").to_string();
    let mut n = blank_node(id.clone(), stage.clone());
    if COLLECTION_STAGES.contains(&stage.as_str()) {
        n.relation = Some(collection.to_string());
    }
    n.index_name = s.get("indexName").and_then(Value::as_str).map(String::from);
    n.detail = detail(&stage, s);

    let st = stats_of(s);
    if timed {
        n.actual_rows = st.returned;
        n.loops = st.returned.map(|_| 1.0);
        n.total_time_ms = st.time_ms;
    }
    if st.docs > 0.0 {
        n.properties.push(PlanProperty { key: "docsExamined".into(), value: fmt_count(st.docs) });
    }
    if st.keys > 0.0 {
        n.properties.push(PlanProperty { key: "keysExamined".into(), value: fmt_count(st.keys) });
    }
    for key in ["direction", "isMultiKey", "memLimit", "limitAmount", "strategy", "foreignCollection", "localField", "foreignField"] {
        if let Some(v) = s.get(key) {
            n.properties.push(PlanProperty { key: key.into(), value: fmt_value(v) });
        }
    }
    if stage == "EQ_LOOKUP" {
        n.relation = s.get("foreignCollection").and_then(Value::as_str).map(|c| c.split_once('.').map_or(c, |x| x.1).to_string());
    }

    n.children = children_of(s)
        .into_iter()
        .enumerate()
        .map(|(i, c)| tree(c, format!("{id}.{i}"), collection, stats_of, timed))
        .collect();
    stage_warnings(&mut n, s, &st, timed);
    n
}

fn detail(stage: &str, s: &Obj) -> Option<String> {
    let get = |k: &str| s.get(k).map(compact);
    match stage {
        "IXSCAN" | "COUNT_SCAN" | "DISTINCT_SCAN" | "EXPRESS_IXSCAN" => {
            let key = get("keyPattern").unwrap_or_default();
            match s.get("indexBounds") {
                Some(b) => Some(format!("{key} bounds {}", compact(b))),
                None => Some(key),
            }
        }
        "SORT" | "SORT_KEY_GENERATOR" => get("sortPattern"),
        "LIMIT" => get("limitAmount").map(|l| format!("limit {l}")),
        "SKIP" => get("skipAmount").map(|l| format!("skip {l}")),
        "PROJECTION_SIMPLE" | "PROJECTION_DEFAULT" | "PROJECTION_COVERED" => get("transformBy"),
        "EQ_LOOKUP" => Some(format!(
            "{} = {} via {}",
            s.get("localField").and_then(Value::as_str).unwrap_or("?"),
            s.get("foreignField").and_then(Value::as_str).unwrap_or("?"),
            s.get("strategy").and_then(Value::as_str).unwrap_or("?")
        )),
        _ => get("filter"),
    }
}

/// One-line JSON, truncated for display.
fn compact(v: &Value) -> String {
    let s = v.to_string();
    match s.char_indices().nth(240) {
        Some((cut, _)) => format!("{}…", &s[..cut]),
        None => s,
    }
}

/// Field names a filter tests: `{ status: …, $and: [{ total: … }] }` → status, total.
fn filter_fields(f: &Value, out: &mut Vec<String>) {
    match f {
        Value::Object(o) => {
            for (k, v) in o {
                if k.starts_with('$') {
                    filter_fields(v, out);
                } else if !out.contains(k) {
                    out.push(k.clone());
                }
            }
        }
        Value::Array(items) => items.iter().for_each(|i| filter_fields(i, out)),
        _ => {}
    }
}

fn blocking_sort(input: f64, key: &str) -> crate::model::PlanWarning {
    warning(
        WarningKind::BlockingSort,
        WarningSeverity::Info,
        format!(
            "Sorts {} documents in memory before returning any. An index on {key} returns them already in \
             order, and lets a limit stop early.",
            fmt_count(input)
        ),
    )
}

fn stage_warnings(n: &mut PlanNode, s: &Obj, st: &SbeStats, timed: bool) {
    let returned = st.returned.unwrap_or(0.0);
    let coll = n.relation.clone().unwrap_or_else(|| "the collection".into());
    match n.node_type.as_str() {
        "COLLSCAN" => {
            let mut fields = Vec::new();
            if let Some(f) = s.get("filter") {
                filter_fields(f, &mut fields);
            }
            let fields = fields.join(", ");
            if !timed {
                if !fields.is_empty() {
                    n.warnings.push(warning(
                        WarningKind::MissingIndex,
                        WarningSeverity::Info,
                        format!("No index supports this filter, so MongoDB reads every document of {coll} (fields: {fields})."),
                    ));
                }
                return;
            }
            let examined = st.docs.max(returned);
            if !fields.is_empty() && examined >= SELECTIVE_MIN_DOCS && returned < examined * SELECTIVE_SHARE {
                n.warnings.push(warning(
                    WarningKind::MissingIndex,
                    WarningSeverity::Warning,
                    format!(
                        "Scanned {} documents of {coll} to return {} ({:.1}%). An index on {fields} lets MongoDB \
                         read only the matching documents.",
                        fmt_count(examined),
                        fmt_count(returned),
                        returned / examined * 100.0
                    ),
                ));
            } else if examined >= LARGE_SCAN_DOCS {
                n.warnings.push(warning(
                    WarningKind::SeqScanLarge,
                    WarningSeverity::Info,
                    format!("Full collection scan of {} documents of {coll}.", fmt_count(examined)),
                ));
            }
        }
        "FETCH" if timed => {
            let fetched = st.docs;
            let below_index = n.children.iter().any(|c| c.node_type.contains("IXSCAN"));
            if below_index && s.contains_key("filter") && fetched >= SELECTIVE_MIN_DOCS && returned < fetched * SELECTIVE_SHARE {
                let mut fields = Vec::new();
                filter_fields(&s["filter"], &mut fields);
                let index = n.children.iter().find_map(|c| c.index_name.clone()).unwrap_or_else(|| "the index".into());
                n.warnings.push(warning(
                    WarningKind::UnselectiveIndex,
                    WarningSeverity::Warning,
                    format!(
                        "{index} found {} documents, but the remaining filter kept only {}. A compound index that \
                         also covers {} avoids fetching documents that are thrown away.",
                        fmt_count(fetched),
                        fmt_count(returned),
                        fields.join(", ")
                    ),
                ));
            }
        }
        "SORT" => {
            if st.used_disk {
                n.warnings.push(warning(
                    WarningKind::SortSpill,
                    WarningSeverity::Warning,
                    "The sort spilled to disk: it exceeded the 100 MB in-memory limit.".into(),
                ));
            } else {
                let input = n.children.first().and_then(|c| c.actual_rows).unwrap_or(0.0);
                if timed && input >= BLOCKING_SORT_MIN_DOCS {
                    n.warnings.push(blocking_sort(input, n.detail.as_deref().unwrap_or("the sort key")));
                }
            }
        }
        "GROUP" if st.used_disk => n.warnings.push(warning(
            WarningKind::HashSpill,
            WarningSeverity::Warning,
            "The $group spilled to disk: its state didn't fit in memory.".into(),
        )),
        "EQ_LOOKUP" if s.get("strategy").and_then(Value::as_str) == Some("NestedLoopJoin") => {
            let field = s.get("foreignField").and_then(Value::as_str).unwrap_or("the foreign field");
            n.warnings.push(warning(
                WarningKind::MissingIndex,
                WarningSeverity::Error,
                format!(
                    "$lookup scans {coll} once per input document (nested loop). An index on {coll}.{field} turns \
                     each lookup into an index seek."
                ),
            ));
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use crate::model::{Engine, ExplainMode, WarningKind};
    use crate::plan;

    const CLASSIC: &str = r#"{"explainVersion":"1","queryPlanner":{"namespace":"shop.orders",
      "winningPlan":{"stage":"SORT","sortPattern":{"total":-1},"inputStage":{"stage":"COLLSCAN","filter":{"status":{"$eq":"paid"}}}},
      "rejectedPlans":[]},
      "executionStats":{"nReturned":20,"executionTimeMillis":546,"totalDocsExamined":300000,
        "executionStages":{"stage":"SORT","nReturned":20,"executionTimeMillisEstimate":492,"sortPattern":{"total":-1},
          "usedDisk":false,"limitAmount":20,
          "inputStage":{"stage":"COLLSCAN","filter":{"status":{"$eq":"paid"}},"nReturned":3000,
            "executionTimeMillisEstimate":491,"docsExamined":300000}}}}"#;

    #[test]
    fn classic_find_with_collscan_and_sort() {
        let p = plan::parse(Engine::Mongodb, ExplainMode::Analyze, CLASSIC).unwrap();
        assert_eq!(p.execution_time_ms, Some(546.0));
        assert_eq!(p.root.node_type, "SORT");
        let scan = &p.root.children[0];
        assert_eq!(scan.relation.as_deref(), Some("orders"));
        assert_eq!(scan.total_time_ms, Some(491.0));
        assert_eq!(scan.warnings[0].kind, WarningKind::MissingIndex);
        assert!(scan.warnings[0].message.contains("status"), "{}", scan.warnings[0].message);
        assert_eq!(p.root.warnings[0].kind, WarningKind::BlockingSort);
        assert!((p.root.self_time_ms.unwrap() - 1.0).abs() < 1e-9);
    }

    #[test]
    fn estimate_mode_has_no_stats() {
        let p = plan::parse(Engine::Mongodb, ExplainMode::Estimate, CLASSIC).unwrap();
        assert!(p.root.actual_rows.is_none());
        assert_eq!(p.root.children[0].warnings[0].severity, crate::model::WarningSeverity::Info);
    }

    #[test]
    fn sbe_pipeline_maps_stats_by_plan_node_id() {
        let raw = r#"{"explainVersion":"2","stages":[
          {"$cursor":{"queryPlanner":{"namespace":"shop.orders","optimizationTimeMillis":1,
             "winningPlan":{"queryPlan":{"stage":"GROUP","planNodeId":3,
               "inputStage":{"stage":"COLLSCAN","planNodeId":1,"filter":{"status":{"$eq":"paid"}}}}},"rejectedPlans":[]},
           "executionStats":{"nReturned":20000,"executionTimeMillis":497,"executionStages":
             {"stage":"project","planNodeId":3,"nReturned":20000,"executionTimeMillisEstimate":413,
              "inputStage":{"stage":"group","planNodeId":3,"nReturned":20000,"executionTimeMillisEstimate":379,"usedDisk":false,
               "inputStage":{"stage":"filter","planNodeId":1,"nReturned":60000,"executionTimeMillisEstimate":257,
                "inputStage":{"stage":"scan","planNodeId":1,"nReturned":300000,"executionTimeMillisEstimate":246,"numReads":300000}}}}}}},
          {"$sort":{"sortKey":{"spent":-1},"limit":5},"usedDisk":false,"nReturned":5,"executionTimeMillisEstimate":407},
          {"$lookup":{"from":"users","as":"u","localField":"_id","foreignField":"userRef"},
           "totalDocsExamined":500000,"collectionScans":5,"nReturned":5,"executionTimeMillisEstimate":1001}]}"#;
        let p = plan::parse(Engine::Mongodb, ExplainMode::Analyze, raw).unwrap();
        assert_eq!(p.root.node_type, "$lookup");
        assert_eq!(p.execution_time_ms, Some(1001.0));
        assert_eq!(p.root.warnings[0].kind, WarningKind::MissingIndex);
        assert!(p.root.warnings[0].message.contains("users.userRef"), "{}", p.root.warnings[0].message);
        let sort = &p.root.children[0];
        assert_eq!(sort.node_type, "$sort");
        assert!(sort.warnings.is_empty(), "sorting computed $group output can't use an index");
        let group = &sort.children[0];
        assert_eq!((group.node_type.as_str(), group.total_time_ms, group.actual_rows), ("GROUP", Some(413.0), Some(20000.0)));
        let scan = &group.children[0];
        assert_eq!((scan.total_time_ms, scan.actual_rows), (Some(257.0), Some(60000.0)));
        // 20% of documents match: not selective enough for an index warning, but a big scan.
        assert_eq!(scan.warnings[0].kind, WarningKind::SeqScanLarge);
        assert!(plan::relations(&p.root).contains(&"users".to_string()));
    }
}
