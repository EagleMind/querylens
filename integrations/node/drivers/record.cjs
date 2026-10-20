// What a driver hook needs once it knows a statement is running: time it, and hand it to
// the monitor with its request, line of code and connection when it settles.
'use strict';

const { performance } = require('perf_hooks');

const { requestContext, lazySite, paramText, errorText } = require('../context.cjs');

/**
 * Start timing one statement. `dialect`: how its SQL is scrubbed ('postgres', 'mysql',
 * 'sqlite'). Returns `finish(err, rows)`, which records it once; later calls do nothing.
 * Call this where the statement is issued: the request and line are taken now.
 */
function startStatement(monitor, { sql, params, dialect, conn = 0, site, ctx }) {
  const origin = site || lazySite();
  const request = ctx === undefined ? requestContext.getStore() : ctx;
  const started = performance.now();
  let done = false;
  return (err, rows) => {
    if (done) return;
    done = true;
    try {
      monitor.record(request ? request.txn : null, {
        started,
        durationMs: performance.now() - started,
        sql,
        params: (params || []).map(paramText),
        rows: Number.isFinite(rows) ? rows : 0,
        error: errorText(err),
        origin,
        conn,
        dialect,
      });
    } catch {}
  };
}

/**
 * Start timing statements sent together (a batch). Returns `finish(err, rows)`, `rows` an
 * array (per statement) or a number: each is recorded with its share of the batch's time,
 * so the request's database time isn't counted once per statement.
 */
function startBatch(monitor, statements, { dialect, conn = 0, site, ctx }) {
  const origin = site || lazySite();
  const request = ctx === undefined ? requestContext.getStore() : ctx;
  const started = performance.now();
  let done = false;
  return (err, rows) => {
    if (done) return;
    done = true;
    try {
      const share = (performance.now() - started) / Math.max(1, statements.length);
      statements.forEach((s, i) => {
        monitor.record(request ? request.txn : null, {
          started: started + share * i,
          durationMs: share,
          sql: s.sql,
          params: (s.params || []).map(paramText),
          rows: Array.isArray(rows) && Number.isFinite(rows[i]) ? rows[i] : 0,
          // A failed batch: the error is the last statement's, the one that couldn't run.
          error: err && i === statements.length - 1 ? errorText(err) : null,
          origin,
          conn,
          dialect,
        });
      });
    } catch {}
  };
}

/** Small stable numbers for connection objects, so the dashboard can tell them apart. */
function connectionIds() {
  const ids = new WeakMap();
  let next = 0;
  return (obj) => {
    if (!obj || (typeof obj !== 'object' && typeof obj !== 'function')) return 0;
    let id = ids.get(obj);
    if (id === undefined) ids.set(obj, (id = ++next));
    return id;
  };
}

/** Bound values as an array, whether a driver took them positionally or by name. */
function paramList(args) {
  if (args === undefined || args === null) return [];
  if (Array.isArray(args)) return args;
  if (typeof args === 'object' && !Buffer.isBuffer(args) && !(args instanceof Date)) return Object.values(args);
  return [args];
}

/** `promise`, with `finish` called when it settles; the promise itself is returned unchanged. */
function settle(promise, finish, rowsOf) {
  if (promise && typeof promise.then === 'function') {
    promise.then(
      (res) => {
        let rows = 0;
        try {
          rows = rowsOf(res);
        } catch {}
        finish(null, rows);
      },
      (err) => finish(err, 0),
    );
  }
  return promise;
}

module.exports = { startStatement, startBatch, connectionIds, paramList, settle };
