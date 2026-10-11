//! The capture proxy: a TCP relay between the application and PostgreSQL.
//!
//! Bytes are forwarded unchanged. A copy of each direction is framed and fed to a
//! per-connection [`Tracker`], whose finished executions go to the sink as [`Observed`].
//! The proxy never alters traffic, so if observing ever fails (an unexpected
//! protocol state), it keeps relaying and simply stops recording that connection.

use std::net::SocketAddr;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;
use tokio::task::JoinHandle;

use super::{Clock, Context, Observed, Sink, Via};
use crate::capture::pgwire::framer::Framer;
use crate::capture::pgwire::messages::{self, decode_client, decode_server};
use crate::capture::pgwire::tracker::{Execution, Tracker};
use crate::capture::pgwire::{CANCEL_REQUEST, GSSENC_REQUEST, SSL_REQUEST};
use crate::error::{AppError, AppResult};
use crate::model::SslMode;

/// Where the proxy forwards to.
#[derive(Debug, Clone)]
pub struct Upstream {
    pub host: String,
    pub port: u16,
    pub ssl: SslMode,
}

#[derive(Default)]
pub struct ConnCounters {
    pub open: AtomicU32,
    pub total: AtomicU32,
}

pub struct Proxy {
    addr: SocketAddr,
    shutdown: watch::Sender<bool>,
    accept: JoinHandle<()>,
    pub counters: Arc<ConnCounters>,
}

impl Proxy {
    /// Listen on `listen` (port 0 = any free port) and start accepting.
    pub async fn bind(listen: SocketAddr, upstream: Upstream, sink: Sink, clock: Clock) -> AppResult<Self> {
        let listener = TcpListener::bind(listen).await.map_err(|e| {
            AppError::validation(format!("The capture proxy can't listen on {listen}: {e}. Choose another port."))
        })?;
        let addr = listener.local_addr()?;
        let (shutdown, shutdown_rx) = watch::channel(false);
        let counters = Arc::new(ConnCounters::default());
        let out = Out { sink, clock };
        let accept = tokio::spawn(accept_loop(listener, Arc::new(upstream), out, shutdown_rx, counters.clone()));
        Ok(Self { addr, shutdown, accept, counters })
    }

    pub fn local_addr(&self) -> SocketAddr {
        self.addr
    }

    /// Stop accepting and close every relayed connection.
    pub async fn shutdown(self) {
        let _ = self.shutdown.send(true);
        let _ = self.accept.await;
    }
}

/// Where finished executions go.
#[derive(Clone)]
struct Out {
    sink: Sink,
    clock: Clock,
}

impl Out {
    fn send(&self, conn: u32, exec: Execution) {
        let _ = self.sink.send(Observed {
            via: Via::Proxy,
            conn,
            at_ms: self.clock.since_instant(exec.started),
            duration_ms: exec.finished.saturating_duration_since(exec.started).as_secs_f64() * 1000.0,
            sql: exec.sql.to_string(),
            params: exec.params,
            rows: exec.rows as f64,
            bytes: exec.bytes as f64,
            error: exec.error,
            context: Context::default(),
        });
    }
}

async fn accept_loop(
    listener: TcpListener,
    upstream: Arc<Upstream>,
    out: Out,
    mut shutdown: watch::Receiver<bool>,
    counters: Arc<ConnCounters>,
) {
    let mut connections = tokio::task::JoinSet::new();
    loop {
        tokio::select! {
            accepted = listener.accept() => {
                let Ok((client, _)) = accepted else { continue };
                let _ = client.set_nodelay(true);
                let conn = counters.total.fetch_add(1, Ordering::Relaxed) + 1;
                let (upstream, out, shutdown, counters) = (upstream.clone(), out.clone(), shutdown.clone(), counters.clone());
                connections.spawn(async move {
                    counters.open.fetch_add(1, Ordering::Relaxed);
                    if let Err(e) = serve(client, &upstream, conn, out, shutdown).await {
                        log::debug!("capture connection {conn}: {e}");
                    }
                    counters.open.fetch_sub(1, Ordering::Relaxed);
                });
            }
            _ = shutdown.changed() => break,
        }
    }
    // Connections watch the same signal; wait for them to wind down.
    while connections.join_next().await.is_some() {}
}

trait Stream: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Stream for T {}

/// Read one startup-phase message (no type byte): length, then body.
async fn read_startup(client: &mut TcpStream) -> std::io::Result<Vec<u8>> {
    let len = client.read_u32().await? as usize;
    if !(8..=10_000).contains(&len) {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "invalid startup packet"));
    }
    let mut body = vec![0; len - 4];
    client.read_exact(&mut body).await?;
    Ok(body)
}

async fn serve(
    mut client: TcpStream,
    upstream: &Upstream,
    conn: u32,
    out: Out,
    mut shutdown: watch::Receiver<bool>,
) -> std::io::Result<()> {
    let startup = loop {
        let body = read_startup(&mut client).await?;
        let code = u32::from_be_bytes([body[0], body[1], body[2], body[3]]);
        match code {
            // The app talks plain TCP to the proxy; encryption (if any) is upstream.
            SSL_REQUEST | GSSENC_REQUEST => client.write_all(b"N").await?,
            CANCEL_REQUEST => {
                // Forward as is; the server identifies the session by the secret key.
                let mut server = connect(upstream).await?;
                server.write_all(&framed_startup(&body)).await?;
                return Ok(());
            }
            _ => break body,
        }
    };

    let mut server = match connect(upstream).await {
        Ok(s) => s,
        Err(e) => {
            let msg = format!("QueryLens capture proxy couldn't reach {}:{}: {e}", upstream.host, upstream.port);
            client.write_all(&fatal_error(&msg)).await?;
            return Err(e);
        }
    };
    server.write_all(&framed_startup(&startup)).await?;

    let tracker = Arc::new(Mutex::new(Tracker::default()));
    let (client_read, client_write) = tokio::io::split(client);
    let (server_read, server_write) = tokio::io::split(server);
    let upstream_flow = relay(client_read, server_write, Direction::FromApp, tracker.clone(), conn, out.clone());
    let downstream_flow = relay(server_read, client_write, Direction::FromServer, tracker, conn, out);
    tokio::select! {
        r = upstream_flow => r,
        r = downstream_flow => r,
        _ = shutdown.changed() => Ok(()),
    }
}

fn framed_startup(body: &[u8]) -> Vec<u8> {
    let mut msg = ((body.len() + 4) as u32).to_be_bytes().to_vec();
    msg.extend_from_slice(body);
    msg
}

/// A FATAL ErrorResponse, so the application shows why the connection failed.
fn fatal_error(message: &str) -> Vec<u8> {
    let mut body = Vec::new();
    for (field, value) in [(b'S', "FATAL"), (b'V', "FATAL"), (b'C', "08006"), (b'M', message)] {
        body.push(field);
        body.extend_from_slice(value.as_bytes());
        body.push(0);
    }
    body.push(0);
    let mut msg = vec![b'E'];
    msg.extend_from_slice(&((body.len() + 4) as u32).to_be_bytes());
    msg.extend(body);
    msg
}

async fn connect(upstream: &Upstream) -> std::io::Result<Box<dyn Stream>> {
    let mut tcp = TcpStream::connect((upstream.host.as_str(), upstream.port)).await?;
    let _ = tcp.set_nodelay(true);
    if upstream.ssl == SslMode::Disable {
        return Ok(Box::new(tcp));
    }
    tcp.write_all(&framed_startup(&SSL_REQUEST.to_be_bytes())).await?;
    match tcp.read_u8().await? {
        b'S' => {
            // libpq `prefer` / `require` semantics: encrypt, don't verify the certificate.
            let tls = native_tls::TlsConnector::builder()
                .danger_accept_invalid_certs(true)
                .danger_accept_invalid_hostnames(true)
                .build()
                .map_err(std::io::Error::other)?;
            let stream = tokio_native_tls::TlsConnector::from(tls)
                .connect(&upstream.host, tcp)
                .await
                .map_err(std::io::Error::other)?;
            Ok(Box::new(stream))
        }
        _ if upstream.ssl == SslMode::Require => {
            Err(std::io::Error::other("the server doesn't support TLS, but the connection requires it"))
        }
        _ => Ok(Box::new(tcp)),
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Direction {
    FromApp,
    FromServer,
}

/// Copy `from` → `to`, observing the messages on the way.
async fn relay(
    mut from: impl AsyncRead + Unpin,
    mut to: impl AsyncWrite + Unpin,
    direction: Direction,
    tracker: Arc<Mutex<Tracker>>,
    conn: u32,
    out: Out,
) -> std::io::Result<()> {
    let wants = match direction {
        Direction::FromApp => messages::client_wants_body,
        Direction::FromServer => messages::server_wants_body,
    };
    let mut framer = Framer::new(wants);
    let mut observing = true;
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = from.read(&mut buf).await?;
        if n == 0 {
            let _ = to.shutdown().await;
            return Ok(());
        }
        if observing {
            let now = Instant::now();
            // Update the tracker before forwarding, so a request is always registered
            // before its response can arrive.
            let mut t = tracker.lock().unwrap_or_else(|p| p.into_inner());
            let fed = framer.feed(&buf[..n], &mut |tag, len, body| match direction {
                Direction::FromApp => {
                    if let Some(msg) = decode_client(tag, body) {
                        t.on_client(msg, now);
                    }
                }
                Direction::FromServer => {
                    for exec in t.on_server(decode_server(tag, body), len, now) {
                        out.send(conn, exec);
                    }
                }
            });
            if fed.is_err() {
                log::warn!("capture connection {conn}: unrecognised protocol data; relaying without recording");
                observing = false;
            }
        }
        to.write_all(&buf[..n]).await?;
    }
}
