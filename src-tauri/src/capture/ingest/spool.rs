//! SDK events written to files, for commands QueryLens runs itself (`capture --`,
//! `check --`). The SDK appends one `<pid>.ndjson` per process with synchronous
//! writes, so a test runner calling `process.exit()` loses nothing. This tails the
//! directory while the command runs and drains it on stop.

use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::watch;
use tokio::task::JoinHandle;

use super::sdk::SdkIngest;
use crate::error::AppResult;

const POLL: Duration = Duration::from_millis(150);

pub struct Spool {
    dir: PathBuf,
    stop: watch::Sender<bool>,
    task: JoinHandle<()>,
}

impl Spool {
    /// Create `dir` (empty) and start tailing it.
    pub fn start(dir: PathBuf, ingest: Arc<SdkIngest>) -> AppResult<Self> {
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir)?;
        let (stop, mut stopped) = watch::channel(false);
        let watched = dir.clone();
        let task = tokio::spawn(async move {
            let mut tail = Tail::default();
            loop {
                tail.read(&watched, &ingest);
                tokio::select! {
                    _ = tokio::time::sleep(POLL) => {}
                    _ = stopped.changed() => break,
                }
            }
            // Whatever was written up to the end.
            tail.read(&watched, &ingest);
        });
        Ok(Self { dir, stop, task })
    }

    /// QUERYLENS_SPOOL for the command.
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Read what's left, then delete the directory.
    pub async fn finish(self) {
        let _ = self.stop.send(true);
        let _ = self.task.await;
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// Read offsets per file, and the incomplete last line of each.
#[derive(Default)]
struct Tail {
    files: HashMap<PathBuf, (u64, String)>,
}

impl Tail {
    fn read(&mut self, dir: &Path, ingest: &SdkIngest) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for path in entries.flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|e| e == "ndjson")) {
            let (offset, partial) = self.files.entry(path.clone()).or_default();
            let Ok(mut file) = std::fs::File::open(&path) else { continue };
            if file.seek(SeekFrom::Start(*offset)).is_err() {
                continue;
            }
            let mut buf = Vec::new();
            let Ok(n) = file.read_to_end(&mut buf) else { continue };
            *offset += n as u64;
            partial.push_str(&String::from_utf8_lossy(&buf));
            // Only complete lines; a write in progress finishes on the next pass.
            if let Some(end) = partial.rfind('\n') {
                let complete: String = partial.drain(..=end).collect();
                ingest.feed(&complete);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture::ingest::Clock;

    #[tokio::test]
    async fn tails_files_and_drains_on_finish() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let ingest = Arc::new(SdkIngest::new(tx, Clock::start()));
        let dir = std::env::temp_dir().join(format!("ql-spool-{}", uuid::Uuid::new_v4()));
        let spool = Spool::start(dir.clone(), ingest).unwrap();
        let line = |sql: &str| format!(r#"{{"pid":1,"conn":1,"at":0,"durationMs":1,"sql":"{sql}"}}"#);
        std::fs::write(dir.join("1.ndjson"), format!("{}\n{}", line("SELECT 1"), &line("SELECT 2")[..10])).unwrap();
        tokio::time::sleep(POLL * 3).await;
        assert_eq!(rx.try_recv().unwrap().sql, "SELECT 1");
        assert!(rx.try_recv().is_err(), "the half-written line waits");
        // The rest of the line, then a final event written just before stopping.
        let mut f = std::fs::OpenOptions::new().append(true).open(dir.join("1.ndjson")).unwrap();
        std::io::Write::write_all(&mut f, format!("{}\n{}\n", &line("SELECT 2")[10..], line("SELECT 3")).as_bytes()).unwrap();
        drop(f);
        spool.finish().await;
        assert_eq!(rx.try_recv().unwrap().sql, "SELECT 2");
        assert_eq!(rx.try_recv().unwrap().sql, "SELECT 3");
        assert!(!dir.exists());
    }
}
