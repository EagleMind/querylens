use std::time::Instant;

use crate::error::AppResult;
use crate::llm::{self, EventSink, LlmRequest, NullSink, parse, prompt};
use crate::model::{LlmProviderKind, LlmSettings, LlmTestResult, SuggestionEvent, SuggestionSet};
use crate::secrets;
use crate::storage::Store;

/// Settings with the read-only `has_api_key` flag resolved from the keychain.
pub fn llm_settings(store: &Store) -> AppResult<LlmSettings> {
    let mut llm = store.get_settings()?.llm;
    llm.has_api_key = secrets::get(&secrets::llm_account(llm.provider))?.is_some();
    Ok(llm)
}

/// Generate suggestions for a stored analysis, streaming progress to `sink`, and
/// persist the result alongside the analysis.
pub async fn generate(store: &Store, analysis_id: &str, sink: &dyn EventSink) -> AppResult<SuggestionSet> {
    let analysis = store.get_analysis(analysis_id)?;
    let settings = llm_settings(store)?;
    let provider = llm::build(&settings)?;

    // Tools need the live connection; history entries may outlive it.
    let tools = settings.provider == LlmProviderKind::ClaudeCode
        && settings.verify_with_tools
        && store.get_connection(&analysis.connection_id).is_ok();

    let req = LlmRequest {
        system: prompt::system(analysis.engine, tools),
        user: prompt::user(&analysis),
        temperature: settings.temperature,
        tools_connection_id: tools.then(|| analysis.connection_id.clone()),
    };

    sink.emit(SuggestionEvent::Started { provider: provider.label(), model: provider.model() });
    let out = provider.stream(&req, sink).await?;
    let (summary, suggestions) = parse::parse_suggestions(&out.text, out.tool_calls)?;
    let set = SuggestionSet {
        summary,
        suggestions,
        provider: provider.label(),
        model: provider.model(),
        created_at: crate::storage::now(),
    };
    store.set_suggestions(analysis_id, &set)?;
    Ok(set)
}

/// Round-trip a trivial prompt to confirm the provider works.
pub async fn test(store: &Store) -> AppResult<LlmTestResult> {
    let settings = llm_settings(store)?;
    let provider = llm::build(&settings)?;
    let req = LlmRequest {
        system: "You are a connectivity check. Follow the instruction exactly.".into(),
        user: "Reply with exactly: QueryLens OK".into(),
        temperature: 0.0,
        tools_connection_id: None,
    };
    let started = Instant::now();
    let out = provider.stream(&req, &NullSink).await?;
    Ok(LlmTestResult {
        latency_ms: started.elapsed().as_secs_f64() * 1000.0,
        reply: parse::strip_think(&out.text).trim().chars().take(200).collect(),
    })
}
