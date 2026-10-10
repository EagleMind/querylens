//! Database engines: connect, run EXPLAIN safely, and read schema context.

mod duckdb;
mod postgres;

use async_trait::async_trait;

use crate::error::{AppError, AppResult};
use crate::model::{ConnectionTestResult, Engine, ExplainMode, ServerInfo, TableContext};

/// Everything needed to open a session; built from a saved connection or a form.
#[derive(Debug, Clone)]
pub struct ConnectSpec {
    pub engine: Engine,
    pub host: Option<String>,
    pub port: Option<u16>,
    pub database: Option<String>,
    pub username: Option<String>,
    pub password: Option<String>,
    pub ssl_mode: crate::model::SslMode,
    pub file_path: Option<String>,
}

pub struct ExplainRequest<'a> {
    /// A single statement, already passed through [`sanitize_sql`].
    pub sql: &'a str,
    pub mode: ExplainMode,
    pub timeout_ms: u32,
    /// Fail fast instead of queueing behind another session's locks. 0 = no limit.
    pub lock_timeout_ms: u32,
    /// Statements validated by [`sanitize_setup_sql`], run first in the same rolled-back
    /// transaction: candidate indexes, planner settings, extended statistics.
    pub setup: &'a [String],
    /// `CREATE INDEX` statements to register as HypoPG hypothetical indexes. Forces a
    /// plain EXPLAIN: hypothetical indexes are invisible to ANALYZE. Postgres only.
    pub hypothetical: &'a [String],
    /// Make the transaction read-only after setup. Used for model-issued queries so a
    /// prompt-injected UPDATE/DELETE can't even run (let alone commit).
    pub read_only: bool,
}

impl<'a> ExplainRequest<'a> {
    /// A request with no setup, no hypothetical indexes and the default lock timeout.
    pub fn new(sql: &'a str, mode: ExplainMode, timeout_ms: u32) -> Self {
        Self { sql, mode, timeout_ms, lock_timeout_ms: 5_000, setup: &[], hypothetical: &[], read_only: false }
    }
}

#[async_trait]
pub trait EngineSession: Send {
    async fn test(&mut self) -> AppResult<ConnectionTestResult>;

    /// Capabilities detected when the session was opened.
    fn server_info(&self) -> ServerInfo;

    /// Run EXPLAIN and return the engine's raw JSON output. Implementations MUST NOT
    /// leave side effects behind: everything runs inside a transaction that is always
    /// rolled back.
    async fn explain(&mut self, req: &ExplainRequest<'_>) -> AppResult<String>;

    /// Best-effort schema facts for the given relations; unknown names are skipped.
    async fn table_context(&mut self, relations: &[String]) -> AppResult<Vec<TableContext>>;
}

pub async fn open(spec: &ConnectSpec) -> AppResult<Box<dyn EngineSession>> {
    match spec.engine {
        Engine::Postgres => Ok(Box::new(postgres::PgSession::connect(spec).await?)),
        Engine::Duckdb => Ok(Box::new(duckdb::DuckSession::open(spec).await?)),
    }
}

/// Normalize user SQL: trim, drop trailing semicolons, and strip a leading EXPLAIN
/// (with its options) since QueryLens adds its own.
pub fn sanitize_sql(sql: &str) -> AppResult<String> {
    let mut s = sql.trim();
    while let Some(rest) = s.strip_suffix(';') {
        s = rest.trim_end();
    }
    s = strip_explain(s);
    if s.is_empty() {
        return Err(AppError::validation("Enter a SQL statement to analyze."));
    }
    Ok(s.to_string())
}

/// Setup statements allowed before a verification EXPLAIN. They run inside the
/// rolled-back transaction, so only plan-affecting, transactional DDL/settings qualify.
pub fn sanitize_setup_sql(setup: &str) -> AppResult<String> {
    let s = sanitize_sql(setup)?;
    let lower = s.to_ascii_lowercase();
    let allowed = ["create index", "create unique index", "create statistics", "set ", "analyze", "analyse"];
    if !allowed.iter().any(|p| lower.starts_with(p)) {
        return Err(AppError::validation(
            "setup_sql may only be CREATE [UNIQUE] INDEX, CREATE STATISTICS, SET or ANALYZE.",
        ));
    }
    // CONCURRENTLY can't run inside a transaction block; a plain build is equivalent here.
    Ok(s.replacen(" CONCURRENTLY", "", 1).replacen(" concurrently", "", 1))
}

/// Whether a statement modifies data (at the top level or in a CTE).
pub fn is_dml(sql: &str) -> bool {
    let lower = sql.to_ascii_lowercase();
    ["insert into", "update ", "delete from", "merge into"].iter().any(|k| lower.contains(k))
}

/// EXPLAIN options for this server: richer evidence on newer Postgres versions.
pub fn postgres_explain_options(mode: ExplainMode, info: &ServerInfo, dml: bool) -> String {
    let v = info.version_num;
    let mut opts: Vec<&str> = Vec::new();
    if mode == ExplainMode::Analyze {
        opts.push("ANALYZE");
        opts.push("BUFFERS");
        if v >= 130_000 && dml {
            opts.push("WAL");
        }
        if v >= 170_000 {
            opts.push("SERIALIZE");
        }
    }
    if v >= 120_000 {
        opts.push("SETTINGS");
    }
    if v >= 170_000 {
        opts.push("MEMORY");
    }
    opts.push("FORMAT JSON");
    opts.join(", ")
}

fn strip_explain(sql: &str) -> &str {
    let lower = sql.to_ascii_lowercase();
    if !lower.starts_with("explain") || !lower[7..].starts_with(|c: char| c.is_whitespace() || c == '(') {
        return sql;
    }
    let mut rest = sql[7..].trim_start();
    if rest.starts_with('(') {
        if let Some(end) = rest.find(')') {
            rest = rest[end + 1..].trim_start();
        }
    }
    const OPTION_WORDS: &[&str] = &["analyze", "analyse", "verbose", "costs", "buffers"];
    loop {
        let word_end = rest.find(char::is_whitespace).unwrap_or(rest.len());
        if OPTION_WORDS.contains(&rest[..word_end].to_ascii_lowercase().as_str()) {
            rest = rest[word_end..].trim_start();
        } else {
            return rest;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::sanitize_sql;

    #[test]
    fn strips_semicolons_and_explain() {
        assert_eq!(sanitize_sql("  select 1 ;; ").unwrap(), "select 1");
        assert_eq!(sanitize_sql("EXPLAIN ANALYZE select 1").unwrap(), "select 1");
        assert_eq!(sanitize_sql("explain (analyze, buffers) select 1;").unwrap(), "select 1");
        assert_eq!(sanitize_sql("explainer_view").unwrap(), "explainer_view");
        assert!(sanitize_sql(" ; ").is_err());
    }

    #[test]
    fn setup_sql_is_restricted() {
        use super::sanitize_setup_sql;
        assert_eq!(
            sanitize_setup_sql("CREATE INDEX CONCURRENTLY ON orders (user_id);").unwrap(),
            "CREATE INDEX ON orders (user_id)"
        );
        assert!(sanitize_setup_sql("SET work_mem = '64MB'").is_ok());
        assert!(sanitize_setup_sql("DROP TABLE orders").is_err());
        assert!(sanitize_setup_sql("delete from orders").is_err());
        assert!(sanitize_setup_sql("CREATE STATISTICS s (dependencies) ON a, b FROM t").is_ok());
    }

    #[test]
    fn explain_options_follow_server_version() {
        use super::postgres_explain_options as opts;
        use crate::model::{ExplainMode, ServerInfo};
        let v = |n| ServerInfo { version_num: n, ..Default::default() };
        assert_eq!(opts(ExplainMode::Analyze, &v(110000), false), "ANALYZE, BUFFERS, FORMAT JSON");
        assert_eq!(opts(ExplainMode::Analyze, &v(160000), true), "ANALYZE, BUFFERS, WAL, SETTINGS, FORMAT JSON");
        assert_eq!(
            opts(ExplainMode::Analyze, &v(170000), false),
            "ANALYZE, BUFFERS, SERIALIZE, SETTINGS, MEMORY, FORMAT JSON"
        );
        assert_eq!(opts(ExplainMode::Estimate, &v(170000), true), "SETTINGS, MEMORY, FORMAT JSON");
        assert!(super::is_dml("WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x"));
        assert!(!super::is_dml("SELECT updated_at FROM t"));
    }
}
