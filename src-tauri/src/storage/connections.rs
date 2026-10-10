use rusqlite::{OptionalExtension, Row, params};

use super::{Store, now};
use crate::error::{AppError, AppResult};
use crate::model::{Connection, ConnectionInput, Engine, SslMode};

const COLUMNS: &str = "id, name, engine, color, host, port, database, username, ssl_mode, \
                       file_path, has_password, created_at, last_used_at";

fn from_row(r: &Row) -> rusqlite::Result<Connection> {
    let engine: String = r.get(2)?;
    let ssl: String = r.get(8)?;
    Ok(Connection {
        id: r.get(0)?,
        name: r.get(1)?,
        engine: Engine::parse(&engine).unwrap_or(Engine::Postgres),
        color: r.get(3)?,
        host: r.get(4)?,
        port: r.get(5)?,
        database: r.get(6)?,
        username: r.get(7)?,
        ssl_mode: SslMode::parse(&ssl),
        file_path: r.get(9)?,
        has_password: r.get(10)?,
        created_at: r.get(11)?,
        last_used_at: r.get(12)?,
    })
}

impl Store {
    pub fn list_connections(&self) -> AppResult<Vec<Connection>> {
        self.with(|db| {
            let mut stmt = db.prepare(&format!(
                "SELECT {COLUMNS} FROM connections ORDER BY name COLLATE NOCASE"
            ))?;
            let rows = stmt.query_map([], from_row)?.collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
    }

    pub fn get_connection(&self, id: &str) -> AppResult<Connection> {
        self.with(|db| {
            db.query_row(&format!("SELECT {COLUMNS} FROM connections WHERE id = ?1"), [id], from_row)
                .optional()?
                .ok_or_else(|| AppError::not_found("Connection not found"))
        })
    }

    /// Insert or update. `has_password` is passed explicitly because the caller owns
    /// the keychain write.
    pub fn upsert_connection(
        &self,
        id: &str,
        input: &ConnectionInput,
        has_password: bool,
    ) -> AppResult<Connection> {
        self.with(|db| {
            db.execute(
                "INSERT INTO connections (id, name, engine, color, host, port, database, username,
                                          ssl_mode, file_path, has_password, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
                 ON CONFLICT (id) DO UPDATE SET
                    name = excluded.name, engine = excluded.engine, color = excluded.color,
                    host = excluded.host, port = excluded.port, database = excluded.database,
                    username = excluded.username, ssl_mode = excluded.ssl_mode,
                    file_path = excluded.file_path, has_password = excluded.has_password",
                params![
                    id,
                    input.name.trim(),
                    input.engine.as_str(),
                    input.color,
                    input.host,
                    input.port,
                    input.database,
                    input.username,
                    input.ssl_mode.as_str(),
                    input.file_path,
                    has_password,
                    now(),
                ],
            )?;
            Ok(())
        })?;
        self.get_connection(id)
    }

    pub fn delete_connection(&self, id: &str) -> AppResult<()> {
        self.with(|db| {
            db.execute("DELETE FROM connections WHERE id = ?1", [id])?;
            Ok(())
        })
    }

    pub fn touch_connection(&self, id: &str) -> AppResult<()> {
        self.with(|db| {
            db.execute("UPDATE connections SET last_used_at = ?2 WHERE id = ?1", params![id, now()])?;
            Ok(())
        })
    }
}
