//! One implementation for every OpenAI-compatible `/chat/completions` server:
//! LM Studio, Ollama, OpenRouter, OpenAI and anything else speaking the protocol.

use std::time::Duration;

use async_trait::async_trait;
use futures_util::StreamExt;
use serde_json::{Value, json};

use super::{EventSink, LlmOutput, LlmProvider, LlmRequest};
use crate::error::{AppError, AppResult};
use crate::model::{LlmProviderKind, LlmSettings, SuggestionEvent};

pub struct OpenAiCompat {
    kind: LlmProviderKind,
    base_url: String,
    api_key: Option<String>,
    model: String,
    client: reqwest::Client,
}

impl OpenAiCompat {
    pub fn new(settings: &LlmSettings, api_key: Option<String>) -> AppResult<Self> {
        let base = if settings.base_url.trim().is_empty() {
            settings.provider.default_base_url().to_string()
        } else {
            settings.base_url.trim().trim_end_matches('/').to_string()
        };
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .build()
            .map_err(|e| AppError::internal(e.to_string()))?;
        Ok(Self {
            kind: settings.provider,
            base_url: base,
            api_key,
            model: settings.model.trim().to_string(),
            client,
        })
    }

    fn request(&self, method: reqwest::Method, path: &str) -> reqwest::RequestBuilder {
        let mut rb = self.client.request(method, format!("{}{path}", self.base_url));
        if let Some(key) = &self.api_key {
            rb = rb.bearer_auth(key);
        }
        if self.kind == LlmProviderKind::OpenRouter {
            rb = rb.header("HTTP-Referer", "https://querylens.dev").header("X-Title", "QueryLens");
        }
        rb
    }

    async fn error_from(&self, resp: reqwest::Response) -> AppError {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        let detail = serde_json::from_str::<Value>(&body)
            .ok()
            .and_then(|v| {
                v.pointer("/error/message")
                    .or_else(|| v.get("error"))
                    .and_then(Value::as_str)
                    .map(String::from)
            })
            .unwrap_or(body);
        AppError::llm(format!("{} returned {status}: {}", self.kind.label(), detail.trim()))
    }

    pub async fn list_models(&self) -> AppResult<Vec<String>> {
        let resp = self.request(reqwest::Method::GET, "/models").send().await?;
        if !resp.status().is_success() {
            return Err(self.error_from(resp).await);
        }
        let v: Value = resp.json().await?;
        let mut models: Vec<String> = v
            .get("data")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(|m| m.get("id")?.as_str().map(String::from)).collect())
            .unwrap_or_default();
        models.sort();
        Ok(models)
    }

    /// Local servers often have exactly one model loaded; use it when none is configured.
    async fn resolve_model(&self) -> AppResult<String> {
        if !self.model.is_empty() {
            return Ok(self.model.clone());
        }
        self.list_models().await?.into_iter().find(|m| !m.contains("embed")).ok_or_else(|| {
            AppError::llm(format!(
                "No model configured and {} reports none loaded. Pick a model in Settings.",
                self.kind.label()
            ))
        })
    }
}

#[async_trait]
impl LlmProvider for OpenAiCompat {
    fn label(&self) -> String {
        self.kind.label().to_string()
    }

    fn model(&self) -> String {
        if self.model.is_empty() { "auto".into() } else { self.model.clone() }
    }

    async fn stream(&self, req: &LlmRequest, sink: &dyn EventSink) -> AppResult<LlmOutput> {
        let model = self.resolve_model().await?;
        let body = json!({
            "model": model,
            "messages": [
                { "role": "system", "content": req.system },
                { "role": "user", "content": req.user },
            ],
            "temperature": req.temperature,
            "stream": true,
        });
        let resp = self.request(reqwest::Method::POST, "/chat/completions").json(&body).send().await?;
        if !resp.status().is_success() {
            return Err(self.error_from(resp).await);
        }

        let mut bytes = resp.bytes_stream();
        let mut buf: Vec<u8> = Vec::new();
        let mut text = String::new();
        let mut announced_reasoning = false;

        'outer: while let Some(chunk) = bytes.next().await {
            buf.extend_from_slice(&chunk?);
            // SSE frames are newline-delimited; split on bytes so multi-byte UTF-8
            // characters straddling chunks stay intact.
            while let Some(pos) = buf.iter().position(|b| *b == b'\n') {
                let line: Vec<u8> = buf.drain(..=pos).collect();
                let line = String::from_utf8_lossy(&line);
                let Some(data) = line.trim().strip_prefix("data:") else { continue };
                let data = data.trim();
                if data == "[DONE]" {
                    break 'outer;
                }
                let Ok(v) = serde_json::from_str::<Value>(data) else { continue };
                if let Some(err) = v.get("error") {
                    let msg = err.get("message").and_then(Value::as_str).unwrap_or("unknown error");
                    return Err(AppError::llm(format!("{}: {msg}", self.kind.label())));
                }
                let Some(delta) = v.pointer("/choices/0/delta") else { continue };
                let reasoning = delta
                    .get("reasoning_content")
                    .or_else(|| delta.get("reasoning"))
                    .and_then(Value::as_str)
                    .is_some_and(|r| !r.is_empty());
                if reasoning && !announced_reasoning {
                    announced_reasoning = true;
                    sink.emit(SuggestionEvent::Activity { label: "Model is reasoning…".into(), detail: None });
                }
                if let Some(content) = delta.get("content").and_then(Value::as_str).filter(|c| !c.is_empty()) {
                    text.push_str(content);
                    sink.emit(SuggestionEvent::Delta { text: content.to_string() });
                }
            }
        }
        Ok(LlmOutput { text, tool_calls: 0 })
    }
}
