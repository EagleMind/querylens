// Monitoring mode: always on (production included) when a DSN is set, reporting to a
// QueryLens backend (the Cloudflare Worker in cloud/).
//
// Per request (a *transaction*), the queries are buffered in memory. When the request
// ends, a cheap local check decides whether it's worth sending: a statement repeated
// in a row (N+1, loops), a slow, failing or large one, or too many statements. Those
// requests are sent with all their statements, rate-limited per route and problem;
// a sample of the others is sent for the dashboard's live feed. Separately, every
// statement is counted into per-shape totals, sent once a minute.
//
// Values never leave the process unless `sendValues` is set: SQL is scrubbed (see
// scrub.cjs), bound parameters are dropped, error messages lose quoted values. With
// `sourceContext`, the lines of code around each reported query's origin are sent once
// (see source.cjs).
// Sending happens in the background, batched and gzipped; when the backend is
// unreachable or slow, data is dropped rather than buffered without limit.
'use strict';

const http = require('http');
const https = require('https');
const os = require('os');
const zlib = require('zlib');
const { performance } = require('perf_hooks');

const { scrub, scrubError, valueHash } = require('./scrub.cjs');
const { createSourceReader } = require('./source.cjs');

const SDK = 'querylens-node/0.2.0';
const MAX_QUERIES = 1000;
const MAX_PARAM = 2000;
const FLUSH_MS = 5000;
/** Statistics periods: a live chart while developing, fewer writes in production. */
const STATS_MS = 60_000;
const STATS_MS_PRODUCTION = 300_000;
const BACKGROUND_MS = 5000;
const QUEUE_ITEMS = 200;
const QUEUE_BYTES = 4 * 1024 * 1024;
const MAX_SHAPES = 1000;
const SCRUB_CACHE = 500;
/** At most one sent transaction per route and problem in this window. */
const RATE_WINDOW_MS = 30_000;
/** Lines of code whose source is sent, per process, and read per flush. */
const MAX_SOURCE_ORIGINS = 5000;
const SOURCES_PER_FLUSH = 50;

const DEFAULT_CONFIG = { slowMs: 100, loopMin: 5, chatty: 50, largeRows: 1000, liveSampleRate: 0.05 };

const RELEASE_VARS = [
  'QUERYLENS_RELEASE',
  'VERCEL_GIT_COMMIT_SHA',
  'RENDER_GIT_COMMIT',
  'RAILWAY_GIT_COMMIT_SHA',
  'HEROKU_SLUG_COMMIT',
  'CF_PAGES_COMMIT_SHA',
  'SOURCE_VERSION',
  'GITHUB_SHA',
  'GIT_COMMIT',
];

/** `https://<key>@<host>/<project>` → where and how to send. `null` when malformed. */
function parseDsn(dsn) {
  try {
    const url = new URL(dsn);
    const key = decodeURIComponent(url.username);
    const project = url.pathname.replace(/^\/+|\/+$/g, '');
    if (!key || !project || !/^https?:$/.test(url.protocol)) return null;
    return { key, project, endpoint: new URL(`/api/${project}/envelope`, `${url.protocol}//${url.host}`) };
  } catch {
    return null;
  }
}

function detectRelease(env) {
  for (const name of RELEASE_VARS) {
    const v = env[name];
    if (v) return /^[0-9a-f]{40}$/i.test(v) ? v.slice(0, 12) : v.slice(0, 200);
  }
  return null;
}

/** POST one gzipped body. Resolves to `{ status, body, retryAfter }`; never rejects. */
function post(endpoint, key, lines, timeoutMs = 10_000) {
  return new Promise((resolve) => {
    zlib.gzip(lines, (err, body) => {
      if (err) return resolve({ status: 0 });
      const lib = endpoint.protocol === 'https:' ? https : http;
      const req = lib.request(
        endpoint,
        {
          method: 'POST',
          timeout: timeoutMs,
          headers: {
            'content-type': 'application/x-ndjson',
            'content-encoding': 'gzip',
            'content-length': body.length,
            'x-querylens-key': key,
            'user-agent': SDK,
          },
        },
        (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (c) => (text += c));
          res.on('end', () => resolve({ status: res.statusCode, body: text, retryAfter: Number(res.headers['retry-after']) || 0 }));
          res.on('error', () => resolve({ status: 0 }));
        },
      );
      req.on('timeout', () => req.destroy());
      req.on('error', () => resolve({ status: 0 }));
      req.end(body);
    });
  });
}

/**
 * Options: { dsn, environment, release, sendValues, sampleRate, sourceContext, send, sourceReader }.
 * `send(lines) → Promise<{ status, body, retryAfter }>` replaces the HTTP transport, and
 * `sourceReader` the file system (tests).
 */
function createMonitor(options, env = process.env) {
  const target = parseDsn(options.dsn);
  if (!target) {
    console.warn('querylens: the DSN is malformed; monitoring is off. Expected https://<key>@<host>/<project>.');
    return null;
  }
  const environment = String(options.environment || env.QUERYLENS_ENVIRONMENT || env.NODE_ENV || 'production').slice(0, 64);
  const release = options.release || detectRelease(env);
  const sendValues = options.sendValues === true || env.QUERYLENS_SEND_VALUES === '1';
  const fixedSampleRate =
    typeof options.sampleRate === 'number'
      ? options.sampleRate
      : env.QUERYLENS_SAMPLE_RATE
        ? Number(env.QUERYLENS_SAMPLE_RATE)
        : environment === 'production'
          ? null // the project's setting
          : 1;
  const sourceContext = options.sourceContext === true || env.QUERYLENS_SOURCE_CONTEXT === '1';
  const sources = sourceContext ? options.sourceReader || createSourceReader() : null;
  const send = options.send || ((lines) => post(target.endpoint, target.key, lines));
  const header = `${JSON.stringify({ type: 'header', sdk: SDK, environment, release, server: os.hostname() })}\n`;

  let config = { ...DEFAULT_CONFIG };
  let queue = [];
  let queueBytes = 0;
  let sending = false;
  let disabled = false;
  let backoffUntil = 0;
  let failures = 0;
  const lastSent = new Map();
  const scrubCache = new Map();
  let stats = new Map();
  let statsStart = Date.now();
  let background = null;
  /** Origins whose source was read or queued, and those still to read. */
  const seenOrigins = new Set();
  let pendingOrigins = [];

  const sampleRate = () => (fixedSampleRate === null ? config.liveSampleRate : fixedSampleRate);

  function scrubbed(sql, dialect) {
    const key = dialect === 'mysql' ? `mysql:${sql}` : sql;
    let hit = scrubCache.get(key);
    if (!hit) {
      hit = scrub(sql, dialect);
      if (scrubCache.size >= SCRUB_CACHE) scrubCache.delete(scrubCache.keys().next().value);
      scrubCache.set(key, hit);
    }
    return hit;
  }

  function enqueue(item) {
    const line = `${JSON.stringify(item)}\n`;
    queue.push(line);
    queueBytes += line.length;
    // Over the limits the oldest data goes: monitoring must never grow the app's memory.
    while (queue.length > QUEUE_ITEMS || queueBytes > QUEUE_BYTES) queueBytes -= queue.shift().length;
  }

  /** Queue the source of origins seen in sent requests (read in the background, never twice). */
  function noteOrigin(origin) {
    if (!sources || !origin || seenOrigins.has(origin) || seenOrigins.size >= MAX_SOURCE_ORIGINS) return;
    seenOrigins.add(origin);
    pendingOrigins.push(origin);
  }

  async function collectSources() {
    if (!sources || pendingOrigins.length === 0) return;
    const origins = pendingOrigins.slice(0, SOURCES_PER_FLUSH);
    pendingOrigins = pendingOrigins.slice(SOURCES_PER_FLUSH);
    const items = await Promise.all(origins.map((o) => sources.snippet(o)));
    for (const item of items) if (item) enqueue(item);
  }

  async function flush() {
    if (sending || disabled || queue.length === 0 || Date.now() < backoffUntil) return;
    sending = true;
    try {
      await collectSources();
    } catch {}
    const batch = queue;
    queue = [];
    queueBytes = 0;
    try {
      const res = await send(header + batch.join(''));
      if (res.status === 202 || res.status === 200) {
        failures = 0;
        try {
          const reply = JSON.parse(res.body || '{}');
          if (reply.config) config = { ...config, ...reply.config };
        } catch {}
      } else if (res.status === 401 || res.status === 404) {
        disabled = true;
        console.warn(`querylens: the backend refused the DSN (HTTP ${res.status}); monitoring is off.`);
      } else if (res.status === 400 || res.status === 413) {
        // That batch can't be sent; drop it, keep going.
      } else {
        failures++;
        const wait = res.retryAfter ? res.retryAfter * 1000 : Math.min(300_000, 5000 * 2 ** (failures - 1));
        backoffUntil = Date.now() + wait;
        // Keep what fits; newer data has priority.
        for (const line of batch.reverse()) {
          if (queue.length >= QUEUE_ITEMS || queueBytes + line.length > QUEUE_BYTES) break;
          queue.unshift(line);
          queueBytes += line.length;
        }
      }
    } finally {
      sending = false;
    }
  }

  // ───────────────────────────── statistics ─────────────────────────────

  function count(q, sql) {
    let s = stats.get(sql);
    if (!s) {
      if (stats.size >= MAX_SHAPES) return;
      s = { sql, calls: 0, totalMs: 0, maxMs: 0, errors: 0, rows: 0 };
      stats.set(sql, s);
    }
    s.calls++;
    s.totalMs += q.durationMs;
    s.maxMs = Math.max(s.maxMs, q.durationMs);
    s.errors += q.error ? 1 : 0;
    s.rows += q.rows;
  }

  function flushStats() {
    if (stats.size > 0) {
      enqueue({ type: 'stats', start: statsStart, periodMs: Date.now() - statsStart, queries: [...stats.values()] });
    }
    stats = new Map();
    statsStart = Date.now();
  }

  // ───────────────────────────── transactions ─────────────────────────────

  function startTransaction(name) {
    return { name, start: Date.now(), t0: performance.now(), queries: [], dropped: 0, ended: false };
  }

  /** `q`: { started, durationMs, sql, params, rows, error, origin, conn, dialect } */
  function record(txn, q) {
    try {
      const shape = sendValues ? null : scrubbed(q.sql, q.dialect);
      count(q, shape ? shape.sql : q.sql);
      const t = txn || backgroundTxn();
      if (t.queries.length >= MAX_QUERIES) {
        t.dropped++;
        return;
      }
      t.queries.push({ ...q, shape });
      if (!txn && t.queries.length >= 100) endBackground();
    } catch {}
  }

  function backgroundTxn() {
    if (!background) {
      background = startTransaction(null);
      setTimeout(endBackground, BACKGROUND_MS).unref();
    }
    return background;
  }

  function endBackground() {
    const t = background;
    background = null;
    if (t) endTransaction(t);
  }

  /** Why a transaction is worth sending, or [] when it looks fine. */
  function problems(t) {
    const out = new Set();
    const counts = new Map();
    for (const q of t.queries) {
      // Executions per shape, consecutive or not: a superset of what the backend calls a
      // loop (it allows a few statements in between), so no loop is missed here.
      const key = q.shape ? q.shape.sql : q.sql;
      const n = (counts.get(key) || 0) + 1;
      counts.set(key, n);
      if (n >= config.loopMin) out.add('loop');
      if (q.durationMs >= config.slowMs) out.add('slow');
      if (q.error) out.add('error');
      if (q.rows >= config.largeRows) out.add('large');
    }
    if (t.queries.length >= config.chatty) out.add('chatty');
    return [...out].sort();
  }

  function endTransaction(t) {
    if (t.ended) return;
    t.ended = true;
    try {
      if (t.queries.length === 0) return;
      const found = problems(t);
      let send = false;
      if (found.length > 0) {
        const signature = `${t.name}|${found.join(',')}`;
        const last = lastSent.get(signature) || 0;
        if (Date.now() - last >= RATE_WINDOW_MS) {
          if (lastSent.size >= 1000) lastSent.clear();
          lastSent.set(signature, Date.now());
          send = true;
        }
      } else {
        send = Math.random() < sampleRate();
      }
      if (!send) return;
      enqueue({
        type: 'transaction',
        name: t.name,
        start: t.start,
        durationMs: performance.now() - t.t0,
        dropped: t.dropped,
        queries: t.queries.map((q) => serialize(t, q)),
      });
    } catch {}
  }

  function serialize(t, q) {
    const base = {
      at: q.started - t.t0,
      durationMs: q.durationMs,
      rows: q.rows,
      origin: q.origin ? q.origin() : null,
      conn: q.conn,
    };
    noteOrigin(base.origin);
    if (sendValues) {
      return {
        ...base,
        sql: q.sql,
        params: (q.params || []).map((v) => (v === null || v === undefined ? null : String(v).slice(0, MAX_PARAM))),
        error: q.error,
      };
    }
    return { ...base, sql: q.shape.sql, vh: valueHash(q.shape.values, q.params), error: scrubError(q.error) };
  }

  const flushTimer = setInterval(() => void flush(), FLUSH_MS);
  flushTimer.unref();
  const statsMs = Number(options.statsInterval) || (environment === 'production' ? STATS_MS_PRODUCTION : STATS_MS);
  const statsTimer = setInterval(flushStats, statsMs);
  statsTimer.unref();
  process.once('beforeExit', () => {
    endBackground();
    flushStats();
    void flush();
  });

  return {
    environment,
    release,
    sourceContext,
    startTransaction,
    endTransaction,
    record,
    /** Send everything buffered now (serverless handlers, graceful shutdown). */
    async flush() {
      endBackground();
      flushStats();
      backoffUntil = 0;
      while (sending) await new Promise((ok) => setTimeout(ok, 10));
      await flush();
    },
    _internal: { problems, get config() {
      return config;
    }, get queue() {
      return queue;
    } },
  };
}

module.exports = { createMonitor, parseDsn, detectRelease, DEFAULT_CONFIG };
