//! Per-fingerprint aggregation.

use std::collections::HashMap;

use crate::capture::sql::shape;
use crate::model::{CapturedStatement, FingerprintStat, OriginCount};
use crate::plan::fingerprint;

/// Origins listed per fingerprint / finding.
const TOP_ORIGINS: usize = 5;

/// One entry per fingerprint, most total time first.
pub fn fingerprints(statements: &[CapturedStatement]) -> Vec<FingerprintStat> {
    let grand_total: f64 = statements.iter().map(|s| s.duration_ms).sum();
    let mut groups: HashMap<&str, Vec<&CapturedStatement>> = HashMap::new();
    for s in statements {
        groups.entry(&s.fingerprint).or_default().push(s);
    }
    let mut out: Vec<FingerprintStat> = groups.into_values().map(|group| aggregate(&group, grand_total)).collect();
    out.sort_by(|a, b| b.total_ms.total_cmp(&a.total_ms).then_with(|| a.fingerprint.cmp(&b.fingerprint)));
    out
}

fn aggregate(group: &[&CapturedStatement], grand_total: f64) -> FingerprintStat {
    let mut times: Vec<f64> = group.iter().map(|s| s.duration_ms).collect();
    times.sort_by(f64::total_cmp);
    let total: f64 = times.iter().sum();
    let pct = |p: f64| times[((times.len() - 1) as f64 * p).round() as usize];
    // The slowest successful execution is the most useful one to re-plan.
    let sample = group
        .iter()
        .filter(|s| s.error.is_none())
        .max_by(|a, b| a.duration_ms.total_cmp(&b.duration_ms))
        .unwrap_or(&group[0]);
    let calls = group.len() as u32;
    FingerprintStat {
        fingerprint: sample.fingerprint.clone(),
        normalized: fingerprint::normalize_sql(&sample.sql),
        sample_sql: sample.sql.clone(),
        sample_params: sample.params.clone(),
        kind: shape::kind(&sample.sql),
        tables: shape::tables(&sample.sql).into_iter().map(|t| t.name).collect(),
        calls,
        total_ms: total,
        mean_ms: total / calls as f64,
        p50_ms: pct(0.5),
        p95_ms: pct(0.95),
        max_ms: times[times.len() - 1],
        rows: group.iter().map(|s| s.rows).sum(),
        max_rows: group.iter().map(|s| s.rows).fold(0.0, f64::max),
        bytes: group.iter().map(|s| s.bytes).sum(),
        errors: group.iter().filter(|s| s.error.is_some()).count() as u32,
        share: if grand_total > 0.0 { total / grand_total } else { 0.0 },
        origins: origins(group.iter().copied()),
    }
}

/// Most frequent origins first.
pub fn origins<'a>(statements: impl Iterator<Item = &'a CapturedStatement>) -> Vec<OriginCount> {
    let mut counts: HashMap<&str, u32> = HashMap::new();
    for s in statements {
        if let Some(o) = s.origin.as_deref() {
            *counts.entry(o).or_default() += 1;
        }
    }
    let mut out: Vec<OriginCount> =
        counts.into_iter().map(|(origin, count)| OriginCount { origin: origin.to_string(), count }).collect();
    out.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.origin.cmp(&b.origin)));
    out.truncate(TOP_ORIGINS);
    out
}
