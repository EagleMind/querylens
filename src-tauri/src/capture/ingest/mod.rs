//! Where captured statements come from. Every source turns what it sees into an
//! [`Observed`] statement on one channel, and the recorder doesn't know the difference.
//!
//! - [`sdk`]: events from the QueryLens SDK running inside the application (the
//!   default for Node.js), received by the [`collector`] (HTTP, long-running apps)
//!   or read from a [`spool`] directory (CLI runs).
//! - [`proxy`]: a PostgreSQL wire proxy, for any language or an app you can't change.

pub mod collector;
pub mod proxy;
pub mod sdk;
pub mod spool;

use std::time::{Instant, SystemTime, UNIX_EPOCH};

use tokio::sync::mpsc;

/// Which source saw the statement.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Via {
    Proxy,
    Sdk,
}

/// What the source knows about where a statement came from. The proxy only knows
/// what the SQL's comment tags say, which the recorder reads.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Context {
    pub origin: Option<String>,
    pub route: Option<String>,
    pub unit: Option<String>,
}

/// One statement execution, as any source reports it.
#[derive(Debug, Clone, PartialEq)]
pub struct Observed {
    pub via: Via,
    /// Connection (proxy) or client (SDK) number, unique within the capture.
    pub conn: u32,
    /// Start, ms since the capture started.
    pub at_ms: f64,
    pub duration_ms: f64,
    pub sql: String,
    /// `None` when some bound value couldn't be rendered.
    pub params: Option<Vec<Option<String>>>,
    pub rows: f64,
    pub bytes: f64,
    pub error: Option<String>,
    pub context: Context,
}

pub type Sink = mpsc::UnboundedSender<Observed>;

/// The capture's start, in both clocks: sources timestamp with `Instant` (proxy)
/// or wall-clock epoch milliseconds (SDK, another process).
#[derive(Debug, Clone, Copy)]
pub struct Clock {
    started: Instant,
    epoch_ms: f64,
}

impl Clock {
    pub fn start() -> Self {
        let epoch_ms = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs_f64() * 1000.0).unwrap_or(0.0);
        Self { started: Instant::now(), epoch_ms }
    }

    pub fn since_instant(&self, t: Instant) -> f64 {
        t.saturating_duration_since(self.started).as_secs_f64() * 1000.0
    }

    pub fn since_epoch(&self, epoch_ms: f64) -> f64 {
        (epoch_ms - self.epoch_ms).max(0.0)
    }
}
