//! Reading captured statements: SQL text ([`sql`]), patterns across statements
//! ([`detect`]), and fixes in the application's ORM ([`orm`]).

pub mod detect;
pub mod orm;
pub mod sql;

pub use detect::Thresholds;
