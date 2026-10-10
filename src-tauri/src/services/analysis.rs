use crate::engines::{self, ConnectSpec, ExplainRequest};
use crate::error::AppResult;
use crate::model::{AnalysisResult, Connection, ConnectionInput, ExplainMode};
use crate::storage::Store;
use crate::{plan, secrets};

pub fn spec_for(conn: &Connection) -> AppResult<ConnectSpec> {
    let password = if conn.has_password {
        secrets::get(&secrets::connection_account(&conn.id))?
    } else {
        None
    };
    Ok(ConnectSpec {
        engine: conn.engine,
        host: conn.host.clone(),
        port: conn.port,
        database: conn.database.clone(),
        username: conn.username.clone(),
        password,
        ssl_mode: conn.ssl_mode,
        file_path: conn.file_path.clone(),
    })
}

/// Spec for an unsaved form. A `null` password on an existing connection falls back
/// to the stored one, so "Test" works when editing without retyping it.
pub fn spec_for_input(input: &ConnectionInput) -> AppResult<ConnectSpec> {
    let password = match (&input.password, &input.id) {
        (Some(p), _) => Some(p.clone()),
        (None, Some(id)) => secrets::get(&secrets::connection_account(id))?,
        (None, None) => None,
    };
    Ok(ConnectSpec {
        engine: input.engine,
        host: input.host.clone(),
        port: input.port,
        database: input.database.clone(),
        username: input.username.clone(),
        password,
        ssl_mode: input.ssl_mode,
        file_path: input.file_path.clone(),
    })
}

pub struct RunOptions {
    pub mode: ExplainMode,
    /// Save to history (false for MCP tool calls the model makes).
    pub persist: bool,
    /// Statement run first inside the same rolled-back transaction (MCP verification).
    pub setup_sql: Option<String>,
    /// Model-issued query: run the EXPLAIN in a read-only transaction.
    pub read_only: bool,
}

/// Analyze against a saved connection: resolve credentials, explain, (persist).
pub async fn run(store: &Store, connection_id: &str, sql: &str, opts: RunOptions) -> AppResult<AnalysisResult> {
    let conn = store.get_connection(connection_id)?;
    let timeout_ms = store.get_settings()?.analysis.statement_timeout_ms;
    let result = explain(&conn, &spec_for(&conn)?, sql, &opts, timeout_ms).await?;
    if opts.persist {
        store.insert_analysis(&result)?;
        store.touch_connection(&conn.id)?;
    }
    Ok(result)
}

/// Connect → EXPLAIN → parse/score → schema context. No storage or keychain access.
pub async fn explain(
    conn: &Connection,
    spec: &ConnectSpec,
    sql: &str,
    opts: &RunOptions,
    timeout_ms: u32,
) -> AppResult<AnalysisResult> {
    let sql = engines::sanitize_sql(sql)?;
    let setup = opts.setup_sql.as_deref().map(engines::sanitize_setup_sql).transpose()?;

    let mut session = engines::open(spec).await?;
    let raw = session
        .explain(&ExplainRequest {
            sql: &sql,
            mode: opts.mode,
            timeout_ms,
            setup: setup.as_deref(),
            read_only: opts.read_only,
        })
        .await?;
    let parsed = plan::parse(conn.engine, opts.mode, &raw)?;
    // Schema context improves suggestions but must never fail an analysis.
    let tables = session.table_context(&plan::relations(&parsed.root)).await.unwrap_or_else(|e| {
        log::warn!("table context failed: {e}");
        Vec::new()
    });

    Ok(AnalysisResult {
        id: uuid::Uuid::new_v4().to_string(),
        connection_id: conn.id.clone(),
        connection_name: conn.name.clone(),
        engine: conn.engine,
        mode: opts.mode,
        sql,
        node_count: plan::count_nodes(&parsed.root),
        warnings_count: plan::count_warnings(&parsed.root),
        planning_time_ms: parsed.planning_time_ms,
        execution_time_ms: parsed.execution_time_ms,
        total_cost: parsed.total_cost,
        root: parsed.root,
        tables,
        raw_plan: raw,
        analyzed_at: crate::storage::now(),
        suggestions: None,
    })
}
