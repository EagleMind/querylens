//! Finding the project's database without being told: the environment, `.env`
//! files, then ORM config files. Each source also says which variables the app
//! reads, so the capture can point exactly those at the proxy.

use std::collections::HashMap;
use std::path::Path;

/// Which environment the command runs in: picks `.env.test` vs `.env.development`
/// and the matching section of an ORM config.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Profile {
    Development,
    Test,
}

impl Profile {
    fn name(self) -> &'static str {
        match self {
            Profile::Development => "development",
            Profile::Test => "test",
        }
    }
    fn env_files(self) -> &'static [&'static str] {
        match self {
            Profile::Development => &[".env.development.local", ".env.local", ".env.development", ".env"],
            Profile::Test => &[".env.test.local", ".env.test", ".env"],
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Discovered {
    pub url: String,
    /// Shown to the user: where the URL came from.
    pub source: String,
    /// Variables to override for the command, with {url} / {host} / {port} placeholders.
    pub overrides: Vec<(String, String)>,
}

const URL_KEYS: &[&str] = &["DATABASE_URL", "POSTGRES_URL", "POSTGRESQL_URL", "PG_URL", "DB_URL"];
const HOST_KEYS: &[&str] = &["PGHOST", "DB_HOST", "POSTGRES_HOST", "DATABASE_HOST"];
const PORT_KEYS: &[&str] = &["PGPORT", "DB_PORT", "POSTGRES_PORT", "DATABASE_PORT"];
const USER_KEYS: &[&str] = &["PGUSER", "DB_USER", "DB_USERNAME", "POSTGRES_USER", "DATABASE_USER"];
const PASSWORD_KEYS: &[&str] = &["PGPASSWORD", "DB_PASSWORD", "DB_PASS", "POSTGRES_PASSWORD", "DATABASE_PASSWORD"];
const NAME_KEYS: &[&str] = &["PGDATABASE", "DB_NAME", "DB_DATABASE", "POSTGRES_DB", "DATABASE_NAME"];

/// `env` reads the process environment (a parameter so tests control it).
pub fn discover(dir: &Path, profile: Profile, env: &dyn Fn(&str) -> Option<String>) -> Option<Discovered> {
    let process: HashMap<String, String> =
        URL_KEYS.iter().chain(HOST_KEYS).chain(PORT_KEYS).chain(USER_KEYS).chain(PASSWORD_KEYS).chain(NAME_KEYS)
            .filter_map(|k| env(k).filter(|v| !v.trim().is_empty()).map(|v| (k.to_string(), v)))
            .collect();
    if let Some(found) = from_vars(&process, "the environment") {
        return Some(found);
    }
    for file in profile.env_files() {
        if let Ok(text) = std::fs::read_to_string(dir.join(file)) {
            let vars = parse_dotenv(&text, env);
            if let Some(found) = from_vars(&vars, file) {
                return Some(found);
            }
        }
    }
    sequelize_config(dir, profile, env)
}

/// A URL variable, or host/port/user/password/database variables.
fn from_vars(vars: &HashMap<String, String>, origin: &str) -> Option<Discovered> {
    for key in URL_KEYS {
        if let Some(url) = vars.get(*key).filter(|u| is_postgres_url(u)) {
            return Some(Discovered {
                url: url.clone(),
                source: format!("{key} in {origin}"),
                overrides: vec![(key.to_string(), "{url}".into())],
            });
        }
    }
    let pick = |keys: &[&str]| keys.iter().find_map(|k| vars.get(*k).map(|v| (k.to_string(), v.clone())));
    let host = pick(HOST_KEYS);
    let database = pick(NAME_KEYS);
    if host.is_none() && database.is_none() {
        return None;
    }
    let port = pick(PORT_KEYS);
    let url = build_url(
        host.as_ref().map(|h| h.1.as_str()),
        port.as_ref().and_then(|p| p.1.parse().ok()),
        pick(USER_KEYS).map(|u| u.1).as_deref(),
        pick(PASSWORD_KEYS).map(|p| p.1).as_deref(),
        database.as_ref().map(|d| d.1.as_str()),
    )?;
    let mut overrides = vec![(host.map(|h| h.0).unwrap_or_else(|| "PGHOST".into()), "{host}".into())];
    overrides.push((port.map(|p| p.0).unwrap_or_else(|| "PGPORT".into()), "{port}".into()));
    Some(Discovered { url, source: format!("database variables in {origin}"), overrides })
}

fn is_postgres_url(u: &str) -> bool {
    u.starts_with("postgres://") || u.starts_with("postgresql://")
}

fn build_url(host: Option<&str>, port: Option<u16>, user: Option<&str>, password: Option<&str>, db: Option<&str>) -> Option<String> {
    let mut url = url::Url::parse("postgres://localhost").ok()?;
    url.set_host(Some(host.unwrap_or("localhost"))).ok()?;
    url.set_port(Some(port.unwrap_or(5432))).ok()?;
    if let Some(u) = user {
        url.set_username(u).ok()?;
    }
    if let Some(p) = password.filter(|p| !p.is_empty()) {
        url.set_password(Some(p)).ok()?;
    }
    url.set_path(db.unwrap_or(""));
    Some(url.to_string())
}

/// sequelize-cli's `config/config.json` (or `config/database.json`).
fn sequelize_config(dir: &Path, profile: Profile, env: &dyn Fn(&str) -> Option<String>) -> Option<Discovered> {
    let section = env("NODE_ENV").unwrap_or_else(|| profile.name().to_string());
    for file in ["config/config.json", "config/database.json"] {
        let Ok(text) = std::fs::read_to_string(dir.join(file)) else { continue };
        let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) else { continue };
        let Some(cfg) = json.get(&section).or_else(|| json.get("development")) else { continue };
        let s = |k: &str| cfg.get(k).and_then(|v| v.as_str().map(String::from).or_else(|| v.as_u64().map(|n| n.to_string())));
        if s("dialect").is_some_and(|d| d != "postgres") {
            continue;
        }
        let source = format!("{file} ({section})");
        if let Some(var) = s("use_env_variable") {
            // The URL lives in an environment variable, maybe in a .env file.
            let mut value = env(&var);
            for f in profile.env_files() {
                if value.is_some() {
                    break;
                }
                value = std::fs::read_to_string(dir.join(f)).ok().and_then(|t| parse_dotenv(&t, env).remove(&var));
            }
            if let Some(url) = value.filter(|u| is_postgres_url(u)) {
                return Some(Discovered { url, source, overrides: vec![(var, "{url}".into())] });
            }
            continue;
        }
        let url = build_url(
            s("host").as_deref(),
            s("port").and_then(|p| p.parse().ok()),
            s("username").as_deref(),
            s("password").as_deref(),
            s("database").as_deref(),
        )?;
        // The app reads this file, not the environment: the SDK records it in-process.
        return Some(Discovered { url, source, overrides: Vec::new() });
    }
    None
}

/// `KEY=value` lines, with `export`, quotes, comments and `${VAR}` expansion.
pub fn parse_dotenv(text: &str, env: &dyn Fn(&str) -> Option<String>) -> HashMap<String, String> {
    let mut vars: HashMap<String, String> = HashMap::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line.strip_prefix("export ").unwrap_or(line);
        let Some((key, raw)) = line.split_once('=') else { continue };
        let key = key.trim();
        let raw = raw.trim();
        let value = if let Some(v) = raw.strip_prefix('\'').and_then(|r| r.split_once('\'')) {
            v.0.to_string()
        } else if let Some(v) = raw.strip_prefix('"').and_then(|r| r.split_once('"')) {
            expand(&v.0.replace("\\n", "\n"), &vars, env)
        } else {
            let unquoted = raw.split(" #").next().unwrap_or(raw).trim();
            expand(unquoted, &vars, env)
        };
        vars.insert(key.to_string(), value);
    }
    vars
}

/// `${VAR}` and `$VAR` from earlier lines, then the environment.
fn expand(value: &str, vars: &HashMap<String, String>, env: &dyn Fn(&str) -> Option<String>) -> String {
    let mut out = String::with_capacity(value.len());
    let mut rest = value;
    while let Some(i) = rest.find('$') {
        out.push_str(&rest[..i]);
        let after = &rest[i + 1..];
        let (name, consumed) = if let Some(braced) = after.strip_prefix('{') {
            match braced.find('}') {
                Some(end) => (&braced[..end], end + 2),
                None => ("", 0),
            }
        } else {
            let end = after.find(|c: char| !(c.is_ascii_alphanumeric() || c == '_')).unwrap_or(after.len());
            (&after[..end], end)
        };
        if name.is_empty() {
            out.push('$');
            rest = after;
            continue;
        }
        out.push_str(&vars.get(name).cloned().or_else(|| env(name)).unwrap_or_default());
        rest = &after[consumed..];
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn no_env(_: &str) -> Option<String> {
        None
    }

    fn project(files: &[(&str, &str)]) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("ql-discover-{}", uuid::Uuid::new_v4()));
        for (name, content) in files {
            let path = dir.join(name);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, content).unwrap();
        }
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn dotenv_parsing() {
        let text = "# comment\nexport DB_USER=app\nDB_PASSWORD='p#ss'\nDATABASE_URL=\"postgres://${DB_USER}:x@db/shop\" \nNAME=value # trailing\n";
        let v = parse_dotenv(text, &no_env);
        assert_eq!(v["DB_PASSWORD"], "p#ss");
        assert_eq!(v["DATABASE_URL"], "postgres://app:x@db/shop");
        assert_eq!(v["NAME"], "value");
    }

    #[test]
    fn environment_wins_then_env_files_by_profile() {
        let dir = project(&[
            (".env", "DATABASE_URL=postgres://dev@localhost/dev"),
            (".env.test", "DATABASE_URL=postgres://test@localhost/test"),
        ]);
        let dev = discover(&dir, Profile::Development, &no_env).unwrap();
        assert_eq!((dev.url.as_str(), dev.source.as_str()), ("postgres://dev@localhost/dev", "DATABASE_URL in .env"));
        assert_eq!(discover(&dir, Profile::Test, &no_env).unwrap().url, "postgres://test@localhost/test");
        let env = |k: &str| (k == "DATABASE_URL").then(|| "postgres://ci@pg/ci".to_string());
        assert_eq!(discover(&dir, Profile::Test, &env).unwrap().source, "DATABASE_URL in the environment");
    }

    #[test]
    fn separate_variables_become_a_url_and_overrides() {
        let dir = project(&[(".env", "DB_HOST=127.0.0.1\nDB_PORT=54329\nDB_USER=app\nDB_PASSWORD=secret\nDB_NAME=shop\n")]);
        let d = discover(&dir, Profile::Development, &no_env).unwrap();
        assert_eq!(d.url, "postgres://app:secret@127.0.0.1:54329/shop");
        assert_eq!(d.overrides, [("DB_HOST".into(), "{host}".into()), ("DB_PORT".into(), "{port}".into())]);
    }

    #[test]
    fn sequelize_cli_config() {
        let config = r#"{
            "development": { "username": "app", "password": null, "database": "shop_dev", "host": "localhost", "port": 5433, "dialect": "postgres" },
            "test": { "use_env_variable": "TEST_DB_URL", "dialect": "postgres" },
            "production": { "dialect": "mysql" }
        }"#;
        let dir = project(&[("config/config.json", config), (".env.test", "TEST_DB_URL=postgres://t@localhost/shop_test")]);
        let dev = discover(&dir, Profile::Development, &no_env).unwrap();
        assert_eq!(dev.url, "postgres://app@localhost:5433/shop_dev");
        assert_eq!(dev.source, "config/config.json (development)");
        assert!(dev.overrides.is_empty());
        let test = discover(&dir, Profile::Test, &no_env).unwrap();
        assert_eq!(test.url, "postgres://t@localhost/shop_test");
        assert_eq!(test.overrides, [("TEST_DB_URL".into(), "{url}".into())]);
        let prod = |k: &str| (k == "NODE_ENV").then(|| "production".to_string());
        assert!(discover(&dir, Profile::Development, &prod).is_none(), "MySQL config is skipped");
    }
}
