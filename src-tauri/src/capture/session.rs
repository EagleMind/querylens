//! A running capture: its sources (SDK collector and spool, proxy), the recorder,
//! and the registry that owns the captures started from the app or the MCP server.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::Ordering;

use tokio::sync::{Mutex, mpsc};
use tokio::task::JoinHandle;

use super::ingest::collector::Collector;
use super::ingest::proxy::{Proxy, Upstream};
use super::ingest::sdk::SdkIngest;
use super::ingest::spool::Spool;
use super::ingest::{Clock, Sink};
use super::recorder::{self, LiveStats};
use crate::error::{AppError, AppResult};
use crate::model::{CaptureLive, CaptureSource, CaptureSummary, Engine};
use crate::services::target::Target;
use crate::storage::Store;

/// Which sources to run. At least one is needed.
pub struct StartOptions {
    pub name: Option<String>,
    pub source: CaptureSource,
    /// Receive SDK events over HTTP here (long-running apps). Port 0 = any.
    pub collector: Option<SocketAddr>,
    /// Receive SDK events through files in this directory (commands QueryLens runs).
    pub spool: Option<PathBuf>,
    /// Proxy the database here, for apps without the SDK. Needs a target.
    pub proxy: Option<SocketAddr>,
    /// When the collector's address is taken, fall back to any free port (the app
    /// must then be told QUERYLENS_URL) instead of failing.
    pub collector_fallback: bool,
}

pub struct RunningCapture {
    summary: CaptureSummary,
    app_url: Option<String>,
    proxy: Option<Proxy>,
    collector: Option<Collector>,
    spool: Option<Spool>,
    ingest: Arc<SdkIngest>,
    recorder: JoinHandle<AppResult<()>>,
    live: Arc<LiveStats>,
}

impl RunningCapture {
    /// `target` is the database statements are re-planned on (and proxied to).
    pub async fn start(store: Arc<Store>, target: Option<&Target>, opts: StartOptions) -> AppResult<Self> {
        if opts.collector.is_none() && opts.spool.is_none() && opts.proxy.is_none() {
            return Err(AppError::validation("A capture needs at least one source"));
        }
        if let Some(t) = target.filter(|t| t.conn.engine != Engine::Postgres) {
            return Err(AppError::validation(format!(
                "Capture works with PostgreSQL for now; {} support is planned.",
                t.conn.engine.label()
            )));
        }
        let clock = Clock::start();
        let (sink, incoming) = mpsc::unbounded_channel();
        let ingest = Arc::new(SdkIngest::new(sink.clone(), clock));
        // Every source holds a sender; the recorder ends when all have stopped.
        let sources = Sources::start(&opts, target, sink, clock, ingest.clone()).await?;

        let id = uuid::Uuid::new_v4().to_string();
        let db_name = target.map(|t| t.conn.name.clone()).unwrap_or_else(|| "capture".into());
        let summary = CaptureSummary {
            name: opts.name.unwrap_or_else(|| format!("{db_name} · {}", chrono::Local::now().format("%b %-d %H:%M"))),
            connection_id: target.filter(|t| !t.conn.id.starts_with("url:")).map(|t| t.conn.id.clone()),
            upstream: target.map(|t| format!("{}:{}", t.host(), t.port())).unwrap_or_default(),
            listen: sources.proxy.as_ref().map(|p| p.local_addr().to_string()).unwrap_or_default(),
            source: opts.source,
            started_at: crate::storage::now(),
            stopped_at: None,
            statements: 0,
            total_ms: 0.0,
            id: id.clone(),
        };
        store.insert_capture(&summary)?;
        let live = Arc::new(LiveStats::default());
        let recorder = recorder::spawn(store, id, live.clone(), incoming);
        let app_url = match (&sources.proxy, target) {
            (Some(p), Some(t)) => {
                let addr = p.local_addr();
                // An app connects to a concrete address, never 0.0.0.0.
                let host = if addr.ip().is_unspecified() { "127.0.0.1".to_string() } else { addr.ip().to_string() };
                Some(t.url_via(&host, addr.port()))
            }
            _ => None,
        };
        Ok(Self {
            summary,
            app_url,
            proxy: sources.proxy,
            collector: sources.collector,
            spool: sources.spool,
            ingest,
            recorder,
            live,
        })
    }

    pub fn summary(&self) -> &CaptureSummary {
        &self.summary
    }

    /// Proxy URL for apps without the SDK.
    pub fn app_url(&self) -> Option<&str> {
        self.app_url.as_deref()
    }

    pub fn proxy_addr(&self) -> Option<SocketAddr> {
        self.proxy.as_ref().map(Proxy::local_addr)
    }

    /// QUERYLENS_URL for the SDK.
    pub fn collector_url(&self) -> Option<String> {
        self.collector.as_ref().map(Collector::url)
    }

    /// QUERYLENS_SPOOL for the SDK.
    pub fn spool_dir(&self) -> Option<&Path> {
        self.spool.as_ref().map(Spool::dir)
    }

    pub fn live(&self) -> CaptureLive {
        let snap = self.live.snapshot();
        let (open, total) = match &self.proxy {
            Some(p) => (p.counters.open.load(Ordering::Relaxed), p.counters.total.load(Ordering::Relaxed)),
            None => (0, 0),
        };
        CaptureLive {
            id: self.summary.id.clone(),
            statements: snap.statements,
            total_ms: snap.total_ms,
            errors: snap.errors,
            open_connections: open,
            total_connections: total,
            sdk_processes: self.ingest.processes(),
            app_url: self.app_url.clone(),
            collector_url: self.collector_url(),
            recent: snap.recent,
        }
    }

    /// Stop every source (closing the app's proxy connections), drain what they
    /// still hold, and mark the capture finished.
    pub async fn stop(self, store: &Store) -> AppResult<CaptureSummary> {
        if let Some(p) = self.proxy {
            p.shutdown().await;
        }
        if let Some(c) = self.collector {
            c.shutdown().await;
        }
        if let Some(s) = self.spool {
            s.finish().await;
        }
        // The last sender lives in the SDK ingest.
        drop(self.ingest);
        self.recorder.await.map_err(|e| AppError::internal(format!("Capture recorder failed: {e}")))??;
        store.finish_capture(&self.summary.id, &crate::storage::now())?;
        store.get_capture(&self.summary.id)
    }
}

struct Sources {
    proxy: Option<Proxy>,
    collector: Option<Collector>,
    spool: Option<Spool>,
}

impl Sources {
    async fn start(opts: &StartOptions, target: Option<&Target>, sink: Sink, clock: Clock, ingest: Arc<SdkIngest>) -> AppResult<Self> {
        let proxy = match (opts.proxy, target) {
            (Some(listen), Some(t)) => {
                let upstream = Upstream { host: t.host().to_string(), port: t.port(), ssl: t.spec.ssl_mode };
                Some(Proxy::bind(listen, upstream, sink, clock).await?)
            }
            (Some(_), None) => return Err(AppError::validation("The proxy needs to know the database")),
            _ => None,
        };
        let collector = match opts.collector {
            Some(addr) => match Collector::bind(addr, ingest.clone()).await {
                Ok(c) => Some(c),
                Err(_) if opts.collector_fallback => {
                    Some(Collector::bind(SocketAddr::new(addr.ip(), 0), ingest.clone()).await?)
                }
                Err(e) => return Err(e),
            },
            None => None,
        };
        let spool = opts.spool.clone().map(|dir| Spool::start(dir, ingest)).transpose()?;
        Ok(Self { proxy, collector, spool })
    }
}

/// Captures running inside this process, by id.
#[derive(Default)]
pub struct CaptureRegistry(Mutex<HashMap<String, RunningCapture>>);

impl CaptureRegistry {
    pub async fn start(&self, store: Arc<Store>, target: Option<&Target>, opts: StartOptions) -> AppResult<CaptureLive> {
        let running = RunningCapture::start(store, target, opts).await?;
        let live = running.live();
        self.0.lock().await.insert(running.summary().id.clone(), running);
        Ok(live)
    }

    pub async fn stop(&self, id: &str, store: &Store) -> AppResult<CaptureSummary> {
        let running = self.0.lock().await.remove(id).ok_or_else(|| AppError::not_found("This capture isn't running"))?;
        running.stop(store).await
    }

    pub async fn live(&self, id: &str) -> Option<CaptureLive> {
        self.0.lock().await.get(id).map(RunningCapture::live)
    }

    pub async fn running(&self) -> Vec<CaptureLive> {
        self.0.lock().await.values().map(RunningCapture::live).collect()
    }

    pub async fn running_ids(&self) -> Vec<String> {
        self.0.lock().await.keys().cloned().collect()
    }
}
