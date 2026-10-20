// What every driver hook shares: the request (transaction) a query belongs to, the ORM
// operation running, the line of application code that issued it, and how values and
// errors are written down. No hook depends on another; they all depend on this.
'use strict';

const path = require('path');
const url = require('url');
const { AsyncLocalStorage } = require('async_hooks');

const MAX_PARAM = 2000;

/** The request (or named job) running: `{ txn }`. */
const requestContext = new AsyncLocalStorage();
const cwd = process.cwd();
const DRIVERS = path.join(__dirname, 'drivers') + path.sep;
const SDK_FILES = new Set(
  ['index.cjs', 'context.cjs', 'monitor.cjs', 'scrub.cjs', 'source.cjs', 'prisma.cjs', 'register.cjs'].map((f) => path.join(__dirname, f)),
);

const isSdkFile = (file) => SDK_FILES.has(file) || file.startsWith(DRIVERS);

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
    if (isSdkFile(file) || file.includes('node_modules') || file.startsWith('node:') || !path.isAbsolute(file)) {
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

module.exports = { requestContext, operations, siteOf, stackSite, lazySite, inCallerContext, paramText, errorText };
