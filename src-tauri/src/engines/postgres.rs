use std::time::{Duration, Instant};

use async_trait::async_trait;
use tokio_postgres::{Client, NoTls};

use super::{ConnectSpec, EngineSession, ExplainRequest};
use crate::error::{AppError, AppResult};
use crate::model::{
    ColumnInfo, ConnectionTestResult, ExplainMode, IndexInfo, SslMode, TableContext,
};

pub struct PgSession {
    client: Client,
    connect_ms: f64,
}

impl PgSession {
    pub async fn connect(spec: &ConnectSpec) -> AppResult<Self> {
        let mut cfg = tokio_postgres::Config::new();
        cfg.host(spec.host.as_deref().filter(|h| !h.is_empty()).unwrap_or("localhost"))
            .port(spec.port.unwrap_or(5432))
            .dbname(spec.database.as_deref().filter(|d| !d.is_empty()).unwrap_or("postgres"))
            .user(spec.username.as_deref().filter(|u| !u.is_empty()).unwrap_or("postgres"))
            .application_name("QueryLens")
            .connect_timeout(Duration::from_secs(10));
        if let Some(pw) = spec.password.as_deref().filter(|p| !p.is_empty()) {
            cfg.password(pw);
        }

        let started = Instant::now();
        let client = match spec.ssl_mode {
            SslMode::Disable => {
                let (client, conn) = cfg.connect(NoTls).await?;
                tokio::spawn(async move {
                    let _ = conn.await;
                });
                client
            }
            mode => {
                cfg.ssl_mode(match mode {
                    SslMode::Require => tokio_postgres::config::SslMode::Require,
                    _ => tokio_postgres::config::SslMode::Prefer,
                });
                // libpq semantics: `prefer`/`require` encrypt but don't verify the
                // certificate (that's `verify-full`, not offered yet).
                let tls = native_tls::TlsConnector::builder()
                    .danger_accept_invalid_certs(true)
                    .danger_accept_invalid_hostnames(true)
                    .build()
                    .map_err(|e| AppError::connection(format!("TLS setup failed: {e}")))?;
                let (client, conn) = cfg.connect(postgres_native_tls::MakeTlsConnector::new(tls)).await?;
                tokio::spawn(async move {
                    let _ = conn.await;
                });
                client
            }
        };
        Ok(Self { client, connect_ms: started.elapsed().as_secs_f64() * 1000.0 })
    }
}

#[async_trait]
impl EngineSession for PgSession {
    async fn test(&mut self) -> AppResult<ConnectionTestResult> {
        let started = Instant::now();
        let row = self.client.query_one("SELECT version()", &[]).await?;
        let version: String = row.get(0);
        let short = version.split(" on ").next().unwrap_or(&version).to_string();
        Ok(ConnectionTestResult {
            latency_ms: self.connect_ms + started.elapsed().as_secs_f64() * 1000.0,
            server_version: short,
        })
    }

    async fn explain(&mut self, req: &ExplainRequest<'_>) -> AppResult<String> {
        let options = match req.mode {
            ExplainMode::Analyze => "ANALYZE, BUFFERS, FORMAT JSON",
            ExplainMode::Estimate => "FORMAT JSON",
        };
        // Safety envelope: EXPLAIN ANALYZE really executes the statement, so it runs
        // in a transaction that is always rolled back, under a statement timeout.
        // `query_one` uses the extended protocol, which rejects multiple statements.
        let tx = self.client.transaction().await?;
        tx.batch_execute(&format!("SET LOCAL statement_timeout = {}", req.timeout_ms)).await?;
        if let Some(setup) = req.setup {
            // `execute` = extended protocol → exactly one statement. Plain SET would
            // outlive the transaction on a pooled session, so force SET LOCAL.
            let setup = match setup.strip_prefix("SET ").or_else(|| setup.strip_prefix("set ")) {
                Some(rest) if !rest.to_ascii_lowercase().starts_with("local ") => format!("SET LOCAL {rest}"),
                _ => setup.to_string(),
            };
            if let Err(e) = tx.execute(setup.as_str(), &[]).await {
                let _ = tx.rollback().await;
                return Err(e.into());
            }
        }
        if req.read_only {
            // Allowed mid-transaction (only read-only → read-write is restricted).
            tx.batch_execute("SET LOCAL transaction_read_only = on").await?;
        }
        let result = tx.query_one(&format!("EXPLAIN ({options}) {}", req.sql), &[]).await;
        // Roll back explicitly (dropping would too, but asynchronously).
        let _ = tx.rollback().await;
        let row = result?;
        let plan: serde_json::Value = row.try_get(0)?;
        Ok(plan.to_string())
    }

    async fn table_context(&mut self, relations: &[String]) -> AppResult<Vec<TableContext>> {
        let mut out = Vec::new();
        for rel in relations {
            let Some(meta) = self
                .client
                .query_opt(
                    "SELECT c.oid::regclass::text, c.reltuples::float8,
                            pg_total_relation_size(c.oid)::float8,
                            greatest(s.last_analyze, s.last_autoanalyze)::text,
                            s.n_mod_since_analyze::float8
                     FROM pg_class c
                     LEFT JOIN pg_stat_all_tables s ON s.relid = c.oid
                     WHERE c.oid = to_regclass($1)",
                    &[rel],
                )
                .await?
            else {
                continue;
            };
            let indexes = self
                .client
                .query(
                    "SELECT indexrelid::regclass::text, pg_get_indexdef(indexrelid)
                     FROM pg_index WHERE indrelid = to_regclass($1) ORDER BY 1",
                    &[rel],
                )
                .await?
                .iter()
                .map(|r| IndexInfo { name: r.get(0), definition: r.get(1) })
                .collect();
            let columns = self
                .client
                .query(
                    "SELECT attname::text, format_type(atttypid, atttypmod)
                     FROM pg_attribute
                     WHERE attrelid = to_regclass($1) AND attnum > 0 AND NOT attisdropped
                     ORDER BY attnum LIMIT 60",
                    &[rel],
                )
                .await?
                .iter()
                .map(|r| ColumnInfo { name: r.get(0), data_type: r.get(1) })
                .collect();
            let reltuples: f64 = meta.get(1);
            out.push(TableContext {
                name: meta.get(0),
                // -1 means "never analyzed" on PG14+
                row_estimate: (reltuples >= 0.0).then_some(reltuples),
                size_bytes: Some(meta.get(2)),
                last_analyzed: meta.get(3),
                modified_since_analyze: meta.get(4),
                columns,
                indexes,
            });
        }
        Ok(out)
    }
}
