// mysql2: Sequelize, Knex, TypeORM, MikroORM and Drizzle on MySQL use it.
'use strict';

const { performance } = require('perf_hooks');

const { requestContext, lazySite, inCallerContext, paramText, errorText } = require('../context.cjs');
const { patchPool } = require('./pool.cjs');

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

module.exports = { patchMysql2, mysqlRows };
