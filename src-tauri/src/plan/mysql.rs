//! MySQL `EXPLAIN ANALYZE` / `EXPLAIN FORMAT=TREE` parser.
//!
//! Both print the same indented tree, one operator per `-> ` line:
//! `-> Index lookup on o using idx (user_id=u.id)  (cost=0.25 rows=12) (actual time=0.01..0.2 rows=12 loops=400)`
//! `cost` is cumulative; `actual time` (first..last row, ms) and `rows` are averages per
//! loop, like PostgreSQL. Operators name tables by alias, so aliases are resolved
//! against the query text.

use std::collections::HashMap;

use super::{ParsedPlan, blank_node, fmt_count, warning};
use crate::error::{AppError, AppResult};
use crate::model::{ExplainMode, PlanNode, PlanProperty, WarningKind, WarningSeverity};

/// A full scan this large is worth mentioning even without a selective filter.
const LARGE_SCAN_ROWS: f64 = 1_000_000.0;
/// Filters keeping less than this share of a scanned table want an index.
const SELECTIVE_SHARE: f64 = 0.1;
const SELECTIVE_MIN_ROWS: f64 = 10_000.0;
/// A table scanned this many rows per loop, repeatedly, is a missing join index.
const REPEATED_SCAN_MIN_ROWS: f64 = 1_000.0;
const BLOCKING_SORT_MIN_ROWS: f64 = 10_000.0;

pub(super) fn parse(raw: &str, mode: ExplainMode, sql: &str) -> AppResult<ParsedPlan> {
    let mut lines: Vec<(usize, String)> = Vec::new();
    for line in raw.lines() {
        let trimmed = line.trim_start();
        match trimmed.strip_prefix("-> ") {
            Some(rest) => lines.push((line.len() - trimmed.len(), rest.trim_end().to_string())),
            // Continuation of a long operator description.
            None if !trimmed.is_empty() => {
                if let Some((_, last)) = lines.last_mut() {
                    last.push(' ');
                    last.push_str(trimmed.trim_end());
                }
            }
            None => {}
        }
    }
    if lines.is_empty() {
        return Err(AppError::internal("Unexpected MySQL EXPLAIN output (expected the TREE format)."));
    }

    let mut pos = 0;
    let mut roots = Vec::new();
    while pos < lines.len() {
        roots.push(build(&lines, &mut pos, roots.len().to_string(), mode));
    }
    let mut root = if roots.len() == 1 {
        roots.pop().unwrap()
    } else {
        let mut q = blank_node("q".into(), "Query".into());
        q.children = roots;
        q
    };
    let aliases = alias_map(sql);
    resolve(&mut root, &aliases);
    annotate(&mut root, mode);

    let execution_time_ms = root.total_time_ms;
    // Limit/Sort/aggregate operators often carry no cost: use the topmost costed one.
    let total_cost = root.total_cost.or_else(|| {
        let mut top = None;
        super::walk(&root, &mut |n| top = top.or(n.total_cost));
        top
    });
    Ok(ParsedPlan {
        root,
        planning_time_ms: None,
        execution_time_ms,
        total_cost,
        jit_ms: None,
        serialize_ms: None,
        serialize_bytes: None,
        planner_settings: Vec::new(),
    })
}

/// Pre-order build: children are the following lines indented deeper.
fn build(lines: &[(usize, String)], pos: &mut usize, id: String, mode: ExplainMode) -> PlanNode {
    let (indent, text) = &lines[*pos];
    *pos += 1;
    let mut n = node(text, id.clone(), mode);
    while *pos < lines.len() && lines[*pos].0 > *indent {
        let child_id = format!("{id}.{}", n.children.len());
        n.children.push(build(lines, pos, child_id, mode));
    }
    n
}

fn node(text: &str, id: String, mode: ExplainMode) -> PlanNode {
    let (desc, stats) = split_stats(text);
    let mut n = blank_node(id, String::new());
    describe(&mut n, desc);

    if let Some(cost) = stat(stats, "(cost=") {
        n.total_cost = number(cost.split("..").last().unwrap_or(cost));
        n.estimated_rows = stat(cost_section(stats), "rows=").and_then(number);
    }
    if mode == ExplainMode::Analyze {
        if stats.contains("(never executed)") {
            (n.loops, n.actual_rows, n.total_time_ms) = (Some(0.0), Some(0.0), Some(0.0));
        } else if let Some(actual) = stats.find("(actual time=").map(|i| &stats[i..]) {
            let last = stat(actual, "time=").and_then(|t| number(t.split("..").last().unwrap_or(t)));
            let rows = stat(actual, "rows=").and_then(number);
            let loops = stat(actual, "loops=").and_then(number).unwrap_or(1.0);
            n.loops = Some(loops);
            n.actual_rows = rows;
            n.total_time_ms = last.map(|ms| ms * loops);
        }
    }
    if !stats.is_empty() {
        n.properties.push(PlanProperty { key: "Statistics".into(), value: stats.trim().to_string() });
    }
    n
}

/// Split `desc  (cost=…) (actual …)` at the first statistics group.
fn split_stats(text: &str) -> (&str, &str) {
    let at = ["  (cost=", " (cost=", "  (actual time=", " (actual time=", "  (never executed)", " (never executed)"]
        .iter()
        .filter_map(|p| text.find(p))
        .min();
    match at {
        Some(i) => (text[..i].trim(), &text[i..]),
        None => (text.trim(), ""),
    }
}

/// The `(cost=… rows=…)` group only, so its `rows=` isn't confused with the actual one.
fn cost_section(stats: &str) -> &str {
    match (stats.find("(cost="), stats.find("(actual")) {
        (Some(c), Some(a)) if a > c => &stats[c..a],
        (Some(c), _) => &stats[c..],
        _ => "",
    }
}

/// Value after `key` up to the next space or `)`.
fn stat<'a>(s: &'a str, key: &str) -> Option<&'a str> {
    let start = s.find(key)? + key.len();
    let rest = &s[start..];
    let end = rest.find([' ', ')']).unwrap_or(rest.len());
    Some(&rest[..end])
}

/// Accepts MySQL's `1e+6` style too.
fn number(s: &str) -> Option<f64> {
    s.trim().parse().ok()
}

/// Operator name, table alias, index and condition from the description.
fn describe(n: &mut PlanNode, desc: &str) {
    // "Index lookup on o using idx (user_id=u.id)", "Table scan on o", "Covering index scan on t using i"
    if let Some(on) = desc.find(" on ") {
        let kind = &desc[..on];
        let lower = kind.to_ascii_lowercase();
        if ["scan", "lookup", "search", "row from", "rows from"].iter().any(|k| lower.ends_with(k)) {
            let rest = &desc[on + 4..];
            let alias_end = rest.find(' ').unwrap_or(rest.len());
            let alias = rest[..alias_end].trim_matches('`');
            n.node_type = kind.to_string();
            n.alias = Some(alias.to_string());
            n.relation = Some(alias.to_string());
            let mut tail = rest[alias_end..].trim();
            if let Some(after) = tail.strip_prefix("using ") {
                let idx_end = after.find([' ', '(']).unwrap_or(after.len());
                n.index_name = Some(after[..idx_end].trim_matches('`').to_string());
                tail = after[idx_end..].trim();
            }
            if !tail.is_empty() {
                n.detail = Some(tail.to_string());
            }
            return;
        }
    }
    // "Filter: (o.status = 'paid')", "Sort: spent DESC, limit input to 20 row(s) per chunk"
    if let Some(colon) = desc.find(": ") {
        if !desc[..colon].contains('(') {
            n.node_type = desc[..colon].to_string();
            n.detail = Some(desc[colon + 2..].to_string());
            return;
        }
    }
    // "Inner hash join (o.user_id = u.id)"
    if let Some(paren) = desc.find(" (") {
        if desc[..paren].to_ascii_lowercase().ends_with("join") {
            n.node_type = desc[..paren].to_string();
            n.detail = Some(desc[paren + 1..].to_string());
            return;
        }
    }
    n.node_type = desc.to_string();
}

/// Aliases → table names from FROM / JOIN clauses (`orders o`, `orders AS o`, `shop.orders`).
pub(super) fn alias_map(sql: &str) -> HashMap<String, String> {
    const STOP: &[&str] = &[
        "where", "on", "using", "join", "inner", "left", "right", "cross", "natural", "straight_join", "group",
        "order", "limit", "having", "union", "window", "for", "lock", "set", "outer", "partition", "force",
        "ignore", "use", "lateral", "values", "select",
    ];
    let tokens: Vec<String> = sql
        .split(|c: char| c.is_whitespace() || c == ',' || c == '(' || c == ')' || c == ';')
        .filter(|t| !t.is_empty())
        .map(|t| t.trim_matches('`').to_string())
        .collect();
    let mut map = HashMap::new();
    let mut i = 0;
    while i < tokens.len() {
        let kw = tokens[i].to_ascii_lowercase();
        if kw == "from" || kw == "join" || kw == "straight_join" || kw == "update" || kw == "into" {
            let mut j = i + 1;
            // FROM a x, b y: each comma-separated table (commas were split away).
            while let Some(table) = tokens.get(j) {
                let tl = table.to_ascii_lowercase();
                if STOP.contains(&tl.as_str()) || tl == "from" {
                    break;
                }
                let name = table.rsplit('.').next().unwrap_or(table).trim_matches('`').to_string();
                let mut k = j + 1;
                if tokens.get(k).is_some_and(|t| t.eq_ignore_ascii_case("as")) {
                    k += 1;
                }
                match tokens.get(k) {
                    Some(alias) if !STOP.contains(&alias.to_ascii_lowercase().as_str()) && !alias.eq_ignore_ascii_case("from") => {
                        map.insert(alias.clone(), name.clone());
                        map.entry(name.clone()).or_insert(name);
                        j = k + 1;
                    }
                    _ => {
                        map.entry(name.clone()).or_insert(name);
                        j = k;
                    }
                }
            }
            i = j;
        } else {
            i += 1;
        }
    }
    map
}

fn resolve(n: &mut PlanNode, aliases: &HashMap<String, String>) {
    if let Some(alias) = n.alias.clone() {
        if let Some(table) = aliases.get(&alias) {
            n.relation = Some(table.clone());
        }
        if n.relation.as_deref() == Some(alias.as_str()) {
            n.alias = None;
        }
    }
    for c in &mut n.children {
        resolve(c, aliases);
    }
}

/// Rows produced over all loops (actual when profiled, else the estimate).
fn produced(n: &PlanNode) -> Option<f64> {
    match (n.actual_rows, n.loops) {
        (Some(rows), Some(loops)) => Some(rows * loops),
        _ => n.estimated_rows,
    }
}

fn label(n: &PlanNode) -> String {
    match (&n.relation, &n.alias) {
        (Some(t), Some(a)) => format!("{t} ({a})"),
        (Some(t), None) => t.clone(),
        _ => "the table".into(),
    }
}

fn annotate(n: &mut PlanNode, mode: ExplainMode) {
    for c in &mut n.children {
        annotate(c, mode);
    }
    let is_filter = n.node_type == "Filter";
    let kept = produced(n);
    let cond = n.detail.clone().unwrap_or_default();
    for c in &mut n.children {
        if !c.node_type.eq_ignore_ascii_case("table scan") || c.relation.as_deref().is_some_and(|r| r.starts_with('<')) {
            continue;
        }
        let per_loop = if mode == ExplainMode::Analyze { c.actual_rows } else { c.estimated_rows }.unwrap_or(0.0);
        let loops = c.loops.unwrap_or(1.0);
        let scanned = per_loop * loops.max(1.0);
        let what = label(c);
        if loops > 1.0 && per_loop >= REPEATED_SCAN_MIN_ROWS {
            c.warnings.push(warning(
                WarningKind::MissingIndex,
                WarningSeverity::Error,
                format!(
                    "{what} is scanned in full {} times ({} rows read). An index on its join column lets MySQL \
                     look matching rows up instead.",
                    fmt_count(loops),
                    fmt_count(scanned)
                ),
            ));
        } else if is_filter && scanned >= SELECTIVE_MIN_ROWS && kept.is_some_and(|k| k < scanned * SELECTIVE_SHARE) {
            let kept = kept.unwrap_or(0.0);
            c.warnings.push(warning(
                WarningKind::MissingIndex,
                WarningSeverity::Warning,
                format!(
                    "Read every row of {what} ({}) to keep {} ({:.1}%). An index on the columns in {cond} lets \
                     MySQL read only the matching rows.",
                    fmt_count(scanned),
                    fmt_count(kept),
                    kept / scanned * 100.0
                ),
            ));
        } else if scanned >= LARGE_SCAN_ROWS {
            c.warnings.push(warning(
                WarningKind::SeqScanLarge,
                WarningSeverity::Info,
                format!("Full table scan of {} rows of {what}.", fmt_count(scanned)),
            ));
        }
    }
    if n.node_type == "Sort" {
        let input = n.children.first().and_then(produced).unwrap_or(0.0);
        if input >= BLOCKING_SORT_MIN_ROWS {
            n.warnings.push(warning(
                WarningKind::BlockingSort,
                WarningSeverity::Info,
                format!(
                    "Sorts {} rows before returning the first one. An index whose columns match the ORDER BY \
                     lets MySQL read rows already in order, and stop early under a LIMIT.",
                    fmt_count(input)
                ),
            ));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Engine, Heat};
    use crate::plan;

    const ANALYZE: &str = "-> Limit: 20 row(s)  (actual time=2231..2231 rows=20 loops=1)
    -> Sort: spent DESC, limit input to 20 row(s) per chunk  (actual time=2231..2231 rows=20 loops=1)
        -> Table scan on <temporary>  (actual time=2230..2231 rows=3333 loops=1)
            -> Aggregate using temporary table  (actual time=2230..2230 rows=3333 loops=1)
                -> Nested loop inner join  (cost=212094 rows=9969) (actual time=37.8..2071 rows=33330 loops=1)
                    -> Filter: (o.`status` = 'paid')  (cost=103242 rows=99687) (actual time=24.8..879 rows=200000 loops=1)
                        -> Table scan on o  (cost=103242 rows=996870) (actual time=24.8..734 rows=1e+6 loops=1)
                    -> Filter: (u.country = 'TN')  (cost=0.992 rows=0.1) (actual time=0.00559..0.00561 rows=0.167 loops=200000)
                        -> Single-row index lookup on u using PRIMARY (id=o.user_id)  (cost=0.992 rows=1) (actual time=0.00516..0.00523 rows=1 loops=200000)";

    const SQL: &str = "SELECT u.email, count(*) FROM orders o JOIN users u ON u.id = o.user_id WHERE o.status = 'paid'";

    #[test]
    fn parses_the_tree_with_per_loop_times() {
        let p = plan::parse_query(Engine::Mysql, ExplainMode::Analyze, ANALYZE, SQL).unwrap();
        assert_eq!(p.root.node_type, "Limit");
        assert_eq!(p.execution_time_ms, Some(2231.0));
        let join = &p.root.children[0].children[0].children[0].children[0];
        assert_eq!(join.node_type, "Nested loop inner join");
        assert_eq!(join.total_cost, Some(212094.0));
        let scan = &join.children[0].children[0];
        assert_eq!((scan.node_type.as_str(), scan.relation.as_deref(), scan.alias.as_deref()), ("Table scan", Some("orders"), Some("o")));
        assert_eq!(scan.actual_rows, Some(1e6));
        let lookup = &join.children[1].children[0];
        assert_eq!(lookup.index_name.as_deref(), Some("PRIMARY"));
        assert_eq!(lookup.relation.as_deref(), Some("users"));
        assert_eq!(lookup.detail.as_deref(), Some("(id=o.user_id)"));
        // 0.00523 ms × 200000 loops
        assert!((lookup.total_time_ms.unwrap() - 1046.0).abs() < 1.0);
        assert!(join.children[1].heat != Heat::Low || lookup.heat != Heat::Low);
    }

    #[test]
    fn flags_unindexed_filter_and_sort() {
        let p = plan::parse_query(Engine::Mysql, ExplainMode::Analyze, ANALYZE, SQL).unwrap();
        let mut kinds = Vec::new();
        plan::walk(&p.root, &mut |n| kinds.extend(n.warnings.iter().map(|w| w.kind)));
        // status filter keeps 20%: not selective enough for MissingIndex, but a 1M-row scan.
        assert!(kinds.contains(&WarningKind::SeqScanLarge), "{kinds:?}");
        let raw = "-> Filter: (o.user_id = 42)  (cost=100000 rows=10) (actual time=0.1..300 rows=9 loops=1)
    -> Table scan on o  (cost=100000 rows=1e+6) (actual time=0.05..250 rows=1e+6 loops=1)";
        let p = plan::parse_query(Engine::Mysql, ExplainMode::Analyze, raw, "select * from orders o where o.user_id = 42").unwrap();
        let w = &p.root.children[0].warnings[0];
        assert_eq!(w.kind, WarningKind::MissingIndex);
        assert!(w.message.contains("orders (o)") && w.message.contains("user_id"), "{}", w.message);
    }

    #[test]
    fn estimate_tree_and_never_executed() {
        let raw = "-> Nested loop inner join  (cost=4.5 rows=3)
    -> Table scan on t1  (cost=0.55 rows=3)
    -> Index lookup on t2 using t2_a (a=t1.a)  (cost=1.1 rows=1)";
        let p = plan::parse_query(Engine::Mysql, ExplainMode::Estimate, raw, "select * from t1 join t2 on t2.a = t1.a").unwrap();
        assert_eq!(p.root.children.len(), 2);
        assert_eq!(p.total_cost, Some(4.5));
        assert!(p.root.actual_rows.is_none());
        let raw = "-> Filter: (t.a > 5)  (cost=1 rows=1) (never executed)";
        let p = plan::parse_query(Engine::Mysql, ExplainMode::Analyze, raw, "").unwrap();
        assert_eq!(p.root.loops, Some(0.0));
    }

    #[test]
    fn maps_aliases() {
        let m = alias_map("SELECT * FROM shop.orders AS o, products p JOIN `users` u ON u.id = o.user_id WHERE 1");
        assert_eq!(m.get("o").map(String::as_str), Some("orders"));
        assert_eq!(m.get("u").map(String::as_str), Some("users"));
        assert_eq!(m.get("p").map(String::as_str), Some("products"));
    }
}
