//! Tolerant extraction of the suggestions JSON from model output.

use serde_json::Value;

use crate::error::{AppError, AppResult};
use crate::model::{Suggestion, SuggestionSeverity};

const MAX_SUGGESTIONS: usize = 6;

/// Remove `<think>…</think>` blocks emitted by local reasoning models.
pub fn strip_think(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("<think>") {
        out.push_str(&rest[..start]);
        match rest[start..].find("</think>") {
            Some(end) => rest = &rest[start + end + "</think>".len()..],
            None => return out, // unterminated: drop the remainder
        }
    }
    out.push_str(rest);
    out
}

/// Outermost `{ … }` in the text, ignoring braces inside JSON strings.
fn extract_object(text: &str) -> Option<&str> {
    let bytes = text.as_bytes();
    let mut search_from = 0;
    while let Some(off) = text[search_from..].find('{') {
        let start = search_from + off;
        let (mut depth, mut in_str, mut escaped) = (0i32, false, false);
        for (i, &b) in bytes.iter().enumerate().skip(start) {
            if in_str {
                match (escaped, b) {
                    (true, _) => escaped = false,
                    (false, b'\\') => escaped = true,
                    (false, b'"') => in_str = false,
                    _ => {}
                }
                continue;
            }
            match b {
                b'"' => in_str = true,
                b'{' => depth += 1,
                b'}' => {
                    depth -= 1;
                    if depth == 0 {
                        let candidate = &text[start..=i];
                        if serde_json::from_str::<Value>(candidate).is_ok() {
                            return Some(candidate);
                        }
                        break;
                    }
                }
                _ => {}
            }
        }
        search_from = start + 1;
    }
    None
}

fn str_field(v: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|k| match v.get(*k)? {
        Value::String(s) if !s.trim().is_empty() => Some(s.trim().to_string()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    })
}

pub fn parse_suggestions(text: &str, tool_calls: u32) -> AppResult<(String, Vec<Suggestion>)> {
    let cleaned = strip_think(text);
    let json = extract_object(&cleaned).ok_or_else(|| {
        let preview: String = cleaned.trim().chars().take(300).collect();
        AppError::llm(format!(
            "The model didn't return valid JSON suggestions. Try again, or use a stronger \
             model.\n\nResponse started with: {preview}"
        ))
    })?;
    let v: Value = serde_json::from_str(json)?;

    let summary = str_field(&v, &["summary"]).unwrap_or_default();
    let items = v.get("suggestions").and_then(Value::as_array).cloned().unwrap_or_default();
    let suggestions: Vec<Suggestion> = items
        .iter()
        .filter_map(|s| {
            let title = str_field(s, &["title"])?;
            let severity = match str_field(s, &["severity", "impact"]).unwrap_or_default().to_lowercase().as_str() {
                "high" | "critical" => SuggestionSeverity::High,
                "low" | "info" => SuggestionSeverity::Low,
                _ => SuggestionSeverity::Medium,
            };
            Some(Suggestion {
                severity,
                title,
                explanation: str_field(s, &["explanation", "description", "details"]).unwrap_or_default(),
                sql_fix: str_field(s, &["sqlFix", "sql_fix", "fix", "sql"]),
                node_id: str_field(s, &["nodeId", "node_id", "node"]),
                // Only trust "verified" if the model actually called a tool.
                verified: tool_calls > 0 && s.get("verified").and_then(Value::as_bool).unwrap_or(false),
            })
        })
        .take(MAX_SUGGESTIONS)
        .collect();

    if suggestions.is_empty() && summary.is_empty() {
        return Err(AppError::llm("The model returned an empty answer. Try again."));
    }
    Ok((summary, suggestions))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handles_fences_think_and_prose() {
        let text = "<think>user wants {json}</think>Sure! Here you go:\n```json\n{\"summary\": \"Seq scan on orders\", \
            \"suggestions\": [{\"severity\": \"HIGH\", \"title\": \"Add index\", \"explanation\": \"Use {braces} ok\", \
            \"sql_fix\": \"CREATE INDEX ON orders (user_id)\", \"nodeId\": \"0.0\", \"verified\": true}]}\n```";
        let (summary, s) = parse_suggestions(text, 0).unwrap();
        assert_eq!(summary, "Seq scan on orders");
        assert_eq!(s[0].severity, SuggestionSeverity::High);
        assert_eq!(s[0].sql_fix.as_deref(), Some("CREATE INDEX ON orders (user_id)"));
        assert!(!s[0].verified, "verified requires tool calls");
        assert!(parse_suggestions(text, 2).unwrap().1[0].verified);
    }

    #[test]
    fn rejects_non_json() {
        assert!(parse_suggestions("I cannot help with that", 0).is_err());
    }
}
