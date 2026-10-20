//! The pure core of QueryLens: everything that reads SQL text and statements and
//! decides what's wrong, with no I/O. The desktop app and CLI build on it, and the
//! Cloudflare backend runs it as WebAssembly (`querylens-wasm`).
//!
//! - [`fingerprint`]: "the same statement" across literals, parameters and comments.
//! - [`capture`]: SQL reading (`sql`), pattern detection (`detect`), ORM advice (`orm`).
//! - [`monitor`]: what SDKs send the monitoring backend, and its evaluation.
//! - [`model`], [`format`]: shared types and number formatting.

pub mod capture;
pub mod fingerprint;
pub mod format;
pub mod model;
pub mod monitor;
