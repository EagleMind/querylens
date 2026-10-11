//! Capture tools: an agent records the application's traffic while it runs the app
//! or its tests, reads the findings with ORM-specific fixes, applies a fix, and
//! captures again to compare.

use serde_json::Value;

use super::{Server, arg_str};
use crate::capture::ingest::collector;
use crate::capture::node_hook::{self, node_options};
use crate::capture::{CaptureRegistry, ReportOptions, StartOptions, compare, render, report};
use crate::error::{AppError, AppResult};
use crate::format::fmt_ms;
use crate::model::{CaptureReport, CaptureSource};

/// Default proxy port for agent captures.
const DEFAULT_PORT: u16 = 6543;

impl Server {
    pub(super) async fn capture_start(&self, reg: &CaptureRegistry, args: &Value) -> AppResult<String> {
        let port = args.get("port").and_then(Value::as_u64).map(|p| p as u16).unwrap_or(DEFAULT_PORT);
        let name = args.get("name").and_then(Value::as_str).map(String::from);
        let opts = StartOptions {
            name,
            source: CaptureSource::Mcp,
            collector: Some(([127, 0, 0, 1], collector::DEFAULT_PORT).into()),
            spool: None,
            proxy: Some(([127, 0, 0, 1], port).into()),
            collector_fallback: true,
        };
        let live = reg.start(self.store.clone(), Some(&self.target), opts).await?;
        let sdk = node_options("", &node_hook::install()?);
        let collector_url = live.collector_url.unwrap_or_default();
        let default_url = format!("http://127.0.0.1:{}", collector::DEFAULT_PORT);
        let url_env = if collector_url == default_url { String::new() } else { format!("QUERYLENS_URL='{collector_url}' ") };
        Ok(format!(
            "Capture {id} started on {db}. Now run the application or its tests:

             - Node.js apps on `pg` (Sequelize, Knex, TypeORM, Drizzle): with the querylens-node package installed              they report by themselves{url_hint}. Otherwise preload it:
               {url_env}NODE_OPTIONS='{sdk}' npm test
             - Any other app: point its database URL at the proxy:
               DATABASE_URL='{proxy}' <command>

             Call capture_stop when done to get the findings.",
            id = live.id,
            db = self.target.conn.name,
            url_hint = if url_env.is_empty() { String::new() } else { format!(" when started with {url_env}") },
            proxy = live.app_url.unwrap_or_default(),
        ))
    }

    pub(super) async fn capture_stop(&self, reg: &CaptureRegistry, args: &Value) -> AppResult<String> {
        let id = match args.get("capture_id").and_then(Value::as_str) {
            Some(id) => id.to_string(),
            None => reg.running_ids().await.into_iter().next().ok_or_else(|| AppError::validation("No capture is running"))?,
        };
        let summary = reg.stop(&id, &self.store).await?;
        if summary.statements == 0 {
            return Ok(format!(
                "Capture {id} stopped with no statements: the application didn't connect through the proxy. \
                 Check that it reads the database URL you set."
            ));
        }
        let report = report::build(&self.store, &id, Some(&self.target), &ReportOptions::default()).await?;
        Ok(format!("Capture {id} stopped.\n\n{}", render::markdown(&report)))
    }

    /// The stored report, or a fresh one.
    async fn report_for(&self, id: Option<&str>) -> AppResult<CaptureReport> {
        let id = match id.filter(|i| *i != "latest") {
            Some(i) => i.to_string(),
            None => self.store.list_captures(1)?.into_iter().next().map(|c| c.id).ok_or_else(|| AppError::not_found("No captures yet"))?,
        };
        match self.store.capture_report(&id)? {
            Some(r) => Ok(r),
            None => report::build(&self.store, &id, Some(&self.target), &ReportOptions::default()).await,
        }
    }

    pub(super) async fn capture_report(&self, args: &Value) -> AppResult<String> {
        let report = self.report_for(args.get("capture_id").and_then(Value::as_str)).await?;
        Ok(render::markdown(&report))
    }

    pub(super) async fn capture_statement(&self, args: &Value) -> AppResult<String> {
        let fp = arg_str(args, "fingerprint")?;
        let report = self.report_for(args.get("capture_id").and_then(Value::as_str)).await?;
        let stat = report
            .fingerprints
            .iter()
            .find(|s| s.fingerprint == fp)
            .ok_or_else(|| AppError::not_found(format!("No statement with fingerprint {fp} in this capture")))?;
        let mut out = format!(
            "Statement {fp}: {} calls, {} total, mean {}, p95 {}, max {}; {} rows returned in total.\n\n\
             Normalized:\n{}\n\nSlowest execution:\n{}\n",
            stat.calls,
            fmt_ms(stat.total_ms),
            fmt_ms(stat.mean_ms),
            fmt_ms(stat.p95_ms),
            fmt_ms(stat.max_ms),
            stat.rows,
            stat.normalized,
            stat.sample_sql
        );
        if !stat.sample_params.is_empty() {
            out.push_str(&format!("Parameters: {:?}\n", stat.sample_params));
        }
        if !stat.origins.is_empty() {
            let list: Vec<String> = stat.origins.iter().map(|o| format!("{} (×{})", o.origin, o.count)).collect();
            out.push_str(&format!("Issued from: {}\n", list.join(", ")));
        }
        if let Some(check) = report.plan_checks.iter().find(|c| c.fingerprint == fp) {
            match &check.error {
                Some(e) => out.push_str(&format!("\nPlan: not available ({e})\n")),
                None => {
                    out.push_str(&format!("\nPlan: {}\n", check.shape));
                    for w in &check.warnings {
                        out.push_str(&format!("- {}\n", w.message));
                    }
                    if let Some(ix) = &check.index {
                        out.push_str(&format!(
                            "Index tested: {} → {} ({})\n",
                            ix.ddl,
                            render::index_evidence(ix.evidence, ix.before, ix.after),
                            if ix.used { "used" } else { "not used" }
                        ));
                    }
                }
            }
        }
        Ok(out)
    }

    pub(super) async fn compare_captures(&self, args: &Value) -> AppResult<String> {
        let before = self.report_for(Some(arg_str(args, "before")?)).await?;
        let after = self.report_for(args.get("after").and_then(Value::as_str)).await?;
        Ok(format!(
            "{} → {}\n\n{}",
            before.capture.name,
            after.capture.name,
            render::comparison(&compare::compare(&before, &after))
        ))
    }

    pub(super) fn list_captures(&self) -> AppResult<String> {
        let list = self.store.list_captures(20)?;
        if list.is_empty() {
            return Ok("No captures yet.".into());
        }
        Ok(list
            .iter()
            .map(|c| {
                let state = if c.stopped_at.is_none() { " (running)" } else { "" };
                format!("{}  {}  {} statements, {}{state}", c.id, c.name, c.statements, fmt_ms(c.total_ms))
            })
            .collect::<Vec<_>>()
            .join("\n"))
    }
}
