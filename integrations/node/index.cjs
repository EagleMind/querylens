// QueryLens SDK for Node.js. Monitors the queries your app sends to PostgreSQL (`pg`,
// `postgres`) and MySQL (`mysql2`), through Sequelize, Knex, TypeORM, MikroORM, Drizzle,
// Prisma (with querylens-node/prisma) or the drivers directly, and reports them to your
// QueryLens backend, which finds N+1s, writes in a loop, slow and failing statements, and
// says how to fix them in your ORM.
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
const DRIZZLE_FILE = /[\\/]drizzle-orm[\\/]/;

const requestContext = new AsyncLocalStorage();
const cwd = process.cwd();
const SDK_FILES = new Set([__filename, ...['monitor.cjs', 'scrub.cjs', 'prisma.cjs'].map((f) => path.join(__dirname, f))]);

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

/**
 * The ORM operation running, set by ORM integrations (querylens-node/prisma, the Drizzle
 * hook): `{ site() }`, the app's line for it, and `viaDriver`, set when a driver hook sees its SQL.
 */
const operations = new AsyncLocalStorage();

/** Capture the call stack now; read its app line (the costly part) only when it's asked for. */
function stackSite() {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 50;
  const holder = {};
  Error.captureStackTrace(holder);
  Error.stackTraceLimit = limit;
  let site;
  return () => (site === undefined ? (site = siteOf(holder.stack)) : site);
}

/**
 * For a driver hook, when a query starts: the app's line, read when the request is sent.
 * Inside an ORM operation an integration knows the app's line for, that line wins: the
 * driver's own stack may be all ORM internals.
 */
function lazySite() {
  const own = stackSite();
  const operation = operations.getStore();
  if (operation) operation.viaDriver = true;
  return () => (operation && operation.site()) || own();
}

/**
 * `fn`, for a driver to call back later from code of its own (a pool's queue, a pooled
 * connection's socket, which keeps the context it was opened in), run in the request and
 * operation current now. Only QueryLens's own context is carried over.
 */
function inCallerContext(fn) {
  const ctx = requestContext.getStore();
  const operation = operations.getStore();
  return function () {
    return requestContext.run(ctx, () => operations.run(operation, () => fn.apply(this, arguments)));
  };
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

/**
 * Wrap `pg.Client.prototype.query` so every query is timed and handed to the monitor, and
 * `pg.Pool`'s so its queries keep their line and request.
 */
function patchPg(pg, monitor) {
  const Client = pg && pg.Client;
  if (typeof Client !== 'function') return pg;
  patchPool(pg.Pool, ['query'], 'connect');
  if (Client.prototype.query.__querylens) return pg;
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
          dialect: 'postgres',
        });
      } catch {}
    };

    const args = Array.prototype.slice.call(arguments);
    const cb = args.findIndex((a) => typeof a === 'function');
    if (cb >= 0) {
      // A pooled client calls back from its socket, in the request that opened it.
      const original = inCallerContext(args[cb]);
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

/**
 * A pool runs a query on a connection once it has one, later and outside the app's code
 * (pg-pool's `query`, mysql2's `query` and `execute`): the app's line is taken when one of
 * `queries` is called, and the query runs inside an operation holding it (unless an ORM
 * operation already holds one). A pool out of connections queues `acquire` callbacks and
 * calls them from the query that frees a connection, in that query's request: they're run
 * in their own.
 */
function patchPool(Pool, queries, acquire) {
  let proto = Pool && Pool.prototype;
  while (proto && !Object.prototype.hasOwnProperty.call(proto, queries[0])) proto = Object.getPrototypeOf(proto);
  if (!proto || typeof proto[queries[0]] !== 'function' || typeof proto[acquire] !== 'function' || proto[queries[0]].__querylens) return Pool;

  const connect = proto[acquire];
  proto[acquire] = function (cb) {
    if (typeof cb !== 'function') return connect.apply(this, arguments);
    const args = Array.prototype.slice.call(arguments);
    args[0] = inCallerContext(cb);
    return connect.apply(this, args);
  };
  for (const method of queries) {
    const query = proto[method];
    if (typeof query !== 'function') continue;
    proto[method] = function () {
      if (operations.getStore()) return query.apply(this, arguments);
      return operations.run({ site: stackSite(), viaDriver: false }, () => query.apply(this, arguments));
    };
    proto[method].__querylens = true;
  }
  return Pool;
}

/** Rows a mysql2 result holds: rows read, or rows written for an INSERT/UPDATE/DELETE. */
function mysqlRows(res) {
  if (!res) return 0;
  if (Array.isArray(res)) {
    // Several statements at once: one result per statement.
    const nested = res.length > 0 && (Array.isArray(res[0]) || (res[0] && typeof res[0].affectedRows === 'number'));
    return nested ? res.reduce((n, r) => n + mysqlRows(r), 0) : res.length;
  }
  return typeof res.affectedRows === 'number' ? res.affectedRows : 0;
}

/**
 * Wrap mysql2's `query` and `execute` (Sequelize, Knex, TypeORM, MikroORM and Drizzle on
 * MySQL use it). They live on the base connection class, shared by connections, pool
 * connections and the promise API, so one patch covers them all. Handles the three ways
 * mysql2 runs a statement: a callback, a Query command handed over by a pool, and the
 * event-emitter form. The pool's own `query` and `execute` are wrapped so their queries
 * keep their line and request.
 */
function patchMysql2(mysql2, monitor) {
  const Connection = mysql2 && mysql2.Connection;
  if (typeof Connection !== 'function') return mysql2;
  patchPool(mysql2.Pool, ['query', 'execute'], 'getConnection');
  let proto = Connection.prototype;
  while (proto && !Object.prototype.hasOwnProperty.call(proto, 'query')) proto = Object.getPrototypeOf(proto);
  if (!proto || typeof proto.query !== 'function' || proto.query.__querylens) return mysql2;
  const connIds = new WeakMap();
  let nextConn = 0;

  for (const method of ['query', 'execute']) {
    const original = proto[method];
    if (typeof original !== 'function') continue;
    const wrapped = function (sql, values) {
      let text;
      let params;
      let command = null;
      try {
        if (typeof sql === 'string') {
          text = sql;
          params = Array.isArray(values) ? values : undefined;
        } else if (sql && typeof sql.sql === 'string') {
          text = sql.sql;
          params = Array.isArray(sql.values) ? sql.values : Array.isArray(values) ? values : undefined;
          // A pool hands its connection a ready Query command.
          if (sql.constructor && sql.constructor.name === 'Query' && typeof sql.on === 'function') command = sql;
        }
      } catch {
        text = undefined;
      }
      if (text === undefined) return original.apply(this, arguments);

      const site = lazySite();
      const ctx = requestContext.getStore();
      let conn = connIds.get(this);
      if (conn === undefined) connIds.set(this, (conn = ++nextConn));
      const started = performance.now();
      let done = false;
      const finish = (err, rows) => {
        if (done) return;
        done = true;
        try {
          monitor.record(ctx ? ctx.txn : null, {
            started,
            durationMs: performance.now() - started,
            sql: text,
            params: (params || []).map(paramText),
            rows,
            error: errorText(err),
            origin: site,
            conn,
            dialect: 'mysql',
          });
        } catch {}
      };
      // Event-emitter form: rows arrive one 'result' event at a time.
      const listen = (emitter) => {
        let rows = 0;
        emitter.on('result', (r) => (rows += r && typeof r.affectedRows === 'number' ? r.affectedRows : 1));
        emitter.once('error', (err) => finish(err, rows));
        emitter.once('end', () => finish(null, rows));
      };

      try {
        if (command) {
          if (typeof command.onResult === 'function') {
            // A connection calls back from its socket, in the request that opened it.
            const onResult = inCallerContext(command.onResult);
            command.onResult = function (err, res) {
              finish(err, mysqlRows(res));
              return onResult.apply(this, arguments);
            };
          } else {
            listen(command);
          }
          return original.apply(this, arguments);
        }
        const args = Array.prototype.slice.call(arguments);
        const cb = args.findIndex((a, i) => i > 0 && typeof a === 'function');
        if (cb >= 0) {
          const callback = inCallerContext(args[cb]);
          args[cb] = function (err, res) {
            finish(err, mysqlRows(res));
            return callback.apply(this, arguments);
          };
          return original.apply(this, args);
        }
        const result = original.apply(this, args);
        if (result && typeof result.once === 'function') listen(result);
        return result;
      } catch (e) {
        // mysql2 throws synchronously on bad arguments; let the app see it unchanged.
        finish(e, 0);
        throw e;
      }
    };
    wrapped.__querylens = true;
    proto[method] = wrapped;
  }
  return mysql2;
}

/**
 * Rows a postgres.js result holds: its command's count (rows read or written). A Result is
 * an array of rows carrying `command` and `count`; several statements give an array of them.
 */
function postgresRows(res) {
  if (!res || typeof res !== 'object') return 0;
  if ('command' in res) return typeof res.count === 'number' ? res.count : res.length;
  return Array.isArray(res) ? res.reduce((n, r) => n + (r && typeof r === 'object' && 'command' in r ? postgresRows(r) : 0), 0) : 0;
}

/** The statement postgres.js sent; when it failed before that, its text with `$n` placeholders. */
function postgresSql(query) {
  if (typeof query.string === 'string') return query.string;
  const strings = Array.isArray(query.strings) ? query.strings : [];
  return strings.length ? strings.reduce((sql, part, i) => `${sql}$${i}${part}`) : null;
}

/**
 * Wrap postgres.js (`postgres`, Drizzle's postgres-js driver) through its Query class, which
 * tagged templates, `sql.unsafe`, `sql.file`, `sql.begin` and reserved connections all use.
 * A query is a lazy promise: the call site and request are taken when it's created (the
 * app's line is on the stack then), the timing from when it's handed to a connection until
 * postgres.js settles it.
 */
function patchPostgres(Query, monitor) {
  const proto = Query && Query.prototype;
  if (typeof Query !== 'function' || !proto || typeof proto.handle !== 'function' || proto.handle.__querylens) return Query;
  const Base = Object.getPrototypeOf(Query);
  const created = new WeakMap();
  const connIds = new WeakMap();
  let nextConn = 0;

  // Query's constructor calls `super`, its parent class (Promise): a step in between sees
  // each query created, and builds it exactly as `super` would.
  function Created(executor) {
    const query = Reflect.construct(Base, [executor], new.target);
    try {
      created.set(query, { site: lazySite(), ctx: requestContext.getStore() });
    } catch {}
    return query;
  }
  Object.setPrototypeOf(Created, Base);
  Created.prototype = Base.prototype;
  Object.setPrototypeOf(Query, Created);

  function watch(query) {
    const call = created.get(query);
    // Created before the patch, or one of the connection's own (array types, read-only
    // state), which it runs itself, through its `execute`.
    if (!call || query.handler.name === 'execute') return;
    created.delete(query);
    const started = performance.now();
    const { resolve, reject } = query;
    let done = false;
    const finish = (err, res) => {
      if (done) return;
      done = true;
      try {
        const sql = postgresSql(query);
        if (sql === null) return;
        let conn = 0;
        if (query.state && typeof query.state === 'object') {
          conn = connIds.get(query.state);
          if (conn === undefined) connIds.set(query.state, (conn = ++nextConn));
        }
        monitor.record(call.ctx ? call.ctx.txn : null, {
          started,
          durationMs: performance.now() - started,
          sql,
          params: (Array.isArray(query.parameters) ? query.parameters : []).map(paramText),
          rows: postgresRows(res),
          error: errorText(err),
          origin: call.site,
          conn,
          dialect: 'postgres',
        });
      } catch {}
    };
    // An async-iterator cursor replaces these on each batch: it's recorded if it ends in the first.
    query.resolve = function (value) {
      finish(null, value);
      return resolve.apply(this, arguments);
    };
    query.reject = function (err) {
      finish(err, null);
      return reject.apply(this, arguments);
    };
  }

  const handle = proto.handle;
  proto.handle = function () {
    if (!this.executed) {
      try {
        watch(this);
      } catch {}
    }
    return handle.apply(this, arguments);
  };
  proto.handle.__querylens = true;
  return Query;
}

/** postgres.js keeps its Query class in `query.js` next to its entry file, in each of its builds. */
function postgresQueryFile(entry) {
  return path.join(path.dirname(entry), 'query.js');
}

/**
 * Give Drizzle's queries the line of the app that awaited them. A Drizzle query is a
 * thenable (QueryPromise): `await` calls its `then` from a microtask, so the driver hooks
 * see no app frame. But `await` (like `Promise.all`, `.catch`) reads `then` right away, in
 * the app's code: a getter takes the stack there and starts the query inside an operation
 * holding that line. `then` itself is unchanged, and assigning one still works.
 * Select builders copy QueryPromise's methods when they load: patch it before that.
 */
function patchDrizzle(QueryPromise) {
  const proto = QueryPromise && QueryPromise.prototype;
  const desc = proto && Object.getOwnPropertyDescriptor(proto, 'then');
  // Already patched (a getter), or not Drizzle's.
  if (typeof QueryPromise !== 'function' || !desc || typeof desc.value !== 'function') return QueryPromise;
  const then = desc.value;
  Object.defineProperty(proto, 'then', {
    configurable: true,
    enumerable: desc.enumerable,
    get() {
      const own = stackSite();
      // Drizzle awaiting one of its own queries: the app's line is the outer one's.
      const outer = operations.getStore();
      let site;
      const operation = {
        site: () => (site === undefined ? (site = own() || (outer ? outer.site() : null)) : site),
        viaDriver: false,
      };
      return function () {
        return operations.run(operation, () => then.apply(this, arguments));
      };
    },
    set(value) {
      Object.defineProperty(this, 'then', { value, writable: true, enumerable: true, configurable: true });
    },
  });
  return QueryPromise;
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

/** The running monitor, from whichever copy of this module started it; `null` when off. */
function activeMonitor() {
  const sdk = globalThis[GLOBAL];
  return (sdk && sdk.monitor) || null;
}

/**
 * Run `fn` as its own transaction named `name` (a queue job, a cron task, a script), so
 * its queries are evaluated together like a request's. Returns what `fn` returns.
 */
function withTransaction(name, fn) {
  const monitor = activeMonitor();
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

  // `require('pg')` / `require('mysql2')` / `require('postgres')` from anywhere (ORMs load them
  // themselves), and Drizzle's QueryPromise as Drizzle loads it…
  const load = Module._load;
  Module._load = function (request, parent) {
    const exported = load.apply(this, arguments);
    try {
      if (request === 'pg') return patchPg(exported, monitor);
      if (request === 'mysql2') return patchMysql2(exported, monitor);
      // The promise API shares the core's connection class: patch it through the core.
      if (request === 'mysql2/promise') patchMysql2(load.call(this, 'mysql2', parent, false), monitor);
      if (request === 'postgres') {
        const file = postgresQueryFile(Module._resolveFilename(request, parent));
        patchPostgres(load.call(this, file, parent, false).Query, monitor);
      }
      if (request.endsWith('query-promise.cjs') && parent && DRIZZLE_FILE.test(parent.filename)) {
        patchDrizzle(exported.QueryPromise);
      }
    } catch {}
    return exported;
  };
  // …and the app's copies right away (ESM imports of pg and mysql2 share the CommonJS cache).
  const appRequire = Module.createRequire(path.join(cwd, 'noop.js'));
  for (const [name, patch] of [
    ['pg', patchPg],
    ['mysql2', patchMysql2],
  ]) {
    try {
      patch(appRequire(name), monitor);
    } catch {
      // Not installed (yet); the require hook still applies.
    }
  }
  try {
    // postgres.js has a CommonJS build (cjs/src, for require) and an ESM one (src, for
    // import), each with its own Query class. The ESM one loads asynchronously: it's
    // patched before the app's first request, possibly after queries run at startup.
    const entry = appRequire.resolve('postgres');
    patchPostgres(appRequire(postgresQueryFile(entry)).Query, monitor);
    const esm = path.join(path.dirname(entry), '..', '..', 'src', 'query.js');
    import(url.pathToFileURL(esm).href).then(
      (m) => patchPostgres(m.Query, monitor),
      () => {},
    );
  } catch {
    // Not installed (yet); the require hook still applies to CommonJS.
  }
  try {
    // Drizzle too has a CommonJS build (.cjs) and an ESM one (.js). Since Node 20.19 the ESM
    // one can be loaded synchronously, before the app's imports run; on older versions it's
    // patched asynchronously, after its select builders copied `then` (they get no line).
    const file = appRequire.resolve('drizzle-orm/query-promise');
    patchDrizzle(appRequire(file).QueryPromise);
    const esm = file.replace(/\.cjs$/, '.js');
    try {
      patchDrizzle(require(esm).QueryPromise);
    } catch {
      import(url.pathToFileURL(esm).href).then(
        (m) => patchDrizzle(m.QueryPromise),
        () => {},
      );
    }
  } catch {
    // Not installed (yet); the require hook still applies to CommonJS.
  }
  instrumentHttp(monitor);
  return api;
}

/** Send what's buffered now (serverless handlers, graceful shutdown). */
function flush() {
  const sdk = globalThis[GLOBAL];
  return sdk ? sdk.flush() : Promise.resolve();
}

module.exports = { init, flush, withTransaction, routeOf, paramText, errorText, rowCount, _internal: { patchPg, patchPool, patchMysql2, patchPostgres, patchDrizzle, mysqlRows, postgresRows, siteOf, lazySite, operations, requestContext, activeMonitor } };
