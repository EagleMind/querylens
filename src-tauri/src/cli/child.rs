//! Running the user's command while capturing: Node.js processes get the QueryLens
//! SDK preloaded (reporting through the spool directory), and when there is a proxy,
//! the variables the app reads its database from point at it.

use std::path::Path;
use std::process::ExitStatus;

use crate::capture::node_hook;
use crate::error::{AppError, AppResult};

pub struct ChildSpec<'a> {
    pub command: &'a [String],
    /// Proxy URL, when the database is known.
    pub app_url: Option<&'a str>,
    pub proxy_host: &'a str,
    pub proxy_port: u16,
    /// Variables to set, with {url}, {host} and {port} standing for the proxy.
    pub overrides: &'a [(String, String)],
    /// QUERYLENS_SPOOL: where the SDK writes its events.
    pub spool: Option<&'a Path>,
    /// Preload the SDK into Node.js processes.
    pub sdk: bool,
}

/// `KEY=VALUE` from `--set`.
pub fn parse_set(item: &str) -> AppResult<(String, String)> {
    item.split_once('=')
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .ok_or_else(|| AppError::validation(format!("--set expects KEY=VALUE, got “{item}”")))
}

/// Environment changes for the command, in order.
pub fn environment(spec: &ChildSpec, sdk_path: Option<&Path>) -> Vec<(String, String)> {
    let mut env = Vec::new();
    if let Some(app_url) = spec.app_url {
        let fill = |template: &str| {
            template
                .replace("{url}", app_url)
                .replace("{host}", spec.proxy_host)
                .replace("{port}", &spec.proxy_port.to_string())
        };
        env.push(("DATABASE_URL".to_string(), app_url.to_string()));
        // libpq-style variables, for apps configured through them.
        if std::env::var_os("PGHOST").is_some() || std::env::var_os("PGPORT").is_some() {
            env.push(("PGHOST".into(), spec.proxy_host.to_string()));
            env.push(("PGPORT".into(), spec.proxy_port.to_string()));
            env.push(("PGSSLMODE".into(), "disable".into()));
        }
        for (key, template) in spec.overrides {
            env.retain(|(k, _)| k != key);
            env.push((key.clone(), fill(template)));
        }
    }
    if let Some(sdk) = sdk_path {
        let existing = std::env::var("NODE_OPTIONS").unwrap_or_default();
        env.push(("NODE_OPTIONS".into(), node_hook::node_options(&existing, sdk)));
    }
    if let Some(dir) = spec.spool {
        env.push(("QUERYLENS_SPOOL".into(), dir.display().to_string()));
    }
    env.push(("QUERYLENS_CAPTURE".into(), "1".into()));
    env
}

/// Run the command to completion with the capture environment.
pub async fn run(spec: &ChildSpec<'_>) -> AppResult<ExitStatus> {
    let (program, args) = spec.command.split_first().ok_or_else(|| AppError::validation("No command given"))?;
    let sdk = if spec.sdk { Some(node_hook::install()?) } else { None };
    // Resolve through PATH (and PATHEXT on Windows, so `npm` finds npm.cmd).
    let resolved = which::which(program).map_err(|_| AppError::validation(format!("Command not found: {program}")))?;
    let mut cmd = tokio::process::Command::new(resolved);
    cmd.args(args);
    for (k, v) in environment(spec, sdk.as_deref()) {
        cmd.env(k, v);
    }
    let mut child = cmd.spawn().map_err(|e| AppError::internal(format!("Couldn't start {program}: {e}")))?;
    Ok(child.wait().await?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn environment_reaches_the_sdk_and_the_proxy() {
        let command = vec!["npm".to_string(), "test".to_string()];
        let overrides = vec![
            ("TEST_DATABASE_URL".to_string(), "{url}".to_string()),
            ("DB_PORT".to_string(), "{port}".to_string()),
            ("DB_HOST".to_string(), "{host}".to_string()),
        ];
        let spool = Path::new("/tmp/spool");
        let spec = ChildSpec {
            command: &command,
            app_url: Some("postgres://app@127.0.0.1:6543/shop?sslmode=disable"),
            proxy_host: "127.0.0.1",
            proxy_port: 6543,
            overrides: &overrides,
            spool: Some(spool),
            sdk: true,
        };
        let env = environment(&spec, Some(Path::new("/tmp/register.cjs")));
        let get = |k: &str| env.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str());
        assert_eq!(get("DATABASE_URL"), spec.app_url);
        assert_eq!(get("TEST_DATABASE_URL"), spec.app_url);
        assert_eq!(get("DB_PORT"), Some("6543"));
        assert_eq!(get("DB_HOST"), Some("127.0.0.1"));
        assert_eq!(get("QUERYLENS_SPOOL"), Some(spool.display().to_string().as_str()));
        assert!(get("NODE_OPTIONS").unwrap().ends_with("--require \"/tmp/register.cjs\""));

        // Without a known database there is no proxy: nothing database-related is set.
        let sdk_only = environment(&ChildSpec { app_url: None, ..spec }, None);
        assert!(sdk_only.iter().all(|(k, _)| k != "DATABASE_URL" && k != "DB_PORT"));
        assert!(parse_set("oops").is_err());
    }
}
