//! What SDKs send the server: newline-separated JSON items, a header first.
//!
//! ```text
//! {"type":"header","sdk":"querylens-node/0.3.0","environment":"production","release":"4f2c1e0"}
//! {"type":"transaction","name":"GET /orders/:id","start":1760950000000,"durationMs":41.2,"queries":[…]}
//! {"type":"stats","start":1760950000000,"queries":[{"sql":"SELECT … = ?","calls":120,"totalMs":96.1,…}]}
//! {"type":"source","origin":"src/orders.js:42","firstLine":35,"lines":["…", …]}
//! ```
//!
//! A *transaction* is one request (or job) the SDK chose to send because it looked
//! problematic, with all its statements. *Stats* are per-shape totals for every statement,
//! sent each minute. In production the SDK scrubs values: literals become `?`, bound
//! parameters are dropped, and each statement carries `vh`, an opaque hash of its values,
//! so the server can still tell an N+1 (different values) from a repeated query.
//! *Source* items are opt-in (`sourceContext`): the lines of application code around an
//! `origin`, sent once per line of code, so fixes can be written against the real code.
//! Pure: no I/O.

use serde::Deserialize;

use super::model::SourceSnippet;
use crate::capture::sql::comments;
use crate::fingerprint;
use crate::model::CapturedStatement;

pub const DEFAULT_ENVIRONMENT: &str = "production";
/// The transaction name for statements run outside any request.
pub const BACKGROUND: &str = "background";
/// Statements kept per transaction; the SDK sends at most this many too.
pub const MAX_QUERIES: usize = 1000;
const MAX_SQL: usize = 20_000;
const MAX_LABEL: usize = 200;
/// Lines of code kept around an origin, and characters per line.
const MAX_SOURCE_LINES: usize = 41;
const MAX_SOURCE_LINE: usize = 300;
/// Source items kept per envelope.
const MAX_SOURCES: usize = 200;

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Item {
    Header(Header),
    Transaction(Transaction),
    Stats(Stats),
    Source(Source),
}

#[derive(Debug, Clone, Default, Deserialize)]
struct Header {
    #[serde(default)]
    sdk: Option<String>,
    #[serde(default)]
    environment: Option<String>,
    #[serde(default)]
    release: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Transaction {
    /// The route (`GET /orders/:id`) or job name; `None` for background work.
    #[serde(default)]
    pub name: Option<String>,
    /// Epoch milliseconds.
    pub start: f64,
    #[serde(default)]
    pub duration_ms: f64,
    pub queries: Vec<Query>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Query {
    /// Start, ms since the transaction started.
    pub at: f64,
    pub duration_ms: f64,
    pub sql: String,
    /// Bound values, when the app sends them (development).
    #[serde(default)]
    pub params: Option<Vec<Option<String>>>,
    /// Hash of the values, when they were scrubbed.
    #[serde(default)]
    pub vh: Option<String>,
    #[serde(default)]
    pub rows: f64,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub origin: Option<String>,
    #[serde(default)]
    pub conn: u32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    /// Start of the period, epoch milliseconds.
    pub start: f64,
    /// Length of the period: one minute in development, five in production.
    #[serde(default = "default_period")]
    pub period_ms: f64,
    pub queries: Vec<StatQuery>,
}

fn default_period() -> f64 {
    60_000.0
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatQuery {
    /// A sample of the shape (scrubbed in production).
    pub sql: String,
    pub calls: u32,
    pub total_ms: f64,
    #[serde(default)]
    pub max_ms: f64,
    #[serde(default)]
    pub errors: u32,
    #[serde(default)]
    pub rows: f64,
}

/// The application's code around one `origin` (`file:line`), as the SDK read it.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub origin: String,
    /// The line number of `lines[0]`.
    pub first_line: u32,
    pub lines: Vec<String>,
}

impl Source {
    /// The snippet, clipped, when it is what it claims: a relative `file:line` inside the
    /// project whose line is among the lines sent.
    pub fn snippet(&self) -> Option<SourceSnippet> {
        let origin = label(Some(self.origin.clone()))?;
        let (file, line) = origin.rsplit_once(':')?;
        let line: u32 = line.parse().ok()?;
        let inside = !file.is_empty()
            && !file.starts_with('/')
            && !file.contains('\\')
            && !file.contains(':')
            && file.split('/').all(|part| part != "..");
        if !inside || self.first_line == 0 || self.lines.is_empty() {
            return None;
        }
        // Keep a window centred on the origin's line when more was sent than is kept.
        let at = line.checked_sub(self.first_line)? as usize;
        if at >= self.lines.len() {
            return None;
        }
        let start = at.saturating_sub(MAX_SOURCE_LINES / 2).min(self.lines.len().saturating_sub(MAX_SOURCE_LINES));
        let lines = self.lines[start..].iter().take(MAX_SOURCE_LINES).map(|l| l.chars().take(MAX_SOURCE_LINE).collect()).collect();
        Some(SourceSnippet { origin, first_line: self.first_line + start as u32, lines })
    }
}

#[derive(Debug, Clone, Default)]
pub struct Envelope {
    pub sdk: Option<String>,
    pub environment: String,
    pub release: Option<String>,
    pub transactions: Vec<Transaction>,
    pub stats: Vec<Stats>,
    pub sources: Vec<Source>,
    /// Lines that weren't valid items.
    pub skipped: usize,
}

/// Parse a body; malformed lines are counted and skipped, never fatal.
pub fn parse(body: &str) -> Envelope {
    let mut env = Envelope::default();
    let mut header = Header::default();
    for line in body.lines().map(str::trim).filter(|l| !l.is_empty()) {
        match serde_json::from_str::<Item>(line) {
            Ok(Item::Header(h)) => header = h,
            Ok(Item::Transaction(t)) => env.transactions.push(t),
            Ok(Item::Stats(s)) => env.stats.push(s),
            Ok(Item::Source(s)) if env.sources.len() < MAX_SOURCES => env.sources.push(s),
            Ok(Item::Source(_)) => env.skipped += 1,
            Err(_) => env.skipped += 1,
        }
    }
    env.sdk = label(header.sdk);
    env.environment = label(header.environment).unwrap_or_else(|| DEFAULT_ENVIRONMENT.to_string());
    env.release = label(header.release);
    env
}

fn label(s: Option<String>) -> Option<String> {
    let s = s?.trim().to_string();
    (!s.is_empty()).then(|| s.chars().take(MAX_LABEL).collect())
}

fn clip(sql: &str) -> String {
    if sql.len() <= MAX_SQL {
        return sql.to_string();
    }
    let mut end = MAX_SQL;
    while !sql.is_char_boundary(end) {
        end -= 1;
    }
    sql[..end].to_string()
}

impl Transaction {
    /// The route or job name; work outside any request is "background".
    pub fn name(&self) -> String {
        label(self.name.clone()).unwrap_or_else(|| BACKGROUND.to_string())
    }

    /// The statements, in start order, as the capture analysis reads them: one unit (this
    /// transaction), fingerprinted the same way as captured traffic.
    pub fn statements(&self) -> Vec<CapturedStatement> {
        let route = Some(self.name());
        let mut queries: Vec<&Query> = self.queries.iter().take(MAX_QUERIES).collect();
        queries.sort_by(|a, b| a.at.total_cmp(&b.at));
        queries
            .into_iter()
            .enumerate()
            .map(|(i, q)| {
                let (sql, tags) = comments::extract(&clip(&q.sql));
                CapturedStatement {
                    seq: i as u32 + 1,
                    conn: q.conn,
                    at_ms: q.at.max(0.0),
                    duration_ms: q.duration_ms.max(0.0),
                    fingerprint: fingerprint::query_fp(&sql),
                    params: params(q),
                    rows: q.rows.max(0.0),
                    bytes: 0.0,
                    error: q.error.clone(),
                    unit: Some("transaction".into()),
                    origin: label(q.origin.clone()).or_else(|| tags.origin()),
                    route: route.clone(),
                    sql,
                }
            })
            .collect()
    }
}

/// Real values when sent; otherwise one opaque token per distinct set of values, which
/// is all loop detection needs (same token = a repeated query, different = an N+1).
fn params(q: &Query) -> Vec<Option<String>> {
    match (&q.params, &q.vh) {
        (Some(p), _) => p.clone(),
        (None, Some(vh)) => vec![Some(format!("#{vh}"))],
        (None, None) => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_items_and_skips_garbage() {
        let body = concat!(
            r#"{"type":"header","sdk":"querylens-node/0.2.0","environment":" staging ","release":"abc"}"#,
            "\n",
            r#"{"type":"transaction","name":"GET /orders","start":1,"durationMs":5,"queries":[{"at":2,"durationMs":1,"sql":"SELECT 2","vh":"bb"},{"at":1,"durationMs":1,"sql":"SELECT 1 /*file='a.js%3A3'*/","vh":"aa","origin":null}]}"#,
            "\n",
            "nonsense\n",
            r#"{"type":"stats","start":0,"queries":[{"sql":"SELECT ?","calls":3,"totalMs":1.5}]}"#,
            "\n",
            r#"{"type":"unknown"}"#,
        );
        let env = parse(body);
        assert_eq!(env.environment, "staging");
        assert_eq!(env.release.as_deref(), Some("abc"));
        assert_eq!((env.transactions.len(), env.stats.len(), env.skipped), (1, 1, 2));
        let s = env.transactions[0].statements();
        assert_eq!(s[0].sql, "SELECT 1", "start order, tags stripped");
        assert_eq!(s[0].origin.as_deref(), Some("a.js:3"), "origin from the comment tag");
        assert_eq!(s[0].params, vec![Some("#aa".to_string())]);
        assert_eq!(s[0].route.as_deref(), Some("GET /orders"));
        assert_eq!(s[1].seq, 2);
    }

    #[test]
    fn keeps_source_inside_the_project() {
        let item = |origin: &str, first: u32, n: usize| {
            let lines: Vec<String> = (0..n).map(|i| format!("line {}", first as usize + i)).collect();
            serde_json::json!({ "type": "source", "origin": origin, "firstLine": first, "lines": lines }).to_string()
        };
        let body = [
            item("src/orders.js:42", 35, 15),
            item("../secrets.js:3", 1, 5),
            item("/etc/app.js:3", 1, 5),
            item("src/a.js:99", 1, 5),
            item("src/long.js:100", 1, 200),
        ]
        .join("\n");
        let env = parse(&body);
        let kept: Vec<_> = env.sources.iter().filter_map(Source::snippet).collect();
        assert_eq!(kept.len(), 2, "outside the project, or the line missing: dropped");
        assert_eq!((kept[0].origin.as_str(), kept[0].first_line, kept[0].lines.len()), ("src/orders.js:42", 35, 15));
        let long = &kept[1];
        assert_eq!(long.lines.len(), MAX_SOURCE_LINES);
        assert!(long.first_line <= 100 && 100 < long.first_line + MAX_SOURCE_LINES as u32, "window around the line");
        assert_eq!(long.lines[(100 - long.first_line) as usize], "line 100");
    }

    #[test]
    fn defaults_to_production() {
        assert_eq!(parse("").environment, DEFAULT_ENVIRONMENT);
    }

    /// The SDK scrubs values on its side; the server must group a scrubbed statement
    /// with the same statement sent in full. Cases shared with the SDK's tests.
    #[test]
    fn scrubbed_sql_has_the_same_fingerprint() {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Case {
            sql: String,
            scrubbed: String,
            /// MySQL backslash escapes and "…" strings: the scrubbed form is right, but the
            /// raw form (only sent with `sendValues`) isn't read with MySQL's rules here.
            #[serde(default = "yes")]
            same_fingerprint: bool,
        }
        fn yes() -> bool {
            true
        }
        let cases: Vec<Case> = serde_json::from_str(include_str!("../../../../integrations/node/test/scrub-cases.json")).unwrap();
        for c in cases.into_iter().filter(|c| c.same_fingerprint) {
            assert_eq!(fingerprint::normalize_sql(&c.scrubbed), fingerprint::normalize_sql(&c.sql), "{}", c.sql);
        }
    }
}
