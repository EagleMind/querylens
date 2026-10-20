//! Reading captured statements: SQL text ([`sql`]) and MongoDB operations ([`mongo`]),
//! patterns across statements ([`detect`]), and fixes in the application's ORM ([`orm`]).

pub mod detect;
pub mod mongo;
pub mod orm;
pub mod sql;

pub use detect::Thresholds;
