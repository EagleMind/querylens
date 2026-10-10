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
