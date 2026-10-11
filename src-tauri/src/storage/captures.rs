use rusqlite::{OptionalExtension, params};

use super::Store;
use crate::error::{AppError, AppResult};
use crate::model::{CaptureReport, CaptureSource, CaptureSummary, CapturedStatement};

/// Captures are working material: older ones are dropped beyond this many.
const CAPTURE_CAP: u32 = 30;

const SUMMARY_COLUMNS: &str = "c.id, c.name, c.connection_id, c.upstream, c.listen, c.source, c.started_at, c.stopped_at,
     (SELECT COUNT(*) FROM capture_statements s WHERE s.capture_id = c.id),
     (SELECT COALESCE(SUM(duration_ms), 0) FROM capture_statements s WHERE s.capture_id = c.id)";

fn summary(r: &rusqlite::Row) -> rusqlite::Result<CaptureSummary> {
    Ok(CaptureSummary {
        id: r.get(0)?,
        name: r.get(1)?,
        connection_id: r.get(2)?,
        upstream: r.get(3)?,
        listen: r.get(4)?,
        source: CaptureSource::parse(&r.get::<_, String>(5)?),
        started_at: r.get(6)?,
        stopped_at: r.get(7)?,
        statements: r.get(8)?,
        total_ms: r.get(9)?,
    })
}

impl Store {
    pub fn insert_capture(&self, c: &CaptureSummary) -> AppResult<()> {
        self.with(|db| {
            let tx = db.transaction()?;
            tx.execute(
                "INSERT INTO captures (id, name, connection_id, upstream, listen, source, started_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![c.id, c.name, c.connection_id, c.upstream, c.listen, c.source.as_str(), c.started_at],
            )?;
            tx.execute(
                "DELETE FROM captures WHERE id NOT IN (SELECT id FROM captures ORDER BY started_at DESC LIMIT ?1)",
                [CAPTURE_CAP],
            )?;
            tx.commit()?;
            Ok(())
        })
    }

    pub fn finish_capture(&self, id: &str, stopped_at: &str) -> AppResult<()> {
        self.with(|db| {
            db.execute("UPDATE captures SET stopped_at = ?2 WHERE id = ?1", params![id, stopped_at])?;
            Ok(())
        })
    }

    /// Captures still marked running belong to a process that ended without stopping
    /// them (crash, killed CLI). Close them so they read as finished.
    pub fn close_abandoned_captures(&self, keep_running: &[String]) -> AppResult<()> {
        let stamp = super::now();
        self.with(|db| {
            let mut stmt = db.prepare("SELECT id FROM captures WHERE stopped_at IS NULL")?;
            let ids: Vec<String> = stmt.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?;
            for id in ids.iter().filter(|id| !keep_running.contains(id)) {
                db.execute("UPDATE captures SET stopped_at = ?2 WHERE id = ?1", params![id, stamp])?;
            }
            Ok(())
        })
    }

    pub fn insert_captured(&self, capture_id: &str, batch: &[CapturedStatement]) -> AppResult<()> {
        if batch.is_empty() {
            return Ok(());
        }
        self.with(|db| {
            let tx = db.transaction()?;
            {
                let mut stmt = tx.prepare_cached(
                    "INSERT INTO capture_statements (capture_id, seq, conn, at_ms, duration_ms, fingerprint, sql,
                        params_json, rows, bytes, error, unit, origin, route)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
                )?;
                for s in batch {
                    stmt.execute(params![
                        capture_id,
                        s.seq,
                        s.conn,
                        s.at_ms,
                        s.duration_ms,
                        s.fingerprint,
                        s.sql,
                        serde_json::to_string(&s.params)?,
                        s.rows,
                        s.bytes,
                        s.error,
                        s.unit,
                        s.origin,
                        s.route,
                    ])?;
                }
            }
            tx.commit()?;
            Ok(())
        })
    }

    pub fn list_captures(&self, limit: u32) -> AppResult<Vec<CaptureSummary>> {
        self.with(|db| {
            let mut stmt =
                db.prepare(&format!("SELECT {SUMMARY_COLUMNS} FROM captures c ORDER BY c.started_at DESC LIMIT ?1"))?;
            let rows = stmt.query_map([limit], summary)?.collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
    }

    pub fn get_capture(&self, id: &str) -> AppResult<CaptureSummary> {
        self.with(|db| {
            db.query_row(&format!("SELECT {SUMMARY_COLUMNS} FROM captures c WHERE c.id = ?1"), [id], summary)
                .optional()?
                .ok_or_else(|| AppError::not_found("Capture not found"))
        })
    }

    /// Every statement of a capture, in start order.
    pub fn captured_statements(&self, capture_id: &str) -> AppResult<Vec<CapturedStatement>> {
        let rows = self.with(|db| {
            let mut stmt = db.prepare(
                "SELECT seq, conn, at_ms, duration_ms, fingerprint, sql, params_json, rows, bytes, error, unit, origin, route
                 FROM capture_statements WHERE capture_id = ?1 ORDER BY at_ms, seq",
            )?;
            let rows = stmt
                .query_map([capture_id], |r| {
                    Ok((
                        CapturedStatement {
                            seq: r.get(0)?,
                            conn: r.get(1)?,
                            at_ms: r.get(2)?,
                            duration_ms: r.get(3)?,
                            fingerprint: r.get(4)?,
                            sql: r.get(5)?,
                            params: Vec::new(),
                            rows: r.get(7)?,
                            bytes: r.get(8)?,
                            error: r.get(9)?,
                            unit: r.get(10)?,
                            origin: r.get(11)?,
                            route: r.get(12)?,
                        },
                        r.get::<_, String>(6)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })?;
        rows.into_iter()
            .map(|(mut s, params)| {
                s.params = serde_json::from_str(&params)?;
                Ok(s)
            })
            .collect()
    }

    pub fn save_capture_report(&self, report: &CaptureReport) -> AppResult<()> {
        let json = serde_json::to_string(report)?;
        self.with(|db| {
            db.execute("UPDATE captures SET report_json = ?2 WHERE id = ?1", params![report.capture.id, json])?;
            Ok(())
        })
    }

    pub fn capture_report(&self, id: &str) -> AppResult<Option<CaptureReport>> {
        let json: Option<String> = self.with(|db| {
            Ok(db
                .query_row("SELECT report_json FROM captures WHERE id = ?1", [id], |r| r.get(0))
                .optional()?
                .flatten())
        })?;
        json.map(|j| serde_json::from_str(&j).map_err(Into::into)).transpose()
    }

    pub fn delete_capture(&self, id: &str) -> AppResult<()> {
        self.with(|db| {
            db.execute("DELETE FROM captures WHERE id = ?1", [id])?;
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stmt(seq: u32, fp: &str) -> CapturedStatement {
        CapturedStatement {
            seq,
            conn: 1,
            at_ms: seq as f64,
            duration_ms: 2.0,
            fingerprint: fp.into(),
            sql: "select 1".into(),
            params: vec![Some("7".into()), None],
            rows: 1.0,
            bytes: 10.0,
            error: None,
            unit: None,
            origin: Some("app.js:3".into()),
            route: None,
        }
    }

    #[test]
    fn capture_roundtrip_and_cascade() {
        let store = Store::open_in_memory().unwrap();
        let summary = CaptureSummary {
            id: "c1".into(),
            name: "test".into(),
            connection_id: None,
            upstream: "localhost:5432".into(),
            listen: "127.0.0.1:6543".into(),
            source: CaptureSource::Cli,
            started_at: crate::storage::now(),
            stopped_at: None,
            statements: 0,
            total_ms: 0.0,
        };
        store.insert_capture(&summary).unwrap();
        store.insert_captured("c1", &[stmt(1, "a"), stmt(2, "b")]).unwrap();
        let got = store.get_capture("c1").unwrap();
        assert_eq!((got.statements, got.total_ms), (2, 4.0));
        assert!(got.stopped_at.is_none());
        let rows = store.captured_statements("c1").unwrap();
        assert_eq!(rows[1].params, vec![Some("7".to_string()), None]);

        store.close_abandoned_captures(&[]).unwrap();
        assert!(store.get_capture("c1").unwrap().stopped_at.is_some());
        store.delete_capture("c1").unwrap();
        assert!(store.captured_statements("c1").unwrap().is_empty());
    }
}
