//! Claude Code CLI provider.
//!
//! Spawns the user's local `claude` in headless print mode, so it reuses their existing
//! Claude login — no API key. When verification is on, the QueryLens executable
//! itself is handed to Claude as an MCP server (`querylens --mcp --connection <id>`),
//! letting the model EXPLAIN its own rewrites before recommending them.

use std::path::{Path, PathBuf};
use std::process::Stdio;

use async_trait::async_trait;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

use super::{EventSink, LlmOutput, LlmProvider, LlmRequest};
use crate::error::{AppError, AppResult};
use crate::model::{LlmSettings, SuggestionEvent};
use crate::paths;

pub const MCP_SERVER_NAME: &str = "querylens";
const ALLOWED_TOOLS: &str = "mcp__querylens__explain_query,mcp__querylens__table_info,mcp__querylens__test_index";

pub struct ClaudeCli {
    binary: PathBuf,
    model: String,
}

impl ClaudeCli {
    pub fn new(settings: &LlmSettings) -> AppResult<Self> {
        Ok(Self { binary: resolve_binary(&settings.claude_path)?, model: settings.model.trim().to_string() })
    }
}

/// Where the CLI is: a configured path (if it still exists), then PATH, then the copy
/// the Claude desktop app ships, then the usual install locations. A stale configured
/// path falls through instead of failing: desktop-app updates delete old version folders.
fn resolve_binary(configured: &str) -> AppResult<PathBuf> {
    let configured = configured.trim();
    if !configured.is_empty() && Path::new(configured).exists() {
        return Ok(PathBuf::from(configured));
    }
    if let Ok(p) = which::which("claude") {
        return Ok(p);
    }
    let exe = if cfg!(windows) { "claude.exe" } else { "claude" };
    if let Some(p) = desktop_bundled(exe) {
        return Ok(p);
    }
    // GUI apps don't always inherit the shell PATH (notably on macOS).
    let home = dirs::home_dir().unwrap_or_default();
    let mut candidates = vec![
        home.join(".claude/local").join(exe),
        home.join(".local/bin").join(exe),
        PathBuf::from("/opt/homebrew/bin/claude"),
        PathBuf::from("/usr/local/bin/claude"),
    ];
    if let Some(local) = dirs::data_local_dir() {
        candidates.push(local.join("Programs/claude").join(exe));
    }
    if let Some(roaming) = dirs::config_dir() {
        candidates.push(roaming.join("npm/claude.cmd"));
    }
    candidates.into_iter().find(|p| p.exists()).ok_or_else(|| {
        let hint = if configured.is_empty() {
            String::new()
        } else {
            format!(" (the path in Settings no longer exists: {configured})")
        };
        AppError::llm(format!(
            "Claude Code CLI not found{hint}. Install Claude Code or the Claude desktop app and sign in,              or set the path to `claude` in Settings."
        ))
    })
}

/// The CLI copy the Claude desktop app ships. It lives in a per-version folder and is not
/// on PATH. Roots: `%APPDATA%\Claude\claude-code`, plus, for the Microsoft Store (MSIX)
/// install, `%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude\claude-code`.
/// It has two layouts: older builds put the binary in the version folder, newer ones
/// one level down in a hash folder next to a `.verified` marker. The newest version wins.
fn desktop_bundled(exe: &str) -> Option<PathBuf> {
    let mut roots = Vec::new();
    if let Some(roaming) = dirs::config_dir() {
        roots.push(roaming.join("Claude/claude-code"));
    }
    if let Some(local) = dirs::data_local_dir() {
        for pkg in std::fs::read_dir(local.join("Packages")).into_iter().flatten().flatten() {
            if pkg.file_name().to_string_lossy().starts_with("Claude") {
                roots.push(pkg.path().join("LocalCache/Roaming/Claude/claude-code"));
            }
        }
    }
    let mut found: Vec<(Vec<u64>, PathBuf)> = Vec::new();
    for root in roots {
        for version in std::fs::read_dir(&root).into_iter().flatten().flatten() {
            let vdir = version.path();
            let key = version.file_name().to_string_lossy().split('.').filter_map(|x| x.parse().ok()).collect();
            let direct = vdir.join(exe);
            if direct.exists() {
                found.push((key, direct));
                continue;
            }
            // A hash folder without `.verified` may be an unfinished download.
            let hashed: Vec<PathBuf> = std::fs::read_dir(&vdir)
                .into_iter()
                .flatten()
                .flatten()
                .map(|h| h.path())
                .filter(|h| h.join(exe).exists())
                .collect();
            if let Some(pick) = hashed.iter().find(|h| h.join(".verified").exists()).or(hashed.first()) {
                found.push((key, pick.join(exe)));
            }
        }
    }
    found.sort_by(|a, b| b.0.cmp(&a.0));
    found.into_iter().next().map(|(_, p)| p)
}

/// Temporary MCP config file, removed when dropped.
struct McpConfig(PathBuf);

impl McpConfig {
    fn write(connection_id: &str) -> AppResult<Self> {
        // The MCP server is this executable in `--mcp` mode. Tests run from a test
        // harness binary, so they point at the built app via QUERYLENS_MCP_EXE.
        let exe = match std::env::var_os("QUERYLENS_MCP_EXE") {
            Some(p) => PathBuf::from(p),
            None => std::env::current_exe()?,
        };
        let mut env = serde_json::Map::new();
        if let Ok(dir) = std::env::var(paths::DATA_DIR_ENV) {
            env.insert(paths::DATA_DIR_ENV.into(), dir.into());
        }
        let config = json!({
            "mcpServers": {
                MCP_SERVER_NAME: {
                    "type": "stdio",
                    "command": exe,
                    "args": ["--mcp", "--connection", connection_id],
                    "env": env,
                }
            }
        });
        let path = paths::runtime_dir()?.join(format!("mcp-{}.json", uuid::Uuid::new_v4()));
        std::fs::write(&path, serde_json::to_vec_pretty(&config)?)?;
        Ok(Self(path))
    }
}

impl Drop for McpConfig {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn tool_activity(name: &str, input: &Value) -> (String, Option<String>) {
    let short = name.rsplit("__").next().unwrap_or(name);
    match short {
        "explain_query" => {
            let label = if input.get("setup_sql").and_then(Value::as_str).is_some_and(|s| !s.is_empty()) {
                "Testing a fix with EXPLAIN"
            } else {
                "Running EXPLAIN on a candidate query"
            };
            let mut detail = String::new();
            if let Some(setup) = input.get("setup_sql").and_then(Value::as_str) {
                detail.push_str(setup.trim());
                detail.push_str("\n\n");
            }
            if let Some(sql) = input.get("sql").and_then(Value::as_str) {
                detail.push_str(sql.trim());
            }
            (label.into(), (!detail.is_empty()).then_some(detail))
        }
        "test_index" => {
            let ddl: Vec<&str> = input
                .get("indexes")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(Value::as_str).collect())
                .unwrap_or_default();
            ("Testing candidate index".into(), (!ddl.is_empty()).then(|| ddl.join("\n")))
        }
        "table_info" => {
            let table = input.get("table").and_then(Value::as_str).unwrap_or("table");
            (format!("Inspecting {table}"), None)
        }
        other => (format!("Calling {other}"), None),
    }
}

#[async_trait]
impl LlmProvider for ClaudeCli {
    fn label(&self) -> String {
        "Claude Code".into()
    }

    fn model(&self) -> String {
        if self.model.is_empty() { "default".into() } else { self.model.clone() }
    }

    async fn stream(&self, req: &LlmRequest, sink: &dyn EventSink) -> AppResult<LlmOutput> {
        let workdir = paths::runtime_dir()?.join("claude");
        std::fs::create_dir_all(&workdir)?;

        let mut cmd = tokio::process::Command::new(&self.binary);
        cmd.args(["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages"])
            .args(["--no-session-persistence", "--system-prompt", &req.system]);
        if !self.model.is_empty() {
            cmd.args(["--model", &self.model]);
        }
        let _mcp_guard = match &req.tools_connection_id {
            Some(id) => {
                let cfg = McpConfig::write(id)?;
                cmd.arg("--mcp-config").arg(&cfg.0).arg("--strict-mcp-config");
                cmd.args(["--allowedTools", ALLOWED_TOOLS, "--permission-mode", "dontAsk"]);
                Some(cfg)
            }
            None => None,
        };
        // No built-in tools (Bash, file edits…): Claude can only use QueryLens's MCP tools.
        cmd.args(["--tools", ""]);
        cmd.current_dir(&workdir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(windows)]
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW

        let mut child = cmd.spawn().map_err(|e| {
            AppError::llm(format!("Couldn't start Claude Code ({}): {e}", display(&self.binary)))
        })?;

        let mut stdin = child.stdin.take().ok_or_else(|| AppError::internal("no stdin"))?;
        stdin.write_all(req.user.as_bytes()).await?;
        drop(stdin);

        let mut stderr = child.stderr.take().ok_or_else(|| AppError::internal("no stderr"))?;
        let stderr_task = tokio::spawn(async move {
            let mut s = String::new();
            let _ = stderr.read_to_string(&mut s).await;
            s
        });

        let stdout = child.stdout.take().ok_or_else(|| AppError::internal("no stdout"))?;
        let mut lines = BufReader::new(stdout).lines();
        let mut final_text: Option<String> = None;
        let mut failure: Option<String> = None;
        let mut tool_calls = 0u32;

        while let Some(line) = lines.next_line().await? {
            let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
            match v.get("type").and_then(Value::as_str) {
                Some("system") if v.get("subtype").and_then(Value::as_str) == Some("init") => {
                    let model = v.get("model").and_then(Value::as_str).map(String::from);
                    sink.emit(SuggestionEvent::Activity { label: "Claude Code session started".into(), detail: model });
                }
                Some("stream_event") => {
                    let ev = &v["event"];
                    if ev["type"] == "content_block_delta" && ev["delta"]["type"] == "text_delta" {
                        if let Some(t) = ev["delta"]["text"].as_str() {
                            sink.emit(SuggestionEvent::Delta { text: t.to_string() });
                        }
                    }
                }
                Some("assistant") => {
                    for block in v.pointer("/message/content").and_then(Value::as_array).into_iter().flatten() {
                        if block["type"] == "tool_use" {
                            tool_calls += 1;
                            let name = block["name"].as_str().unwrap_or("tool");
                            let (label, detail) = tool_activity(name, &block["input"]);
                            sink.emit(SuggestionEvent::Activity { label, detail });
                        }
                    }
                }
                Some("result") => {
                    let text = v.get("result").and_then(Value::as_str).unwrap_or_default().to_string();
                    if v.get("is_error").and_then(Value::as_bool).unwrap_or(false) {
                        failure = Some(if text.is_empty() {
                            v.get("subtype").and_then(Value::as_str).unwrap_or("error").to_string()
                        } else {
                            text
                        });
                    } else {
                        final_text = Some(text);
                    }
                }
                _ => {}
            }
        }

        let status = child.wait().await?;
        let stderr_text = stderr_task.await.unwrap_or_default();
        if let Some(msg) = failure {
            return Err(AppError::llm(format!("Claude Code: {msg}")));
        }
        match final_text {
            Some(text) => Ok(LlmOutput { text, tool_calls }),
            None => {
                let hint = stderr_text.trim();
                Err(AppError::llm(format!(
                    "Claude Code exited ({status}) without a result.{}",
                    if hint.is_empty() { String::new() } else { format!("\n{hint}") }
                )))
            }
        }
    }
}

fn display(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    #[test]
    fn finds_some_claude_binary_if_installed() {
        if let Ok(p) = super::resolve_binary("") {
            println!("resolved claude: {}", p.display());
            assert!(p.exists());
        }
    }
}
