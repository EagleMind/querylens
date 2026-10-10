use std::time::{Duration, Instant};

use crate::engines::{self, ConnectSpec, ExplainRequest};
use crate::error::AppResult;
use crate::model::{AnalysisResult, Baseline, Connection, ConnectionInput, ExplainMode, RunStats};
use crate::storage::Store;
use crate::{plan, secrets};

pub fn spec_for(conn: &Connection) -> AppResult<ConnectSpec> {
    let password = if conn.has_password {
        secrets::get(&secrets::connection_account(&conn.id))?
    } else {
        None
    };
    Ok(ConnectSpec {
        engine: conn.engine,
        host: conn.host.clone(),
        port: conn.port,
        database: conn.database.clone(),
        username: conn.username.clone(),
        password,
        ssl_mode: conn.ssl_mode,
        file_path: conn.file_path.clone(),
    })
}

/// Spec for an unsaved form. A `null` password on an existing connection falls back
/// to the stored one, so "Test" works when editing without retyping it.
pub fn spec_for_input(input: &ConnectionInput) -> AppResult<ConnectSpec> {
    let password = match (&input.password, &input.id) {
        (Some(p), _) => Some(p.clone()),
        (None, Some(id)) => secrets::get(&secrets::connection_account(id))?,
        (None, None) => None,
    };
    Ok(ConnectSpec {
        engine: input.engine,
        host: input.host.clone(),
        port: input.port,
        database: input.database.clone(),
        username: input.username.clone(),
        password,
        ssl_mode: input.ssl_mode,
        file_path: input.file_path.clone(),
    })
}

pub struct RunOptions {
    pub mode: ExplainMode,
    /// Save to history (false for MCP tool calls the model makes).
    pub persist: bool,
    /// Statements run first inside the same rolled-back transaction (verification,
    /// what-if scenarios). Validated with `sanitize_setup_sql`.
    pub setup: Vec<String>,
    /// HypoPG hypothetical indexes (`CREATE INDEX …`); forces a plain EXPLAIN.
    pub hypothetical: Vec<String>,
    /// Model-issued query: run the EXPLAIN in a read-only transaction.
    pub read_only: bool,
    /// Profile repeats (1 = single run). Ignored for Explain, which is deterministic.
    pub runs: u32,
}

impl RunOptions {
    pub fn new(mode: ExplainMode) -> Self {
        Self { mode, persist: false, setup: Vec::new(), hypothetical: Vec::new(), read_only: false, runs: 1 }
    }
}

/// Statement/lock timeouts from Settings.
#[derive(Debug, Clone, Copy)]
pub struct Limits {
    pub timeout_ms: u32,
    pub lock_timeout_ms: u32,
}

impl Limits {
    pub fn from_settings(s: &crate::model::AnalysisSettings) -> Self {
        Self { timeout_ms: s.statement_timeout_ms, lock_timeout_ms: s.lock_timeout_ms }
    }
}

/// Repeat-run budget: a single run longer than this is never repeated, and repeats stop
/// once the total exceeds max(2 × first run, this).
const REPEAT_BUDGET: Duration = Duration::from_secs(10);

/// Analyze against a saved connection: resolve credentials, explain, (persist).
pub async fn run(store: &Store, connection_id: &str, sql: &str, opts: RunOptions) -> AppResult<AnalysisResult> {
    let conn = store.get_connection(connection_id)?;
    let limits = Limits::from_settings(&store.get_settings()?.analysis);
    let mut result = explain(&conn, &spec_for(&conn)?, sql, &opts, limits).await?;
    if opts.persist {
        result.baseline = store.previous_analysis(&conn.id, &result.query_fp)?.map(|prev| Baseline {
            plan_changed: !prev.plan_fp.is_empty() && prev.plan_fp != result.plan_fp,
            time_ratio: match (prev.mode, result.mode, prev.execution_time_ms, result.execution_time_ms) {
                (ExplainMode::Analyze, ExplainMode::Analyze, Some(before), Some(now)) if before > 0.0 => {
                    Some(now / before)
                }
                _ => None,
            },
            previous_id: prev.id,
            previous_at: prev.created_at,
        });
        store.insert_analysis(&result)?;
        store.touch_connection(&conn.id)?;
    }
    Ok(result)
}

struct Sample {
    raw: String,
    parsed: plan::ParsedPlan,
    execution_ms: f64,
    read_blocks: f64,
}

/// Connect → EXPLAIN (×runs) → parse/score → schema context. No storage or keychain access.
pub async fn explain(
    conn: &Connection,
    spec: &ConnectSpec,
    sql: &str,
    opts: &RunOptions,
    limits: Limits,
) -> AppResult<AnalysisResult> {
    let sql = engines::sanitize_sql(sql)?;
    let setup = opts.setup.iter().map(|s| engines::sanitize_setup_sql(s)).collect::<AppResult<Vec<_>>>()?;
    let hypothetical = opts.hypothetical.iter().map(|s| engines::sanitize_sql(s)).collect::<AppResult<Vec<_>>>()?;
    // Hypothetical indexes are planner-only, so they always produce an estimate.
    let mode = if hypothetical.is_empty() { opts.mode } else { ExplainMode::Estimate };

    let mut session = engines::open(spec).await?;
    let request = ExplainRequest {
        sql: &sql,
        mode,
        timeout_ms: limits.timeout_ms,
        lock_timeout_ms: limits.lock_timeout_ms,
        setup: &setup,
        hypothetical: &hypothetical,
        read_only: opts.read_only,
    };

    let wanted = if mode == ExplainMode::Analyze { opts.runs.clamp(1, 10) } else { 1 };
    let started = Instant::now();
    let mut first_wall = Duration::ZERO;
    let mut samples: Vec<Sample> = Vec::new();
    while samples.len() < wanted as usize {
        let run_started = Instant::now();
        let raw = session.explain(&request).await?;
        let parsed = plan::parse(conn.engine, mode, &raw)?;
        let execution_ms = parsed.execution_time_ms.unwrap_or(0.0);
        let read_blocks = parsed.root.buffers.as_ref().map(|b| b.shared_read).unwrap_or(0.0);
        samples.push(Sample { raw, parsed, execution_ms, read_blocks });
        if samples.len() == 1 {
            first_wall = run_started.elapsed();
            if first_wall > REPEAT_BUDGET {
                break;
            }
        } else if started.elapsed() > (first_wall * 2).max(REPEAT_BUDGET) {
            break;
        }
    }

    let timing = (samples.len() > 1).then(|| run_stats(&samples, wanted));
    // Show the median run: it is the most representative plan and timing.
    let median_idx = median_index(&samples);
    let server = session.server_info();
    let Sample { raw, parsed, .. } = samples.swap_remove(median_idx);

    // Schema context improves suggestions but must never fail an analysis.
    let tables = session.table_context(&plan::relations(&parsed.root)).await.unwrap_or_else(|e| {
        log::warn!("table context failed: {e}");
        Vec::new()
    });

    let sql_for_fp = sql.clone();
    let root_for_fp = parsed.root.clone();
    Ok(AnalysisResult {
        id: uuid::Uuid::new_v4().to_string(),
        connection_id: conn.id.clone(),
        connection_name: conn.name.clone(),
        engine: conn.engine,
        mode,
        sql,
        node_count: plan::count_nodes(&parsed.root),
        warnings_count: plan::count_warnings(&parsed.root),
        planning_time_ms: parsed.planning_time_ms,
        execution_time_ms: parsed.execution_time_ms,
        total_cost: parsed.total_cost,
        jit_ms: parsed.jit_ms,
        serialize_ms: parsed.serialize_ms,
        serialize_bytes: parsed.serialize_bytes,
        planner_settings: parsed.planner_settings,
        root: parsed.root,
        tables,
        raw_plan: raw,
        analyzed_at: crate::storage::now(),
        suggestions: None,
        server,
        timing,
        query_fp: plan::fingerprint::query_fp(&sql_for_fp),
        plan_fp: plan::fingerprint::plan_fp(&root_for_fp),
        baseline: None,
        whatif: None,
    })
}

/// Above this many rows a candidate index is tested hypothetically (HypoPG) instead
/// of being built inside the transaction.
const HYPOTHETICAL_ABOVE_ROWS: f64 = 5_000_000.0;

/// Re-run the baseline query with a suggested fix applied, inside the usual rolled-back
/// transaction. Supports index DDL, settings/statistics, and query rewrites.
pub async fn preview_fix(store: &Store, baseline: &AnalysisResult, fix: &str) -> AppResult<AnalysisResult> {
    let fix = engines::sanitize_sql(fix)?;
    let lower = fix.to_ascii_lowercase();
    let runs = store.get_settings()?.analysis.repeat_runs;
    let base = RunOptions { read_only: true, runs, ..RunOptions::new(baseline.mode) };

    let (sql, opts) = if lower.starts_with("create index") || lower.starts_with("create unique index") {
        let target_rows = index_target(&lower)
            .and_then(|t| baseline.tables.iter().find(|tc| tc.name.rsplit('.').next() == Some(t.as_str())))
            .and_then(|tc| tc.row_estimate)
            .unwrap_or(0.0);
        if baseline.server.hypopg && target_rows > HYPOTHETICAL_ABOVE_ROWS {
            (baseline.sql.clone(), RunOptions { hypothetical: vec![fix.clone()], ..base })
        } else {
            (baseline.sql.clone(), RunOptions { setup: vec![fix.clone()], ..base })
        }
    } else if ["select", "with", "values", "table"].iter().any(|k| lower.starts_with(k)) {
        (fix.clone(), base)
    } else {
        // Settings / statistics, possibly several statements ("CREATE STATISTICS …; ANALYZE t").
        let setup: Vec<String> = fix.split(';').map(str::trim).filter(|s| !s.is_empty()).map(String::from).collect();
        for s in &setup {
            engines::sanitize_setup_sql(s).map_err(|_| {
                crate::error::AppError::validation(
                    "This fix can't be previewed automatically. Only indexes, SET, CREATE STATISTICS / ANALYZE \
                     and rewritten queries can be.",
                )
            })?;
        }
        (baseline.sql.clone(), RunOptions { setup, ..base })
    };
    let conn = store.get_connection(&baseline.connection_id)?;
    let limits = Limits::from_settings(&store.get_settings()?.analysis);
    explain(&conn, &spec_for(&conn)?, &sql, &opts, limits).await
}

/// Table name in `create [unique] index [concurrently] [name] on [only] <table> …`.
fn index_target(lower: &str) -> Option<String> {
    let after_on = lower.split(" on ").nth(1)?;
    let mut words = after_on.split_whitespace();
    let mut t = words.next()?;
    if t == "only" {
        t = words.next()?;
    }
    let t = t.split('(').next()?.trim_matches('"');
    Some(t.rsplit('.').next()?.to_string())
}

fn median_index(samples: &[Sample]) -> usize {
    let mut order: Vec<usize> = (0..samples.len()).collect();
    order.sort_by(|&a, &b| samples[a].execution_ms.total_cmp(&samples[b].execution_ms));
    order[(order.len() - 1) / 2]
}

fn run_stats(samples: &[Sample], requested: u32) -> RunStats {
    let times: Vec<f64> = samples.iter().map(|s| s.execution_ms).collect();
    let mut sorted = times.clone();
    sorted.sort_by(f64::total_cmp);
    let mut warm_reads: Vec<f64> = samples[1..].iter().map(|s| s.read_blocks).collect();
    warm_reads.sort_by(f64::total_cmp);
    RunStats {
        first_ms: times[0],
        median_ms: sorted[(sorted.len() - 1) / 2],
        min_ms: sorted[0],
        max_ms: sorted[sorted.len() - 1],
        first_read_blocks: samples[0].read_blocks,
        warm_read_blocks: warm_reads.get((warm_reads.len().max(1) - 1) / 2).copied(),
        requested,
        execution_ms: times,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(ms: f64, reads: f64) -> Sample {
        let raw = r#"[{"Plan": {"Node Type": "Result", "Total Cost": 1, "Plan Rows": 1}}]"#;
        Sample {
            raw: raw.into(),
            parsed: plan::parse(crate::model::Engine::Postgres, ExplainMode::Estimate, raw).unwrap(),
            execution_ms: ms,
            read_blocks: reads,
        }
    }

    #[test]
    fn finds_index_target_table() {
        assert_eq!(index_target("create index concurrently foo on public.orders (user_id)").as_deref(), Some("orders"));
        assert_eq!(index_target("create unique index on only events(kind)").as_deref(), Some("events"));
    }

    #[test]
    fn stats_separate_first_run_from_warm_median() {
        let samples = vec![sample(400.0, 8000.0), sample(40.0, 0.0), sample(36.0, 0.0)];
        let st = run_stats(&samples, 3);
        assert_eq!(st.first_ms, 400.0);
        assert_eq!(st.median_ms, 40.0);
        assert_eq!((st.min_ms, st.max_ms), (36.0, 400.0));
        assert_eq!(st.first_read_blocks, 8000.0);
        assert_eq!(st.warm_read_blocks, Some(0.0));
        assert_eq!(samples[median_index(&samples)].execution_ms, 40.0);
    }
}
