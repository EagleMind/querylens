use rusqlite::{OptionalExtension, params};

use super::Store;
use crate::error::AppResult;
use crate::model::Settings;

const KEY: &str = "app";

impl Store {
    /// Stored settings, or defaults. `llm.has_api_key` is filled in by the caller.
    pub fn get_settings(&self) -> AppResult<Settings> {
        let json: Option<String> = self.with(|db| {
            Ok(db
                .query_row("SELECT value_json FROM settings WHERE key = ?1", [KEY], |r| r.get(0))
                .optional()?)
        })?;
        // A settings blob from an older/newer build must never brick the app.
        Ok(json.and_then(|j| serde_json::from_str(&j).ok()).unwrap_or_default())
    }

    pub fn save_settings(&self, settings: &Settings) -> AppResult<()> {
        let json = serde_json::to_string(settings)?;
        self.with(|db| {
            db.execute(
                "INSERT INTO settings (key, value_json) VALUES (?1, ?2)
                 ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json",
                params![KEY, json],
            )?;
            Ok(())
        })
    }
}
