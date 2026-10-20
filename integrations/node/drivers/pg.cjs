// node-postgres (`pg`): Sequelize, Knex, TypeORM, MikroORM, Drizzle and Prisma's pg adapter on
// PostgreSQL use it, and so does Neon's WebSocket driver (a bundled copy).
'use strict';

const { performance } = require('perf_hooks');

const { requestContext, lazySite, inCallerContext, paramText, errorText } = require('../context.cjs');
const { patchPool } = require('./pool.cjs');

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

module.exports = { patchPg, rowCount };
