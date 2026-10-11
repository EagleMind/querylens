//! Turns observed statements (from the SDK or the proxy) into [`CapturedStatement`]s,
//! keeps live counters, and writes them to storage in batches.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use super::ingest::{Observed, Via};
use super::sql::comments;
use crate::error::AppResult;
use crate::model::CapturedStatement;
use crate::plan::fingerprint;
use crate::storage::Store;

/// Recent statements kept for the live view.
const RECENT: usize = 100;
/// Rows written per storage transaction at most.
const BATCH: usize = 500;

#[derive(Default)]
struct Counters {
    statements: u32,
    total_ms: f64,
    errors: u32,
    recent: VecDeque<CapturedStatement>,
}

/// Counters shared with whoever displays the capture while it runs.
#[derive(Default)]
pub struct LiveStats(Mutex<Counters>);

pub struct LiveSnapshot {
    pub statements: u32,
    pub total_ms: f64,
    pub errors: u32,
    pub recent: Vec<CapturedStatement>,
}

impl LiveStats {
    fn record(&self, batch: &[CapturedStatement]) {
        let mut c = self.0.lock().unwrap_or_else(|p| p.into_inner());
        for s in batch {
            c.statements += 1;
            c.total_ms += s.duration_ms;
            c.errors += u32::from(s.error.is_some());
            c.recent.push_front(s.clone());
        }
        c.recent.truncate(RECENT);
    }

    pub fn snapshot(&self) -> LiveSnapshot {
        let c = self.0.lock().unwrap_or_else(|p| p.into_inner());
        LiveSnapshot { statements: c.statements, total_ms: c.total_ms, errors: c.errors, recent: c.recent.iter().cloned().collect() }
    }
}

/// Run until every sender is dropped (all sources have stopped), then flush.
pub fn spawn(
    store: Arc<Store>,
    capture_id: String,
    live: Arc<LiveStats>,
    mut events: mpsc::UnboundedReceiver<Observed>,
) -> JoinHandle<AppResult<()>> {
    tokio::spawn(async move {
        let mut seq = 0u32;
        let mut incoming = Vec::with_capacity(BATCH);
        while events.recv_many(&mut incoming, BATCH).await > 0 {
            let batch: Vec<CapturedStatement> = incoming
                .drain(..)
                .filter_map(|ev| {
                    let next = seq + 1;
                    let statement = to_statement(next, ev)?;
                    seq = next;
                    Some(statement)
                })
                .collect();
            live.record(&batch);
            store.insert_captured(&capture_id, &batch)?;
        }
        Ok(())
    })
}

/// `None` for a proxy copy of a statement the SDK already recorded: the SDK tags the
/// SQL it sends with `ql_sdk`, and its own record has more (exact call site, values).
fn to_statement(seq: u32, ev: Observed) -> Option<CapturedStatement> {
    let (sql, tags) = comments::extract(&ev.sql);
    if ev.via == Via::Proxy && tags.get("ql_sdk").is_some() {
        return None;
    }
    let ctx = ev.context;
    Some(CapturedStatement {
        seq,
        conn: ev.conn,
        at_ms: ev.at_ms,
        duration_ms: ev.duration_ms,
        fingerprint: fingerprint::query_fp(&sql),
        params: ev.params.unwrap_or_default(),
        rows: ev.rows,
        bytes: ev.bytes,
        error: ev.error,
        unit: ctx.unit.or_else(|| tags.unit()),
        origin: ctx.origin.or_else(|| tags.origin()),
        route: ctx.route.or_else(|| tags.route()),
        sql,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture::ingest::Context;

    fn observed(via: Via, sql: &str) -> Observed {
        Observed {
            via,
            conn: 1,
            at_ms: 0.0,
            duration_ms: 1.0,
            sql: sql.into(),
            params: None,
            rows: 1.0,
            bytes: 0.0,
            error: None,
            context: Context::default(),
        }
    }

    #[test]
    fn sdk_records_win_over_proxy_copies() {
        let tagged = "SELECT 1 /*file='app.js%3A3',ql_sdk='1'*/";
        assert!(to_statement(1, observed(Via::Proxy, tagged)).is_none());
        let from_sdk = to_statement(1, observed(Via::Sdk, tagged)).unwrap();
        assert_eq!(from_sdk.sql, "SELECT 1");
        assert_eq!(from_sdk.origin.as_deref(), Some("app.js:3"));
        // Untagged traffic through the proxy (another language) is recorded.
        let plain = to_statement(2, observed(Via::Proxy, "SELECT 2 /*route='GET%20%2F'*/")).unwrap();
        assert_eq!(plain.route.as_deref(), Some("GET /"));
    }
}
