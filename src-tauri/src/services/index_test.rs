//! Does a candidate index help a query? Tested against the planner with HypoPG
//! hypothetical indexes when available (instant, lock-free: an estimate), else by
//! building the index inside the rolled-back transaction and profiling (measured).

use crate::error::{AppError, AppResult};
use crate::model::{AnalysisResult, Engine, Evidence, ExplainMode};
use crate::plan;

use super::analysis::{self, Limits, RunOptions};
use super::target::Target;

pub struct IndexTest {
    pub evidence: Evidence,
    /// Estimated cost (Estimated) or median ms (Measured), without / with.
    pub before: f64,
    pub after: f64,
    /// Indexes from the candidates the planner chose, "name on table".
    pub used: Vec<String>,
    pub plan_after: AnalysisResult,
}

pub struct IndexTestOptions {
    pub params: Vec<Option<String>>,
    /// Profile repeats for the measured path.
    pub runs: u32,
    /// Without HypoPG, building the index for real (rolled back) is allowed.
    pub allow_build: bool,
}

pub fn validate(indexes: &[String]) -> AppResult<()> {
    if indexes.is_empty() {
        return Err(AppError::validation("`indexes` must list at least one CREATE INDEX statement"));
    }
    for ddl in indexes {
        let lower = ddl.trim().to_ascii_lowercase();
        if !(lower.starts_with("create index") || lower.starts_with("create unique index")) {
            return Err(AppError::validation("`indexes` may only contain CREATE [UNIQUE] INDEX statements"));
        }
    }
    Ok(())
}

pub async fn test(target: &Target, limits: Limits, sql: &str, indexes: &[String], opts: IndexTestOptions) -> AppResult<IndexTest> {
    validate(indexes)?;
    if target.conn.engine != Engine::Postgres {
        return Err(AppError::validation(
            "Index testing needs PostgreSQL: other engines can't build an index inside a rolled-back transaction.",
        ));
    }
    let run = |mode, setup: Vec<String>, hypothetical: Vec<String>| RunOptions {
        setup,
        hypothetical,
        read_only: true,
        runs: if mode == ExplainMode::Analyze { opts.runs } else { 1 },
        params: opts.params.clone(),
        ..RunOptions::new(mode)
    };
    // A cheap estimate first: detects HypoPG, and is the "before" of the estimate path.
    let before = analysis::explain(&target.conn, &target.spec, sql, &run(ExplainMode::Estimate, vec![], vec![]), limits).await?;
    if before.server.hypopg {
        let after = analysis::explain(&target.conn, &target.spec, sql, &run(ExplainMode::Estimate, vec![], indexes.to_vec()), limits).await?;
        // HypoPG names its indexes like "<13741>btree_orders_user_id".
        let used = used_indexes(&after, |name| name.contains('<'));
        return Ok(IndexTest {
            evidence: Evidence::Estimated,
            before: before.total_cost.unwrap_or(0.0),
            after: after.total_cost.unwrap_or(0.0),
            used,
            plan_after: after,
        });
    }
    if !opts.allow_build {
        return Err(AppError::validation("HypoPG isn't installed, and building the index for a test wasn't allowed."));
    }
    let existing: Vec<String> = before.tables.iter().flat_map(|t| t.indexes.iter().map(|i| i.name.clone())).collect();
    let before = analysis::explain(&target.conn, &target.spec, sql, &run(ExplainMode::Analyze, vec![], vec![]), limits).await?;
    let after = analysis::explain(&target.conn, &target.spec, sql, &run(ExplainMode::Analyze, indexes.to_vec(), vec![]), limits).await?;
    let used = used_indexes(&after, |name| !existing.iter().any(|e| e == name));
    Ok(IndexTest { evidence: Evidence::Measured, before: median_ms(&before), after: median_ms(&after), used, plan_after: after })
}

fn used_indexes(a: &AnalysisResult, is_candidate: impl Fn(&str) -> bool) -> Vec<String> {
    let mut used = Vec::new();
    plan::walk(&a.root, &mut |n| {
        if let Some(i) = n.index_name.as_deref().filter(|i| is_candidate(i)) {
            let entry = format!("{} on {}", i, n.relation.as_deref().unwrap_or("?"));
            if !used.contains(&entry) {
                used.push(entry);
            }
        }
    });
    used
}

pub fn median_ms(a: &AnalysisResult) -> f64 {
    a.timing.as_ref().map(|t| t.median_ms).or(a.execution_time_ms).unwrap_or(0.0)
}
