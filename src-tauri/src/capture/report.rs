//! Assembling a capture report: detection → plan checks → plan findings → ORM fixes.

use std::collections::{HashMap, HashSet};

use super::detect::{self, Thresholds};
use super::orm::{self, HintContext};
use super::plans::{self, PlanDepth};
use super::render;
use crate::error::AppResult;
use crate::model::{
    CaptureFinding, CaptureReport, FindingKind, FingerprintStat, PlanCheck, StatementKind, SuggestionSeverity,
    WarningKind, WarningSeverity,
};
use crate::services::analysis::Limits;
use crate::services::target::Target;
use crate::storage::Store;

#[derive(Debug, Clone, Copy)]
pub struct ReportOptions {
    pub thresholds: Thresholds,
    pub plans: PlanDepth,
    /// At most this many statements are re-planned.
    pub max_plan_checks: usize,
}

impl Default for ReportOptions {
    fn default() -> Self {
        Self { thresholds: Thresholds::default(), plans: PlanDepth::Explain, max_plan_checks: 12 }
    }
}

/// Build (and store) the report for a capture. `target` is the database to re-plan
/// statements on; without it, plan checks are skipped.
pub async fn build(store: &Store, capture_id: &str, target: Option<&Target>, opts: &ReportOptions) -> AppResult<CaptureReport> {
    let capture = store.get_capture(capture_id)?;
    let statements = store.captured_statements(capture_id)?;
    let detection = detect::detect(&statements, &opts.thresholds);
    let orm = orm::recognize(&detection.fingerprints);

    let plan_checks = match target {
        Some(t) if opts.plans != PlanDepth::Off => {
            let limits = Limits::from_settings(&store.get_settings()?.analysis);
            let candidates = plan_candidates(&detection.fingerprints, &detection.findings, opts.max_plan_checks);
            plans::check_all(t, limits, &candidates, opts.plans).await
        }
        _ => Vec::new(),
    };

    let mut findings = detection.findings;
    let stats: HashMap<&str, &FingerprintStat> =
        detection.fingerprints.iter().map(|f| (f.fingerprint.as_str(), f)).collect();
    findings.extend(plan_findings(&plan_checks, &stats, &findings));

    let advisor = orm::advisor(orm);
    let checks: HashMap<&str, &PlanCheck> = plan_checks.iter().map(|c| (c.fingerprint.as_str(), c)).collect();
    for f in &mut findings {
        let Some(stat) = stats.get(f.fingerprint.as_str()) else { continue };
        let ctx = HintContext {
            stat,
            parent: f.parent_fingerprint.as_deref().and_then(|p| stats.get(p).copied()),
            plan: checks.get(f.fingerprint.as_str()).copied(),
        };
        f.fix = advisor.fix(f, &ctx);
    }
    detect::sort(&mut findings);

    let report = CaptureReport {
        statements: statements.len() as u32,
        total_ms: statements.iter().map(|s| s.duration_ms).sum(),
        units: detection.units,
        fingerprints: detection.fingerprints,
        findings,
        plan_checks,
        orm,
        capture,
        generated_at: crate::storage::now(),
    };
    store.save_capture_report(&report)?;
    Ok(report)
}

/// Statements worth re-planning: those already flagged, then the most expensive
/// reads and writes.
fn plan_candidates<'a>(stats: &'a [FingerprintStat], findings: &[CaptureFinding], max: usize) -> Vec<&'a FingerprintStat> {
    let flagged: HashSet<&str> = findings.iter().map(|f| f.fingerprint.as_str()).collect();
    let plannable = |s: &&FingerprintStat| s.kind != StatementKind::Other && s.errors < s.calls;
    let mut out: Vec<&FingerprintStat> = stats.iter().filter(plannable).filter(|s| flagged.contains(s.fingerprint.as_str())).collect();
    for s in stats.iter().filter(plannable) {
        if out.len() >= max {
            break;
        }
        if !flagged.contains(s.fingerprint.as_str()) {
            out.push(s);
        }
    }
    out.truncate(max);
    out
}

/// One finding per statement whose plan has a serious warning.
fn plan_findings(checks: &[PlanCheck], stats: &HashMap<&str, &FingerprintStat>, existing: &[CaptureFinding]) -> Vec<CaptureFinding> {
    let in_loop: HashSet<&str> = existing
        .iter()
        .filter(|f| matches!(f.kind, FindingKind::NPlusOne | FindingKind::DuplicateQuery))
        .map(|f| f.fingerprint.as_str())
        .collect();
    checks
        .iter()
        .filter_map(|c| {
            let stat = stats.get(c.fingerprint.as_str())?;
            let w = c
                .warnings
                .iter()
                .filter(|w| w.severity != WarningSeverity::Info && w.kind != WarningKind::RowEstimateError)
                .min_by_key(|w| match w.kind {
                    WarningKind::MissingIndex => 0,
                    WarningKind::SeqScanLarge => 1,
                    _ => 2,
                })?;
            // A scan an index would avoid, repeated in a loop or costing real time, matters most.
            // (A large scan that reads most of the table, e.g. count(*), has no index fix.)
            let missing_index = w.kind == WarningKind::MissingIndex;
            let severity = if missing_index && (in_loop.contains(c.fingerprint.as_str()) || stat.share >= 0.05) {
                SuggestionSeverity::High
            } else {
                SuggestionSeverity::Medium
            };
            let mut detail = w.message.clone();
            if let Some(ix) = c.index.as_ref().filter(|i| i.used) {
                detail.push_str(&format!(" Tested `{}`: {}.", ix.ddl, render::index_evidence(ix.evidence, ix.before, ix.after)));
            }
            Some(detect::finding(
                FindingKind::PlanIssue,
                stat,
                severity,
                format!("{}: {}", detect::subject(stat), short(w.kind)),
                detail,
                stat.total_ms,
                stat.calls,
            ))
        })
        .collect()
}

fn short(kind: WarningKind) -> &'static str {
    match kind {
        WarningKind::MissingIndex => "full table scan, an index would help",
        WarningKind::SeqScanLarge => "large full table scan",
        WarningKind::SortSpill => "sort spills to disk",
        WarningKind::HashSpill => "hash spills to disk",
        WarningKind::NestedLoopBlowup => "nested loop repeats an expensive inner side",
        WarningKind::HeapFetches => "index-only scan visits the table",
        WarningKind::JitOverhead => "JIT compilation overhead",
        WarningKind::IoBound => "waiting on disk reads",
        WarningKind::SerializeHeavy => "large result serialization",
        WarningKind::BlockingSort => "sorts all rows before returning any",
        WarningKind::UnselectiveIndex => "index scan discards most rows",
        WarningKind::RowEstimateError => "row estimates are off",
    }
}
