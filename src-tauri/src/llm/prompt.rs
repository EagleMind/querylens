//! Prompt construction. The model never sees raw EXPLAIN output — only the
//! normalized, annotated tree in a compact indented text form (cheaper and easier
//! for models to reason about than JSON).

use std::fmt::Write;

use crate::model::{AnalysisResult, Engine, ExplainMode, PlanNode, TableContext};
use crate::plan::fmt_count;

const MAX_PLAN_LINES: usize = 200;

pub fn system(engine: Engine, tools: bool) -> String {
    let engine_name = engine.label();
    let index_ddl = match engine {
        Engine::Postgres => "CREATE INDEX CONCURRENTLY",
        Engine::Duckdb => "CREATE INDEX",
    };
    let mut s = format!(
        "You are QueryLens, a senior {engine_name} performance engineer. You receive a SQL \
query, its execution plan (normalized, with each operator's exclusive time, its share of \
total time, and heuristic warnings) and schema facts (columns, existing indexes, row \
counts, statistics freshness).

Give 1-5 specific, actionable suggestions, most impactful first.

Rules:
- Ground every suggestion in the plan and set nodeId to the id of the operator it targets.
- Check the existing indexes first. Never suggest an index that already exists.
- sqlFix must be runnable {engine_name} SQL: a {index_ddl}, a rewritten query, ANALYZE, or a \
SET. Use null if no SQL applies.
- Explanations: at most 3 sentences, and state the expected effect.
- If the plan is already efficient, return a single low-severity suggestion saying so. \
Never invent problems.
"
    );
    if tools {
        s.push_str(
            "
You have tools connected to the user's database:
- explain_query(sql, analyze?, setup_sql?) runs EXPLAIN on a query inside a transaction \
that is always rolled back. setup_sql (Postgres only) runs first in the same transaction, \
for example a CREATE INDEX (without CONCURRENTLY) or SET work_mem, so you can measure a \
fix before recommending it.
- table_info(table) returns columns, indexes, size and statistics.
Test your top suggestions (at most 4 tool calls in total) and quote the measured \
before/after time in the explanation. Set \"verified\": true only for suggestions you \
actually measured.
",
        );
    }
    s.push_str(
        r#"
Your final answer must be ONLY a JSON object, with no prose and no code fences:
{"summary": "<one sentence naming the main bottleneck>",
 "suggestions": [{"severity": "high" | "medium" | "low", "title": "<= 70 chars",
   "explanation": "...", "sqlFix": "..." | null, "nodeId": "0.1" | null, "verified": false}]}"#,
    );
    s
}

pub fn user(a: &AnalysisResult) -> String {
    let mut s = String::new();
    let mode = match a.mode {
        ExplainMode::Analyze => "EXPLAIN ANALYZE (executed, then rolled back)",
        ExplainMode::Estimate => "EXPLAIN (planner estimates only, not executed)",
    };
    let _ = writeln!(s, "Engine: {} · Mode: {mode}", a.engine.label());
    if let Some(ms) = a.execution_time_ms {
        let _ = write!(s, "Execution time: {}", fmt_ms(ms));
        if let Some(t) = &a.timing {
            let _ = write!(
                s,
                " (median of {} runs; first run {}, range {}–{})",
                t.execution_ms.len(),
                fmt_ms(t.first_ms),
                fmt_ms(t.min_ms),
                fmt_ms(t.max_ms)
            );
        }
        if let Some(p) = a.planning_time_ms {
            let _ = write!(s, " · Planning time: {}", fmt_ms(p));
        }
        s.push('\n');
    }
    if let Some(j) = a.jit_ms {
        let _ = writeln!(s, "JIT compilation: {}", fmt_ms(j));
    }
    if let Some(ser) = a.serialize_ms {
        let _ = writeln!(s, "Result serialization: {}", fmt_ms(ser));
    }
    if !a.planner_settings.is_empty() {
        let set: Vec<String> = a.planner_settings.iter().map(|p| format!("{} = {}", p.key, p.value)).collect();
        let _ = writeln!(s, "Non-default planner settings: {}", set.join(", "));
    }
    if let Some(c) = a.total_cost {
        let _ = writeln!(s, "Total estimated cost: {c:.0}");
    }
    let _ = writeln!(s, "\n## Query\n{}\n", a.sql);
    s.push_str("## Plan (id operator · self time (share) · rows actual/estimated · detail)\n");
    s.push_str(&compact_plan(&a.root));
    if !a.tables.is_empty() {
        s.push_str("\n## Tables\n");
        // Column statistics only for columns the query or plan actually mentions.
        let mut mentioned = a.sql.to_ascii_lowercase();
        crate::plan::walk(&a.root, &mut |n| {
            if let Some(d) = &n.detail {
                mentioned.push(' ');
                mentioned.push_str(&d.to_ascii_lowercase());
            }
        });
        for t in &a.tables {
            s.push_str(&table_summary(t, Some(&mentioned)));
        }
    }
    s
}

/// Indented one-line-per-operator rendering, shared with the MCP tool output.
pub fn compact_plan(root: &PlanNode) -> String {
    let mut out = String::new();
    let mut lines = 0;
    render(root, 0, &mut out, &mut lines);
    if lines > MAX_PLAN_LINES {
        let _ = writeln!(out, "… ({} more operators omitted)", lines - MAX_PLAN_LINES);
    }
    out
}

fn render(n: &PlanNode, depth: usize, out: &mut String, lines: &mut usize) {
    *lines += 1;
    if *lines <= MAX_PLAN_LINES {
        let pad = "  ".repeat(depth);
        let _ = write!(out, "{pad}{} {}", n.id, n.node_type);
        if let Some(rel) = &n.relation {
            let _ = write!(out, " on {rel}");
            if let Some(alias) = &n.alias {
                let _ = write!(out, " {alias}");
            }
        }
        if let Some(idx) = &n.index_name {
            let _ = write!(out, " using {idx}");
        }
        if let Some(t) = n.self_time_ms {
            let _ = write!(out, " · self {} ({:.0}%)", fmt_ms(t), n.share * 100.0);
        } else if let Some(c) = n.self_cost {
            let _ = write!(out, " · self cost {c:.0} ({:.0}%)", n.share * 100.0);
        }
        let est = n.estimated_rows.map(fmt_count).unwrap_or_else(|| "?".into());
        match n.actual_rows {
            Some(rows) => {
                let _ = write!(out, " · rows {}/{est}", fmt_count(rows));
                if let Some(l) = n.loops.filter(|l| *l > 1.0) {
                    let _ = write!(out, " ×{} loops", fmt_count(l));
                }
            }
            None => {
                let _ = write!(out, " · est rows {est}");
            }
        }
        if let Some(d) = &n.detail {
            let _ = write!(out, " · {d}");
        }
        for key in ["Rows Removed by Filter", "Rows Removed by Join Filter", "Sort Method", "Hash Batches"] {
            if let Some(p) = n.properties.iter().find(|p| p.key == key && p.value != "1" && p.value != "0") {
                let _ = write!(out, " · {key}: {}", p.value);
            }
        }
        out.push('\n');
        for w in &n.warnings {
            let _ = writeln!(out, "{pad}  ! {:?}: {}", w.kind, w.message);
        }
    }
    for c in &n.children {
        render(c, depth + 1, out, lines);
    }
}

/// `mentioned`: lowercase text to look for column names in; statistics are printed only
/// for columns found there (`None` = every column).
pub fn table_summary(t: &TableContext, mentioned: Option<&str>) -> String {
    let mut s = format!("{}", t.name);
    let mut facts = Vec::new();
    if let Some(r) = t.row_estimate {
        facts.push(format!("~{} rows", fmt_count(r)));
    }
    if let Some(b) = t.size_bytes {
        facts.push(fmt_bytes(b));
    }
    match &t.last_analyzed {
        Some(at) => facts.push(format!("last analyzed {at}")),
        None if t.size_bytes.is_some() => facts.push("never analyzed".into()),
        None => {}
    }
    if let Some(m) = t.modified_since_analyze.filter(|m| *m > 0.0) {
        facts.push(format!("{} rows modified since", fmt_count(m)));
    }
    if !facts.is_empty() {
        let _ = write!(s, " ({})", facts.join(", "));
    }
    s.push('\n');
    if !t.columns.is_empty() {
        let cols: Vec<String> = t.columns.iter().map(|c| format!("{} {}", c.name, c.data_type)).collect();
        let _ = writeln!(s, "  columns: {}", cols.join(", "));
        for c in &t.columns {
            let Some(st) = &c.stats else { continue };
            if mentioned.is_some_and(|m| !mentions(m, &c.name.to_ascii_lowercase())) {
                continue;
            }
            let distinct = if st.n_distinct < 0.0 {
                format!("{:.0}% distinct", -st.n_distinct * 100.0)
            } else {
                format!("{} distinct", fmt_count(st.n_distinct))
            };
            let _ = write!(s, "  stats {}: {distinct}, {:.0}% null", c.name, st.null_frac * 100.0);
            if let Some(corr) = st.correlation {
                let _ = write!(s, ", correlation {corr:.2}");
            }
            let common: Vec<String> = st
                .common_values
                .iter()
                .zip(&st.common_freqs)
                .map(|(v, f)| format!("{v} ({:.1}%)", f * 100.0))
                .collect();
            if !common.is_empty() {
                let _ = write!(s, ", most common: {}", common.join(", "));
            }
            s.push('\n');
        }
    }
    if t.indexes.is_empty() {
        s.push_str("  indexes: none\n");
    } else {
        for i in &t.indexes {
            let _ = writeln!(s, "  index: {}", i.definition);
        }
    }
    s
}

/// Whole-word containment (identifiers: letters, digits, underscore).
fn mentions(haystack: &str, word: &str) -> bool {
    let is_ident = |c: char| c.is_ascii_alphanumeric() || c == '_';
    haystack.match_indices(word).any(|(i, _)| {
        let before = haystack[..i].chars().next_back();
        let after = haystack[i + word.len()..].chars().next();
        !before.is_some_and(is_ident) && !after.is_some_and(is_ident)
    })
}

pub fn fmt_ms(ms: f64) -> String {
    if ms >= 1000.0 {
        format!("{:.2} s", ms / 1000.0)
    } else if ms >= 10.0 {
        format!("{ms:.0} ms")
    } else {
        format!("{ms:.2} ms")
    }
}

fn fmt_bytes(b: f64) -> String {
    const UNITS: [&str; 5] = ["B", "kB", "MB", "GB", "TB"];
    let mut v = b;
    let mut i = 0;
    while v >= 1024.0 && i < UNITS.len() - 1 {
        v /= 1024.0;
        i += 1;
    }
    format!("{v:.0} {}", UNITS[i])
}
