//! Database engines: connect, run EXPLAIN safely, and read schema context.

mod duckdb;
mod postgres;

use async_trait::async_trait;

use crate::error::{AppError, AppResult};
use crate::model::{ConnectionTestResult, Engine, ExplainMode, TableContext};

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
    /// Validated by [`sanitize_setup_sql`]; runs first in the same transaction — e.g.
    /// a candidate CREATE INDEX the model wants to measure.
    pub setup: Option<&'a str>,
    /// Make the transaction read-only after setup. Used for model-issued queries so a
    /// prompt-injected UPDATE/DELETE can't even run (let alone commit).
    pub read_only: bool,
}

#[async_trait]
pub trait EngineSession: Send {
    async fn test(&mut self) -> AppResult<ConnectionTestResult>;

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
    let allowed = ["create index", "create unique index", "set ", "analyze", "analyse"];
    if !allowed.iter().any(|p| lower.starts_with(p)) {
        return Err(AppError::validation(
            "setup_sql may only be CREATE [UNIQUE] INDEX, SET or ANALYZE.",
        ));
    }
    // CONCURRENTLY can't run inside a transaction block; a plain build is equivalent here.
    Ok(s.replacen(" CONCURRENTLY", "", 1).replacen(" concurrently", "", 1))
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
    }
}
