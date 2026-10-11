// QueryLens SDK for Node.js. Records the queries your app sends through `pg`
// (Sequelize, Knex, TypeORM, MikroORM, Drizzle on node-postgres, or plain `pg`)
// and reports them to QueryLens, which finds N+1s, missing indexes and the like.
//
//   require('querylens-node/register')        // CommonJS, first line of your entry file
//   import 'querylens-node/register'           // ESM / TypeScript
//
// Each query is recorded with its timing, rows, error, the line of your code that
// issued it, and the HTTP request it served. Nothing leaves your machine: events go
// to the QueryLens desktop app or CLI on localhost, and only while one is capturing.
// Off when NODE_ENV=production (set QUERYLENS_ENABLED=1 to override) or
// QUERYLENS_DISABLED=1. Your queries are never changed, except for a trailing comment.
'use strict';

const fs = require('fs');
const http = require('http');
const Module = require('module');
const path = require('path');
const url = require('url');
const { AsyncLocalStorage } = require('async_hooks');
const { performance } = require('perf_hooks');

const VERSION = 1;
const DEFAULT_URL = 'http://127.0.0.1:7343';
/** Shared by every copy of this file loaded in the process (the CLI preloads one). */
const GLOBAL = Symbol.for('querylens.sdk');
const MAX_PARAM = 2000;
const FLUSH_MS = 200;
const FLUSH_SIZE = 200;

const requestContext = new AsyncLocalStorage();
const cwd = process.cwd();
let nextRequest = 0;

const encode = (s) => encodeURIComponent(s).replace(/'/g, '%27');

/** First stack frame outside node_modules, Node internals and this file. */
function callSite() {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 80;
  const stack = new Error().stack || '';
  Error.stackTraceLimit = limit;
  for (const raw of stack.split('\n').slice(1)) {
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
    if (file === __filename || file.includes('node_modules') || file.startsWith('node:') || !path.isAbsolute(file)) {
      continue;
    }
    return `${path.relative(cwd, file).split(path.sep).join('/')}:${m[2]}`;
  }
  return null;
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
    conn(client) {
      let id = connIds.get(client);
      if (id === undefined) connIds.set(client, (id = ++nextConn));
      return id;
    },
    add(event) {
      queue.push(`${JSON.stringify(event)}\n`);
      if (queue.length >= FLUSH_SIZE) flush();
      else if (!timer) (timer = setTimeout(flush, FLUSH_MS)).unref();
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

    const site = callSite();
    const ctx = requestContext.getStore();
    const args = Array.prototype.slice.call(arguments);
    // Named prepared statements must keep identical text, so they aren't tagged.
    if (typeof config === 'string') args[0] = tag(text, site, ctx);
    else if (!config.name) args[0] = { ...config, text: tag(text, site, ctx) };

    const conn = recorder.conn(this);
    const at = performance.timeOrigin + performance.now();
    const started = performance.now();
    const finish = (err, res) => {
      try {
        recorder.add({
          v: VERSION,
          pid: process.pid,
          conn,
          at,
          durationMs: performance.now() - started,
          sql: text,
          params: params ? params.map(paramText) : [],
          rows: rowCount(res),
          error: errorText(err),
          origin: site,
          route: ctx ? ctx.route : null,
          unit: ctx ? ctx.unit : null,
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

function instrumentHttp() {
  for (const name of ['http', 'https']) {
    const Server = require(name).Server;
    const emit = Server.prototype.emit;
    Server.prototype.emit = function (event, req) {
      if (event === 'request' && req && typeof req.url === 'string') {
        const ctx = { route: routeOf(req), unit: `${process.pid.toString(36)}-${(++nextRequest).toString(36)}` };
        return requestContext.run(ctx, () => emit.apply(this, arguments));
      }
      return emit.apply(this, arguments);
    };
  }
}

/**
 * Start recording. Safe to call more than once and from several copies of this
 * module: the first call wins. Options: { url, enabled }.
 */
function init(options = {}) {
  if (globalThis[GLOBAL]) return globalThis[GLOBAL];
  const env = process.env;
  const enabled =
    env.QUERYLENS_DISABLED !== '1' &&
    (options.enabled === true || env.QUERYLENS_ENABLED === '1' || env.NODE_ENV !== 'production');
  const api = { enabled, version: VERSION };
  globalThis[GLOBAL] = api;
  if (!enabled) return api;

  const transport = env.QUERYLENS_SPOOL
    ? fileTransport(env.QUERYLENS_SPOOL)
    : httpTransport(options.url || env.QUERYLENS_URL || DEFAULT_URL);
  const recorder = createRecorder(transport);

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
  instrumentHttp();
  return api;
}

module.exports = { init, tag, callSite, routeOf, paramText, errorText, rowCount, _internal: { patchPg, createRecorder, fileTransport } };
