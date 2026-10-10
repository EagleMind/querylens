//! Stable fingerprints for "the same query" and "the same plan shape".
//!
//! FNV-1a is used instead of `DefaultHasher` because the fingerprints are persisted and
//! must not change between Rust releases.

use crate::model::PlanNode;

fn fnv1a(bytes: &[u8]) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{h:016x}")
}

/// Normalize SQL so that the same statement with different literals, parameters,
/// casing or whitespace maps to one fingerprint.
pub fn normalize_sql(sql: &str) -> String {
    let lower = sql.trim().trim_end_matches(';').to_lowercase();
    let chars: Vec<char> = lower.chars().collect();
    let is_ident = |c: char| c.is_alphanumeric() || c == '_';
    let mut out = String::with_capacity(lower.len());
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        let prev_ident = out.chars().next_back().is_some_and(is_ident);
        if c == '\'' {
            // String literal, with '' escapes.
            i += 1;
            while i < chars.len() {
                if chars[i] == '\'' {
                    if chars.get(i + 1) == Some(&'\'') {
                        i += 2;
                        continue;
                    }
                    break;
                }
                i += 1;
            }
            out.push('?');
            i += 1;
        } else if c == '$' && chars.get(i + 1).is_some_and(char::is_ascii_digit) {
            i += 1;
            while i < chars.len() && chars[i].is_ascii_digit() {
                i += 1;
            }
            out.push('?');
        } else if c.is_ascii_digit() && !prev_ident {
            while i < chars.len() && (chars[i].is_ascii_digit() || chars[i] == '.') {
                i += 1;
            }
            out.push('?');
        } else if c.is_whitespace() {
            while i < chars.len() && chars[i].is_whitespace() {
                i += 1;
            }
            if !out.is_empty() {
                out.push(' ');
            }
        } else {
            out.push(c);
            i += 1;
        }
    }
    out.trim_end().to_string()
}

pub fn query_fp(sql: &str) -> String {
    fnv1a(normalize_sql(sql).as_bytes())
}

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
    fn literals_params_and_whitespace_normalize_away() {
        let a = "SELECT * FROM orders WHERE user_id = 42 AND status = 'paid';";
        let b = "select *\n  from orders\n where user_id = 7 and status = 'it''s'";
        let c = "SELECT * FROM orders WHERE user_id = $1 AND status = $2";
        assert_eq!(normalize_sql(a), "select * from orders where user_id = ? and status = ?");
        assert_eq!(query_fp(a), query_fp(b));
        assert_eq!(query_fp(a), query_fp(c));
        // Digits inside identifiers are not literals.
        assert_eq!(normalize_sql("select t1.x from t1"), "select t1.x from t1");
        assert_ne!(query_fp(a), query_fp("SELECT * FROM users WHERE id = 1"));
    }

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
