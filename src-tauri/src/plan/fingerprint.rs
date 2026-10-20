//! Stable fingerprints for "the same plan shape". Query fingerprints live in the core
//! (shared with captured and monitored traffic) and are re-exported here.

pub use querylens_core::fingerprint::{normalize_sql, query_fp};
use querylens_core::fingerprint::fnv1a;

use crate::model::PlanNode;

/// Shape of the plan: operators, relations and indexes in pre-order, ignoring numbers.
pub fn plan_fp(root: &PlanNode) -> String {
    let mut shape = String::new();
    super::walk(root, &mut |n| {
        shape.push_str(&n.node_type);
        shape.push('|');
        shape.push_str(n.relation.as_deref().unwrap_or(""));
        shape.push('|');
        shape.push_str(n.index_name.as_deref().unwrap_or(""));
        shape.push(';');
    });
    fnv1a(shape.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plan_fp_ignores_numbers_but_not_shape() {
        let raw = |idx: &str| {
            format!(
                r#"[{{"Plan": {{"Node Type": "Index Scan", "Relation Name": "t", "Index Name": "{idx}",
                "Total Cost": 1, "Plan Rows": 1}}}}]"#
            )
        };
        let p = |r: &str| crate::plan::parse(crate::model::Engine::Postgres, crate::model::ExplainMode::Estimate, r).unwrap();
        let a = p(&raw("t_pkey"));
        let b = p(&raw("t_pkey").replace("\"Total Cost\": 1", "\"Total Cost\": 99"));
        assert_eq!(plan_fp(&a.root), plan_fp(&b.root));
        assert_ne!(plan_fp(&a.root), plan_fp(&p(&raw("t_other")).root));
    }
}
