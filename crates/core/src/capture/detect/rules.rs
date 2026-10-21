//! Findings that need no sequence analysis: slow statements, large results,
//! failures, and requests that run too many statements.

use std::collections::HashMap;

use super::{Thresholds, finding, stats};
use crate::capture::mongo;
use crate::capture::sql::shape;
use crate::format::{fmt_count, fmt_ms};
use crate::model::{CaptureFinding, CapturedStatement, FindingKind, FingerprintStat, StatementKind, SuggestionSeverity};

pub fn slow(stat: &FingerprintStat, t: &Thresholds) -> Option<CaptureFinding> {
    // With few calls one outlier is the signal; with many, the 95th percentile.
    let typical = if stat.calls >= 20 { stat.p95_ms } else { stat.max_ms };
    if typical < t.slow_ms {
        return None;
    }
    let severity = if typical >= t.slow_ms * 10.0 {
        SuggestionSeverity::High
    } else if typical >= t.slow_ms * 3.0 {
        SuggestionSeverity::Medium
    } else {
        SuggestionSeverity::Low
    };
    // Said of the request (or capture) it was found in: the issue's own totals say the rest.
    let detail = match stat.calls {
        1 => format!("It took {} (the limit is {}).", fmt_ms(typical), fmt_ms(t.slow_ms)),
        n if n >= 20 => format!(
            "It ran {} times here; 95% of runs finished within {}, half within {} (the limit is {}).",
            fmt_count(n as f64),
            fmt_ms(typical),
            fmt_ms(stat.p50_ms),
            fmt_ms(t.slow_ms)
        ),
        n => format!(
            "It ran {} times here; the slowest took {}, half took under {} (the limit is {}).",
            fmt_count(n as f64),
            fmt_ms(typical),
            fmt_ms(stat.p50_ms),
            fmt_ms(t.slow_ms)
        ),
    };
    Some(finding(
        FindingKind::SlowQuery,
        stat,
        severity,
        format!("Slow {}", subject(stat)),
        detail,
        stat.total_ms,
        stat.calls,
    ))
}

pub fn large_result(stat: &FingerprintStat, t: &Thresholds) -> Option<CaptureFinding> {
    if stat.kind != StatementKind::Select {
        return None;
    }
    let bytes_per_call = stat.bytes / stat.calls as f64;
    let unbounded = stat.max_rows >= t.large_rows && !shape::has_limit(&stat.sample_sql);
    if !unbounded && bytes_per_call < t.large_bytes {
        return None;
    }
    // Result sizes are only known from captures; the SDKs don't measure them (0).
    let size = if bytes_per_call > 0.0 { format!(", about {} each time", crate::format::fmt_bytes(bytes_per_call)) } else { String::new() };
    let detail = if unbounded {
        format!(
            "It returned up to {} rows at once, with no LIMIT{size}. The app receives every row and builds an \
             object for each, however few it uses.",
            fmt_count(stat.max_rows),
        )
    } else {
        format!("Returns {} per call on average.", crate::format::fmt_bytes(bytes_per_call))
    };
    Some(finding(
        FindingKind::LargeResult,
        stat,
        SuggestionSeverity::Medium,
        format!("Large result from {}", subject(stat)),
        detail,
        stat.total_ms,
        stat.calls,
    ))
}

pub fn errors(stat: &FingerprintStat, statements: &[CapturedStatement]) -> Option<CaptureFinding> {
    if stat.errors == 0 {
        return None;
    }
    let first = statements.iter().find(|s| s.fingerprint == stat.fingerprint && s.error.is_some())?;
    Some(finding(
        FindingKind::QueryErrors,
        stat,
        SuggestionSeverity::Medium,
        format!("{} failed {}×", capitalize(&subject(stat)), stat.errors),
        first.error.clone().unwrap_or_default(),
        0.0,
        stat.errors,
    ))
}

/// One finding per route (or request, without routes) whose busiest request ran at
/// least `t.chatty` statements.
pub fn chatty(statements: &[CapturedStatement], by_fp: &HashMap<&str, &FingerprintStat>, t: &Thresholds) -> Vec<CaptureFinding> {
    let mut units: HashMap<&str, Vec<&CapturedStatement>> = HashMap::new();
    for s in statements {
        if let Some(u) = s.unit.as_deref() {
            units.entry(u).or_default().push(s);
        }
    }
    // Busiest request per route.
    let mut worst: HashMap<String, Vec<&CapturedStatement>> = HashMap::new();
    for (unit, group) in units {
        if (group.len() as u32) < t.chatty {
            continue;
        }
        let key = group.iter().find_map(|s| s.route.clone()).unwrap_or_else(|| format!("request {unit}"));
        if worst.get(&key).is_none_or(|w| w.len() < group.len()) {
            worst.insert(key, group);
        }
    }
    let mut out: Vec<CaptureFinding> = worst
        .into_iter()
        .filter_map(|(route, group)| {
            let mut counts: HashMap<&str, u32> = HashMap::new();
            for s in &group {
                *counts.entry(&s.fingerprint).or_default() += 1;
            }
            let (top_fp, top_count) = counts.into_iter().max_by(|a, b| a.1.cmp(&b.1).then_with(|| b.0.cmp(a.0)))?;
            let stat = by_fp.get(top_fp)?;
            let time: f64 = group.iter().map(|s| s.duration_ms).sum();
            let mut f = finding(
                FindingKind::ChattyRequest,
                stat,
                if group.len() as u32 >= t.chatty * 4 { SuggestionSeverity::High } else { SuggestionSeverity::Medium },
                format!("{route} runs {} statements per request", group.len()),
                format!(
                    "{} of database time in one request; the most repeated statement ({}) ran {top_count}×.",
                    fmt_ms(time),
                    subject(stat)
                ),
                time,
                group.len() as u32,
            );
            f.id = format!("{}:{route}", FindingKind::ChattyRequest.as_str());
            f.origins = stats::origins(group.iter().copied());
            Some(f)
        })
        .collect();
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

/// "SELECT on order_items", "INSERT into users"; for MongoDB "find on order_items".
pub fn subject(stat: &FingerprintStat) -> String {
    if let Some(op) = mongo::parse(&stat.sample_sql) {
        return format!("{} on {}", op.command, op.target);
    }
    let table = stat.tables.first().map(String::as_str);
    match (stat.kind, table) {
        (StatementKind::Select, Some(t)) => format!("SELECT on {t}"),
        (StatementKind::Insert, Some(t)) => format!("INSERT into {t}"),
        (StatementKind::Update, Some(t)) => format!("UPDATE of {t}"),
        (StatementKind::Delete, Some(t)) => format!("DELETE from {t}"),
        _ => {
            let words: Vec<&str> = stat.normalized.split_whitespace().take(4).collect();
            format!("“{}…”", words.join(" "))
        }
    }
}

pub(super) fn capitalize(s: &str) -> String {
    let mut c = s.chars();
    c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default()
}
