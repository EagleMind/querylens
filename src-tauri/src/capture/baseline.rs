//! CI gate: compare a capture's findings with a committed baseline.
//!
//! The baseline (`.querylens/baseline.json`) lists the findings a team has accepted.
//! A run fails when it has a finding at or above the gate's severity that the
//! baseline doesn't list, e.g. a pull request that introduces an N+1. Timing-based
//! findings never fail the gate: CI machines are too noisy for them.

use std::collections::{BTreeMap, HashSet};
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::model::{CaptureFinding, CaptureReport, FindingKind, SuggestionSeverity};

const VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BaselineFinding {
    pub id: String,
    pub kind: FindingKind,
    pub severity: SuggestionSeverity,
    pub title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Baseline {
    pub version: u32,
    pub created_at: String,
    pub statements: u32,
    pub findings: Vec<BaselineFinding>,
    /// Calls per fingerprint, with the normalized text so the file reads in review.
    pub statements_by_fingerprint: BTreeMap<String, (u32, String)>,
}

impl Baseline {
    pub fn from_report(r: &CaptureReport) -> Self {
        Self {
            version: VERSION,
            created_at: r.generated_at.clone(),
            statements: r.statements,
            findings: r
                .findings
                .iter()
                .map(|f| BaselineFinding { id: f.id.clone(), kind: f.kind, severity: f.severity, title: f.title.clone() })
                .collect(),
            statements_by_fingerprint: r
                .fingerprints
                .iter()
                .map(|s| (s.fingerprint.clone(), (s.calls, s.normalized.clone())))
                .collect(),
        }
    }

    pub fn load(path: &Path) -> AppResult<Option<Self>> {
        match std::fs::read_to_string(path) {
            Ok(text) => {
                let b: Self = serde_json::from_str(&text)
                    .map_err(|e| AppError::validation(format!("{} isn't a valid baseline: {e}", path.display())))?;
                Ok(Some(b))
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    pub fn save(&self, path: &Path) -> AppResult<()> {
        if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
            std::fs::create_dir_all(dir)?;
        }
        std::fs::write(path, serde_json::to_string_pretty(self)? + "\n")?;
        Ok(())
    }
}

/// What fails the gate.
#[derive(Debug, Clone, Copy)]
pub struct Gate {
    pub fail_on: SuggestionSeverity,
}

#[derive(Debug)]
pub struct Verdict {
    /// Findings not in the baseline that fail the gate.
    pub failing: Vec<CaptureFinding>,
    /// New findings below the gate's severity (reported, not failing).
    pub new_below_gate: Vec<CaptureFinding>,
    /// Baseline findings that no longer occur.
    pub fixed: Vec<BaselineFinding>,
    /// (baseline, now) statement totals.
    pub statements: Option<(u32, u32)>,
}

impl Verdict {
    pub fn passed(&self) -> bool {
        self.failing.is_empty()
    }
}

fn rank(s: SuggestionSeverity) -> u8 {
    match s {
        SuggestionSeverity::High => 3,
        SuggestionSeverity::Medium => 2,
        SuggestionSeverity::Low => 1,
    }
}

pub fn evaluate(report: &CaptureReport, baseline: Option<&Baseline>, gate: Gate) -> Verdict {
    let known: HashSet<&str> = baseline.map(|b| b.findings.iter().map(|f| f.id.as_str()).collect()).unwrap_or_default();
    let (mut failing, mut new_below_gate) = (Vec::new(), Vec::new());
    for f in report.findings.iter().filter(|f| !known.contains(f.id.as_str())) {
        let gated = f.kind != FindingKind::SlowQuery && rank(f.severity) >= rank(gate.fail_on);
        if gated { failing.push(f.clone()) } else { new_below_gate.push(f.clone()) }
    }
    let current: HashSet<&str> = report.findings.iter().map(|f| f.id.as_str()).collect();
    let fixed = baseline
        .map(|b| b.findings.iter().filter(|f| !current.contains(f.id.as_str())).cloned().collect())
        .unwrap_or_default();
    Verdict { failing, new_below_gate, fixed, statements: baseline.map(|b| (b.statements, report.statements)) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{CaptureSource, CaptureSummary};

    fn finding(id: &str, kind: FindingKind, severity: SuggestionSeverity) -> CaptureFinding {
        CaptureFinding {
            id: id.into(),
            kind,
            severity,
            title: id.into(),
            detail: String::new(),
            fingerprint: String::new(),
            parent_fingerprint: None,
            impact_ms: 0.0,
            occurrences: 1,
            origins: vec![],
            fix: None,
        }
    }

    fn report(findings: Vec<CaptureFinding>) -> CaptureReport {
        CaptureReport {
            capture: CaptureSummary {
                id: "c".into(),
                name: "c".into(),
                connection_id: None,
                upstream: String::new(),
                listen: String::new(),
                source: CaptureSource::Cli,
                started_at: String::new(),
                stopped_at: None,
                statements: 0,
                total_ms: 0.0,
            },
            orm: None,
            statements: 10,
            total_ms: 0.0,
            units: 0,
            fingerprints: vec![],
            findings,
            plan_checks: vec![],
            generated_at: String::new(),
        }
    }

    #[test]
    fn new_findings_fail_known_ones_pass_and_slow_never_gates() {
        let base = Baseline::from_report(&report(vec![
            finding("n_plus_one:a", FindingKind::NPlusOne, SuggestionSeverity::High),
            finding("large_result:z", FindingKind::LargeResult, SuggestionSeverity::Medium),
        ]));
        let now = report(vec![
            finding("n_plus_one:a", FindingKind::NPlusOne, SuggestionSeverity::High),
            finding("n_plus_one:b", FindingKind::NPlusOne, SuggestionSeverity::High),
            finding("slow_query:c", FindingKind::SlowQuery, SuggestionSeverity::High),
            finding("duplicate_query:d", FindingKind::DuplicateQuery, SuggestionSeverity::Low),
        ]);
        let v = evaluate(&now, Some(&base), Gate { fail_on: SuggestionSeverity::Medium });
        assert!(!v.passed());
        assert_eq!(v.failing.iter().map(|f| f.id.as_str()).collect::<Vec<_>>(), ["n_plus_one:b"]);
        assert_eq!(v.new_below_gate.len(), 2);
        assert_eq!(v.fixed[0].id, "large_result:z");
        assert_eq!(v.statements, Some((10, 10)));

        // Without a baseline every gated finding fails.
        let v = evaluate(&now, None, Gate { fail_on: SuggestionSeverity::High });
        assert_eq!(v.failing.len(), 2);
    }
}
