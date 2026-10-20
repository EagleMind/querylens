//! The shape every ORM-specific advisor shares: one fix per finding kind, written in
//! the ORM's own API. An ORM implements [`Templates`]; the blanket [`OrmAdvisor`]
//! impl works out the facts, picks the template and attaches the tested index.

use super::{Facts, HintContext, OrmAdvisor, tested_index};
use crate::model::{CaptureFinding, FindingKind, FixHint, Orm, StatementKind};

/// A fix in one ORM's terms: what to change, and the code that changes it.
pub struct Advice {
    pub text: String,
    pub code: Option<String>,
}

impl Advice {
    pub fn new(text: impl Into<String>, code: impl Into<String>) -> Self {
        Self { text: text.into(), code: Some(code.into()) }
    }

    pub fn text(text: impl Into<String>) -> Self {
        Self { text: text.into(), code: None }
    }
}

pub trait Templates {
    const ORM: Orm;

    /// Rows loaded one query per row of `facts.parent_*`. `facts.by_primary_key()`
    /// tells a belongs-to lookup from a has-many one.
    fn n_plus_one(&self, facts: &Facts) -> Advice;
    fn duplicate_query(&self, facts: &Facts) -> Advice;
    fn looped_writes(&self, kind: StatementKind, facts: &Facts) -> Advice;
    /// Many rows in one result: pagination, a column list, and a separate count.
    fn large_result(&self, facts: &Facts) -> Advice;
    /// Declaring `ddl` (a tested `CREATE INDEX`) the ORM's way, with its migration.
    fn index(&self, ddl: &str, facts: &Facts) -> Advice;
    fn unique_violation(&self, facts: &Facts) -> Advice;
    fn chatty_request(&self) -> Advice;

    /// A slow statement with no tested index to suggest. SQL ORMs say nothing (the
    /// index comes from a plan check); MongoDB advisors propose one from the filter.
    fn untested_index(&self, _facts: &Facts) -> Option<Advice> {
        None
    }

    fn deadlock(&self) -> Advice {
        Advice::text(
            "Transactions deadlock: two of them lock the same rows in a different order. Update rows in a consistent \
             order (e.g. sorted by id), and retry the transaction when it is chosen as the deadlock victim.",
        )
    }
}

impl<T: Templates> OrmAdvisor for T {
    fn fix(&self, f: &CaptureFinding, ctx: &HintContext) -> Option<FixHint> {
        let facts = Facts::of(ctx);
        let index = tested_index(ctx);
        let advice = match f.kind {
            FindingKind::NPlusOne => self.n_plus_one(&facts),
            FindingKind::DuplicateQuery => self.duplicate_query(&facts),
            FindingKind::LoopedWrites => self.looped_writes(ctx.stat.kind, &facts),
            FindingKind::LargeResult => self.large_result(&facts),
            FindingKind::SlowQuery | FindingKind::PlanIssue => match index.as_deref() {
                Some(ddl) => self.index(ddl, &facts),
                None => self.untested_index(&facts)?,
            },
            FindingKind::QueryErrors => match DbError::of(&f.detail)? {
                DbError::UniqueViolation => self.unique_violation(&facts),
                DbError::Deadlock => self.deadlock(),
            },
            FindingKind::ChattyRequest => self.chatty_request(),
        };
        Some(FixHint { orm: Some(T::ORM), text: advice.text, code: advice.code, ddl: index })
    }
}

/// Errors with a fix in the application's code, by their PostgreSQL SQLSTATE, MySQL or
/// MongoDB code (the SDK appends the driver's `err.code` in parentheses).
enum DbError {
    UniqueViolation,
    Deadlock,
}

impl DbError {
    fn of(detail: &str) -> Option<Self> {
        // MongoDB: E11000 duplicate key; 112, a write conflict between transactions.
        if detail.contains("(23505)") || detail.contains("(ER_DUP_ENTRY)") || detail.contains("(11000)") {
            Some(Self::UniqueViolation)
        } else if detail.contains("(40P01)") || detail.contains("(ER_LOCK_DEADLOCK)") || detail.contains("(112)") {
            Some(Self::Deadlock)
        } else {
            None
        }
    }
}

/// Fills `{{name}}` placeholders in a template. The templates are JavaScript, whose
/// own braces `format!` would need escaped; a leading newline is dropped so a
/// template can start on the line after `r#"`.
pub fn fill(template: &str, vars: &[(&str, &str)]) -> String {
    let mut out = String::with_capacity(template.len());
    let mut rest = template.strip_prefix('\n').unwrap_or(template);
    while let Some(start) = rest.find("{{") {
        let Some(len) = rest[start + 2..].find("}}") else { break };
        let name = &rest[start + 2..start + 2 + len];
        out.push_str(&rest[..start]);
        match vars.iter().find(|(k, _)| *k == name) {
            Some((_, v)) => out.push_str(v),
            None => {
                debug_assert!(false, "template variable {name} not given");
                out.push_str(&rest[start..start + len + 4]);
            }
        }
        rest = &rest[start + len + 4..];
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
pub(super) mod test_support {
    use crate::model::{CaptureFinding, FindingKind, FingerprintStat, FixHint, StatementKind, SuggestionSeverity};

    use super::super::{HintContext, OrmAdvisor};

    pub fn stat(sql: &str, kind: StatementKind) -> FingerprintStat {
        FingerprintStat {
            fingerprint: "fp".into(),
            normalized: String::new(),
            sample_sql: sql.into(),
            sample_params: vec![],
            kind,
            tables: vec![],
            calls: 1,
            total_ms: 1.0,
            mean_ms: 1.0,
            p50_ms: 1.0,
            p95_ms: 1.0,
            max_ms: 1.0,
            rows: 1.0,
            max_rows: 1.0,
            bytes: 1.0,
            errors: 0,
            share: 1.0,
            origins: vec![],
        }
    }

    pub fn finding(kind: FindingKind) -> CaptureFinding {
        CaptureFinding {
            id: String::new(),
            kind,
            severity: SuggestionSeverity::High,
            title: String::new(),
            detail: String::new(),
            fingerprint: "fp".into(),
            parent_fingerprint: None,
            impact_ms: 0.0,
            occurrences: 1,
            origins: vec![],
            fix: None,
        }
    }

    /// The fix for `kind` on `sql` (and the N+1 loop's `parent` statement).
    pub fn fix_for(advisor: &dyn OrmAdvisor, kind: FindingKind, sql: &str, parent: Option<&str>) -> FixHint {
        let statement_kind = crate::capture::sql::shape::kind(sql);
        let child = stat(sql, statement_kind);
        let parent = parent.map(|p| stat(p, StatementKind::Select));
        let ctx = HintContext { stat: &child, parent: parent.as_ref(), plan: None };
        let fix = advisor.fix(&finding(kind), &ctx).expect("a fix");
        let code = fix.code.as_deref().unwrap_or_default();
        assert!(!fix.text.contains("{{") && !code.contains("{{"), "unfilled template: {} {code}", fix.text);
        fix
    }

    /// Every finding kind with something to say gets a fix with code.
    pub fn covers_every_kind(advisor: &dyn OrmAdvisor, select: &str) {
        for kind in [FindingKind::NPlusOne, FindingKind::DuplicateQuery, FindingKind::LargeResult] {
            assert!(fix_for(advisor, kind, select, Some(select)).code.is_some(), "{kind:?}");
        }
        let mut error = finding(FindingKind::QueryErrors);
        error.detail = "ERROR: duplicate key value violates unique constraint (23505)".into();
        let s = stat(select, StatementKind::Insert);
        let fix = advisor.fix(&error, &HintContext { stat: &s, parent: None, plan: None }).expect("unique fix");
        assert!(fix.code.is_some());
        error.detail = "Deadlock found when trying to get lock (ER_LOCK_DEADLOCK)".into();
        assert!(advisor.fix(&error, &HintContext { stat: &s, parent: None, plan: None }).is_some());
        assert!(fix_for(advisor, FindingKind::ChattyRequest, select, None).text.len() > 40);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fills_placeholders_and_keeps_javascript_braces() {
        let t = "\nconst {{var}} = await {{model}}.findAll({ where: { id } });";
        assert_eq!(fill(t, &[("var", "orders"), ("model", "Order")]), "const orders = await Order.findAll({ where: { id } });");
        assert_eq!(fill("include: { {{rel}}: true }", &[("rel", "items")]), "include: { items: true }");
    }
}
