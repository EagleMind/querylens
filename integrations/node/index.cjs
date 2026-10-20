// QueryLens SDK for Node.js. Monitors the queries your app sends to PostgreSQL (`pg`,
// `postgres`, Neon), MySQL (`mysql2`, PlanetScale) and SQLite (`better-sqlite3`, `sqlite3`,
// `node:sqlite`, libSQL / Turso), through
// Sequelize, Knex, TypeORM, MikroORM, Drizzle, Prisma (with querylens-node/prisma) or the
// drivers directly (one module each in drivers/), and reports them to your
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

const { createMonitor } = require('./monitor.cjs');
const { requestContext, operations, siteOf, stackSite, lazySite, paramText, errorText } = require('./context.cjs');
const { patchPool } = require('./drivers/pool.cjs');
const { patchPg, rowCount } = require('./drivers/pg.cjs');
const { patchMysql2, mysqlRows } = require('./drivers/mysql2.cjs');
const { patchPostgres, postgresRows, postgresQueryFile } = require('./drivers/postgres.cjs');
const { patchDrizzle } = require('./drivers/drizzle.cjs');
const { packageRoot, patchBuilds } = require('./drivers/builds.cjs');
const neon = require('./drivers/neon.cjs');
const planetscale = require('./drivers/planetscale.cjs');
const libsql = require('./drivers/libsql.cjs');
const sqlite = require('./drivers/sqlite.cjs');

/** Shared by every copy of this file loaded in the process. */
const GLOBAL = Symbol.for('querylens.sdk');
const DRIZZLE_FILE = /[\\/]drizzle-orm[\\/]/;
const cwd = process.cwd();

/** Drivers with one build: patched through what `require` returns (ESM imports share it). */
const PACKAGES = [
  { name: 'pg', patch: patchPg },
  { name: 'mysql2', patch: patchMysql2 },
  { name: 'better-sqlite3', patch: sqlite.patchBetterSqlite3 },
  { name: 'sqlite3', patch: sqlite.patchSqlite3 },
];

/**
 * Drivers shipped as a CommonJS and an ES module build, each with its own classes: both are
 * patched, file by file (drivers/builds.cjs), when the app has the package.
 */
const DUAL_BUILDS = [
  { name: '@neondatabase/serverless', builds: neon.BUILDS, patch: neon.patchNeon },
  { name: '@planetscale/database', builds: planetscale.BUILDS, patch: planetscale.patchPlanetScale },
  { name: '@libsql/client', builds: libsql.BUILDS, patch: libsql.patchLibsql },
];

/** `/orders/123/items` → `/orders/:id/items`, so a route groups its requests. */
function routeOf(req) {
  const pathname = (req.url || '').split('?')[0];
  const generic = pathname
    .split('/')
    .map((seg) => (/^\d+$/.test(seg) || /^[0-9a-f-]{16,}$/i.test(seg) ? ':id' : seg))
    .join('/');
  return `${req.method} ${generic}`;
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
 * the first call wins. Options: { dsn, environment, release, sendValues, sampleRate, sourceContext }.
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

  /** Package directories of dual-build drivers already patched. */
  const patchedRoots = new Set();
  const patchDualBuild = (lib, resolved) => {
    const root = packageRoot(resolved, lib.name);
    if (!root || patchedRoots.has(root)) return;
    patchedRoots.add(root);
    patchBuilds(root, lib.builds, (exports) => lib.patch(exports, monitor));
  };

  // `require('pg')` / `require('mysql2')` / `require('postgres')` from anywhere (ORMs load them
  // themselves), and Drizzle's QueryPromise as Drizzle loads it…
  const load = Module._load;
  Module._load = function (request, parent) {
    const exported = load.apply(this, arguments);
    try {
      const lib = PACKAGES.find((l) => l.name === request);
      if (lib) return lib.patch(exported, monitor);
      if (request === 'node:sqlite') return sqlite.patchNodeSqlite(exported, monitor);
      // The promise API shares the core's connection class: patch it through the core.
      if (request === 'mysql2/promise') patchMysql2(load.call(this, 'mysql2', parent, false), monitor);
      if (request === 'postgres') {
        const file = postgresQueryFile(Module._resolveFilename(request, parent));
        patchPostgres(load.call(this, file, parent, false).Query, monitor);
      }
      if (request.endsWith('query-promise.cjs') && parent && DRIZZLE_FILE.test(parent.filename)) {
        patchDrizzle(exported.QueryPromise);
      }
      const dual = DUAL_BUILDS.find((lib) => lib.name === request);
      if (dual) patchDualBuild(dual, Module._resolveFilename(request, parent));
    } catch {}
    return exported;
  };
  // …and the app's copies right away (ESM imports of these share the CommonJS cache).
  const appRequire = Module.createRequire(path.join(cwd, 'noop.js'));
  for (const lib of PACKAGES) {
    try {
      lib.patch(appRequire(lib.name), monitor);
    } catch {
      // Not installed (yet); the require hook still applies.
    }
  }
  // node:sqlite warns when it loads, so it's only patched once the app has loaded it: an ES
  // module importing it is linked before this runs; a later import, by the next turn.
  const patchNodeSqlite = () => {
    if (sqlite.builtinLoaded('sqlite')) sqlite.patchNodeSqlite(require('node:sqlite'), monitor);
  };
  patchNodeSqlite();
  setImmediate(patchNodeSqlite).unref();
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
  for (const lib of DUAL_BUILDS) {
    try {
      patchDualBuild(lib, appRequire.resolve(lib.name));
    } catch {
      // Not installed; the require hook still applies.
    }
  }
  instrumentHttp(monitor);
  return api;
}

/** Send what's buffered now (serverless handlers, graceful shutdown). */
function flush() {
  const sdk = globalThis[GLOBAL];
  return sdk ? sdk.flush() : Promise.resolve();
}

module.exports = { init, flush, withTransaction, routeOf, paramText, errorText, rowCount, _internal: { patchPg, patchPool, patchMysql2, patchPostgres, patchDrizzle, patchNeon: neon.patchNeon, patchPlanetScale: planetscale.patchPlanetScale, patchLibsql: libsql.patchLibsql, ...sqlite, mysqlRows, postgresRows, siteOf, lazySite, operations, requestContext, activeMonitor } };
