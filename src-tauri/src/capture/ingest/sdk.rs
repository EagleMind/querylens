//! Events from the QueryLens SDK (`integrations/node`): one JSON object per line,
//! over HTTP to the collector or appended to a spool file.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use serde::Deserialize;

use super::{Clock, Context, Observed, Sink, Via};

/// Wire format, version 1.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SdkEvent {
    pub pid: u32,
    /// Client number within the process.
    pub conn: u32,
    /// Start, epoch milliseconds.
    pub at: f64,
    pub duration_ms: f64,
    pub sql: String,
    #[serde(default)]
    pub params: Option<Vec<Option<String>>>,
    #[serde(default)]
    pub rows: f64,
    #[serde(default)]
    pub bytes: f64,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub origin: Option<String>,
    #[serde(default)]
    pub route: Option<String>,
    #[serde(default)]
    pub unit: Option<String>,
}

/// First connection number given to SDK clients, so they never collide with proxy
/// connections (numbered from 1).
const FIRST_CONN: u32 = 100_001;

#[derive(Default)]
struct State {
    conns: HashMap<(u32, u32), u32>,
    processes: HashSet<u32>,
}

/// Turns SDK lines into [`Observed`] statements for one capture, numbering clients
/// across processes and counting the processes reporting.
pub struct SdkIngest {
    sink: Sink,
    clock: Clock,
    state: Mutex<State>,
}

impl SdkIngest {
    pub fn new(sink: Sink, clock: Clock) -> Self {
        Self { sink, clock, state: Mutex::default() }
    }

    /// Feed newline-separated events; malformed lines are skipped. Returns how many
    /// statements were accepted.
    pub fn feed(&self, ndjson: &str) -> usize {
        let mut accepted = 0;
        for line in ndjson.lines().map(str::trim).filter(|l| !l.is_empty()) {
            let Ok(event) = serde_json::from_str::<SdkEvent>(line) else { continue };
            if self.sink.send(self.observe(event)).is_ok() {
                accepted += 1;
            }
        }
        accepted
    }

    fn observe(&self, e: SdkEvent) -> Observed {
        let conn = {
            let mut st = self.state.lock().unwrap_or_else(|p| p.into_inner());
            st.processes.insert(e.pid);
            let next = FIRST_CONN + st.conns.len() as u32;
            *st.conns.entry((e.pid, e.conn)).or_insert(next)
        };
        Observed {
            via: Via::Sdk,
            conn,
            at_ms: self.clock.since_epoch(e.at),
            duration_ms: e.duration_ms.max(0.0),
            sql: e.sql,
            params: e.params,
            rows: e.rows,
            bytes: e.bytes,
            error: e.error,
            context: Context { origin: e.origin, route: e.route, unit: e.unit },
        }
    }

    /// Application processes that have reported so far.
    pub fn processes(&self) -> u32 {
        self.state.lock().unwrap_or_else(|p| p.into_inner()).processes.len() as u32
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lines_become_observed_statements() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let clock = Clock::start();
        let ingest = SdkIngest::new(tx, clock);
        let lines = concat!(
            r#"{"v":1,"pid":7,"conn":1,"at":1,"durationMs":2.5,"sql":"SELECT 1","params":["42",null],"rows":1,"error":null,"origin":"app.js:3","route":"GET /x","unit":"u1"}"#,
            "\n",
            "not json\n",
            r#"{"v":1,"pid":8,"conn":1,"at":1,"durationMs":1,"sql":"SELECT 2"}"#,
            "\n",
            r#"{"v":1,"pid":7,"conn":1,"at":1,"durationMs":1,"sql":"SELECT 3"}"#,
        );
        assert_eq!(ingest.feed(lines), 3);
        let a = rx.try_recv().unwrap();
        assert_eq!((a.via, a.conn, a.duration_ms, a.rows), (Via::Sdk, FIRST_CONN, 2.5, 1.0));
        assert_eq!(a.params, Some(vec![Some("42".to_string()), None]));
        assert_eq!(a.context.origin.as_deref(), Some("app.js:3"));
        // Timestamps before the capture started clamp to 0.
        assert_eq!(a.at_ms, 0.0);
        let b = rx.try_recv().unwrap();
        let c = rx.try_recv().unwrap();
        assert_eq!(b.conn, FIRST_CONN + 1, "another process, another client");
        assert_eq!(c.conn, FIRST_CONN, "same process and client");
        assert_eq!(ingest.processes(), 2);
    }
}
