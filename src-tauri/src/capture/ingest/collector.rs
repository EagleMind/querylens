//! The local HTTP endpoint the SDK reports to from long-running apps (`npm run dev`).
//!
//!   GET  /v1/status   {"capturing": true}: the SDK records only while this answers
//!   POST /v1/events   newline-separated SDK events
//!
//! It exists only while a capture runs, so "something answers" means "capturing".
//! Listens on loopback only.

use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::Arc;

use bytes::Bytes;
use http_body_util::{BodyExt, Full, Limited};
use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use tokio::net::TcpListener;
use tokio::sync::watch;
use tokio::task::JoinHandle;

use super::sdk::SdkIngest;
use crate::error::{AppError, AppResult};

/// Where the SDK looks when QUERYLENS_URL isn't set.
pub const DEFAULT_PORT: u16 = 7343;
const MAX_BODY: usize = 16 * 1024 * 1024;

pub struct Collector {
    addr: SocketAddr,
    shutdown: watch::Sender<bool>,
    task: JoinHandle<()>,
}

impl Collector {
    pub async fn bind(listen: SocketAddr, ingest: Arc<SdkIngest>) -> AppResult<Self> {
        let listener = TcpListener::bind(listen)
            .await
            .map_err(|e| AppError::validation(format!("QueryLens can't receive SDK events on {listen}: {e}")))?;
        let addr = listener.local_addr()?;
        let (shutdown, mut stop) = watch::channel(false);
        let task = tokio::spawn(async move {
            let mut connections = tokio::task::JoinSet::new();
            loop {
                tokio::select! {
                    accepted = listener.accept() => {
                        let Ok((stream, _)) = accepted else { continue };
                        let ingest = ingest.clone();
                        let mut stop = stop.clone();
                        connections.spawn(async move {
                            let service = service_fn(move |req| handle(req, ingest.clone()));
                            let conn = http1::Builder::new().serve_connection(TokioIo::new(stream), service);
                            tokio::pin!(conn);
                            tokio::select! {
                                _ = conn.as_mut() => {}
                                _ = stop.changed() => conn.as_mut().graceful_shutdown(),
                            }
                        });
                    }
                    _ = stop.changed() => break,
                }
            }
            while connections.join_next().await.is_some() {}
        });
        Ok(Self { addr, shutdown, task })
    }

    pub fn local_addr(&self) -> SocketAddr {
        self.addr
    }

    /// The URL the SDK should report to (QUERYLENS_URL).
    pub fn url(&self) -> String {
        format!("http://{}", self.addr)
    }

    pub async fn shutdown(self) {
        let _ = self.shutdown.send(true);
        let _ = self.task.await;
    }
}

fn json(status: StatusCode, body: &'static str) -> Response<Full<Bytes>> {
    Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .body(Full::new(Bytes::from_static(body.as_bytes())))
        .expect("static response")
}

async fn handle(req: Request<Incoming>, ingest: Arc<SdkIngest>) -> Result<Response<Full<Bytes>>, Infallible> {
    Ok(match (req.method(), req.uri().path()) {
        (&Method::GET, "/v1/status") => json(StatusCode::OK, r#"{"capturing":true,"app":"querylens"}"#),
        (&Method::POST, "/v1/events") => match Limited::new(req.into_body(), MAX_BODY).collect().await {
            Ok(body) => {
                ingest.feed(&String::from_utf8_lossy(&body.to_bytes()));
                json(StatusCode::ACCEPTED, r#"{"capturing":true}"#)
            }
            Err(_) => json(StatusCode::PAYLOAD_TOO_LARGE, r#"{"error":"body too large"}"#),
        },
        _ => json(StatusCode::NOT_FOUND, r#"{"error":"not found"}"#),
    })
}
