//! Capture: record the statements an application actually sends, find the
//! patterns ORMs produce (N+1, duplicate queries, row-by-row writes, unbounded
//! results), re-plan them, and say how to fix them in the application's own ORM.
//!
//! Layers, from the source up:
//! - [`pgwire`], [`sql`]: pure protocol and SQL-text reading.
//! - [`ingest`]: where statements come from (the SDK in the app; the proxy otherwise).
//! - [`recorder`], [`session`]: persistence, live counters and lifecycle.
//! - [`detect`], [`orm`]: pure analysis and ORM-specific advice.
//! - [`plans`], [`report`]: plan checks against the database, and the assembled report.
//! - [`render`], [`baseline`]: outputs (Markdown, terminal) and the CI gate.

// The pure layers (SQL reading, detection, ORM advice) live in the core crate, shared
// with the Cloudflare backend.
pub use querylens_core::capture::{detect, orm, sql};

pub mod baseline;
pub mod compare;
pub mod ingest;
pub mod node_hook;
pub mod pgwire;
pub mod plans;
pub mod recorder;
pub mod render;
pub mod report;
pub mod session;

pub use detect::Thresholds;
pub use plans::PlanDepth;
pub use report::ReportOptions;
pub use session::{CaptureRegistry, RunningCapture, StartOptions};
