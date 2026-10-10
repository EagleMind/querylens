//! Before/after plan comparison.
//!
//! Plans are aligned top-down. Children are matched first by (operator family,
//! relation), so `Seq Scan on orders` → `Index Scan on orders` is one *changed* node
//! rather than a removal plus an addition; leftovers of the same family are paired by
//! position; anything else is added/removed.

use crate::model::{AnalysisResult, DiffNode, DiffSide, DiffStatus, PlanDiff, PlanNode};

/// Coarse operator family used for alignment.
fn family(node_type: &str) -> &'static str {
    let t = node_type.to_ascii_lowercase();
    if t.contains("scan") {
        "scan"
    } else if t.contains("join") || t.contains("nested loop") {
        "join"
    } else if t.contains("aggregate") || t.contains("group") {
        "aggregate"
    } else if t.contains("sort") || t.contains("top_n") {
        "sort"
    } else if t.contains("hash") {
        "hash"
    } else if t.contains("gather") {
        "gather"
    } else if t.contains("limit") {
        "limit"
    } else {
        "other"
    }
}

fn side(n: &PlanNode) -> DiffSide {
    DiffSide {
        id: n.id.clone(),
        node_type: n.node_type.clone(),
        index_name: n.index_name.clone(),
        self_time_ms: n.self_time_ms,
        self_cost: n.self_cost,
        actual_rows: n.actual_rows,
        estimated_rows: n.estimated_rows,
        loops: n.loops,
        heat: n.heat,
    }
}

fn one_sided(n: &PlanNode, status: DiffStatus) -> DiffNode {
    DiffNode {
        status,
        relation: n.relation.clone(),
        detail: n.detail.clone(),
        before: (status == DiffStatus::Removed).then(|| side(n)),
        after: (status == DiffStatus::Added).then(|| side(n)),
        children: n.children.iter().map(|c| one_sided(c, status)).collect(),
    }
}

fn pair(b: &PlanNode, a: &PlanNode) -> DiffNode {
    let same = b.node_type == a.node_type && b.index_name == a.index_name && b.relation == a.relation;
    DiffNode {
        status: if same { DiffStatus::Same } else { DiffStatus::Changed },
        relation: a.relation.clone().or_else(|| b.relation.clone()),
        detail: a.detail.clone().or_else(|| b.detail.clone()),
        before: Some(side(b)),
        after: Some(side(a)),
        children: align(&b.children, &a.children),
    }
}

fn align(before: &[PlanNode], after: &[PlanNode]) -> Vec<DiffNode> {
    let mut used = vec![false; before.len()];
    let mut matched: Vec<Option<usize>> = vec![None; after.len()];
    let key = |n: &PlanNode| (family(&n.node_type), n.relation.clone());

    // Pass 1: same family and relation.
    for (ai, a) in after.iter().enumerate() {
        if let Some(bi) = (0..before.len()).find(|&bi| !used[bi] && key(&before[bi]) == key(a)) {
            used[bi] = true;
            matched[ai] = Some(bi);
        }
    }
    // Pass 2: same family, in order (e.g. a join whose inputs changed).
    for (ai, a) in after.iter().enumerate() {
        if matched[ai].is_some() {
            continue;
        }
        if let Some(bi) = (0..before.len()).find(|&bi| !used[bi] && family(&before[bi].node_type) == family(&a.node_type)) {
            used[bi] = true;
            matched[ai] = Some(bi);
        }
    }

    let mut out: Vec<DiffNode> = after
        .iter()
        .zip(&matched)
        .map(|(a, m)| match m {
            Some(bi) => pair(&before[*bi], a),
            None => one_sided(a, DiffStatus::Added),
        })
        .collect();
    out.extend(before.iter().zip(&used).filter(|(_, u)| !**u).map(|(b, _)| one_sided(b, DiffStatus::Removed)));
    out
}

pub fn diff(before: &AnalysisResult, after: &AnalysisResult) -> PlanDiff {
    let root = match align(std::slice::from_ref(&before.root), std::slice::from_ref(&after.root)).into_iter().next() {
        Some(n) => n,
        None => pair(&before.root, &after.root),
    };
    let exec = |a: &AnalysisResult| a.timing.as_ref().map(|t| t.median_ms).or(a.execution_time_ms);
    PlanDiff {
        before_id: before.id.clone(),
        after_id: after.id.clone(),
        before_sql: before.sql.clone(),
        after_sql: after.sql.clone(),
        before_label: before.analyzed_at.clone(),
        after_label: after.analyzed_at.clone(),
        before_ms: exec(before),
        after_ms: exec(after),
        before_cost: before.total_cost,
        after_cost: after.total_cost,
        timed: exec(before).is_some() && exec(after).is_some(),
        plan_changed: super::fingerprint::plan_fp(&before.root) != super::fingerprint::plan_fp(&after.root),
        root,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Engine, ExplainMode};

    fn plan(raw: &str) -> PlanNode {
        crate::plan::parse(Engine::Postgres, ExplainMode::Analyze, raw).unwrap().root
    }

    #[test]
    fn index_swap_is_a_changed_node_not_add_remove() {
        let before = plan(
            r#"[{"Plan": {"Node Type": "Aggregate", "Total Cost": 10, "Plan Rows": 1, "Actual Total Time": 50,
            "Actual Rows": 1, "Actual Loops": 1, "Plans": [{"Node Type": "Seq Scan", "Relation Name": "orders",
            "Total Cost": 9, "Plan Rows": 5, "Actual Total Time": 49, "Actual Rows": 5, "Actual Loops": 1}]}}]"#,
        );
        let after = plan(
            r#"[{"Plan": {"Node Type": "Aggregate", "Total Cost": 2, "Plan Rows": 1, "Actual Total Time": 0.2,
            "Actual Rows": 1, "Actual Loops": 1, "Plans": [{"Node Type": "Index Scan", "Relation Name": "orders",
            "Index Name": "orders_user_id_idx", "Total Cost": 1, "Plan Rows": 5, "Actual Total Time": 0.1,
            "Actual Rows": 5, "Actual Loops": 1}]}}]"#,
        );
        let d = align(std::slice::from_ref(&before), std::slice::from_ref(&after));
        assert_eq!(d.len(), 1);
        assert_eq!(d[0].status, DiffStatus::Same);
        let scan = &d[0].children[0];
        assert_eq!(scan.status, DiffStatus::Changed);
        assert_eq!(scan.before.as_ref().unwrap().node_type, "Seq Scan");
        assert_eq!(scan.after.as_ref().unwrap().index_name.as_deref(), Some("orders_user_id_idx"));
    }

    #[test]
    fn unmatched_children_are_added_and_removed() {
        let before = plan(
            r#"[{"Plan": {"Node Type": "Hash Join", "Total Cost": 10, "Plan Rows": 1, "Plans": [
              {"Node Type": "Seq Scan", "Relation Name": "a", "Total Cost": 1, "Plan Rows": 1},
              {"Node Type": "Hash", "Total Cost": 1, "Plan Rows": 1, "Plans": [
                {"Node Type": "Seq Scan", "Relation Name": "b", "Total Cost": 1, "Plan Rows": 1}]}]}}]"#,
        );
        let after = plan(
            r#"[{"Plan": {"Node Type": "Nested Loop", "Total Cost": 10, "Plan Rows": 1, "Plans": [
              {"Node Type": "Seq Scan", "Relation Name": "a", "Total Cost": 1, "Plan Rows": 1},
              {"Node Type": "Index Scan", "Relation Name": "b", "Index Name": "b_pkey", "Total Cost": 1, "Plan Rows": 1}]}}]"#,
        );
        let d = &align(std::slice::from_ref(&before), std::slice::from_ref(&after))[0];
        assert_eq!(d.status, DiffStatus::Changed, "Hash Join → Nested Loop");
        let statuses: Vec<_> = d.children.iter().map(|c| (c.status, c.relation.clone())).collect();
        assert!(statuses.contains(&(DiffStatus::Same, Some("a".into()))));
        assert!(statuses.contains(&(DiffStatus::Added, Some("b".into()))));
        assert!(statuses.iter().any(|(s, _)| *s == DiffStatus::Removed), "{statuses:?}");
    }
}
