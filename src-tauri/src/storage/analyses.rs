use rusqlite::{OptionalExtension, params};

use super::Store;
use crate::error::{AppError, AppResult};
use crate::model::{AnalysisResult, Engine, ExplainMode, HistoryEntry, SuggestionSet, WhatIfReport};

pub struct PreviousRun {
    pub id: String,
    pub created_at: String,
    pub plan_fp: String,
    pub mode: ExplainMode,
    pub execution_time_ms: Option<f64>,
}

/// History is a scratchpad, not an archive.
const HISTORY_CAP: u32 = 200;

impl Store {
    pub fn insert_analysis(&self, a: &AnalysisResult) -> AppResult<()> {
        let json = serde_json::to_string(a)?;
        self.with(|db| {
            let tx = db.transaction()?;
            tx.execute(
                "INSERT INTO analyses (id, connection_id, connection_name, engine, mode, sql,
                                       execution_time_ms, total_cost, warnings_count, result_json,
                                       created_at, query_fp, plan_fp)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
                params![
                    a.id,
                    a.connection_id,
                    a.connection_name,
                    a.engine.as_str(),
                    a.mode.as_str(),
                    a.sql,
                    a.execution_time_ms,
                    a.total_cost,
                    a.warnings_count,
                    json,
                    a.analyzed_at,
                    a.query_fp,
                    a.plan_fp,
                ],
            )?;
            tx.execute(
                "DELETE FROM analyses WHERE id NOT IN
                    (SELECT id FROM analyses ORDER BY created_at DESC LIMIT ?1)",
                [HISTORY_CAP],
            )?;
            tx.commit()?;
            Ok(())
        })
    }

    /// The most recent earlier analysis of the same statement on the same connection.
    pub fn previous_analysis(&self, connection_id: &str, query_fp: &str) -> AppResult<Option<PreviousRun>> {
        self.with(|db| {
            Ok(db
                .query_row(
                    "SELECT id, created_at, plan_fp, mode, execution_time_ms FROM analyses
                     WHERE connection_id = ?1 AND query_fp = ?2
                     ORDER BY created_at DESC LIMIT 1",
                    params![connection_id, query_fp],
                    |r| {
                        Ok(PreviousRun {
                            id: r.get(0)?,
                            created_at: r.get(1)?,
                            plan_fp: r.get::<_, Option<String>>(2)?.unwrap_or_default(),
                            mode: ExplainMode::parse(&r.get::<_, String>(3)?),
                            execution_time_ms: r.get(4)?,
                        })
                    },
                )
                .optional()?)
        })
    }

    pub fn get_analysis(&self, id: &str) -> AppResult<AnalysisResult> {
        let (result, suggestions, whatif): (String, Option<String>, Option<String>) = self.with(|db| {
            db.query_row(
                "SELECT result_json, suggestions_json, whatif_json FROM analyses WHERE id = ?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?
            .ok_or_else(|| AppError::not_found("Analysis not found in history"))
        })?;
        let mut analysis: AnalysisResult = serde_json::from_str(&result)?;
        analysis.suggestions = suggestions.map(|s| serde_json::from_str(&s)).transpose()?;
        // A report from an incompatible older build is simply dropped.
        analysis.whatif = whatif.and_then(|w| serde_json::from_str(&w).ok());
        Ok(analysis)
    }

    pub fn set_whatif(&self, id: &str, report: &WhatIfReport) -> AppResult<()> {
        let json = serde_json::to_string(report)?;
        self.with(|db| {
            db.execute("UPDATE analyses SET whatif_json = ?2 WHERE id = ?1", params![id, json])?;
            Ok(())
        })
    }

    pub fn set_suggestions(&self, id: &str, set: &SuggestionSet) -> AppResult<()> {
        let json = serde_json::to_string(set)?;
        self.with(|db| {
            db.execute("UPDATE analyses SET suggestions_json = ?2 WHERE id = ?1", params![id, json])?;
            Ok(())
        })
    }

    pub fn list_history(&self, search: Option<&str>, limit: u32) -> AppResult<Vec<HistoryEntry>> {
        let pattern = search.map(str::trim).filter(|s| !s.is_empty()).map(|s| {
            let escaped = s.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
            format!("%{escaped}%")
        });
        self.with(|db| {
            let mut stmt = db.prepare(
                r"SELECT id, connection_id, connection_name, engine, mode, substr(sql, 1, 400),
                         execution_time_ms, total_cost, warnings_count,
                         suggestions_json IS NOT NULL, created_at
                  FROM analyses
                  WHERE ?1 IS NULL
                     OR sql LIKE ?1 ESCAPE '\'
                     OR connection_name LIKE ?1 ESCAPE '\'
                  ORDER BY created_at DESC
                  LIMIT ?2",
            )?;
            let rows = stmt
                .query_map(params![pattern, limit], |r| {
                    let engine: String = r.get(3)?;
                    let mode: String = r.get(4)?;
                    Ok(HistoryEntry {
                        id: r.get(0)?,
                        connection_id: r.get(1)?,
                        connection_name: r.get(2)?,
                        engine: Engine::parse(&engine).unwrap_or(Engine::Postgres),
                        mode: ExplainMode::parse(&mode),
                        sql_preview: r.get(5)?,
                        execution_time_ms: r.get(6)?,
                        total_cost: r.get(7)?,
                        warnings_count: r.get(8)?,
                        has_suggestions: r.get(9)?,
                        created_at: r.get(10)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
    }

    pub fn delete_analysis(&self, id: &str) -> AppResult<()> {
        self.with(|db| {
            db.execute("DELETE FROM analyses WHERE id = ?1", [id])?;
            Ok(())
        })
    }

    pub fn clear_history(&self) -> AppResult<()> {
        self.with(|db| {
            db.execute("DELETE FROM analyses", [])?;
            Ok(())
        })
    }
}
