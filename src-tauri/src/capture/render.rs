//! Text renderings of a report: Markdown (files, CI summaries, MCP) and a short
//! terminal summary.

use std::collections::HashMap;
use std::fmt::Write;

use crate::format::{fmt_count, fmt_ms, fmt_pct};
use crate::model::{CaptureFinding, CaptureReport, Evidence, FingerprintStat, SuggestionSeverity};

const TOP_STATEMENTS: usize = 15;

fn severity(s: SuggestionSeverity) -> &'static str {
    match s {
        SuggestionSeverity::High => "HIGH",
        SuggestionSeverity::Medium => "MEDIUM",
        SuggestionSeverity::Low => "LOW",
    }
}

fn headline(r: &CaptureReport) -> String {
    let mut parts = vec![
        format!("{} statements", fmt_count(r.statements as f64)),
        format!("{} of database time", fmt_ms(r.total_ms)),
        format!("{} distinct", r.fingerprints.len()),
    ];
    if r.units > 0 {
        parts.push(format!("{} requests", r.units));
    }
    if let Some(orm) = r.orm {
        parts.push(format!("ORM: {}", orm.label()));
    }
    parts.join(" · ")
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max { s.to_string() } else { format!("{}…", s.chars().take(max).collect::<String>()) }
}

pub fn markdown(r: &CaptureReport) -> String {
    let stats: HashMap<&str, &FingerprintStat> = r.fingerprints.iter().map(|f| (f.fingerprint.as_str(), f)).collect();
    let mut out = String::new();
    let _ = writeln!(out, "# QueryLens capture: {}\n\n{}\n", r.capture.name, headline(r));

    if r.findings.is_empty() {
        let _ = writeln!(out, "No problems found.\n");
    } else {
        let _ = writeln!(out, "## Findings ({})\n", r.findings.len());
        for (i, f) in r.findings.iter().enumerate() {
            finding_markdown(&mut out, i + 1, f, &stats);
        }
    }

    let _ = writeln!(out, "## Top statements by time\n");
    let _ = writeln!(out, "| Share | Calls | Total | p95 | Rows/call | Statement |\n|---:|---:|---:|---:|---:|---|");
    for s in r.fingerprints.iter().take(TOP_STATEMENTS) {
        let _ = writeln!(
            out,
            "| {} | {} | {} | {} | {} | `{}` |",
            fmt_pct(s.share),
            fmt_count(s.calls as f64),
            fmt_ms(s.total_ms),
            fmt_ms(s.p95_ms),
            fmt_count(s.rows / s.calls as f64),
            truncate(&s.normalized, 110).replace('|', "\\|")
        );
    }
    if r.fingerprints.len() > TOP_STATEMENTS {
        let _ = writeln!(out, "\n…and {} more.", r.fingerprints.len() - TOP_STATEMENTS);
    }

    let failed: Vec<_> = r.plan_checks.iter().filter(|c| c.error.is_some()).collect();
    if !failed.is_empty() {
        let _ = writeln!(out, "\n## Statements that couldn't be re-planned\n");
        for c in failed {
            let what = stats.get(c.fingerprint.as_str()).map(|s| truncate(&s.normalized, 80)).unwrap_or_default();
            let _ = writeln!(out, "- `{what}`: {}", c.error.as_deref().unwrap_or_default());
        }
    }
    out
}

fn finding_markdown(out: &mut String, n: usize, f: &CaptureFinding, stats: &HashMap<&str, &FingerprintStat>) {
    let _ = writeln!(out, "### {n}. [{}] {}\n\n{}\n", severity(f.severity), f.title, f.detail);
    if !f.origins.is_empty() {
        let list: Vec<String> = f.origins.iter().map(|o| format!("`{}` (×{})", o.origin, o.count)).collect();
        let _ = writeln!(out, "- **Where:** {}", list.join(", "));
    }
    if let Some(s) = stats.get(f.fingerprint.as_str()) {
        let _ = writeln!(out, "- **Statement** (fingerprint `{}`):\n\n```sql\n{}\n```", f.fingerprint, s.sample_sql.trim());
    }
    if let Some(parent) = f.parent_fingerprint.as_deref().and_then(|p| stats.get(p)) {
        let _ = writeln!(out, "- **After:**\n\n```sql\n{}\n```", parent.sample_sql.trim());
    }
    if let Some(fix) = &f.fix {
        let who = fix.orm.map(|o| format!(" ({})", o.label())).unwrap_or_default();
        let _ = writeln!(out, "\n**Fix{who}:** {}\n", fix.text);
        if let Some(code) = &fix.code {
            let lang = if fix.orm.is_some_and(|o| o == crate::model::Orm::Sequelize) { "js" } else { "" };
            let _ = writeln!(out, "```{lang}\n{code}\n```\n");
        }
        if let Some(ddl) = &fix.ddl {
            let _ = writeln!(out, "```sql\n{ddl};\n```\n");
        }
    }
    let _ = writeln!(out);
}

/// A few lines for a terminal.
pub fn summary(r: &CaptureReport) -> String {
    let mut out = format!("{}\n", headline(r));
    if r.findings.is_empty() {
        out.push_str("No problems found.\n");
        return out;
    }
    for f in &r.findings {
        let origin = f.origins.first().map(|o| format!("  ({})", o.origin)).unwrap_or_default();
        let _ = writeln!(out, "  {:<6} {}{origin}", severity(f.severity), f.title);
    }
    out
}

/// One line about a tested index, for tools that print it.
pub fn index_evidence(evidence: Evidence, before: f64, after: f64) -> String {
    match evidence {
        Evidence::Estimated => format!("estimated cost {} → {} (hypothetical index)", fmt_count(before), fmt_count(after)),
        Evidence::Measured => format!("{} → {} per call (built and rolled back)", fmt_ms(before), fmt_ms(after)),
    }
}

/// The CI gate's outcome, as Markdown.
pub fn verdict(v: &crate::capture::baseline::Verdict, baseline_path: &str, has_baseline: bool) -> String {
    let mut out = String::new();
    if v.passed() {
        let _ = writeln!(out, "## QueryLens check passed");
    } else {
        let _ = writeln!(out, "## QueryLens check failed: {} new problem(s)", v.failing.len());
    }
    if !has_baseline {
        let _ = writeln!(out, "\nNo baseline at `{baseline_path}`: every finding counts as new. Accept the current ones with `--update-baseline`.");
    }
    for f in &v.failing {
        let origin = f.origins.first().map(|o| format!(" (`{}`)", o.origin)).unwrap_or_default();
        let _ = writeln!(out, "- **[{}]** {}{origin}", severity(f.severity), f.title);
    }
    if !v.new_below_gate.is_empty() {
        let _ = writeln!(out, "\nAlso new, below the gate:");
        for f in &v.new_below_gate {
            let _ = writeln!(out, "- [{}] {}", severity(f.severity), f.title);
        }
    }
    if !v.fixed.is_empty() {
        let _ = writeln!(out, "\nFixed since the baseline (run with `--update-baseline` to record it):");
        for f in &v.fixed {
            let _ = writeln!(out, "- {}", f.title);
        }
    }
    if let Some((before, now)) = v.statements
        && before > 0
        && now != before
    {
        let change = (now as f64 - before as f64) / before as f64;
        let _ = writeln!(out, "\nStatements: {before} → {now} ({:+.0}%).", change * 100.0);
    }
    out
}

/// Before/after of two captures, as Markdown.
pub fn comparison(c: &crate::capture::compare::Comparison) -> String {
    let mut out = String::new();
    let _ = writeln!(
        out,
        "Statements: {} → {} · database time: {} → {}\n",
        fmt_count(c.statements.0 as f64),
        fmt_count(c.statements.1 as f64),
        fmt_ms(c.total_ms.0),
        fmt_ms(c.total_ms.1)
    );
    if c.fixed.is_empty() && c.new.is_empty() {
        let _ = writeln!(out, "Same findings in both captures.");
    }
    for (label, list) in [("Fixed", &c.fixed), ("New", &c.new)] {
        if !list.is_empty() {
            let _ = writeln!(out, "**{label}:**");
            for f in list {
                let _ = writeln!(out, "- [{}] {}", severity(f.severity), f.title);
            }
            let _ = writeln!(out);
        }
    }
    if !c.changes.is_empty() {
        let _ = writeln!(out, "| Calls before | Calls after | Time before | Time after | Statement |\n|---:|---:|---:|---:|---|");
        for ch in &c.changes {
            let _ = writeln!(
                out,
                "| {} | {} | {} | {} | `{}` |",
                ch.calls_before,
                ch.calls_after,
                fmt_ms(ch.ms_before),
                fmt_ms(ch.ms_after),
                truncate(&ch.normalized, 90).replace('|', "\\|")
            );
        }
    }
    out
}
