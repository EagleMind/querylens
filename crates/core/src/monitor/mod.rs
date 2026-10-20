//! Monitoring: SDKs in running applications send *envelopes* (requests they flagged,
//! plus per-shape statistics); the backend digests each one with the same analysis as a
//! capture and keeps the findings as issues.
//!
//! - [`envelope`]: the wire format SDKs send.
//! - [`evaluate`]: one request's statements → findings with ORM fixes.
//! - [`digest`]: a whole envelope → everything the backend stores. The WebAssembly entry point.
//! - [`model`]: what the backend's API returns to the dashboard.

pub mod digest;
pub mod envelope;
pub mod evaluate;
pub mod model;
