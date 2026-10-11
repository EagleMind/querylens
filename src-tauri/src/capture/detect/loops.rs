//! Statements issued in a loop: N+1 reads, duplicate reads, row-by-row writes.
//!
//! Statements are grouped into streams: one per request/trace when the application
//! tags its SQL, otherwise one global stream in time order. (Connection pools hand
//! consecutive queries of one loop to different connections, so per-connection
//! streams would hide the pattern.) Within a stream, a *run* is a sequence of
//! executions of one fingerprint where each follows the previous closely: at most a
//! few other statements in between (nested loops: items, then each item's product)
//! and a short gap.

use std::collections::hash_map::DefaultHasher;
use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};

use super::Thresholds;
use crate::model::CapturedStatement;

/// Everything known about the loops one fingerprint ran in.
#[derive(Debug, Clone, Default)]
pub struct LoopStats {
    /// Separate loops (runs) seen.
    pub loops: u32,
    pub executions: u32,
    pub longest: u32,
    pub time_ms: f64,
    /// At least one loop used different values each time (N+1), as opposed to
    /// repeating the identical statement.
    pub varying_values: bool,
    /// Statements that ran just before a loop started, with how often: usually
    /// the query whose rows are being iterated.
    pub parents: HashMap<String, u32>,
    /// Rows the parent returned, at most (to compare with the loop length).
    pub parent_rows: f64,
    /// Indexes (into the statement slice) of the executions inside loops.
    pub members: Vec<usize>,
}

impl LoopStats {
    pub fn main_parent(&self) -> Option<&str> {
        self.parents.iter().max_by(|a, b| a.1.cmp(b.1).then_with(|| b.0.cmp(a.0))).map(|(fp, _)| fp.as_str())
    }
}

struct Run {
    members: Vec<usize>,
    values: HashSet<u64>,
    /// Position of the last member within its stream.
    last_pos: usize,
    last_end_ms: f64,
}

/// Loop statistics per fingerprint, for loops of at least `t.loop_min` executions.
pub fn find(statements: &[CapturedStatement], t: &Thresholds) -> HashMap<String, LoopStats> {
    let mut streams: HashMap<Option<&str>, Vec<usize>> = HashMap::new();
    for (i, s) in statements.iter().enumerate() {
        streams.entry(s.unit.as_deref()).or_default().push(i);
    }
    let mut out: HashMap<String, LoopStats> = HashMap::new();
    for stream in streams.values() {
        let mut open: HashMap<&str, Run> = HashMap::new();
        for (pos, &i) in stream.iter().enumerate() {
            let s = &statements[i];
            let continues = open.get(s.fingerprint.as_str()).is_some_and(|run| {
                pos - run.last_pos - 1 <= t.loop_max_between && s.at_ms - run.last_end_ms <= t.loop_max_gap_ms
            });
            if !continues {
                if let Some(run) = open.remove(s.fingerprint.as_str()) {
                    close(run, stream, statements, t, &mut out);
                }
                open.insert(&s.fingerprint, Run { members: Vec::new(), values: HashSet::new(), last_pos: pos, last_end_ms: 0.0 });
            }
            let run = open.get_mut(s.fingerprint.as_str()).expect("run just ensured");
            run.members.push(i);
            run.values.insert(value_hash(s));
            run.last_pos = pos;
            run.last_end_ms = s.at_ms + s.duration_ms;
        }
        for (_, run) in open {
            close(run, stream, statements, t, &mut out);
        }
    }
    out
}

fn close(run: Run, stream: &[usize], statements: &[CapturedStatement], t: &Thresholds, out: &mut HashMap<String, LoopStats>) {
    if (run.members.len() as u32) < t.loop_min {
        return;
    }
    let first = &statements[run.members[0]];
    let stats = out.entry(first.fingerprint.clone()).or_default();
    stats.loops += 1;
    stats.executions += run.members.len() as u32;
    stats.longest = stats.longest.max(run.members.len() as u32);
    stats.time_ms += run.members.iter().map(|&i| statements[i].duration_ms).sum::<f64>();
    stats.varying_values |= run.values.len() > 1;
    if let Some(parent) = parent_of(run.members[0], stream, statements) {
        *stats.parents.entry(parent.fingerprint.clone()).or_default() += 1;
        stats.parent_rows = stats.parent_rows.max(parent.rows);
    }
    stats.members.extend(run.members);
}

/// The closest earlier statement in the stream with another fingerprint.
fn parent_of<'a>(first: usize, stream: &[usize], statements: &'a [CapturedStatement]) -> Option<&'a CapturedStatement> {
    let pos = stream.iter().position(|&i| i == first)?;
    let fp = &statements[first].fingerprint;
    stream[..pos].iter().rev().take(3).map(|&i| &statements[i]).find(|s| &s.fingerprint != fp)
}

/// Identity of the values a statement ran with: inline literals are part of the text.
fn value_hash(s: &CapturedStatement) -> u64 {
    let mut h = DefaultHasher::new();
    s.sql.hash(&mut h);
    s.params.hash(&mut h);
    h.finish()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture::detect::tests::stmt;

    #[test]
    fn detects_a_loop_after_its_parent_and_ignores_scattered_repeats() {
        let mut s = vec![stmt(0.0, "list", "select * from orders limit 5", 5.0)];
        for i in 0..5 {
            s.push(stmt(1.0 + i as f64, "item", &format!("select * from items where order_id = {i}"), 1.0));
        }
        // The same statement much later is not part of the loop.
        s.push(stmt(10_000.0, "item", "select * from items where order_id = 9", 1.0));
        let t = Thresholds::default();
        let found = find(&s, &t);
        let item = &found["item"];
        assert_eq!((item.loops, item.executions, item.longest), (1, 5, 5));
        assert!(item.varying_values);
        assert_eq!(item.main_parent(), Some("list"));
        assert_eq!(item.parent_rows, 5.0);
        assert!(!found.contains_key("list"));
    }

    #[test]
    fn nested_loops_tolerate_interleaving() {
        let mut s = Vec::new();
        for i in 0..6 {
            s.push(stmt(i as f64 * 2.0, "item", &format!("select * from items where order_id = {i}"), 0.5));
            s.push(stmt(i as f64 * 2.0 + 1.0, "product", &format!("select * from products where id = {i}"), 0.5));
        }
        let found = find(&s, &Thresholds::default());
        assert_eq!(found["item"].longest, 6);
        assert_eq!(found["product"].longest, 6);
    }

    #[test]
    fn units_separate_streams() {
        let mut s = Vec::new();
        for i in 0..6 {
            let mut x = stmt(i as f64, "q", "select 1", 0.1);
            x.unit = Some(if i % 2 == 0 { "a".into() } else { "b".into() });
            s.push(x);
        }
        let found = find(&s, &Thresholds { loop_min: 4, ..Thresholds::default() });
        assert!(found.is_empty(), "3 per request is below the threshold");
        assert!(!find(&s, &Thresholds { loop_min: 3, ..Thresholds::default() })["q"].varying_values);
    }
}
