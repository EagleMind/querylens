//! Tools that plan and measure a single query: explain_query, table_info, test_index.
//! Everything runs read-only inside a transaction that is rolled back.

use serde_json::Value;

use super::{Server, arg_list, arg_str};
use crate::error::AppResult;
use crate::llm::prompt;
use crate::model::{Evidence, ExplainMode};
use crate::services::analysis::{self, Limits, RunOptions};
use crate::services::index_test::{self, IndexTestOptions};
use crate::{capture::render, engines};

impl Server {
    fn limits(&self) -> AppResult<(Limits, u32)> {
        let settings = self.store.get_settings()?.analysis;
        Ok((Limits::from_settings(&settings), settings.repeat_runs))
    }

    pub(super) async fn explain_query(&self, args: &Value) -> AppResult<String> {
        let sql = arg_str(args, "sql")?;
        let analyze = args.get("analyze").and_then(Value::as_bool).unwrap_or(true);
        // A single statement, or several (e.g. CREATE STATISTICS + ANALYZE).
        let setup = arg_list(args, "setup_sql");
        let params: Vec<Option<String>> = arg_list(args, "params").into_iter().map(Some).collect();
        let mode = if analyze { ExplainMode::Analyze } else { ExplainMode::Estimate };
        let (limits, runs) = self.limits()?;
        let opts = RunOptions { setup: setup.clone(), read_only: true, runs, params, ..RunOptions::new(mode) };
        let result = analysis::explain(&self.target.conn, &self.target.spec, sql, &opts, limits).await?;

        let mut out = String::new();
        if !setup.is_empty() {
            out.push_str(&format!("(setup, rolled back afterwards: {})\n", setup.join("; ")));
        }
        match (&result.timing, result.execution_time_ms) {
            (Some(t), _) => out.push_str(&format!(
                "Execution time: median {} over {} runs (first run {}, range {}–{})\n",
                prompt::fmt_ms(t.median_ms),
                t.execution_ms.len(),
                prompt::fmt_ms(t.first_ms),
                prompt::fmt_ms(t.min_ms),
                prompt::fmt_ms(t.max_ms)
            )),
            (None, Some(ms)) => out.push_str(&format!("Execution time: {}\n", prompt::fmt_ms(ms))),
            (None, None) => out.push_str("Estimate only (not executed)\n"),
        }
        if let Some(c) = result.total_cost {
            out.push_str(&format!("Total estimated cost: {c:.0}\n"));
        }
        out.push_str(&prompt::compact_plan(&result.root));
        Ok(out)
    }

    pub(super) async fn test_index(&self, args: &Value) -> AppResult<String> {
        let sql = arg_str(args, "sql")?;
        let indexes = arg_list(args, "indexes");
        let params: Vec<Option<String>> = arg_list(args, "params").into_iter().map(Some).collect();
        let (limits, runs) = self.limits()?;
        let opts = IndexTestOptions { params, runs, allow_build: true };
        let t = index_test::test(&self.target, limits, sql, &indexes, opts).await?;
        let mut out = match t.evidence {
            Evidence::Estimated => "EVIDENCE: estimated (HypoPG hypothetical index; planner cost only, nothing was executed)\n",
            Evidence::Measured => "EVIDENCE: measured (index built inside a rolled-back transaction, query executed)\n",
        }
        .to_string();
        out.push_str(&format!("Result: {}\n", render::index_evidence(t.evidence, t.before, t.after)));
        if t.used.is_empty() {
            out.push_str("The planner does NOT use the candidate index(es) for this query.\n");
        } else {
            out.push_str(&format!("The planner uses: {}\n", t.used.join(", ")));
        }
        out.push_str("Plan with the index:\n");
        out.push_str(&prompt::compact_plan(&t.plan_after.root));
        Ok(out)
    }

    pub(super) async fn table_info(&self, args: &Value) -> AppResult<String> {
        let table = arg_str(args, "table")?;
        let mut session = engines::open(&self.target.spec).await?;
        let tables = session.table_context(&[table.to_string()]).await?;
        Ok(match tables.first() {
            Some(t) => prompt::table_summary(t, None),
            None => format!("Table {table} not found."),
        })
    }
}
