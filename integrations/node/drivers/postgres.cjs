// postgres.js (`postgres`), and Drizzle's postgres-js driver on top of it.
'use strict';

const path = require('path');
const { performance } = require('perf_hooks');

const { requestContext, lazySite, paramText, errorText } = require('../context.cjs');

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

module.exports = { patchPostgres, postgresRows, postgresQueryFile };
