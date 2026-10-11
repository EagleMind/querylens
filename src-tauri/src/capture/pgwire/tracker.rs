//! Per-connection protocol state: turns the message flow in both directions into
//! completed statement executions with timing, rows, bytes and errors.
//!
//! Pairing relies on the protocol guarantee that the server answers in request order.
//! Each `Query` and each `Execute` becomes a pending execution; the server's
//! CommandComplete / EmptyQuery / PortalSuspended / ErrorResponse finishes the
//! oldest one. After an error the server skips everything up to the next Sync, so
//! executions left over when that batch's ReadyForQuery arrives never ran.

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::time::Instant;

use super::messages::{ClientMsg, ServerMsg, param_text, tag_rows};

/// A finished statement.
#[derive(Debug, Clone, PartialEq)]
pub struct Execution {
    pub sql: Arc<str>,
    /// `None` when some bound value couldn't be rendered as text.
    pub params: Option<Vec<Option<String>>>,
    pub started: Instant,
    pub finished: Instant,
    pub rows: u64,
    pub bytes: u64,
    pub error: Option<String>,
}

struct Prepared {
    sql: Arc<str>,
    param_types: Vec<u32>,
}

struct Portal {
    sql: Arc<str>,
    params: Option<Vec<Option<String>>>,
}

#[derive(PartialEq)]
enum Kind {
    /// Simple query: finishes at ReadyForQuery (it may hold several statements).
    Simple,
    /// Extended protocol Execute: finishes at its CommandComplete.
    Extended,
}

struct Pending {
    kind: Kind,
    sql: Arc<str>,
    params: Option<Vec<Option<String>>>,
    sent: Instant,
    /// The Sync / Query batch it belongs to.
    batch: u64,
    rows: u64,
    data_rows: u64,
    bytes: u64,
    error: Option<String>,
}

#[derive(Default)]
pub struct Tracker {
    statements: HashMap<String, Prepared>,
    portals: HashMap<String, Portal>,
    pending: VecDeque<Pending>,
    /// Outstanding Describe messages: (batch, statement name; None = portal).
    describes: VecDeque<(u64, Option<String>)>,
    batches_sent: u64,
    batches_done: u64,
    /// When the previous execution finished: a pipelined request can't start before.
    last_finished: Option<Instant>,
}

const UNKNOWN: &str = "(statement prepared before the capture started)";

impl Tracker {
    pub fn on_client(&mut self, msg: ClientMsg, now: Instant) {
        match msg {
            ClientMsg::Query { sql } => {
                self.push(Kind::Simple, sql.into(), Some(Vec::new()), now);
                self.batches_sent += 1;
            }
            ClientMsg::Parse { statement, sql, param_types } => {
                self.statements.insert(statement, Prepared { sql: sql.into(), param_types });
            }
            ClientMsg::Bind { portal, statement, formats, params } => {
                let (sql, types) = match self.statements.get(&statement) {
                    Some(p) => (p.sql.clone(), p.param_types.as_slice()),
                    None => (Arc::from(UNKNOWN), &[][..]),
                };
                let params = render_params(&formats, &params, types);
                self.portals.insert(portal, Portal { sql, params });
            }
            ClientMsg::Execute { portal } => {
                let (sql, params) = match self.portals.get(&portal) {
                    Some(p) => (p.sql.clone(), p.params.clone()),
                    None => (Arc::from(UNKNOWN), None),
                };
                self.push(Kind::Extended, sql, params, now);
            }
            ClientMsg::Describe { statement } => self.describes.push_back((self.batches_sent, statement)),
            ClientMsg::Close { statement, portal } => {
                if let Some(s) = statement {
                    self.statements.remove(&s);
                }
                if let Some(p) = portal {
                    self.portals.remove(&p);
                }
            }
            ClientMsg::Sync => self.batches_sent += 1,
            ClientMsg::Other => {}
        }
    }

    fn push(&mut self, kind: Kind, sql: Arc<str>, params: Option<Vec<Option<String>>>, now: Instant) {
        self.pending.push_back(Pending {
            kind,
            sql,
            params,
            sent: now,
            batch: self.batches_sent,
            rows: 0,
            data_rows: 0,
            bytes: 0,
            error: None,
        });
    }

    /// `len` is the message body length (result bytes for DataRow / CopyData).
    pub fn on_server(&mut self, msg: ServerMsg, len: usize, now: Instant) -> Vec<Execution> {
        let mut done = Vec::new();
        match msg {
            ServerMsg::DataRow | ServerMsg::CopyData => {
                if let Some(p) = self.pending.front_mut() {
                    p.bytes += len as u64;
                    if msg == ServerMsg::DataRow {
                        p.data_rows += 1;
                    }
                }
            }
            ServerMsg::CommandComplete { tag } => {
                if let Some(p) = self.pending.front_mut() {
                    p.rows += tag_rows(&tag).unwrap_or(0);
                    if p.kind == Kind::Extended {
                        done.extend(self.finish_front(now));
                    }
                }
            }
            ServerMsg::EmptyQuery | ServerMsg::PortalSuspended => {
                if self.pending.front().is_some_and(|p| p.kind == Kind::Extended) {
                    done.extend(self.finish_front(now));
                }
            }
            ServerMsg::Error { message } => {
                if let Some(p) = self.pending.front_mut() {
                    p.error = Some(message);
                    if p.kind == Kind::Extended {
                        done.extend(self.finish_front(now));
                    }
                }
            }
            ServerMsg::ReadyForQuery => {
                // The ReadyForQuery that ends startup answers no request.
                if self.batches_done == self.batches_sent {
                    return done;
                }
                self.batches_done += 1;
                while self.pending.front().is_some_and(|p| p.batch < self.batches_done) {
                    if self.pending.front().is_some_and(|p| p.kind == Kind::Simple) {
                        done.extend(self.finish_front(now));
                    } else {
                        // Skipped by the server after an earlier error in its batch.
                        self.pending.pop_front();
                    }
                }
                // Describes skipped after an error in their batch get no answer either.
                let finished = self.batches_done;
                self.describes.retain(|(batch, _)| *batch >= finished);
            }
            ServerMsg::ParameterDescription { types } => {
                if let Some((_, Some(name))) = self.describes.front()
                    && let Some(p) = self.statements.get_mut(name)
                {
                    p.param_types = types;
                }
            }
            ServerMsg::DescribeDone => {
                self.describes.pop_front();
            }
            ServerMsg::Other => {}
        }
        done
    }

    fn finish_front(&mut self, now: Instant) -> Option<Execution> {
        let p = self.pending.pop_front()?;
        // Pipelined requests queue behind the previous one on the server.
        let started = match self.last_finished {
            Some(prev) if prev > p.sent => prev,
            _ => p.sent,
        };
        self.last_finished = Some(now);
        Some(Execution {
            sql: p.sql,
            params: p.params,
            started,
            finished: now,
            // The tag counts affected rows for writes; DataRows count what was returned.
            rows: p.rows.max(p.data_rows),
            bytes: p.bytes,
            error: p.error,
        })
    }
}

fn render_params(formats: &[i16], values: &[Option<Vec<u8>>], types: &[u32]) -> Option<Vec<Option<String>>> {
    values
        .iter()
        .enumerate()
        .map(|(i, v)| {
            // No codes = all text; one code = applies to all; else one per parameter.
            let binary = match formats.len() {
                0 => false,
                1 => formats[0] == 1,
                _ => formats.get(i) == Some(&1),
            };
            match v {
                None => Ok(None),
                Some(bytes) => param_text(bytes, binary, types.get(i).copied().unwrap_or(0)).map(Some),
            }
        })
        .collect::<Result<_, _>>()
        .ok()
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    fn at(base: Instant, ms: u64) -> Instant {
        base + Duration::from_millis(ms)
    }

    fn cc(tag: &str) -> ServerMsg {
        ServerMsg::CommandComplete { tag: tag.into() }
    }

    #[test]
    fn simple_query_with_rows() {
        let t0 = Instant::now();
        let mut t = Tracker::default();
        t.on_client(ClientMsg::Query { sql: "select * from t".into() }, t0);
        assert!(t.on_server(ServerMsg::DataRow, 40, at(t0, 1)).is_empty());
        assert!(t.on_server(ServerMsg::DataRow, 40, at(t0, 1)).is_empty());
        assert!(t.on_server(cc("SELECT 2"), 0, at(t0, 2)).is_empty());
        let done = t.on_server(ServerMsg::ReadyForQuery, 1, at(t0, 3));
        assert_eq!(done.len(), 1);
        assert_eq!((done[0].rows, done[0].bytes), (2, 80));
        assert_eq!(done[0].finished - done[0].started, Duration::from_millis(3));
        assert_eq!(done[0].params.as_deref(), Some(&[][..]));
    }

    #[test]
    fn extended_protocol_with_named_statement_and_text_params() {
        let t0 = Instant::now();
        let mut t = Tracker::default();
        t.on_client(ClientMsg::Parse { statement: "s1".into(), sql: "select $1".into(), param_types: vec![] }, t0);
        for (i, v) in ["7", "8"].iter().enumerate() {
            t.on_client(
                ClientMsg::Bind {
                    portal: String::new(),
                    statement: "s1".into(),
                    formats: vec![],
                    params: vec![Some(v.as_bytes().to_vec())],
                },
                t0,
            );
            t.on_client(ClientMsg::Execute { portal: String::new() }, at(t0, i as u64));
        }
        t.on_client(ClientMsg::Sync, t0);
        let a = t.on_server(cc("SELECT 1"), 0, at(t0, 5));
        let b = t.on_server(cc("SELECT 1"), 0, at(t0, 9));
        // Each Execute keeps the values bound right before it.
        assert_eq!(a[0].params, Some(vec![Some("7".to_string())]));
        assert_eq!(b[0].params, Some(vec![Some("8".to_string())]));
        assert_eq!(b[0].sql.as_ref(), "select $1");
        // Pipelined: the second starts when the first finished.
        assert_eq!(b[0].finished - b[0].started, Duration::from_millis(4));
        assert!(t.on_server(ServerMsg::ReadyForQuery, 1, at(t0, 9)).is_empty());
    }

    #[test]
    fn error_skips_the_rest_of_the_batch_only() {
        let t0 = Instant::now();
        let mut t = Tracker::default();
        let exec = |t: &mut Tracker, sql: &str| {
            t.on_client(ClientMsg::Parse { statement: String::new(), sql: sql.into(), param_types: vec![] }, t0);
            t.on_client(ClientMsg::Bind { portal: String::new(), statement: String::new(), formats: vec![], params: vec![] }, t0);
            t.on_client(ClientMsg::Execute { portal: String::new() }, t0);
        };
        exec(&mut t, "insert 1");
        exec(&mut t, "insert 2");
        t.on_client(ClientMsg::Sync, t0);
        exec(&mut t, "select 3");
        t.on_client(ClientMsg::Sync, t0);

        let failed = t.on_server(ServerMsg::Error { message: "ERROR: boom".into() }, 0, at(t0, 1));
        assert_eq!(failed[0].error.as_deref(), Some("ERROR: boom"));
        // "insert 2" never ran; "select 3" (next batch) still pending.
        assert!(t.on_server(ServerMsg::ReadyForQuery, 1, at(t0, 1)).is_empty());
        let next = t.on_server(cc("SELECT 0"), 0, at(t0, 2));
        assert_eq!(next[0].sql.as_ref(), "select 3");
        assert!(next[0].error.is_none());
    }

    #[test]
    fn startup_ready_for_query_is_not_a_batch() {
        let t0 = Instant::now();
        let mut t = Tracker::default();
        assert!(t.on_server(ServerMsg::ReadyForQuery, 1, t0).is_empty());
        let exec = |t: &mut Tracker, sql: &str| {
            t.on_client(ClientMsg::Parse { statement: String::new(), sql: sql.into(), param_types: vec![] }, t0);
            t.on_client(ClientMsg::Bind { portal: String::new(), statement: String::new(), formats: vec![], params: vec![] }, t0);
            t.on_client(ClientMsg::Execute { portal: String::new() }, t0);
            t.on_client(ClientMsg::Sync, t0);
        };
        exec(&mut t, "select a");
        exec(&mut t, "select b");
        assert_eq!(t.on_server(cc("SELECT 1"), 0, at(t0, 1))[0].sql.as_ref(), "select a");
        assert!(t.on_server(ServerMsg::ReadyForQuery, 1, at(t0, 1)).is_empty());
        assert_eq!(t.on_server(cc("SELECT 1"), 0, at(t0, 2))[0].sql.as_ref(), "select b");
    }

    #[test]
    fn binary_params_use_described_types() {
        let t0 = Instant::now();
        let mut t = Tracker::default();
        t.on_client(ClientMsg::Parse { statement: "q".into(), sql: "select $1".into(), param_types: vec![0] }, t0);
        t.on_client(ClientMsg::Describe { statement: Some("q".into()) }, t0);
        t.on_server(ServerMsg::ParameterDescription { types: vec![20] }, 6, t0);
        t.on_server(ServerMsg::DescribeDone, 0, t0);
        t.on_client(
            ClientMsg::Bind {
                portal: String::new(),
                statement: "q".into(),
                formats: vec![1],
                params: vec![Some(5i64.to_be_bytes().to_vec())],
            },
            t0,
        );
        t.on_client(ClientMsg::Execute { portal: String::new() }, t0);
        let done = t.on_server(cc("SELECT 1"), 0, t0);
        assert_eq!(done[0].params, Some(vec![Some("5".to_string())]));
    }
}
