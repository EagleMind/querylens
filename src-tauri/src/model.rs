//! Every type that crosses the IPC boundary.
//!
//! These are the single source of truth: `cargo test export_bindings` regenerates
//! the TypeScript mirrors in `src/bindings/`. Never hand-edit those files.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

// ───────────────────────────── Connections ─────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum Engine {
    Postgres,
    Duckdb,
}

impl Engine {
    pub fn as_str(self) -> &'static str {
        match self {
            Engine::Postgres => "postgres",
            Engine::Duckdb => "duckdb",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "postgres" => Some(Engine::Postgres),
            "duckdb" => Some(Engine::Duckdb),
            _ => None,
        }
    }
    pub fn label(self) -> &'static str {
        match self {
            Engine::Postgres => "PostgreSQL",
            Engine::Duckdb => "DuckDB",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum SslMode {
    Disable,
    Prefer,
    Require,
}

impl SslMode {
    pub fn as_str(self) -> &'static str {
        match self {
            SslMode::Disable => "disable",
            SslMode::Prefer => "prefer",
            SslMode::Require => "require",
        }
    }
    pub fn parse(s: &str) -> Self {
        match s {
            "disable" => SslMode::Disable,
            "require" => SslMode::Require,
            _ => SslMode::Prefer,
        }
    }
}

/// A saved connection. The password is never part of this type — it lives in the
/// OS keychain and the UI only learns whether one is stored.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Connection {
    pub id: String,
    pub name: String,
    pub engine: Engine,
    pub color: String,
    pub host: Option<String>,
    pub port: Option<u16>,
    pub database: Option<String>,
    pub username: Option<String>,
    pub ssl_mode: SslMode,
    /// DuckDB: database file path, or `:memory:`.
    pub file_path: Option<String>,
    pub has_password: bool,
    pub created_at: String,
    pub last_used_at: Option<String>,
}

/// Create / update / test payload.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ConnectionInput {
    /// `null` creates a new connection.
    pub id: Option<String>,
    pub name: String,
    pub engine: Engine,
    pub color: String,
    pub host: Option<String>,
    pub port: Option<u16>,
    pub database: Option<String>,
    pub username: Option<String>,
    pub ssl_mode: SslMode,
    pub file_path: Option<String>,
    /// `null` keeps the stored password, `""` removes it, anything else replaces it.
    pub password: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ConnectionTestResult {
    pub latency_ms: f64,
    pub server_version: String,
}

// ───────────────────────────── Plans ─────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum ExplainMode {
    /// `EXPLAIN ANALYZE` — executes the statement inside a rolled-back transaction.
    Analyze,
    /// Plain `EXPLAIN` — planner estimates only, never executes.
    Estimate,
}

impl ExplainMode {
    pub fn as_str(self) -> &'static str {
        match self {
            ExplainMode::Analyze => "analyze",
            ExplainMode::Estimate => "estimate",
        }
    }
    pub fn parse(s: &str) -> Self {
        if s == "estimate" { ExplainMode::Estimate } else { ExplainMode::Analyze }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum Heat {
    High,
    Medium,
    Low,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum WarningKind {
    MissingIndex,
    SeqScanLarge,
    RowEstimateError,
    SortSpill,
    HashSpill,
    NestedLoopBlowup,
    HeapFetches,
    JitOverhead,
    IoBound,
    SerializeHeavy,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum WarningSeverity {
    Error,
    Warning,
    Info,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PlanWarning {
    pub kind: WarningKind,
    pub severity: WarningSeverity,
    pub message: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PlanBuffers {
    pub shared_hit: f64,
    pub shared_read: f64,
    pub temp_read: f64,
    pub temp_written: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct PlanProperty {
    pub key: String,
    pub value: String,
}

/// One operator in the normalized, engine-agnostic plan tree.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PlanNode {
    /// Stable path id: "0", "0.1", "0.1.0"…
    pub id: String,
    pub node_type: String,
    pub relation: Option<String>,
    pub alias: Option<String>,
    pub index_name: Option<String>,
    /// The most informative condition (filter / join / index cond), one line.
    pub detail: Option<String>,
    /// Planner estimate, per loop. `null` when the engine doesn't report one.
    pub estimated_rows: Option<f64>,
    /// Actual rows, per loop (analyze mode only).
    pub actual_rows: Option<f64>,
    pub loops: Option<f64>,
    pub startup_cost: Option<f64>,
    pub total_cost: Option<f64>,
    /// Inclusive wall time across all loops, ms.
    pub total_time_ms: Option<f64>,
    /// Exclusive time: this node minus its children, ms.
    pub self_time_ms: Option<f64>,
    /// Exclusive estimated cost (estimate mode).
    pub self_cost: Option<f64>,
    /// Inclusive time spent waiting on reads/writes, ms (needs `track_io_timing`).
    #[serde(default)]
    pub io_time_ms: Option<f64>,
    /// Exclusive I/O time, ms; always ≤ `self_time_ms`.
    #[serde(default)]
    pub self_io_ms: Option<f64>,
    /// Share of the whole plan's self time (or self cost), 0–1.
    pub share: f64,
    pub heat: Heat,
    pub buffers: Option<PlanBuffers>,
    pub warnings: Vec<PlanWarning>,
    pub properties: Vec<PlanProperty>,
    pub children: Vec<PlanNode>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ColumnInfo {
    pub name: String,
    pub data_type: String,
    /// Planner statistics from `pg_stats`, when the column has been analyzed.
    #[serde(default)]
    pub stats: Option<ColumnStats>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ColumnStats {
    pub null_frac: f64,
    /// Positive: distinct count. Negative: fraction of rows (−1 = unique).
    pub n_distinct: f64,
    /// Physical vs. logical order, −1…1. Near ±1 makes index range scans cheap.
    pub correlation: Option<f64>,
    /// Up to three most common values, with their row fractions.
    pub common_values: Vec<String>,
    pub common_freqs: Vec<f64>,
}

/// What the server supports, detected once per session.
#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ServerInfo {
    /// e.g. 170006 for PostgreSQL 17.6; 0 for engines without a version number.
    pub version_num: u32,
    pub hypopg: bool,
    pub pg_stat_statements: bool,
    pub io_timing: bool,
    pub superuser: bool,
    /// Current `work_mem` in kB (what-if scenarios scale it).
    #[serde(default)]
    pub work_mem_kb: f64,
    #[serde(default)]
    pub random_page_cost: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct IndexInfo {
    pub name: String,
    pub definition: String,
}

/// Schema facts about a relation referenced by the plan, captured at analysis time.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TableContext {
    pub name: String,
    pub row_estimate: Option<f64>,
    pub size_bytes: Option<f64>,
    pub last_analyzed: Option<String>,
    pub modified_since_analyze: Option<f64>,
    pub columns: Vec<ColumnInfo>,
    pub indexes: Vec<IndexInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AnalysisResult {
    pub id: String,
    pub connection_id: String,
    pub connection_name: String,
    pub engine: Engine,
    pub mode: ExplainMode,
    pub sql: String,
    pub root: PlanNode,
    pub planning_time_ms: Option<f64>,
    pub execution_time_ms: Option<f64>,
    pub total_cost: Option<f64>,
    pub node_count: u32,
    pub warnings_count: u32,
    pub tables: Vec<TableContext>,
    /// The engine's EXPLAIN output, verbatim.
    pub raw_plan: String,
    pub analyzed_at: String,
    pub suggestions: Option<SuggestionSet>,
    #[serde(default)]
    pub server: ServerInfo,
    /// JIT compilation time, ms (Postgres).
    #[serde(default)]
    pub jit_ms: Option<f64>,
    /// Time to serialize result rows for the client, ms (PG17 `SERIALIZE`).
    #[serde(default)]
    pub serialize_ms: Option<f64>,
    #[serde(default)]
    pub serialize_bytes: Option<f64>,
    /// Non-default planner-relevant settings in effect (PG12 `SETTINGS`).
    #[serde(default)]
    pub planner_settings: Vec<PlanProperty>,
    /// Repeat-run statistics when Profile ran more than once.
    #[serde(default)]
    pub timing: Option<RunStats>,
    /// Same statement modulo literals/parameters/whitespace.
    #[serde(default)]
    pub query_fp: String,
    /// Same plan shape (operators, relations, indexes).
    #[serde(default)]
    pub plan_fp: String,
    /// The previous analysis of this statement on this connection, if any.
    #[serde(default)]
    pub baseline: Option<Baseline>,
    /// Planner what-if sweep, when one has been run.
    #[serde(default)]
    pub whatif: Option<WhatIfReport>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct WhatIfScenario {
    /// Stable kind, e.g. "nestloop_off", "work_mem", "ext_stats".
    pub kind: String,
    pub label: String,
    /// Statements run inside the rolled-back transaction for this scenario.
    pub setup: Vec<String>,
    /// Why the scenario was chosen for this plan.
    pub rationale: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum WhatIfOutcome {
    /// The planner picked the same plan: this lever doesn't matter here.
    NoChange,
    Faster,
    Slower,
    /// Different plan, within ±15%.
    Similar,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct WhatIfResult {
    pub scenario: WhatIfScenario,
    pub outcome: WhatIfOutcome,
    pub plan_changed: bool,
    /// Baseline vs scenario: median ms when profiled, else estimated cost.
    pub before: Option<f64>,
    pub after: Option<f64>,
    /// before ÷ after (> 1 = faster).
    pub speedup: Option<f64>,
    pub timed: bool,
    /// The scenario's own analysis (in the scratch store) for Compare.
    pub analysis_id: Option<String>,
    pub verdict: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct WhatIfReport {
    pub results: Vec<WhatIfResult>,
    /// One-paragraph diagnosis drawn from the best result.
    pub summary: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
#[ts(export)]
pub enum WhatIfEvent {
    Started { scenarios: Vec<WhatIfScenario> },
    /// A scenario is being explained / profiled.
    Running { kind: String, phase: String },
    Result { result: WhatIfResult },
    Done { report: WhatIfReport },
    Error { message: String },
}

/// How a suggestion was backed up by the model.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum Evidence {
    /// Executed with EXPLAIN ANALYZE (real timings).
    Measured,
    /// Planner estimate only, e.g. a HypoPG hypothetical index.
    Estimated,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Baseline {
    pub previous_id: String,
    pub previous_at: String,
    pub plan_changed: bool,
    /// This run's time ÷ the previous run's (both Profile). >1 = slower.
    pub time_ratio: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum DiffStatus {
    Same,
    Changed,
    Added,
    Removed,
}

/// One operator as it appears on one side of a comparison.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DiffSide {
    pub id: String,
    pub node_type: String,
    pub index_name: Option<String>,
    pub self_time_ms: Option<f64>,
    pub self_cost: Option<f64>,
    pub actual_rows: Option<f64>,
    pub estimated_rows: Option<f64>,
    pub loops: Option<f64>,
    pub heat: Heat,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DiffNode {
    pub status: DiffStatus,
    pub relation: Option<String>,
    pub detail: Option<String>,
    pub before: Option<DiffSide>,
    pub after: Option<DiffSide>,
    pub children: Vec<DiffNode>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PlanDiff {
    pub before_id: String,
    pub after_id: String,
    pub before_sql: String,
    pub after_sql: String,
    pub before_label: String,
    pub after_label: String,
    /// Median execution time (or single-run time), ms.
    pub before_ms: Option<f64>,
    pub after_ms: Option<f64>,
    pub before_cost: Option<f64>,
    pub after_cost: Option<f64>,
    /// Both sides have real timings (Profile), not just estimates.
    pub timed: bool,
    pub plan_changed: bool,
    pub root: DiffNode,
}

/// Profile repeated N times: the median run is the one displayed. The first run is
/// reported separately; it usually reads from disk while later runs hit the cache.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RunStats {
    /// Execution time of every run, in order.
    pub execution_ms: Vec<f64>,
    /// How many runs were asked for (fewer ran if the time budget ran out).
    pub requested: u32,
    pub first_ms: f64,
    pub median_ms: f64,
    pub min_ms: f64,
    pub max_ms: f64,
    /// Shared blocks read from disk/OS cache on the first run vs. the warm median.
    pub first_read_blocks: f64,
    pub warm_read_blocks: Option<f64>,
}

// ───────────────────────────── History ─────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct HistoryEntry {
    pub id: String,
    pub connection_id: String,
    pub connection_name: String,
    pub engine: Engine,
    pub mode: ExplainMode,
    pub sql_preview: String,
    pub execution_time_ms: Option<f64>,
    pub total_cost: Option<f64>,
    pub warnings_count: u32,
    pub has_suggestions: bool,
    pub created_at: String,
}

// ───────────────────────────── LLM ─────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum LlmProviderKind {
    ClaudeCode,
    LmStudio,
    Ollama,
    OpenRouter,
    OpenAi,
}

impl LlmProviderKind {
    pub fn as_str(self) -> &'static str {
        match self {
            LlmProviderKind::ClaudeCode => "claude_code",
            LlmProviderKind::LmStudio => "lm_studio",
            LlmProviderKind::Ollama => "ollama",
            LlmProviderKind::OpenRouter => "open_router",
            LlmProviderKind::OpenAi => "open_ai",
        }
    }
    pub fn label(self) -> &'static str {
        match self {
            LlmProviderKind::ClaudeCode => "Claude Code",
            LlmProviderKind::LmStudio => "LM Studio",
            LlmProviderKind::Ollama => "Ollama",
            LlmProviderKind::OpenRouter => "OpenRouter",
            LlmProviderKind::OpenAi => "OpenAI-compatible",
        }
    }
    pub fn default_base_url(self) -> &'static str {
        match self {
            LlmProviderKind::ClaudeCode => "",
            LlmProviderKind::LmStudio => "http://localhost:1234/v1",
            LlmProviderKind::Ollama => "http://localhost:11434/v1",
            LlmProviderKind::OpenRouter => "https://openrouter.ai/api/v1",
            LlmProviderKind::OpenAi => "https://api.openai.com/v1",
        }
    }
    pub fn needs_api_key(self) -> bool {
        matches!(self, LlmProviderKind::OpenRouter | LlmProviderKind::OpenAi)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LlmSettings {
    pub provider: LlmProviderKind,
    pub base_url: String,
    /// Empty = provider default (Claude Code picks its own default model).
    pub model: String,
    pub temperature: f64,
    /// Claude Code: path to the `claude` binary. Empty = look it up on PATH.
    pub claude_path: String,
    /// Claude Code: let the model run EXPLAIN on its own rewrites via MCP.
    pub verify_with_tools: bool,
    /// Read-only: whether an API key is stored in the keychain for this provider.
    pub has_api_key: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AnalysisSettings {
    pub default_mode: ExplainMode,
    pub statement_timeout_ms: u32,
    /// Give up waiting for row/table locks after this long (Profile on busy tables).
    #[serde(default = "default_lock_timeout_ms")]
    pub lock_timeout_ms: u32,
    /// Profile repeats: the median run is shown, the first run is reported separately.
    #[serde(default = "default_repeat_runs")]
    pub repeat_runs: u32,
}

fn default_lock_timeout_ms() -> u32 {
    5_000
}
fn default_repeat_runs() -> u32 {
    3
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Settings {
    pub llm: LlmSettings,
    pub analysis: AnalysisSettings,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            llm: LlmSettings {
                provider: LlmProviderKind::ClaudeCode,
                base_url: String::new(),
                model: String::new(),
                temperature: 0.2,
                claude_path: String::new(),
                verify_with_tools: true,
                has_api_key: false,
            },
            analysis: AnalysisSettings {
                default_mode: ExplainMode::Analyze,
                statement_timeout_ms: 30_000,
                lock_timeout_ms: default_lock_timeout_ms(),
                repeat_runs: default_repeat_runs(),
            },
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LlmTestResult {
    pub latency_ms: f64,
    pub reply: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum SuggestionSeverity {
    High,
    Medium,
    Low,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Suggestion {
    pub severity: SuggestionSeverity,
    pub title: String,
    pub explanation: String,
    pub sql_fix: Option<String>,
    pub node_id: Option<String>,
    /// The model test-EXPLAINed this fix before recommending it.
    pub verified: bool,
    /// What kind of test backs it (null = not tested).
    #[serde(default)]
    pub evidence: Option<Evidence>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SuggestionSet {
    pub summary: String,
    pub suggestions: Vec<Suggestion>,
    pub provider: String,
    pub model: String,
    pub created_at: String,
}

/// Streamed over a Tauri `Channel` while suggestions are generated.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
#[ts(export)]
pub enum SuggestionEvent {
    Started { provider: String, model: String },
    /// A chunk of model output text.
    Delta { text: String },
    /// Something the model is doing besides writing (tool calls, reasoning).
    /// The UI restarts its partial-JSON buffer on each activity.
    Activity { label: String, detail: Option<String> },
    Done { result: SuggestionSet },
    Error { message: String },
}
