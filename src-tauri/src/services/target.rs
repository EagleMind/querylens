//! The database an operation runs against: a saved connection, or a connection URL
//! (CLI and CI use, where nothing is saved and the password comes from the URL).

use crate::engines::ConnectSpec;
use crate::error::{AppError, AppResult};
use crate::model::{Connection, Engine, SslMode};
use crate::storage::Store;

use super::analysis::spec_for;

#[derive(Debug, Clone)]
pub struct Target {
    pub conn: Connection,
    pub spec: ConnectSpec,
}

impl Target {
    /// A saved connection by id, or else by (case-insensitive) name.
    pub fn saved(store: &Store, id_or_name: &str) -> AppResult<Self> {
        let conn = match store.get_connection(id_or_name) {
            Ok(c) => c,
            Err(_) => store
                .list_connections()?
                .into_iter()
                .find(|c| c.name.eq_ignore_ascii_case(id_or_name))
                .ok_or_else(|| AppError::not_found(format!("No saved connection with id or name “{id_or_name}”")))?,
        };
        let spec = spec_for(&conn)?;
        Ok(Self { conn, spec })
    }

    /// `postgres://user:password@host:port/database?sslmode=disable` (also
    /// `postgresql://`, `mysql://`, `mongodb://`).
    pub fn from_url(raw: &str) -> AppResult<Self> {
        let url = url::Url::parse(raw.trim()).map_err(|e| AppError::validation(format!("Invalid database URL: {e}")))?;
        let (engine, default_port) = match url.scheme() {
            "postgres" | "postgresql" => (Engine::Postgres, 5432),
            "mysql" => (Engine::Mysql, 3306),
            "mongodb" => (Engine::Mongodb, 27017),
            other => return Err(AppError::validation(format!("Unsupported database URL scheme “{other}://”"))),
        };
        let decode = |s: &str| percent_encoding::percent_decode_str(s).decode_utf8_lossy().into_owned();
        let host = url.host_str().filter(|h| !h.is_empty()).unwrap_or("localhost").trim_matches(['[', ']']).to_string();
        let port = url.port().unwrap_or(default_port);
        let database = url.path().trim_start_matches('/');
        let username = (!url.username().is_empty()).then(|| decode(url.username()));
        let password = url.password().map(decode);
        let ssl_mode = url
            .query_pairs()
            .find(|(k, _)| k == "sslmode" || k == "ssl")
            .map(|(_, v)| match v.as_ref() {
                "disable" | "false" | "0" => SslMode::Disable,
                "require" | "verify-ca" | "verify-full" | "true" | "1" => SslMode::Require,
                _ => SslMode::Prefer,
            })
            .unwrap_or(SslMode::Prefer);
        let database = (!database.is_empty()).then(|| decode(database));
        let name = format!("{}@{host}:{port}", database.as_deref().unwrap_or(engine.as_str()));
        let conn = Connection {
            id: format!("url:{name}"),
            name,
            engine,
            color: String::new(),
            host: Some(host.clone()),
            port: Some(port),
            database: database.clone(),
            username: username.clone(),
            ssl_mode,
            file_path: None,
            has_password: password.is_some(),
            created_at: crate::storage::now(),
            last_used_at: None,
        };
        let spec = ConnectSpec {
            engine,
            host: Some(host),
            port: Some(port),
            database,
            username,
            password,
            ssl_mode,
            file_path: None,
        };
        Ok(Self { conn, spec })
    }

    /// A saved connection id/name or a URL, whichever `s` is.
    pub fn resolve(store: &Store, s: &str) -> AppResult<Self> {
        if s.contains("://") { Self::from_url(s) } else { Self::saved(store, s) }
    }

    pub fn host(&self) -> &str {
        self.spec.host.as_deref().unwrap_or("localhost")
    }

    pub fn port(&self) -> u16 {
        self.spec.port.unwrap_or(5432)
    }

    /// The same database reached through `host:port` instead (the capture proxy).
    /// TLS is disabled: the proxy talks plain TCP to the app and encrypts upstream.
    pub fn url_via(&self, host: &str, port: u16) -> String {
        let mut url = url::Url::parse("postgres://placeholder").expect("static URL");
        let _ = url.set_host(Some(host));
        let _ = url.set_port(Some(port));
        if let Some(user) = &self.spec.username {
            let _ = url.set_username(user);
        }
        if let Some(pw) = &self.spec.password {
            let _ = url.set_password(Some(pw));
        }
        url.set_path(self.spec.database.as_deref().unwrap_or(""));
        url.set_query(Some("sslmode=disable"));
        url.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_urls_and_rewrites_through_the_proxy() {
        let t = Target::from_url("postgres://app:p%40ss@db.internal:6432/shop?sslmode=require").unwrap();
        assert_eq!((t.host(), t.port()), ("db.internal", 6432));
        assert_eq!(t.spec.password.as_deref(), Some("p@ss"));
        assert_eq!(t.spec.ssl_mode, SslMode::Require);
        assert_eq!(t.conn.name, "shop@db.internal:6432");
        assert_eq!(t.url_via("127.0.0.1", 6543), "postgres://app:p%40ss@127.0.0.1:6543/shop?sslmode=disable");

        let local = Target::from_url("postgresql://localhost/dev").unwrap();
        assert_eq!(local.port(), 5432);
        assert_eq!(local.spec.ssl_mode, SslMode::Prefer);
        assert!(Target::from_url("redis://x").is_err());
    }
}
