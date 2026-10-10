//! MySQL 8.0.18+: `EXPLAIN ANALYZE` (Profile) and `EXPLAIN FORMAT=TREE` (Explain),
//! both in the same tree format.
//!
//! Safety: everything runs in `START TRANSACTION READ ONLY`, then ROLLBACK. Unlike
//! PostgreSQL, MySQL can't promise to undo writes (MyISAM tables, statements that commit
//! implicitly), so the server refuses any write instead. Timeouts: `max_execution_time`
//! plus a client-side backstop that issues `KILL QUERY` from a second connection.

use std::time::{Duration, Instant};

use async_trait::async_trait;
use mysql_async::prelude::Queryable;
use mysql_async::{Conn, Opts, OptsBuilder, Row, SslOpts};

use super::{ConnectSpec, EngineSession, ExplainRequest};
use crate::error::{AppError, AppResult, ErrorKind};
use crate::model::{
    ColumnInfo, ConnectionTestResult, ExplainMode, IndexInfo, ServerInfo, SslMode, TableContext, TopQuery,
    TopQueryOrder,
};

pub struct MySession {
    conn: Conn,
    opts: Opts,
    connect_ms: f64,
    version: String,
    info: ServerInfo,
}

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

impl MySession {
    pub async fn connect(spec: &ConnectSpec) -> AppResult<Self> {
        let base = OptsBuilder::default()
            .ip_or_hostname(spec.host.as_deref().filter(|h| !h.is_empty()).unwrap_or("localhost"))
            .tcp_port(spec.port.unwrap_or(3306))
            .user(Some(spec.username.as_deref().filter(|u| !u.is_empty()).unwrap_or("root")))
            .pass(spec.password.clone().filter(|p| !p.is_empty()))
            .db_name(spec.database.clone().filter(|d| !d.is_empty()))
            .prefer_socket(false);
        // Like libpq's prefer/require: encrypt without verifying the certificate.
        let tls = SslOpts::default().with_danger_accept_invalid_certs(true).with_danger_skip_domain_validation(true);

        let started = Instant::now();
        let (conn, opts) = match spec.ssl_mode {
            SslMode::Disable => (open(base.clone().into()).await?, base.into()),
            SslMode::Require => {
                let opts: Opts = base.ssl_opts(Some(tls)).into();
                (open(opts.clone()).await?, opts)
            }
            SslMode::Prefer => {
                let with_tls: Opts = base.clone().ssl_opts(Some(tls)).into();
                match open(with_tls.clone()).await {
                    Ok(c) => (c, with_tls),
                    // Server without TLS: fall back to a plain connection.
                    Err(_) => (open(base.clone().into()).await?, base.into()),
                }
            }
        };
        let connect_ms = started.elapsed().as_secs_f64() * 1000.0;
        let mut session = Self { conn, opts, connect_ms, version: String::new(), info: ServerInfo::default() };
        let version: Option<String> = session.conn.query_first("SELECT VERSION()").await?;
        session.version = version.unwrap_or_default();
        session.info.version_num = super::mongo::version_num(&session.version);
        Ok(session)
    }

    fn is_mariadb(&self) -> bool {
        self.version.to_ascii_lowercase().contains("mariadb")
    }

    /// Stop the running statement from a second connection (the first is busy).
    async fn kill_running(&self) {
        let id = self.conn.id();
        if let Ok(mut killer) = open(self.opts.clone()).await {
            let _ = killer.query_drop(format!("KILL QUERY {id}")).await;
            let _ = killer.disconnect().await;
        }
    }
}

async fn open(opts: Opts) -> AppResult<Conn> {
    tokio::time::timeout(CONNECT_TIMEOUT, Conn::new(opts))
        .await
        .map_err(|_| AppError::connection("Timed out connecting to MySQL."))?
        .map_err(AppError::from)
}

/// `SET x = 1` / `SET SESSION x = 1` only: global settings would outlive the session.
fn session_set(stmt: &str) -> AppResult<String> {
    let lower = stmt.trim().to_ascii_lowercase();
    let rest = lower.strip_prefix("set ").ok_or_else(|| {
        AppError::validation(
            "On MySQL, setup can only change session settings (SET …). Indexes can't be tested inside a \
             transaction because MySQL commits DDL immediately.",
        )
    })?;
    if ["global ", "persist", "@@global", "@@persist"].iter().any(|g| rest.trim_start().starts_with(g)) {
        return Err(AppError::validation("Only session settings can be changed (not SET GLOBAL / PERSIST)."));
    }
    let original = stmt.trim();
    Ok(if rest.trim_start().starts_with("session ") || rest.trim_start().starts_with("@@session") {
        original.to_string()
    } else {
        format!("SET SESSION {}", original[4..].trim_start())
    })
}

#[async_trait]
impl EngineSession for MySession {
    async fn test(&mut self) -> AppResult<ConnectionTestResult> {
        let started = Instant::now();
        self.conn.ping().await?;
        let flavor = if self.is_mariadb() { "" } else { "MySQL " };
        Ok(ConnectionTestResult {
            latency_ms: self.connect_ms + started.elapsed().as_secs_f64() * 1000.0,
            server_version: format!("{flavor}{}", self.version),
        })
    }

    fn server_info(&self) -> ServerInfo {
        self.info.clone()
    }

    async fn explain(&mut self, req: &ExplainRequest<'_>) -> AppResult<String> {
        if self.is_mariadb() {
            return Err(AppError::validation(
                "MariaDB isn't supported yet: its EXPLAIN output differs from MySQL's. QueryLens supports MySQL \
                 8.0.18 and later.",
            ));
        }
        if self.info.version_num < 80_018 {
            return Err(AppError::validation(format!(
                "QueryLens needs MySQL 8.0.18 or later (EXPLAIN ANALYZE); this server is {}.",
                self.version
            )));
        }
        if req.params.is_some() || !req.hypothetical.is_empty() {
            return Err(AppError::validation(
                "Parameters and hypothetical indexes are PostgreSQL features. Write the values into the query.",
            ));
        }
        let setup = req.setup.iter().map(|s| session_set(s)).collect::<AppResult<Vec<_>>>()?;
        let lock_secs = req.lock_timeout_ms.div_ceil(1000).max(1);
        self.conn
            .query_drop(format!(
                "SET SESSION max_execution_time = {}, innodb_lock_wait_timeout = {lock_secs}, \
                 lock_wait_timeout = {lock_secs}",
                req.timeout_ms
            ))
            .await?;
        for stmt in &setup {
            self.conn.query_drop(stmt).await?;
        }
        let statement = match req.mode {
            ExplainMode::Analyze => format!("EXPLAIN ANALYZE {}", req.sql),
            ExplainMode::Estimate => format!("EXPLAIN FORMAT=TREE {}", req.sql),
        };

        // Profile executes the statement, so the server must refuse writes. Explain doesn't
        // execute it, but MySQL rejects even EXPLAIN UPDATE in a read-only transaction, so
        // it gets a normal one that is rolled back.
        let begin = match req.mode {
            ExplainMode::Analyze => "START TRANSACTION READ ONLY",
            ExplainMode::Estimate => "START TRANSACTION",
        };
        self.conn.query_drop(begin).await?;
        let budget = Duration::from_millis(u64::from(req.timeout_ms) + 2_000);
        let result = tokio::time::timeout(budget, self.conn.query_first::<String, _>(statement)).await;
        let mut result = match result {
            Ok(r) => r.map_err(AppError::from),
            Err(_) => {
                self.kill_running().await;
                Err(AppError::new(ErrorKind::Timeout, "statement timeout"))
            }
        };
        if result.is_ok() {
            // When max_execution_time fires, EXPLAIN ANALYZE returns the partial plan as if
            // it had finished, leaving only a warning. A truncated plan would mislead.
            let warnings: Vec<(String, u32, String)> = self.conn.query("SHOW WARNINGS").await.unwrap_or_default();
            if warnings.iter().any(|(_, code, _)| *code == 1317 || *code == 3024) {
                result = Err(AppError::new(ErrorKind::Timeout, "statement timeout"));
            }
        }
        let _ = self.conn.query_drop("ROLLBACK").await;
        // Setup changed this session only; it is discarded with the connection.
        let plan = result?.ok_or_else(|| AppError::database("EXPLAIN returned no rows"))?;
        if plan.contains("<not executable by iterator executor>") {
            return Err(AppError::validation(
                "MySQL can't show a plan tree for this statement (single-table UPDATE and DELETE aren't                  supported by EXPLAIN FORMAT=TREE). Explain the SELECT with the same WHERE clause instead.",
            ));
        }
        Ok(plan)
    }

    async fn table_context(&mut self, relations: &[String]) -> AppResult<Vec<TableContext>> {
        let mut out = Vec::new();
        for rel in relations {
            if rel.starts_with('<') {
                continue; // <temporary>, <subquery2>, …
            }
            let meta: Option<(String, Option<f64>, Option<f64>, Option<String>)> = self
                .conn
                .exec_first(
                    "SELECT TABLE_NAME, CAST(TABLE_ROWS AS DOUBLE), CAST(DATA_LENGTH + INDEX_LENGTH AS DOUBLE),
                            DATE_FORMAT(UPDATE_TIME, '%Y-%m-%d %H:%i:%s')
                     FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?",
                    (rel,),
                )
                .await?;
            let Some((name, rows, size, _updated)) = meta else { continue };
            let columns: Vec<(String, String)> = self
                .conn
                .exec(
                    "SELECT COLUMN_NAME, COLUMN_TYPE FROM information_schema.COLUMNS
                     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION LIMIT 60",
                    (rel,),
                )
                .await?;
            let indexes: Vec<(String, i64, String)> = self
                .conn
                .exec(
                    "SELECT INDEX_NAME, MIN(NON_UNIQUE),
                            GROUP_CONCAT(COALESCE(COLUMN_NAME, CONCAT('(', EXPRESSION, ')')) ORDER BY SEQ_IN_INDEX SEPARATOR ', ')
                     FROM information_schema.STATISTICS
                     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? GROUP BY INDEX_NAME",
                    (rel,),
                )
                .await?;
            out.push(TableContext {
                name: name.clone(),
                row_estimate: rows,
                size_bytes: size,
                last_analyzed: None,
                modified_since_analyze: None,
                columns: columns
                    .into_iter()
                    .map(|(name, data_type)| ColumnInfo { name, data_type, stats: None })
                    .collect(),
                indexes: indexes
                    .into_iter()
                    .map(|(index, non_unique, cols)| IndexInfo {
                        definition: if index == "PRIMARY" {
                            format!("PRIMARY KEY ({cols})")
                        } else {
                            let unique = if non_unique == 0 { "UNIQUE " } else { "" };
                            format!("CREATE {unique}INDEX {index} ON {name} ({cols})")
                        },
                        name: index,
                    })
                    .collect(),
            });
        }
        Ok(out)
    }

    async fn top_queries(&mut self, order: TopQueryOrder, limit: u32) -> AppResult<Vec<TopQuery>> {
        let enabled: Option<i64> = self.conn.query_first("SELECT @@performance_schema").await?;
        if enabled != Some(1) {
            return Err(AppError::validation(
                "performance_schema is off on this server. Start MySQL with performance_schema=ON (the default) \
                 to record statement statistics.",
            ));
        }
        let order_by = match order {
            TopQueryOrder::Total => "SUM_TIMER_WAIT",
            TopQueryOrder::Mean => "AVG_TIMER_WAIT",
            TopQueryOrder::Calls => "COUNT_STAR",
        };
        // Timers are in picoseconds. QueryLens's own statements and catalog reads are hidden.
        let sql = format!(
            "SELECT DIGEST, DIGEST_TEXT, CAST(COUNT_STAR AS DOUBLE), CAST(SUM_TIMER_WAIT AS DOUBLE) / 1e9,
                    CAST(AVG_TIMER_WAIT AS DOUBLE) / 1e9, CAST(SUM_ROWS_SENT AS DOUBLE),
                    CAST(SUM_TIMER_WAIT AS DOUBLE) / NULLIF(SUM(SUM_TIMER_WAIT) OVER (), 0)
             FROM performance_schema.events_statements_summary_by_digest
             WHERE SCHEMA_NAME = DATABASE() AND DIGEST_TEXT IS NOT NULL
               AND DIGEST_TEXT NOT REGEXP '^(EXPLAIN|SET|START|ROLLBACK|COMMIT|SHOW|KILL|SELECT (VERSION|@@|`?DATABASE))'
               AND DIGEST_TEXT NOT LIKE '%information_schema%' AND DIGEST_TEXT NOT LIKE '%performance_schema%'
             ORDER BY {order_by} DESC LIMIT {}",
            limit.clamp(1, 500)
        );
        let rows: Vec<Row> = self.conn.query(sql).await?;
        Ok(rows
            .into_iter()
            .map(|mut r| TopQuery {
                query_id: r.take::<Option<String>, _>(0).flatten().unwrap_or_default(),
                query: r.take::<Option<String>, _>(1).flatten().unwrap_or_default(),
                calls: r.take::<Option<f64>, _>(2).flatten().unwrap_or(0.0),
                total_ms: r.take::<Option<f64>, _>(3).flatten().unwrap_or(0.0),
                mean_ms: r.take::<Option<f64>, _>(4).flatten().unwrap_or(0.0),
                rows: r.take::<Option<f64>, _>(5).flatten().unwrap_or(0.0),
                hit_ratio: None,
                share: r.take::<Option<f64>, _>(6).flatten().unwrap_or(0.0),
            })
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::session_set;

    #[test]
    fn setup_is_session_only() {
        assert_eq!(session_set("SET optimizer_switch = 'hash_join=off'").unwrap(), "SET SESSION optimizer_switch = 'hash_join=off'");
        assert_eq!(session_set("set session sort_buffer_size = 1048576").unwrap(), "set session sort_buffer_size = 1048576");
        assert!(session_set("SET GLOBAL max_connections = 1").is_err());
        assert!(session_set("SET PERSIST x = 1").is_err());
        assert!(session_set("CREATE INDEX i ON t (a)").is_err());
    }
}
