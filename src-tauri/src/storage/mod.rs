//! Local persistence: a single SQLite file shared by the GUI and the MCP server.

mod analyses;
mod connections;
mod settings;

use std::path::Path;
use std::sync::Mutex;

use rusqlite::Connection as Db;

use crate::error::{AppError, AppResult};

/// Ordered list of migrations; index + 1 is the schema version it produces.
const MIGRATIONS: &[&str] = &[r#"
    CREATE TABLE connections (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL,
        engine        TEXT NOT NULL,
        color         TEXT NOT NULL,
        host          TEXT,
        port          INTEGER,
        database      TEXT,
        username      TEXT,
        ssl_mode      TEXT NOT NULL DEFAULT 'prefer',
        file_path     TEXT,
        has_password  INTEGER NOT NULL DEFAULT 0,
        created_at    TEXT NOT NULL,
        last_used_at  TEXT
    );

    CREATE TABLE analyses (
        id                 TEXT PRIMARY KEY,
        connection_id      TEXT NOT NULL,
        connection_name    TEXT NOT NULL,
        engine             TEXT NOT NULL,
        mode               TEXT NOT NULL,
        sql                TEXT NOT NULL,
        execution_time_ms  REAL,
        total_cost         REAL,
        warnings_count     INTEGER NOT NULL DEFAULT 0,
        result_json        TEXT NOT NULL,
        suggestions_json   TEXT,
        created_at         TEXT NOT NULL
    );
    CREATE INDEX analyses_created_at ON analyses (created_at DESC);

    CREATE TABLE settings (
        key         TEXT PRIMARY KEY,
        value_json  TEXT NOT NULL
    );
"#];

pub struct Store {
    db: Mutex<Db>,
}

impl Store {
    pub fn open(path: &Path) -> AppResult<Self> {
        let db = Db::open(path)?;
        // WAL lets the `--mcp` subprocess read while the GUI writes.
        db.pragma_update(None, "journal_mode", "WAL")?;
        db.busy_timeout(std::time::Duration::from_secs(5))?;
        let store = Self { db: Mutex::new(db) };
        store.migrate()?;
        Ok(store)
    }

    #[cfg(test)]
    pub fn open_in_memory() -> AppResult<Self> {
        let store = Self { db: Mutex::new(Db::open_in_memory()?) };
        store.migrate()?;
        Ok(store)
    }

    fn migrate(&self) -> AppResult<()> {
        self.with(|db| {
            let current: i64 = db.pragma_query_value(None, "user_version", |r| r.get(0))?;
            for (i, sql) in MIGRATIONS.iter().enumerate().skip(current as usize) {
                let tx = db.transaction()?;
                tx.execute_batch(sql)?;
                tx.pragma_update(None, "user_version", (i + 1) as i64)?;
                tx.commit()?;
            }
            Ok(())
        })
    }

    /// Run `f` with exclusive access to the database. Keep closures short and sync.
    pub(crate) fn with<T>(&self, f: impl FnOnce(&mut Db) -> AppResult<T>) -> AppResult<T> {
        let mut db = self.db.lock().map_err(|_| AppError::internal("Storage lock poisoned"))?;
        f(&mut db)
    }
}

pub(crate) fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::*;

    fn input() -> ConnectionInput {
        ConnectionInput {
            id: None,
            name: "local".into(),
            engine: Engine::Postgres,
            color: "#22d3ee".into(),
            host: Some("localhost".into()),
            port: Some(5432),
            database: Some("shop".into()),
            username: Some("me".into()),
            ssl_mode: SslMode::Prefer,
            file_path: None,
            password: None,
        }
    }

    #[test]
    fn connection_roundtrip() {
        let store = Store::open_in_memory().unwrap();
        let saved = store.upsert_connection("c1", &input(), true).unwrap();
        assert_eq!(saved.name, "local");
        assert!(saved.has_password);
        let mut changed = input();
        changed.name = "renamed".into();
        store.upsert_connection("c1", &changed, false).unwrap();
        let all = store.list_connections().unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].name, "renamed");
        assert!(!all[0].has_password);
        store.delete_connection("c1").unwrap();
        assert!(store.get_connection("c1").is_err());
    }

    #[test]
    fn settings_default_and_save() {
        let store = Store::open_in_memory().unwrap();
        let mut s = store.get_settings().unwrap();
        assert_eq!(s.analysis.statement_timeout_ms, 30_000);
        s.analysis.statement_timeout_ms = 5_000;
        store.save_settings(&s).unwrap();
        assert_eq!(store.get_settings().unwrap().analysis.statement_timeout_ms, 5_000);
    }
}
