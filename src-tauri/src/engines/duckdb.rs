use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use duckdb::{AccessMode, Config, Connection};

use super::{ConnectSpec, EngineSession, ExplainRequest};
use crate::error::{AppError, AppResult};
use crate::model::{ColumnInfo, ConnectionTestResult, ExplainMode, IndexInfo, ServerInfo, TableContext};

pub const MEMORY: &str = ":memory:";

/// DuckDB is synchronous; every call hops onto the blocking pool.
pub struct DuckSession {
    conn: Arc<Mutex<Connection>>,
    open_ms: f64,
}

impl DuckSession {
    pub async fn open(spec: &ConnectSpec) -> AppResult<Self> {
        let path = spec.file_path.clone().filter(|p| !p.trim().is_empty()).unwrap_or_else(|| MEMORY.into());
        let started = Instant::now();
        let conn = tokio::task::spawn_blocking(move || -> AppResult<Connection> {
            if path == MEMORY {
                return Ok(Connection::open_in_memory()?);
            }
            if !std::path::Path::new(&path).exists() {
                return Err(AppError::connection(format!("DuckDB file not found: {path}")));
            }
            // Read-only: never mutate a user's database file, and coexist with other readers.
            let config = Config::default().access_mode(AccessMode::ReadOnly)?;
            Connection::open_with_flags(&path, config).map_err(|e| {
                AppError::connection(format!("Could not open {path} read-only: {e}"))
            })
        })
        .await
        .map_err(|e| AppError::internal(e.to_string()))??;
        Ok(Self { conn: Arc::new(Mutex::new(conn)), open_ms: started.elapsed().as_secs_f64() * 1000.0 })
    }

    async fn run<T: Send + 'static>(
        &self,
        f: impl FnOnce(&Connection) -> AppResult<T> + Send + 'static,
    ) -> AppResult<T> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || {
            let guard = conn.lock().map_err(|_| AppError::internal("DuckDB lock poisoned"))?;
            f(&guard)
        })
        .await
        .map_err(|e| AppError::internal(e.to_string()))?
    }
}

#[async_trait]
impl EngineSession for DuckSession {
    async fn test(&mut self) -> AppResult<ConnectionTestResult> {
        let open_ms = self.open_ms;
        self.run(move |c| {
            let started = Instant::now();
            let version: String = c.query_row("SELECT version()", [], |r| r.get(0))?;
            Ok(ConnectionTestResult {
                latency_ms: open_ms + started.elapsed().as_secs_f64() * 1000.0,
                server_version: format!("DuckDB {version}"),
            })
        })
        .await
    }

    fn server_info(&self) -> ServerInfo {
        ServerInfo::default()
    }

    async fn explain(&mut self, req: &ExplainRequest<'_>) -> AppResult<String> {
        // File databases are opened read-only, so `read_only` holds by construction
        // (`:memory:` has nothing to protect).
        let (mode, timeout_ms, sql) = (req.mode, req.timeout_ms, req.sql);
        if !req.setup.is_empty() || !req.hypothetical.is_empty() {
            return Err(AppError::validation(
                "setup_sql isn't supported for DuckDB (databases are opened read-only).",
            ));
        }
        let options = match mode {
            ExplainMode::Analyze => "ANALYZE, FORMAT JSON",
            ExplainMode::Estimate => "FORMAT JSON",
        };
        let stmt = format!("EXPLAIN ({options}) {sql}");
        self.run(move |c| {
            // DuckDB has no statement_timeout: interrupt from a watchdog thread instead.
            let handle = c.interrupt_handle();
            let (done_tx, done_rx) = std::sync::mpsc::channel::<()>();
            let watchdog = std::thread::spawn(move || {
                if done_rx.recv_timeout(Duration::from_millis(timeout_ms as u64)).is_err() {
                    handle.interrupt();
                }
            });

            c.execute_batch("BEGIN TRANSACTION")?;
            let result = (|| -> AppResult<String> {
                let mut q = c.prepare(&stmt)?;
                let mut rows = q.query([])?;
                let row = rows.next()?.ok_or_else(|| AppError::database("EXPLAIN returned no rows"))?;
                Ok(row.get::<_, String>(1)?)
            })();
            let _ = c.execute_batch("ROLLBACK");

            let _ = done_tx.send(());
            let _ = watchdog.join();
            result.map_err(|e| {
                if e.message.contains("INTERRUPT") || e.message.contains("nterrupted") {
                    AppError::database(format!(
                        "Query interrupted after {timeout_ms} ms (statement timeout, see Settings → Analysis)."
                    ))
                } else {
                    e
                }
            })
        })
        .await
    }

    async fn table_context(&mut self, relations: &[String]) -> AppResult<Vec<TableContext>> {
        let relations = relations.to_vec();
        self.run(move |c| {
            let mut out = Vec::new();
            for rel in relations {
                let meta = c.query_row(
                    "SELECT schema_name || '.' || table_name, estimated_size::DOUBLE
                     FROM duckdb_tables() WHERE table_name = ?1 LIMIT 1",
                    [&rel],
                    |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<f64>>(1)?)),
                );
                let Ok((name, rows)) = meta else { continue };
                let mut cols = c.prepare(
                    "SELECT column_name, data_type FROM duckdb_columns()
                     WHERE table_name = ?1 ORDER BY column_index LIMIT 60",
                )?;
                let columns = cols
                    .query_map([&rel], |r| Ok(ColumnInfo { name: r.get(0)?, data_type: r.get(1)?, stats: None }))?
                    .collect::<Result<Vec<_>, _>>()?;
                let mut idx = c.prepare(
                    "SELECT index_name, coalesce(sql, '') FROM duckdb_indexes() WHERE table_name = ?1",
                )?;
                let indexes = idx
                    .query_map([&rel], |r| Ok(IndexInfo { name: r.get(0)?, definition: r.get(1)? }))?
                    .collect::<Result<Vec<_>, _>>()?;
                out.push(TableContext {
                    name,
                    row_estimate: rows,
                    size_bytes: None,
                    last_analyzed: None,
                    modified_since_analyze: None,
                    columns,
                    indexes,
                });
            }
            Ok(out)
        })
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Engine, SslMode};

    #[tokio::test]
    async fn explains_in_memory_parquet_style_query() {
        let spec = ConnectSpec {
            engine: Engine::Duckdb,
            host: None,
            port: None,
            database: None,
            username: None,
            password: None,
            ssl_mode: SslMode::Disable,
            file_path: Some(MEMORY.into()),
        };
        let mut s = DuckSession::open(&spec).await.unwrap();
        let req = |sql, mode| ExplainRequest::new(sql, mode, 10_000);
        let raw = s
            .explain(&req(
                "SELECT range % 10 AS k, count(*) FROM range(100000) WHERE range > 10 GROUP BY 1",
                ExplainMode::Analyze,
            ))
            .await
            .unwrap();
        let plan = crate::plan::parse(Engine::Duckdb, ExplainMode::Analyze, &raw).unwrap();
        assert!(plan.execution_time_ms.is_some());
        assert!(crate::plan::count_nodes(&plan.root) >= 2);
        let est = s.explain(&req("SELECT 42", ExplainMode::Estimate)).await.unwrap();
        crate::plan::parse(Engine::Duckdb, ExplainMode::Estimate, &est).unwrap();
        assert!(s.test().await.unwrap().server_version.starts_with("DuckDB"));
    }
}
