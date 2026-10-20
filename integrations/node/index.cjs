// QueryLens SDK for Node.js. Records the queries your app sends through `pg`
// (Sequelize, Knex, TypeORM, MikroORM, Drizzle on node-postgres, or plain `pg`)
// and reports them to QueryLens, which finds N+1s, missing indexes and the like.
//
//   require('querylens-node/register')        // CommonJS, first line of your entry file
//   import 'querylens-node/register'           // ESM / TypeScript
//
// Each query is recorded with its timing, rows, error, the line of your code that
// issued it, and the HTTP request it served. Two modes:
//
// - Monitoring (QUERYLENS_DSN or `init({ dsn })`): always on, production included.
//   Requests with problems, a sample of the others and per-minute totals go to your
//   QueryLens backend, with values removed. Queries are never changed. See monitor.cjs.
// - Local capture (no DSN): events go to the QueryLens CLI on localhost, only while it
//   is capturing; off when NODE_ENV=production (QUERYLENS_ENABLED=1 overrides). A
//   trailing comment tags each query so a capture proxy doesn't record it twice.
//
// QUERYLENS_DISABLED=1 turns both off.
'use strict';

const fs = require('fs');
const http = require('http');
const Module = require('module');
const path = require('path');
const url = require('url');
const { AsyncLocalStorage } = require('async_hooks');
const { performance } = require('perf_hooks');

const { createMonitor } = require('./monitor.cjs');

const VERSION = 1;
const DEFAULT_URL = 'http://127.0.0.1:7343';
/** Shared by every copy of this file loaded in the process (the CLI preloads one). */
const GLOBAL = Symbol.for('querylens.sdk');
const MAX_PARAM = 2000;
const FLUSH_MS = 200;
const FLUSH_SIZE = 200;

const requestContext = new AsyncLocalStorage();
const cwd = process.cwd();
const SDK_FILES = new Set([__filename, path.join(__dirname, 'monitor.cjs'), path.join(__dirname, 'scrub.cjs')]);
let nextRequest = 0;

const encode = (s) => encodeURIComponent(s).replace(/'/g, '%27');

/** First frame of `stack` outside node_modules, Node internals and the SDK, as `file:line`. */
function siteOf(stack) {
  for (const raw of (stack || '').split('\n').slice(1)) {
    const line = raw.trim().replace(/^at\s+/, '').replace(/^async\s+/, '');
    const location = line.endsWith(')') ? line.slice(line.lastIndexOf('(') + 1, -1) : line;
    const m = location.match(/^(.*):(\d+):\d+$/);
    if (!m) continue;
    let file = m[1];
    if (file.startsWith('file://')) {
      try {
        file = url.fileURLToPath(file);
      } catch {
        continue;
      }
    }
    if (SDK_FILES.has(file) || file.includes('node_modules') || file.startsWith('node:') || !path.isAbsolute(file)) {
      continue;
    }
    return `${path.relative(cwd, file).split(path.sep).join('/')}:${m[2]}`;
  }
  return null;
}

/** Capture the call stack now; read it (the costly part) only when asked. */
function lazySite() {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 50;
  const holder = {};
  Error.captureStackTrace(holder);
  Error.stackTraceLimit = limit;
  let site;
  return () => (site === undefined ? (site = siteOf(holder.stack)) : site);
}

/** First stack frame outside node_modules, Node internals and the SDK. */
function callSite() {
  return lazySite()();
}

/** `/orders/123/items` → `/orders/:id/items`, so a route groups its requests. */
function routeOf(req) {
  const pathname = (req.url || '').split('?')[0];
  const generic = pathname
    .split('/')
    .map((seg) => (/^\d+$/.test(seg) || /^[0-9a-f-]{16,}$/i.test(seg) ? ':id' : seg))
    .join('/');
  return `${req.method} ${generic}`;
}

/**
 * The statement with a sqlcommenter comment: where it came from, and `ql_sdk` so a
 * QueryLens proxy on the same path knows this query is already recorded.
 */
function tag(sql, site = callSite(), ctx = requestContext.getStore()) {
  if (typeof sql !== 'string' || sql.includes('ql_sdk=')) return sql;
  const parts = [];
  if (site) parts.push(`file='${encode(site)}'`);
  if (ctx) parts.push(`route='${encode(ctx.route)}'`, `ql_unit='${ctx.unit}'`);
  parts.push("ql_sdk='1'");
  // Before a trailing semicolon, so the statement stays a single statement.
  const body = sql.replace(/\s*;\s*$/, '');
  return `${body} /*${parts.join(',')}*/${body.length === sql.length ? '' : ';'}`;
}

/** A bound value as QueryLens shows (and re-plans) it. */
function paramText(v) {
  if (v === null || v === undefined) return null;
  let s;
  if (v instanceof Date) s = v.toISOString();
  else if (Buffer.isBuffer(v)) s = `\\x${v.toString('hex')}`;
  else if (typeof v === 'object') s = JSON.stringify(v);
  else s = String(v);
  return s.length > MAX_PARAM ? s.slice(0, MAX_PARAM) : s;
}

/** "ERROR: duplicate key value … (23505)", like the server reports it. */
function errorText(err) {
  if (!err) return null;
  const severity = err.severity || 'ERROR';
  return `${severity}: ${err.message}${err.code ? ` (${err.code})` : ''}`;
}

function rowCount(res) {
  if (!res) return 0;
  if (Array.isArray(res)) return res.reduce((n, r) => n + rowCount(r), 0);
  if (typeof res.rowCount === 'number') return res.rowCount;
  return Array.isArray(res.rows) ? res.rows.length : 0;
}

// ─────────────────────────── transports ───────────────────────────

/** CLI runs (`querylens capture -- npm test`): append to a spool file. Synchronous
 * writes survive `process.exit()` in test runners. */
function fileTransport(dir) {
  const file = path.join(dir, `${process.pid}.ndjson`);
  return {
    active: () => true,
    send(lines) {
      fs.appendFileSync(file, lines);
    },
    sendSync(lines) {
      fs.appendFileSync(file, lines);
    },
  };
}

/** Long-running apps: POST to the QueryLens app or CLI on localhost, but only while
 * it is capturing (checked every couple of seconds; nothing is sent otherwise). */
function httpTransport(base) {
  const target = new URL('/v1/', base);
  const agent = new http.Agent({ keepAlive: true });
  let capturing = false;
  let failures = 0;

  function request(method, pathname, body, done) {
    const req = http.request(
      { host: target.hostname, port: target.port, path: target.pathname + pathname, method, agent, timeout: 1000 },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (text += c));
        res.on('end', () => done(res.statusCode === 200 || res.statusCode === 202 ? text : null));
      },
    );
    req.on('error', () => done(null));
    req.on('timeout', () => req.destroy());
    if (body) req.setHeader('content-type', 'application/x-ndjson');
    req.end(body);
  }

  function probe() {
    request('GET', 'status', null, (text) => {
      let state = null;
      try {
        state = text && JSON.parse(text);
      } catch {}
      capturing = !!(state && state.capturing);
      failures = state ? 0 : failures + 1;
      // Check less often while nothing is listening.
      setTimeout(probe, capturing ? 2000 : Math.min(2000 * (1 + failures), 10000)).unref();
    });
  }
  probe();

  return {
    active: () => capturing,
    send(lines) {
      request('POST', 'events', lines, (text) => {
        if (text === null) capturing = false;
      });
    },
    // HTTP can't be flushed during `exit`; the last few events of a dying process are lost.
    sendSync() {},
  };
}

// ─────────────────────────── recording ───────────────────────────

function createRecorder(transport) {
  let queue = [];
  let timer = null;
  const connIds = new WeakMap();
  let nextConn = 0;

  function flush() {
    timer = null;
    if (queue.length === 0) return;
    const lines = queue.join('');
    queue = [];
    try {
      transport.send(lines);
    } catch {}
  }

  process.on('exit', () => {
    if (queue.length) {
      try {
        transport.sendSync(queue.join(''));
      } catch {}
      queue = [];
    }
  });

  return {
    active: () => transport.active(),
    // Tag queries, so a capture proxy on the same path knows they're already recorded.
    tags: true,
    conn(client) {
      let id = connIds.get(client);
      if (id === undefined) connIds.set(client, (id = ++nextConn));
      return id;
    },
    record(e) {
      this.add({
        v: VERSION,
        pid: process.pid,
        conn: e.conn,
        at: e.at,
        durationMs: e.durationMs,
        sql: e.sql,
        params: e.params.map(paramText),
        rows: e.rows,
        error: e.error,
        origin: e.origin(),
        route: e.ctx ? e.ctx.route : null,
        unit: e.ctx ? e.ctx.unit : null,
      });
    },
    add(event) {
      queue.push(`${JSON.stringify(event)}\n`);
      if (queue.length >= FLUSH_SIZE) flush();
      else if (!timer) (timer = setTimeout(flush, FLUSH_MS)).unref();
    },
  };
}

/** Recording into a monitor (monitoring mode): the same events, buffered per transaction. */
function monitorSink(monitor) {
  const connIds = new WeakMap();
  let nextConn = 0;
  return {
    active: () => true,
    tags: false,
    conn(client) {
      let id = connIds.get(client);
      if (id === undefined) connIds.set(client, (id = ++nextConn));
      return id;
    },
    record(e) {
      monitor.record(e.ctx ? e.ctx.txn : null, {
        started: e.started,
        durationMs: e.durationMs,
        sql: e.sql,
        params: e.params.map(paramText),
        rows: e.rows,
        error: e.error,
        origin: e.origin,
        conn: e.conn,
      });
    },
  };
}

function patchPg(pg, recorder) {
  const Client = pg && pg.Client;
  if (typeof Client !== 'function' || Client.prototype.query.__querylens) return pg;
  const query = Client.prototype.query;

  function recorded(config, values, callback) {
    let text;
    let params;
    try {
      if (recorder.active()) {
        if (typeof config === 'string') {
          text = config;
          params = Array.isArray(values) ? values : undefined;
        } else if (config && typeof config.text === 'string' && typeof config.submit !== 'function') {
          text = config.text;
          params = Array.isArray(config.values) ? config.values : Array.isArray(values) ? values : undefined;
        }
      }
    } catch {
      text = undefined;
    }
    if (text === undefined) return query.apply(this, arguments);

    const site = lazySite();
    const ctx = requestContext.getStore();
    const args = Array.prototype.slice.call(arguments);
    // Named prepared statements must keep identical text, so they aren't tagged.
    if (recorder.tags) {
      if (typeof config === 'string') args[0] = tag(text, site(), ctx);
      else if (!config.name) args[0] = { ...config, text: tag(text, site(), ctx) };
    }

    const conn = recorder.conn(this);
    const at = performance.timeOrigin + performance.now();
    const started = performance.now();
    const finish = (err, res) => {
      try {
        recorder.record({
          conn,
          ctx,
          at,
          started,
          durationMs: performance.now() - started,
          sql: text,
          params: params || [],
          rows: rowCount(res),
          error: errorText(err),
          origin: site,
        });
      } catch {}
    };

    const cb = args.findIndex((a) => typeof a === 'function');
    if (cb >= 0) {
      const original = args[cb];
      args[cb] = function (err, res) {
        finish(err, res);
        return original.apply(this, arguments);
      };
      return query.apply(this, args);
    }
    const result = query.apply(this, args);
    if (result && typeof result.then === 'function') {
      result.then(
        (res) => finish(null, res),
        (err) => finish(err, null),
      );
    }
    return result;
  }
  recorded.__querylens = true;
  Client.prototype.query = recorded;
  return pg;
}

function instrumentHttp(monitor) {
  for (const name of ['http', 'https']) {
    const Server = require(name).Server;
    const emit = Server.prototype.emit;
    Server.prototype.emit = function (event, req, res) {
      if (event === 'request' && req && typeof req.url === 'string') {
        const route = routeOf(req);
        const ctx = { route, unit: `${process.pid.toString(36)}-${(++nextRequest).toString(36)}`, txn: null };
        if (monitor && res) {
          try {
            ctx.txn = monitor.startTransaction(route);
            const end = () => monitor.endTransaction(ctx.txn);
            res.once('finish', end);
            res.once('close', end);
          } catch {}
        }
        return requestContext.run(ctx, () => emit.apply(this, arguments));
      }
      return emit.apply(this, arguments);
    };
  }
}

/**
 * Run `fn` as its own transaction named `name` (a queue job, a cron task, a script), so
 * its queries are evaluated together like a request's. Returns what `fn` returns.
 */
function withTransaction(name, fn) {
  const sdk = globalThis[GLOBAL];
  const monitor = sdk && sdk.monitor;
  const ctx = { route: String(name), unit: `${process.pid.toString(36)}-${(++nextRequest).toString(36)}`, txn: null };
  if (monitor) ctx.txn = monitor.startTransaction(ctx.route);
  const end = () => monitor && monitor.endTransaction(ctx.txn);
  return requestContext.run(ctx, () => {
    let result;
    try {
      result = fn();
    } catch (e) {
      end();
      throw e;
    }
    if (result && typeof result.then === 'function') {
      return result.then(
        (v) => {
          end();
          return v;
        },
        (e) => {
          end();
          throw e;
        },
      );
    }
    end();
    return result;
  });
}

/**
 * Start recording. Safe to call more than once and from several copies of this
 * module: the first call wins.
 *
 * Options: { dsn, environment, release, sendValues, sampleRate } for monitoring;
 * { url, enabled } for local capture.
 */
function init(options = {}) {
  if (globalThis[GLOBAL]) return globalThis[GLOBAL];
  const env = process.env;
  const dsn = options.dsn || env.QUERYLENS_DSN;
  // A `querylens capture -- <command>` run (spool) records locally even when a DSN is set.
  const monitoring = Boolean(dsn) && !env.QUERYLENS_SPOOL;
  const enabled =
    env.QUERYLENS_DISABLED !== '1' &&
    options.enabled !== false &&
    (monitoring || options.enabled === true || env.QUERYLENS_ENABLED === '1' || env.NODE_ENV !== 'production');
  const api = { enabled, version: VERSION, mode: monitoring ? 'monitor' : 'capture', monitor: null, flush: async () => {} };
  globalThis[GLOBAL] = api;
  if (!enabled) return api;

  let recorder;
  if (monitoring) {
    const monitor = createMonitor({ ...options, dsn }, env);
    if (!monitor) {
      api.enabled = false;
      return api;
    }
    api.monitor = monitor;
    api.flush = () => monitor.flush();
    recorder = monitorSink(monitor);
  } else {
    const transport = env.QUERYLENS_SPOOL
      ? fileTransport(env.QUERYLENS_SPOOL)
      : httpTransport(options.url || env.QUERYLENS_URL || DEFAULT_URL);
    recorder = createRecorder(transport);
  }

  // `require('pg')` from anywhere (Sequelize loads it itself)…
  const load = Module._load;
  Module._load = function (request) {
    const exported = load.apply(this, arguments);
    return request === 'pg' ? patchPg(exported, recorder) : exported;
  };
  // …and the app's copy right away (ESM imports share the CommonJS cache).
  try {
    patchPg(Module.createRequire(path.join(cwd, 'noop.js'))('pg'), recorder);
  } catch {
    // pg isn't installed (yet); the require hook still applies.
  }
  instrumentHttp(api.monitor);
  return api;
}

/** Send what monitoring has buffered (serverless handlers, graceful shutdown). */
function flush() {
  const sdk = globalThis[GLOBAL];
  return sdk ? sdk.flush() : Promise.resolve();
}

module.exports = {
  init,
  flush,
  withTransaction,
  tag,
  callSite,
  routeOf,
  paramText,
  errorText,
  rowCount,
  _internal: { patchPg, createRecorder, fileTransport, monitorSink },
};
