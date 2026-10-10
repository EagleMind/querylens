//! MongoDB: queries in mongosh syntax are turned into the equivalent command and run
//! through the `explain` command. `executionStats` executes reads only: explain never
//! applies an update or delete, and pipelines with `$out`/`$merge` are refused up front.

use std::time::{Duration, Instant};

use async_trait::async_trait;
use futures_util::TryStreamExt;
use mongodb::bson::{Bson, Document, doc};
use mongodb::options::{ClientOptions, Credential, Tls, TlsOptions};
use mongodb::{Client, Database};

use super::mongo_query;
use super::{ConnectSpec, EngineSession, ExplainRequest};
use crate::error::{AppError, AppResult, ErrorKind};
use crate::model::{ColumnInfo, ConnectionTestResult, ExplainMode, IndexInfo, ServerInfo, SslMode, TableContext};

pub struct MongoSession {
    db: Database,
    connect_ms: f64,
    version: String,
    info: ServerInfo,
}

/// Field names sampled per collection for the schema context.
const SAMPLE_DOCS: i64 = 50;
const MAX_FIELDS: usize = 60;

impl MongoSession {
    pub async fn connect(spec: &ConnectSpec) -> AppResult<Self> {
        let host = spec.host.as_deref().map(str::trim).filter(|h| !h.is_empty()).unwrap_or("localhost");
        // A full connection string (e.g. mongodb+srv://… for Atlas) is accepted in Host.
        let uri = if host.starts_with("mongodb://") || host.starts_with("mongodb+srv://") {
            host.to_string()
        } else {
            format!("mongodb://{host}:{}", spec.port.unwrap_or(27017))
        };
        let mut opts = ClientOptions::parse(&uri).await?;
        opts.app_name = Some("QueryLens".into());
        opts.server_selection_timeout = Some(Duration::from_secs(8));
        opts.connect_timeout = Some(Duration::from_secs(8));
        if let Some(user) = spec.username.as_deref().filter(|u| !u.is_empty()) {
            let source = opts.credential.as_ref().and_then(|c| c.source.clone());
            opts.credential = Some(
                Credential::builder()
                    .username(user.to_string())
                    .password(spec.password.clone().filter(|p| !p.is_empty()))
                    .source(source)
                    .build(),
            );
        }
        match spec.ssl_mode {
            SslMode::Disable => opts.tls = Some(Tls::Disabled),
            // Like libpq's `require`: encrypt, don't verify the certificate.
            SslMode::Require => {
                opts.tls = Some(Tls::Enabled(TlsOptions::builder().allow_invalid_certificates(true).build()))
            }
            // `prefer`: whatever the connection string says (mongodb+srv implies TLS).
            SslMode::Prefer => {}
        }
        let database = spec
            .database
            .clone()
            .filter(|d| !d.trim().is_empty())
            .or_else(|| opts.default_database.clone())
            .ok_or_else(|| AppError::validation("Choose a database for MongoDB connections."))?;

        let started = Instant::now();
        let client = Client::with_options(opts)?;
        let db = client.database(&database);
        let build = db.run_command(doc! { "buildInfo": 1 }).await?;
        let connect_ms = started.elapsed().as_secs_f64() * 1000.0;
        let version = build.get_str("version").unwrap_or("?").to_string();
        let info = ServerInfo { version_num: version_num(&version), ..Default::default() };
        Ok(Self { db, connect_ms, version, info })
    }
}

/// "8.0.4" → 80004.
pub(super) fn version_num(v: &str) -> u32 {
    let mut parts = v.split(|c: char| !c.is_ascii_digit()).filter(|p| !p.is_empty()).map(|p| p.parse::<u32>().unwrap_or(0));
    let (a, b, c) = (parts.next().unwrap_or(0), parts.next().unwrap_or(0), parts.next().unwrap_or(0));
    a * 10_000 + b.min(99) * 100 + c.min(99)
}

fn bson_type(v: &Bson) -> &'static str {
    match v {
        Bson::Double(_) => "double",
        Bson::String(_) => "string",
        Bson::Array(_) => "array",
        Bson::Document(_) => "object",
        Bson::Boolean(_) => "bool",
        Bson::Null => "null",
        Bson::Int32(_) => "int",
        Bson::Int64(_) => "long",
        Bson::Decimal128(_) => "decimal",
        Bson::DateTime(_) => "date",
        Bson::ObjectId(_) => "objectId",
        Bson::Binary(_) => "binData",
        Bson::RegularExpression(_) => "regex",
        Bson::Timestamp(_) => "timestamp",
        _ => "other",
    }
}

/// `{ status: 1, createdAt: -1 }` as written in the shell.
fn key_pattern(keys: &Document) -> String {
    let parts: Vec<String> = keys
        .iter()
        .map(|(k, v)| match v {
            Bson::String(s) => format!("{k}: \"{s}\""),
            other => format!("{k}: {}", other.as_i64().or(other.as_i32().map(i64::from)).or(other.as_f64().map(|f| f as i64)).unwrap_or(1)),
        })
        .collect();
    format!("{{ {} }}", parts.join(", "))
}

#[async_trait]
impl EngineSession for MongoSession {
    async fn test(&mut self) -> AppResult<ConnectionTestResult> {
        let started = Instant::now();
        self.db.run_command(doc! { "ping": 1 }).await?;
        Ok(ConnectionTestResult {
            latency_ms: self.connect_ms + started.elapsed().as_secs_f64() * 1000.0,
            server_version: format!("MongoDB {}", self.version),
        })
    }

    fn server_info(&self) -> ServerInfo {
        self.info.clone()
    }

    async fn explain(&mut self, req: &ExplainRequest<'_>) -> AppResult<String> {
        if req.params.is_some() || !req.setup.is_empty() || !req.hypothetical.is_empty() {
            return Err(AppError::validation(
                "MongoDB queries run as they are: setup statements, hypothetical indexes and $n parameters \
                 are PostgreSQL features.",
            ));
        }
        let query = mongo_query::parse(req.sql)?;
        let mut inner = query.command;
        if !query.writes {
            inner.insert("maxTimeMS", i64::from(req.timeout_ms));
        }
        let verbosity = match req.mode {
            ExplainMode::Analyze => "executionStats",
            ExplainMode::Estimate => "queryPlanner",
        };
        let command = doc! { "explain": inner, "verbosity": verbosity };
        // maxTimeMS stops the server; this is the backstop for commands that ignore it.
        let budget = Duration::from_millis(u64::from(req.timeout_ms) + 3_000);
        let out = tokio::time::timeout(budget, self.db.run_command(command))
            .await
            .map_err(|_| AppError::new(ErrorKind::Timeout, "statement timeout"))??;
        Ok(Bson::Document(out).into_relaxed_extjson().to_string())
    }

    async fn table_context(&mut self, relations: &[String]) -> AppResult<Vec<TableContext>> {
        let mut out = Vec::new();
        for name in relations {
            let coll = self.db.collection::<Document>(name);
            let Ok(indexes) = coll.list_indexes().await else { continue };
            let indexes: Vec<IndexInfo> = indexes
                .try_collect::<Vec<_>>()
                .await
                .unwrap_or_default()
                .into_iter()
                .map(|m| {
                    let opts = m.options.unwrap_or_default();
                    let unique = if opts.unique == Some(true) { " unique" } else { "" };
                    IndexInfo {
                        name: opts.name.unwrap_or_default(),
                        definition: format!("{}{unique}", key_pattern(&m.keys)),
                    }
                })
                .collect();
            let rows = coll.estimated_document_count().await.ok().map(|n| n as f64);
            let size = self
                .db
                .run_command(doc! { "collStats": name, "scale": 1 })
                .await
                .ok()
                .and_then(|s| s.get("size").and_then(|v| v.as_f64().or(v.as_i64().map(|i| i as f64)).or(v.as_i32().map(f64::from))));

            // Field names and types from a sample: collections have no fixed schema.
            let mut columns: Vec<ColumnInfo> = Vec::new();
            if let Ok(mut cursor) = coll.aggregate([doc! { "$sample": { "size": SAMPLE_DOCS } }]).await {
                while let Ok(Some(d)) = cursor.try_next().await {
                    for (k, v) in &d {
                        let ty = bson_type(v);
                        if let Some(c) = columns.iter_mut().find(|c| &c.name == k) {
                            if !c.data_type.split(" | ").any(|t| t == ty) {
                                c.data_type.push_str(&format!(" | {ty}"));
                            }
                        } else if columns.len() < MAX_FIELDS {
                            columns.push(ColumnInfo { name: k.clone(), data_type: ty.into(), stats: None });
                        }
                    }
                }
            }
            out.push(TableContext {
                name: name.clone(),
                row_estimate: rows,
                size_bytes: size,
                last_analyzed: None,
                modified_since_analyze: None,
                columns,
                indexes,
            });
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn parses_versions() {
        assert_eq!(super::version_num("8.0.4"), 80004);
        assert_eq!(super::version_num("7.0.12-rc1"), 70012);
    }
}
