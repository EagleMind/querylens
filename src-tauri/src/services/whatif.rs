//! Planner what-if sweep: re-plan the query under alternative settings / statistics,
//! all inside rolled-back transactions, to find out *why* the plan is slow.
//!
//! Each scenario is first EXPLAINed (cheap). Only scenarios that change the plan shape
//! are Profiled, under a tight per-scenario time budget.

use crate::error::AppResult;
use crate::model::{
    AnalysisResult, Engine, ExplainMode, WarningKind, WhatIfEvent, WhatIfOutcome, WhatIfReport, WhatIfResult,
    WhatIfScenario,
};
use crate::plan;
use crate::services::analysis::{self, Limits, RunOptions};
use crate::state::Scratch;
use crate::storage::Store;

/// Within this ratio a different plan counts as "similar".
const SIMILAR: f64 = 0.15;
/// Scenarios may take at most this multiple of the baseline before being stopped.
const BUDGET_FACTOR: f64 = 3.0;
const MIN_BUDGET_MS: f64 = 2_000.0;

fn scenario(kind: &str, label: &str, setup: Vec<String>, rationale: &str) -> WhatIfScenario {
    WhatIfScenario { kind: kind.into(), label: label.into(), setup, rationale: rationale.into() }
}

fn any_node(a: &AnalysisResult, pred: impl Fn(&crate::model::PlanNode) -> bool) -> bool {
    let mut hit = false;
    plan::walk(&a.root, &mut |n| hit |= pred(n));
    hit
}

/// Pick the levers worth pulling for this particular plan.
pub fn select_scenarios(a: &AnalysisResult) -> Vec<WhatIfScenario> {
    if a.engine != Engine::Postgres {
        return Vec::new();
    }
    let has = |needle: &str| any_node(a, |n| n.node_type.contains(needle));
    let mut out = Vec::new();

    if has("Nested Loop") {
        out.push(scenario(
            "nestloop_off",
            "Hash/merge joins instead of nested loops",
            vec!["SET enable_nestloop = off".into()],
            "The plan uses nested loops, which are only fast when the planner's row estimates are right.",
        ));
    }
    if has("Hash Join") || has("Hash Left") || has("Hash Right") || has("Hash Semi") || has("Hash Anti") {
        out.push(scenario(
            "hashjoin_off",
            "No hash joins",
            vec!["SET enable_hashjoin = off".into()],
            "Checks whether a nested loop or merge join would serve these joins better.",
        ));
    }
    if has("Merge Join") || has("Merge Left") || has("Merge Right") {
        out.push(scenario("mergejoin_off", "No merge joins", vec!["SET enable_mergejoin = off".into()], "Checks the merge join choice."));
    }
    let spills = any_node(a, |n| n.warnings.iter().any(|w| matches!(w.kind, WarningKind::SortSpill | WarningKind::HashSpill)));
    if spills || has("Sort") || has("Hash") || has("Aggregate") {
        let current = if a.server.work_mem_kb > 0.0 { a.server.work_mem_kb } else { 4096.0 };
        let target = (current * 4.0).min(1_048_576.0).round() as u64;
        out.push(scenario(
            "work_mem",
            &format!("work_mem × 4 ({} MB)", target / 1024),
            vec![format!("SET work_mem = '{target}kB'")],
            if spills { "Sorts or hashes spill to disk." } else { "Sorts, hashes or aggregates may be memory-limited." },
        ));
    }
    if has("Seq Scan") {
        if a.server.random_page_cost > 1.1 || a.server.random_page_cost == 0.0 {
            out.push(scenario(
                "random_page_cost",
                "SSD cost model (random_page_cost = 1.1)",
                vec!["SET random_page_cost = 1.1".into()],
                "The default cost model assumes slow random I/O, which discourages index scans.",
            ));
        }
        let indexed_scan = any_node(a, |n| {
            n.node_type.contains("Seq Scan")
                && n.relation.as_ref().is_some_and(|r| {
                    a.tables.iter().any(|t| t.name.rsplit('.').next() == Some(r) && !t.indexes.is_empty())
                })
        });
        if indexed_scan {
            out.push(scenario(
                "seqscan_off",
                "Prefer existing indexes",
                vec!["SET enable_seqscan = off".into()],
                "A scanned table has indexes the planner chose not to use.",
            ));
        }
    }
    if a.jit_ms.is_some_and(|j| j > 0.0) {
        out.push(scenario("jit_off", "No JIT compilation", vec!["SET jit = off".into()], "JIT compilation ran for this query."));
    }
    out.extend(statistics_scenarios(a));
    out
}

/// Stale statistics → ANALYZE; misestimates on filters over ≥2 columns of one table →
/// extended statistics.
fn statistics_scenarios(a: &AnalysisResult) -> Vec<WhatIfScenario> {
    let mut out = Vec::new();
    for t in &a.tables {
        let short = t.name.rsplit('.').next().unwrap_or(&t.name);
        let stale = t.last_analyzed.is_none()
            || matches!((t.modified_since_analyze, t.row_estimate), (Some(m), Some(r)) if r > 0.0 && m / r > 0.1);
        let misestimated = any_node(a, |n| {
            n.relation.as_deref() == Some(short) && n.warnings.iter().any(|w| w.kind == WarningKind::RowEstimateError)
        });
        if stale && misestimated {
            out.push(scenario(
                "analyze",
                &format!("Fresh statistics on {short}"),
                vec![format!("ANALYZE {}", t.name)],
                "The table's statistics are missing or stale, and its row estimates are off.",
            ));
        }
        // Columns of this table that appear together in a misestimated node's condition.
        let mut cols: Vec<String> = Vec::new();
        plan::walk(&a.root, &mut |n| {
            if n.relation.as_deref() != Some(short) || !n.warnings.iter().any(|w| w.kind == WarningKind::RowEstimateError) {
                return;
            }
            let detail = n.detail.as_deref().unwrap_or("").to_ascii_lowercase();
            for c in &t.columns {
                if plan::mentions(&detail, &c.name.to_ascii_lowercase()) && !cols.contains(&c.name) {
                    cols.push(c.name.clone());
                }
            }
        });
        if cols.len() >= 2 && a.server.version_num >= 120_000 {
            cols.truncate(8);
            out.push(scenario(
                "ext_stats",
                &format!("Extended statistics on {short} ({})", cols.join(", ")),
                vec![
                    format!("CREATE STATISTICS ql_whatif_stats (dependencies, ndistinct, mcv) ON {} FROM {}", cols.join(", "), t.name),
                    format!("ANALYZE {}", t.name),
                ],
                "Correlated columns filtered together are the classic cause of row misestimates.",
            ));
        }
    }
    out
}

fn verdict(kind: &str, outcome: WhatIfOutcome, speedup: Option<f64>) -> String {
    let x = speedup.map(|s| if s >= 10.0 { format!("{s:.0}×") } else { format!("{s:.1}×") }).unwrap_or_default();
    match outcome {
        WhatIfOutcome::NoChange => "Same plan. This lever doesn't matter for this query.".into(),
        WhatIfOutcome::Failed => "Couldn't evaluate this scenario.".into(),
        WhatIfOutcome::Similar => "Different plan, similar speed.".into(),
        WhatIfOutcome::Slower => {
            if speedup.is_none() {
                "Much slower (stopped early). The planner's current choice is right here.".into()
            } else {
                format!("{} slower. The planner's current choice is right here.", speedup.map(|s| format!("{:.1}×", 1.0 / s)).unwrap_or_default())
            }
        }
        WhatIfOutcome::Faster => match kind {
            "nestloop_off" => format!(
                "{x} faster without nested loops. The planner's row estimates are wrong (cost model), not the \
                 schema. Fix the estimates (ANALYZE, extended statistics) rather than disabling nested loops globally."
            ),
            "hashjoin_off" | "mergejoin_off" => format!("{x} faster with a different join method. The join choice is off, usually due to row misestimates."),
            "work_mem" => format!("{x} faster with more memory. The query is memory-bound: raise work_mem for it (SET LOCAL in its transaction)."),
            "random_page_cost" => format!("{x} faster with an SSD cost model. Set random_page_cost ≈ 1.1 if your storage is SSD/NVMe."),
            "seqscan_off" => format!("{x} faster using an existing index the planner avoided. Check statistics and random_page_cost."),
            "jit_off" => format!("{x} faster without JIT. Compilation costs more than it saves: SET jit = off or raise jit_above_cost."),
            "analyze" => format!("{x} faster with fresh statistics. Run ANALYZE on the table, and check autovacuum."),
            "ext_stats" => format!("{x} faster with extended statistics. These columns are correlated: keep the CREATE STATISTICS."),
            _ => format!("{x} faster."),
        },
    }
}

fn summarize(results: &[WhatIfResult]) -> String {
    let best = results
        .iter()
        .filter(|r| r.outcome == WhatIfOutcome::Faster)
        .max_by(|a, b| a.speedup.unwrap_or(0.0).total_cmp(&b.speedup.unwrap_or(0.0)));
    match best {
        Some(r) => r.verdict.clone(),
        None if results.iter().all(|r| r.outcome == WhatIfOutcome::NoChange) => {
            "None of the planner levers change the plan. The cost is in the data access itself: look at indexes \
             or rewriting the query."
                .into()
        }
        None => "No alternative beats the current plan. The planner's choices hold up; the remaining cost is in the \
                 data access itself (indexes, rewrite)."
            .into(),
    }
}

/// Run the sweep for an analysis on its connection. Streams events through `emit`,
/// stores scenario analyses in `scratch` (for Compare) and persists the report.
pub async fn sweep(
    store: &Store,
    scratch: &Scratch,
    baseline: &AnalysisResult,
    emit: &(dyn Fn(WhatIfEvent) + Send + Sync),
) -> AppResult<WhatIfReport> {
    let conn = store.get_connection(&baseline.connection_id)?;
    let spec = analysis::spec_for(&conn)?;
    let settings = store.get_settings()?.analysis;
    let scenarios = select_scenarios(baseline);
    emit(WhatIfEvent::Started { scenarios: scenarios.clone() });

    let timed = baseline.mode == ExplainMode::Analyze;
    let base_value = if timed {
        baseline.timing.as_ref().map(|t| t.median_ms).or(baseline.execution_time_ms)
    } else {
        baseline.total_cost
    };
    let budget_ms = base_value.filter(|_| timed).map(|ms| (ms * BUDGET_FACTOR).max(MIN_BUDGET_MS));

    let mut results = Vec::new();
    for sc in scenarios {
        emit(WhatIfEvent::Running { kind: sc.kind.clone(), phase: "planning".into() });
        let estimate_opts = RunOptions { setup: sc.setup.clone(), read_only: true, ..RunOptions::new(ExplainMode::Estimate) };
        let limits = Limits::from_settings(&settings);
        let result = match analysis::explain(&conn, &spec, &baseline.sql, &estimate_opts, limits).await {
            Err(e) => WhatIfResult {
                scenario: sc.clone(),
                outcome: WhatIfOutcome::Failed,
                plan_changed: false,
                before: base_value,
                after: None,
                speedup: None,
                timed,
                analysis_id: None,
                verdict: format!("Couldn't evaluate: {}", e.message),
            },
            Ok(est) if est.plan_fp == baseline.plan_fp => WhatIfResult {
                scenario: sc.clone(),
                outcome: WhatIfOutcome::NoChange,
                plan_changed: false,
                before: base_value,
                after: base_value,
                speedup: Some(1.0),
                timed,
                analysis_id: None,
                verdict: verdict(&sc.kind, WhatIfOutcome::NoChange, None),
            },
            Ok(est) => {
                let (after, analysis_id, stopped) = if timed {
                    emit(WhatIfEvent::Running { kind: sc.kind.clone(), phase: "profiling".into() });
                    let opts = RunOptions {
                        setup: sc.setup.clone(),
                        read_only: true,
                        runs: settings.repeat_runs,
                        ..RunOptions::new(ExplainMode::Analyze)
                    };
                    let timeout = budget_ms.map(|b| b.min(settings.statement_timeout_ms as f64) as u32).unwrap_or(settings.statement_timeout_ms);
                    match analysis::explain(&conn, &spec, &baseline.sql, &opts, Limits { timeout_ms: timeout, ..limits }).await {
                        Ok(run) => {
                            let ms = run.timing.as_ref().map(|t| t.median_ms).or(run.execution_time_ms);
                            let id = run.id.clone();
                            scratch.remember(run);
                            (ms, Some(id), false)
                        }
                        // Over budget: clearly slower than the baseline.
                        Err(_) => (None, None, true),
                    }
                } else {
                    let cost = est.total_cost;
                    let id = est.id.clone();
                    scratch.remember(est);
                    (cost, Some(id), false)
                };
                let speedup = match (base_value, after) {
                    (Some(b), Some(a)) if a > 0.0 => Some(b / a),
                    _ => None,
                };
                let outcome = match (stopped, speedup) {
                    (true, _) => WhatIfOutcome::Slower,
                    (_, Some(s)) if s >= 1.0 + SIMILAR => WhatIfOutcome::Faster,
                    (_, Some(s)) if s <= 1.0 / (1.0 + SIMILAR) => WhatIfOutcome::Slower,
                    (_, Some(_)) => WhatIfOutcome::Similar,
                    (_, None) => WhatIfOutcome::Failed,
                };
                WhatIfResult {
                    verdict: verdict(&sc.kind, outcome, speedup),
                    scenario: sc.clone(),
                    outcome,
                    plan_changed: true,
                    before: base_value,
                    after,
                    speedup,
                    timed,
                    analysis_id,
                }
            }
        };
        emit(WhatIfEvent::Result { result: result.clone() });
        results.push(result);
    }

    let report = WhatIfReport { summary: summarize(&results), results, created_at: crate::storage::now() };
    // Persist alongside the analysis when it lives in history (scratch ones don't).
    if store.get_analysis(&baseline.id).is_ok() {
        store.set_whatif(&baseline.id, &report)?;
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{ColumnInfo, IndexInfo, ServerInfo, TableContext};

    fn analysis(raw: &str, tables: Vec<TableContext>) -> AnalysisResult {
        let p = plan::parse(Engine::Postgres, ExplainMode::Analyze, raw).unwrap();
        AnalysisResult {
            id: "a".into(),
            connection_id: "c".into(),
            connection_name: "c".into(),
            engine: Engine::Postgres,
            mode: ExplainMode::Analyze,
            sql: "select 1".into(),
            node_count: 1,
            warnings_count: plan::count_warnings(&p.root),
            planning_time_ms: None,
            execution_time_ms: p.execution_time_ms,
            total_cost: p.total_cost,
            jit_ms: None,
            serialize_ms: None,
            serialize_bytes: None,
            planner_settings: vec![],
            root: p.root,
            tables,
            raw_plan: String::new(),
            analyzed_at: String::new(),
            suggestions: None,
            server: ServerInfo { version_num: 170000, work_mem_kb: 4096.0, random_page_cost: 4.0, ..Default::default() },
            timing: None,
            query_fp: String::new(),
            plan_fp: String::new(),
            baseline: None,
            whatif: None,
        }
    }

    fn table(name: &str, cols: &[&str], indexed: bool, analyzed: bool) -> TableContext {
        TableContext {
            name: name.into(),
            row_estimate: Some(1e6),
            size_bytes: Some(1e8),
            last_analyzed: analyzed.then(|| "2026-10-01".into()),
            modified_since_analyze: Some(0.0),
            columns: cols.iter().map(|c| ColumnInfo { name: (*c).into(), data_type: "int".into(), stats: None }).collect(),
            indexes: if indexed { vec![IndexInfo { name: "i".into(), definition: "x".into() }] } else { vec![] },
        }
    }

    const NESTED: &str = r#"[{"Plan": {"Node Type": "Nested Loop", "Total Cost": 10, "Plan Rows": 1,
        "Actual Total Time": 900, "Actual Rows": 5000, "Actual Loops": 1, "Plans": [
          {"Node Type": "Seq Scan", "Relation Name": "orders", "Total Cost": 5, "Plan Rows": 2,
           "Actual Total Time": 100, "Actual Rows": 5000, "Actual Loops": 1,
           "Filter": "((status = 'paid') AND (country = 'TN'))"},
          {"Node Type": "Index Scan", "Relation Name": "users", "Index Name": "users_pkey", "Total Cost": 1,
           "Plan Rows": 1, "Actual Total Time": 0.15, "Actual Rows": 1, "Actual Loops": 5000}]}}]"#;

    #[test]
    fn picks_levers_that_fit_the_plan() {
        let a = analysis(NESTED, vec![table("orders", &["status", "country", "id"], true, false), table("users", &["id"], true, true)]);
        let kinds: Vec<String> = select_scenarios(&a).into_iter().map(|s| s.kind).collect();
        for k in ["nestloop_off", "random_page_cost", "seqscan_off", "analyze", "ext_stats"] {
            assert!(kinds.contains(&k.to_string()), "missing {k} in {kinds:?}");
        }
        assert!(!kinds.contains(&"jit_off".to_string()));
        assert!(!kinds.contains(&"hashjoin_off".to_string()));
        let ext = select_scenarios(&a).into_iter().find(|s| s.kind == "ext_stats").unwrap();
        assert!(ext.setup[0].contains("ON status, country FROM orders"), "{:?}", ext.setup);
    }

    #[test]
    fn verdicts_name_the_cause() {
        assert!(verdict("nestloop_off", WhatIfOutcome::Faster, Some(3.6)).contains("row estimates"));
        assert!(verdict("work_mem", WhatIfOutcome::Faster, Some(2.0)).contains("memory-bound"));
        assert!(verdict("x", WhatIfOutcome::Slower, None).contains("stopped early"));
    }
}
