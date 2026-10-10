use serde::Serialize;
use ts_rs::TS;

/// Coarse error category, so the UI can pick an icon / recovery action.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum ErrorKind {
    Validation,
    NotFound,
    Connection,
    Database,
    Llm,
    Internal,
}

/// The single error type that crosses the IPC boundary.
#[derive(Debug, Clone, thiserror::Error, Serialize, TS)]
#[error("{message}")]
#[ts(export)]
pub struct AppError {
    pub kind: ErrorKind,
    pub message: String,
}

pub type AppResult<T> = Result<T, AppError>;

impl AppError {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self { kind, message: message.into() }
    }
    pub fn validation(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Validation, message)
    }
    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::NotFound, message)
    }
    pub fn connection(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Connection, message)
    }
    pub fn database(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Database, message)
    }
    pub fn llm(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Llm, message)
    }
    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Internal, message)
    }
}

impl From<rusqlite::Error> for AppError {
    fn from(e: rusqlite::Error) -> Self {
        Self::internal(format!("Local storage error: {e}"))
    }
}

impl From<serde_json::Error> for AppError {
    fn from(e: serde_json::Error) -> Self {
        Self::internal(format!("Serialization error: {e}"))
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        Self::internal(format!("I/O error: {e}"))
    }
}

impl From<keyring::Error> for AppError {
    fn from(e: keyring::Error) -> Self {
        Self::internal(format!("OS keychain error: {e}"))
    }
}

impl From<duckdb::Error> for AppError {
    fn from(e: duckdb::Error) -> Self {
        Self::database(e.to_string())
    }
}

impl From<tokio_postgres::Error> for AppError {
    fn from(e: tokio_postgres::Error) -> Self {
        match e.as_db_error() {
            Some(db) => {
                let mut msg = db.message().to_string();
                if msg.contains("multiple commands") {
                    msg = "Only a single statement can be analyzed at a time.".into();
                }
                if let Some(detail) = db.detail() {
                    msg.push_str(&format!("\nDetail: {detail}"));
                }
                if let Some(hint) = db.hint() {
                    msg.push_str(&format!("\nHint: {hint}"));
                }
                if db.code() == &tokio_postgres::error::SqlState::QUERY_CANCELED {
                    msg = format!("{msg} — the statement timeout was reached (see Settings → Analysis).");
                }
                Self::database(msg)
            }
            None => {
                // Walk the source chain: tokio-postgres hides the useful bit (e.g. "connection refused").
                let mut msg = e.to_string();
                let mut src = std::error::Error::source(&e);
                while let Some(s) = src {
                    msg = format!("{msg}: {s}");
                    src = s.source();
                }
                Self::connection(msg)
            }
        }
    }
}

impl From<reqwest::Error> for AppError {
    fn from(e: reqwest::Error) -> Self {
        if e.is_connect() {
            let url = e.url().map(|u| u.to_string()).unwrap_or_default();
            return Self::llm(format!("Couldn't reach the LLM server at {url}. Is it running?"));
        }
        if e.is_timeout() {
            return Self::llm("The LLM request timed out.");
        }
        Self::llm(format!("LLM request failed: {e}"))
    }
}
