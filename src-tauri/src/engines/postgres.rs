use std::time::{Duration, Instant};

use async_trait::async_trait;
use tokio_postgres::{Client, NoTls};

use super::{ConnectSpec, EngineSession, ExplainRequest, is_dml, postgres_explain_options, quote_literal};
use crate::error::{AppError, AppResult};
use crate::model::{
    ColumnInfo, ColumnStats, ConnectionTestResult, ExplainMode, IndexInfo, ServerInfo, SslMode, TableContext, TopQuery,
    TopQueryOrder,
};

pub struct PgSession {
    client: Client,
    connect_ms: f64,
    info: ServerInfo,
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
        let connect_ms = started.elapsed().as_secs_f64() * 1000.0;
        let info = detect_server_info(&client).await?;
        Ok(Self { client, connect_ms, info })
    }
}

async fn detect_server_info(client: &Client) -> AppResult<ServerInfo> {
    let row = client
        .query_one(
            "SELECT current_setting('server_version_num')::int,
                    EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'hypopg'),
                    EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements'),
                    current_setting('track_io_timing')::bool,
                    current_setting('is_superuser')::bool,
                    pg_size_bytes(current_setting('work_mem'))::float8 / 1024,
                    current_setting('random_page_cost')::float8",
            &[],
        )
        .await?;
    let version: i32 = row.get(0);
    Ok(ServerInfo {
        version_num: version.max(0) as u32,
        hypopg: row.get(1),
        pg_stat_statements: row.get(2),
        io_timing: row.get(3),
        superuser: row.get(4),
        work_mem_kb: row.get(5),
        random_page_cost: row.get(6),
    })
}

/// First, quartiles and last of a histogram: enough to pick "rare" parameter values.
fn sample_bounds(bounds: Vec<String>) -> Vec<String> {
    if bounds.len() <= 5 {
        return bounds;
    }
    let n = bounds.len() - 1;
    [0, n / 4, n / 2, 3 * n / 4, n].iter().map(|&i| bounds[i].clone()).collect()
}

/// Name of the prepared statement used for parameterized queries.
const PREPARED: &str = "querylens_q";

/// Setup statements run with `execute` (extended protocol → exactly one statement).
/// Plain SET would outlive the transaction on a pooled session, so force SET LOCAL.
fn localize_set(stmt: &str) -> String {
    match stmt.strip_prefix("SET ").or_else(|| stmt.strip_prefix("set ")) {
        Some(rest) if !rest.to_ascii_lowercase().starts_with("local ") => format!("SET LOCAL {rest}"),
        _ => stmt.to_string(),
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

    fn server_info(&self) -> ServerInfo {
        self.info.clone()
    }

    async fn explain(&mut self, req: &ExplainRequest<'_>) -> AppResult<String> {
        // Hypothetical indexes only exist for the planner, so they force a plain EXPLAIN.
        let mode = if req.hypothetical.is_empty() { req.mode } else { ExplainMode::Estimate };
        let options = postgres_explain_options(mode, &self.info, is_dml(req.sql));

        // Safety envelope: EXPLAIN ANALYZE really executes the statement, so it runs
        // in a transaction that is always rolled back, under statement and lock
        // timeouts. `query_one`/`execute` use the extended protocol, which rejects
        // multiple statements.
        let tx = self.client.transaction().await?;
        let mut prelude = format!(
            "SET LOCAL statement_timeout = {}; SET LOCAL lock_timeout = {};",
            req.timeout_ms, req.lock_timeout_ms
        );
        if mode == ExplainMode::Analyze && !self.info.io_timing && self.info.superuser {
            // Per-node I/O time; settable by superusers only (checked at connect).
            prelude.push_str(" SET LOCAL track_io_timing = on;");
        }
        tx.batch_execute(&prelude).await?;

        let result = async {
            for stmt in req.setup {
                tx.execute(localize_set(stmt).as_str(), &[]).await?;
            }
            for ddl in req.hypothetical {
                tx.query_one("SELECT indexrelid FROM hypopg_create_index($1)", &[ddl]).await?;
            }
            let target = match req.params {
                Some(values) => {
                    // PREPARE is a single statement (extended protocol), so the safety
                    // guarantees hold; EXECUTE then plans it with these values.
                    tx.execute(format!("PREPARE {PREPARED} AS {}", req.sql).as_str(), &[]).await?;
                    if self.info.version_num >= 120_000 {
                        let mode = if req.generic_plan { "force_generic_plan" } else { "force_custom_plan" };
                        tx.batch_execute(&format!("SET LOCAL plan_cache_mode = {mode}")).await?;
                    }
                    let args: Vec<String> = values.iter().map(|v| quote_literal(v.as_deref())).collect();
                    format!("EXECUTE {PREPARED}({})", args.join(", "))
                }
                None => req.sql.to_string(),
            };
            if req.read_only {
                // Allowed mid-transaction (only read-only → read-write is restricted).
                tx.batch_execute("SET LOCAL transaction_read_only = on").await?;
            }
            tx.query_one(&format!("EXPLAIN ({options}) {target}"), &[]).await
        }
        .await;
        // Roll back explicitly (dropping would too, but asynchronously).
        let _ = tx.rollback().await;
        if !req.hypothetical.is_empty() {
            // HypoPG state is per-backend, not transactional.
            let _ = self.client.batch_execute("SELECT hypopg_reset()").await;
        }
        if req.params.is_some() {
            // Prepared statements outlive the transaction too.
            let _ = self.client.batch_execute(&format!("DEALLOCATE {PREPARED}")).await;
        }
        let row = result?;
        let plan: serde_json::Value = row.try_get(0)?;
        Ok(plan.to_string())
    }

    async fn top_queries(&mut self, order: TopQueryOrder, limit: u32) -> AppResult<Vec<TopQuery>> {
        if !self.info.pg_stat_statements {
            return Err(AppError::validation(
                "pg_stat_statements isn't enabled in this database. To enable it: add \
                 shared_preload_libraries = 'pg_stat_statements' to postgresql.conf, restart Postgres, \
                 then run CREATE EXTENSION pg_stat_statements; in this database.",
            ));
        }
        // Column names changed in PG13.
        let (total, mean) = if self.info.version_num >= 130_000 {
            ("total_exec_time", "mean_exec_time")
        } else {
            ("total_time", "mean_time")
        };
        let order_by = match order {
            TopQueryOrder::Total => "total",
            TopQueryOrder::Mean => "mean",
            TopQueryOrder::Calls => "calls",
        };
        // Hide QueryLens's own traffic and catalog/maintenance statements.
        let sql = format!(
            r#"WITH s AS (
                 SELECT queryid::text AS id, query, calls::float8 AS calls, {total}::float8 AS total,
                        {mean}::float8 AS mean, rows::float8 AS rows,
                        shared_blks_hit::float8 AS hit, shared_blks_read::float8 AS rd
                 FROM pg_stat_statements
                 WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
                   AND query !~* '^\s*(--[^\n]*\n\s*|/\*.*?\*/\s*)*(explain|set |begin|start|rollback|commit|deallocate|prepare|show |vacuum|analyze|create |drop |alter |copy |do )'
                   AND query !~* '(pg_catalog\.|pg_stat|pg_class|pg_attribute|pg_index|pg_namespace|pg_extension|pg_database|hypopg|current_setting|version\(\))'
               )
               SELECT id, query, calls, total, mean, rows,
                      CASE WHEN hit + rd > 0 THEN hit / (hit + rd) END,
                      COALESCE(total / NULLIF(sum(total) OVER (), 0), 0)
               FROM s ORDER BY {order_by} DESC LIMIT $1"#
        );
        let rows = self.client.query(sql.as_str(), &[&(limit.clamp(1, 500) as i64)]).await?;
        Ok(rows
            .iter()
            .map(|r| TopQuery {
                query_id: r.get(0),
                query: r.get(1),
                calls: r.get(2),
                total_ms: r.get(3),
                mean_ms: r.get(4),
                rows: r.get(5),
                hit_ratio: r.get(6),
                share: r.get(7),
            })
            .collect())
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
                    "SELECT a.attname::text, format_type(a.atttypid, a.atttypmod),
                            s.null_frac::float8, s.n_distinct::float8, s.correlation::float8,
                            (s.most_common_vals::text::text[])[1:3],
                            (s.most_common_freqs)[1:3]::float8[],
                            s.histogram_bounds::text::text[]
                     FROM pg_attribute a
                     JOIN pg_class c ON c.oid = a.attrelid
                     JOIN pg_namespace n ON n.oid = c.relnamespace
                     LEFT JOIN pg_stats s
                       ON s.schemaname = n.nspname AND s.tablename = c.relname AND s.attname = a.attname
                     WHERE a.attrelid = to_regclass($1) AND a.attnum > 0 AND NOT a.attisdropped
                     ORDER BY a.attnum LIMIT 60",
                    &[rel],
                )
                .await?
                .iter()
                .map(|r| ColumnInfo {
                    name: r.get(0),
                    data_type: r.get(1),
                    stats: r.get::<_, Option<f64>>(2).map(|null_frac| ColumnStats {
                        null_frac,
                        n_distinct: r.get::<_, Option<f64>>(3).unwrap_or(0.0),
                        correlation: r.get(4),
                        common_values: r.get::<_, Option<Vec<String>>>(5).unwrap_or_default(),
                        common_freqs: r.get::<_, Option<Vec<f64>>>(6).unwrap_or_default(),
                        histogram: sample_bounds(r.get::<_, Option<Vec<String>>>(7).unwrap_or_default()),
                    }),
                })
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
