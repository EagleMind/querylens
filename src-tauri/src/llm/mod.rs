//! LLM providers behind one streaming trait.

mod claude_cli;
mod openai_compat;
pub mod parse;
pub mod prompt;

use async_trait::async_trait;

use crate::error::{AppError, AppResult};
use crate::model::{LlmProviderKind, LlmSettings, SuggestionEvent};
use crate::secrets;

/// Where streamed events go (a Tauri `Channel` in the app, nowhere in tests).
pub trait EventSink: Send + Sync {
    fn emit(&self, event: SuggestionEvent);
}

pub struct NullSink;
impl EventSink for NullSink {
    fn emit(&self, _: SuggestionEvent) {}
}

pub struct LlmRequest {
    pub system: String,
    pub user: String,
    pub temperature: f64,
    /// Expose QueryLens's MCP tools scoped to this connection (Claude Code only).
    pub tools_connection_id: Option<String>,
}

pub struct LlmOutput {
    pub text: String,
    /// Number of verification tool calls the model made.
    pub tool_calls: u32,
}

#[async_trait]
pub trait LlmProvider: Send + Sync {
    fn label(&self) -> String;
    fn model(&self) -> String;
    async fn stream(&self, req: &LlmRequest, sink: &dyn EventSink) -> AppResult<LlmOutput>;
}

pub fn build(settings: &LlmSettings) -> AppResult<Box<dyn LlmProvider>> {
    match settings.provider {
        LlmProviderKind::ClaudeCode => Ok(Box::new(claude_cli::ClaudeCli::new(settings)?)),
        kind => {
            let api_key = secrets::get(&secrets::llm_account(kind))?;
            if kind.needs_api_key() && api_key.is_none() {
                return Err(AppError::llm(format!(
                    "{} needs an API key. Add one in Settings → AI provider.",
                    kind.label()
                )));
            }
            Ok(Box::new(openai_compat::OpenAiCompat::new(settings, api_key)?))
        }
    }
}

/// Models the provider advertises (empty for providers without a listing endpoint).
pub async fn list_models(settings: &LlmSettings) -> AppResult<Vec<String>> {
    match settings.provider {
        LlmProviderKind::ClaudeCode => {
            Ok(vec!["sonnet".into(), "opus".into(), "haiku".into()])
        }
        kind => {
            let api_key = secrets::get(&secrets::llm_account(kind))?;
            openai_compat::OpenAiCompat::new(settings, api_key)?.list_models().await
        }
    }
}
