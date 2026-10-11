//! Before/after comparison of two captures: did the fix remove the finding, and
//! what happened to statement counts and time.

use std::collections::{HashMap, HashSet};

use crate::model::{CaptureFinding, CaptureReport};

pub struct StatementChange {
    pub normalized: String,
    pub calls_before: u32,
    pub calls_after: u32,
    pub ms_before: f64,
    pub ms_after: f64,
}

pub struct Comparison {
    pub fixed: Vec<CaptureFinding>,
    pub new: Vec<CaptureFinding>,
    pub statements: (u32, u32),
    pub total_ms: (f64, f64),
    /// Largest changes in calls, biggest first.
    pub changes: Vec<StatementChange>,
}

const MAX_CHANGES: usize = 10;

pub fn compare(before: &CaptureReport, after: &CaptureReport) -> Comparison {
    let ids = |r: &CaptureReport| r.findings.iter().map(|f| f.id.clone()).collect::<HashSet<_>>();
    let (had, has) = (ids(before), ids(after));
    let fixed = before.findings.iter().filter(|f| !has.contains(&f.id)).cloned().collect();
    let new = after.findings.iter().filter(|f| !had.contains(&f.id)).cloned().collect();

    let mut by_fp: HashMap<&str, StatementChange> = HashMap::new();
    for (side, report) in [(0, before), (1, after)] {
        for s in &report.fingerprints {
            let c = by_fp.entry(&s.fingerprint).or_insert_with(|| StatementChange {
                normalized: s.normalized.clone(),
                calls_before: 0,
                calls_after: 0,
                ms_before: 0.0,
                ms_after: 0.0,
            });
            if side == 0 {
                (c.calls_before, c.ms_before) = (s.calls, s.total_ms);
            } else {
                (c.calls_after, c.ms_after) = (s.calls, s.total_ms);
            }
        }
    }
    let mut changes: Vec<StatementChange> = by_fp.into_values().filter(|c| c.calls_before != c.calls_after).collect();
    changes.sort_by_key(|c| std::cmp::Reverse((c.calls_after as i64 - c.calls_before as i64).abs()));
    changes.truncate(MAX_CHANGES);

    Comparison {
        fixed,
        new,
        statements: (before.statements, after.statements),
        total_ms: (before.total_ms, after.total_ms),
        changes,
    }
}
