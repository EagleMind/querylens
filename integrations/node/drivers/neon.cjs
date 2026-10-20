// Neon's serverless driver (`@neondatabase/serverless`, also under Vercel Postgres and
// Drizzle's neon-http and neon-serverless drivers). Its WebSocket `Pool` and `Client` are a
// bundled copy of node-postgres, hooked like `pg`. Its HTTP queries (`neon()`: the `sql`
// tag and `sql.query`) are lazy thenables, `NeonQueryPromise`, run each time they're
// awaited: the app's line is taken when `await` reads `then`, as for Drizzle, and the
// timing covers the HTTP round trip.
'use strict';

const { lazySite } = require('../context.cjs');
const { patchPg } = require('./pg.cjs');
const { startStatement, settle } = require('./record.cjs');

/** Files holding the driver, in each of its builds. */
const BUILDS = ['index.js', 'index.mjs'];

/** `{ query, params }` for a NeonQueryPromise's query: a tagged template or a `sql.query` call. */
function neonQuery(data) {
  if (!data) return null;
  if (typeof data.toParameterizedQuery === 'function') return data.toParameterizedQuery();
  return typeof data.query === 'string' ? { query: data.query, params: Array.isArray(data.params) ? data.params : [] } : null;
}

/** Rows in a Neon HTTP result: an array of rows, or (`fullResults`) a pg-style result. */
function neonRows(res) {
  if (Array.isArray(res)) return res.length;
  if (res && typeof res.rowCount === 'number') return res.rowCount;
  return res && Array.isArray(res.rows) ? res.rows.length : 0;
}

function patchQueryPromise(NeonQueryPromise, monitor) {
  const proto = NeonQueryPromise && NeonQueryPromise.prototype;
  const desc = proto && Object.getOwnPropertyDescriptor(proto, 'then');
  // Already patched (a getter), or not the class this was written for.
  if (typeof NeonQueryPromise !== 'function' || !desc || typeof desc.value !== 'function') return;
  const then = desc.value;

  Object.defineProperty(proto, 'then', {
    configurable: true,
    enumerable: desc.enumerable,
    get() {
      // Read by `await` in the code that awaits: its line is on the stack now.
      const site = lazySite();
      return function (onFulfilled, onRejected) {
        const q = neonQuery(this.queryData);
        if (!q || typeof this.execute !== 'function') return then.apply(this, arguments);
        const finish = startStatement(monitor, { sql: q.query, params: q.params, dialect: 'postgres', site });
        return settle(this.execute(this.queryData, this.opts), finish, neonRows).then(onFulfilled, onRejected);
      };
    },
    set(value) {
      Object.defineProperty(this, 'then', { value, writable: true, enumerable: true, configurable: true });
    },
  });
  // `catch` and `finally` run the query too: through `then`, so they're recorded the same way.
  proto.catch = function (onRejected) {
    return this.then(undefined, onRejected);
  };
  proto.finally = function (onFinally) {
    return Promise.prototype.finally.call(this.then(), onFinally);
  };
}

/** Patch one build's exports. */
function patchNeon(neon, monitor) {
  if (!neon || typeof neon !== 'object') return neon;
  if (typeof neon.Client === 'function') patchPg({ Client: neon.Client, Pool: neon.Pool }, monitor);
  patchQueryPromise(neon.NeonQueryPromise, monitor);
  return neon;
}

module.exports = { patchNeon, neonQuery, neonRows, BUILDS };
