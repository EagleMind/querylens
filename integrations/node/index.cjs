// QueryLens SDK for Node.js. Monitors the queries your app sends through `pg`
// (Sequelize, Knex, TypeORM, MikroORM, Drizzle on node-postgres, or plain `pg`) and
// reports them to your QueryLens backend, which finds N+1s, writes in a loop, slow and
// failing statements, and says how to fix them in your ORM.
//
//   QUERYLENS_DSN=https://<key>@<host>/<project>
//   require('querylens-node/register')        // CommonJS, first line of your entry file
//   import 'querylens-node/register'           // ESM / TypeScript
//
// Each query is recorded with its timing, rows, error, the line of your code that issued
// it, and the HTTP request it served. Requests with problems, a sample of the others and
// per-shape totals are sent in the background, with values removed (see monitor.cjs).
// Your queries are never changed. Without a DSN, or with QUERYLENS_DISABLED=1, it's off.
'use strict';

const Module = require('module');
const path = require('path');
const url = require('url');
const { AsyncLocalStorage } = require('async_hooks');
const { performance } = require('perf_hooks');

const { createMonitor } = require('./monitor.cjs');

/** Shared by every copy of this file loaded in the process. */
const GLOBAL = Symbol.for('querylens.sdk');
const MAX_PARAM = 2000;

const requestContext = new AsyncLocalStorage();
const cwd = process.cwd();
const SDK_FILES = new Set([__filename, path.join(__dirname, 'monitor.cjs'), path.join(__dirname, 'scrub.cjs')]);

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

/** Capture the call stack now; read it (the costly part) only when the request is sent. */
function lazySite() {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 50;
  const holder = {};
  Error.captureStackTrace(holder);
  Error.stackTraceLimit = limit;
  let site;
  return () => (site === undefined ? (site = siteOf(holder.stack)) : site);
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

/** A bound value as text (only sent with `sendValues`; otherwise only hashed). */
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

/** Wrap `pg.Client.prototype.query` so every query is timed and handed to the monitor. */
function patchPg(pg, monitor) {
  const Client = pg && pg.Client;
  if (typeof Client !== 'function' || Client.prototype.query.__querylens) return pg;
  const query = Client.prototype.query;
  const connIds = new WeakMap();
  let nextConn = 0;

  function recorded(config, values) {
    let text;
    let params;
    try {
      if (typeof config === 'string') {
        text = config;
        params = Array.isArray(values) ? values : undefined;
      } else if (config && typeof config.text === 'string' && typeof config.submit !== 'function') {
        text = config.text;
        params = Array.isArray(config.values) ? config.values : Array.isArray(values) ? values : undefined;
      }
    } catch {
      text = undefined;
    }
    if (text === undefined) return query.apply(this, arguments);

    const site = lazySite();
    const ctx = requestContext.getStore();
    let conn = connIds.get(this);
    if (conn === undefined) connIds.set(this, (conn = ++nextConn));
    const started = performance.now();
    const finish = (err, res) => {
      try {
        monitor.record(ctx ? ctx.txn : null, {
          started,
          durationMs: performance.now() - started,
          sql: text,
          params: (params || []).map(paramText),
          rows: rowCount(res),
          error: errorText(err),
          origin: site,
          conn,
        });
      } catch {}
    };

    const args = Array.prototype.slice.call(arguments);
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

/** Each HTTP request becomes a transaction, ended when the response is done. */
function instrumentHttp(monitor) {
  for (const name of ['http', 'https']) {
    const Server = require(name).Server;
    const emit = Server.prototype.emit;
    Server.prototype.emit = function (event, req, res) {
      if (event === 'request' && req && typeof req.url === 'string' && res) {
        const ctx = { txn: null };
        try {
          ctx.txn = monitor.startTransaction(routeOf(req));
          const end = () => monitor.endTransaction(ctx.txn);
          res.once('finish', end);
          res.once('close', end);
        } catch {}
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
  if (!monitor) return fn();
  const ctx = { txn: monitor.startTransaction(String(name)) };
  const end = () => monitor.endTransaction(ctx.txn);
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
 * Start monitoring. Safe to call more than once and from several copies of this module:
 * the first call wins. Options: { dsn, environment, release, sendValues, sampleRate }.
 */
function init(options = {}) {
  if (globalThis[GLOBAL]) return globalThis[GLOBAL];
  const env = process.env;
  const dsn = options.dsn || env.QUERYLENS_DSN;
  const api = { enabled: false, monitor: null, flush: async () => {} };
  globalThis[GLOBAL] = api;
  if (!dsn || env.QUERYLENS_DISABLED === '1' || options.enabled === false) return api;

  const monitor = createMonitor({ ...options, dsn }, env);
  if (!monitor) return api;
  api.enabled = true;
  api.monitor = monitor;
  api.flush = () => monitor.flush();

  // `require('pg')` from anywhere (Sequelize loads it itself)…
  const load = Module._load;
  Module._load = function (request) {
    const exported = load.apply(this, arguments);
    return request === 'pg' ? patchPg(exported, monitor) : exported;
  };
  // …and the app's copy right away (ESM imports share the CommonJS cache).
  try {
    patchPg(Module.createRequire(path.join(cwd, 'noop.js'))('pg'), monitor);
  } catch {
    // pg isn't installed (yet); the require hook still applies.
  }
  instrumentHttp(monitor);
  return api;
}

/** Send what's buffered now (serverless handlers, graceful shutdown). */
function flush() {
  const sdk = globalThis[GLOBAL];
  return sdk ? sdk.flush() : Promise.resolve();
}

module.exports = { init, flush, withTransaction, routeOf, paramText, errorText, rowCount, _internal: { patchPg, siteOf } };
