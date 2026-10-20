// SQLite: better-sqlite3 (Drizzle, Kysely, MikroORM), sqlite3 (Sequelize, TypeORM, Knex) and
// Node's own node:sqlite. Each runs prepared statements whose SQL it keeps (`source`, `sql`,
// `sourceSQL`), so the statement methods are patched once, on their prototype:
// - better-sqlite3 and node:sqlite are synchronous: timed around the call. Iterators are
//   timed until the last row is read, or the loop stops.
// - sqlite3 calls back: timed until its completion callback. A call without one is left
//   alone, since adding a callback would change how its errors are reported.
'use strict';

const { inCallerContext } = require('../context.cjs');
const { connectionIds, paramList, startStatement } = require('./record.cjs');

/** Values bound in a statement call: positional arguments, an array, or one object of named values. */
function boundValues(args) {
  if (args.length === 1) return paramList(args[0]);
  return args.flatMap((a) => paramList(a));
}

/** Rows a synchronous statement call returned or changed. */
function syncRows(method, res) {
  if (method === 'all') return Array.isArray(res) ? res.length : 0;
  if (method === 'get') return res === undefined ? 0 : 1;
  return res && typeof res.changes === 'number' ? res.changes : 0;
}

/** An iterator that records its statement when it's exhausted, returned early, or throws. */
function countedIterator(it, finish) {
  let rows = 0;
  return {
    next() {
      try {
        const r = it.next();
        if (r.done) finish(null, rows);
        else rows++;
        return r;
      } catch (e) {
        finish(e, rows);
        throw e;
      }
    },
    return(value) {
      finish(null, rows);
      return typeof it.return === 'function' ? it.return(value) : { done: true, value };
    },
    [Symbol.iterator]() {
      return this;
    },
  };
}

/**
 * Patch the synchronous statement methods on `proto`. `sqlOf(stmt)` and `dbOf(stmt)` read
 * a statement's SQL and its database (for the connection number).
 */
function patchSyncStatement(proto, monitor, sqlOf, dbOf) {
  if (!proto || typeof proto.run !== 'function' || proto.run.__querylens) return;
  const connOf = connectionIds();
  for (const method of ['run', 'get', 'all', 'iterate']) {
    const original = proto[method];
    if (typeof original !== 'function') continue;
    proto[method] = function (...args) {
      let sql;
      try {
        sql = sqlOf(this);
      } catch {}
      if (typeof sql !== 'string') return original.apply(this, args);
      const finish = startStatement(monitor, { sql, params: boundValues(args), dialect: 'sqlite', conn: connOf(dbOf(this)) });
      let res;
      try {
        res = original.apply(this, args);
      } catch (e) {
        finish(e, 0);
        throw e;
      }
      if (method === 'iterate') return res && typeof res.next === 'function' ? countedIterator(res, finish) : res;
      finish(null, syncRows(method, res));
      return res;
    };
    proto[method].__querylens = true;
  }
}

/** Patch a synchronous `exec(sql)` (several statements, no values). */
function patchSyncExec(proto, monitor) {
  const exec = proto && proto.exec;
  if (typeof exec !== 'function' || exec.__querylens) return;
  const connOf = connectionIds();
  proto.exec = function (sql) {
    if (typeof sql !== 'string') return exec.apply(this, arguments);
    const finish = startStatement(monitor, { sql, params: [], dialect: 'sqlite', conn: connOf(this) });
    try {
      const res = exec.apply(this, arguments);
      finish(null, 0);
      return res;
    } catch (e) {
      finish(e, 0);
      throw e;
    }
  };
  proto.exec.__querylens = true;
}

/**
 * Patch a synchronous `prepare(sql)`: SQL that can't be prepared (a syntax error, a missing
 * column) throws here, before any statement runs, so it's recorded as a failed statement.
 * `onStatement(stmt)` sees each statement prepared.
 */
function patchSyncPrepare(proto, monitor, onStatement) {
  const prepare = proto && proto.prepare;
  if (typeof prepare !== 'function' || prepare.__querylens) return;
  proto.prepare = function (sql) {
    let stmt;
    try {
      stmt = prepare.apply(this, arguments);
    } catch (e) {
      if (typeof sql === 'string') startStatement(monitor, { sql, params: [], dialect: 'sqlite' })(e, 0);
      throw e;
    }
    try {
      onStatement(stmt);
    } catch {}
    return stmt;
  };
  proto.prepare.__querylens = true;
}

/** better-sqlite3: its Statement class is native and only reachable from a statement, so it's patched on the first `prepare`. */
function patchBetterSqlite3(Database, monitor) {
  const proto = Database && Database.prototype;
  if (typeof Database !== 'function' || typeof proto.prepare !== 'function' || proto.prepare.__querylens) return Database;
  patchSyncPrepare(proto, monitor, (stmt) =>
    patchSyncStatement(
      Object.getPrototypeOf(stmt),
      monitor,
      (s) => s.source,
      (s) => s.database,
    ),
  );
  patchSyncExec(proto, monitor);
  return Database;
}

/** node:sqlite: DatabaseSync and StatementSync. */
function patchNodeSqlite(sqlite, monitor) {
  if (!sqlite || typeof sqlite.StatementSync !== 'function') return sqlite;
  patchSyncStatement(
    sqlite.StatementSync.prototype,
    monitor,
    (s) => s.sourceSQL,
    () => null,
  );
  if (sqlite.DatabaseSync) {
    patchSyncPrepare(sqlite.DatabaseSync.prototype, monitor, () => {});
    patchSyncExec(sqlite.DatabaseSync.prototype, monitor);
  }
  return sqlite;
}

/** Rows an sqlite3 call returned or changed, from its completion callback. */
function callbackRows(method, stmt, res) {
  if (method === 'all') return Array.isArray(res) ? res.length : 0;
  if (method === 'get') return res === undefined ? 0 : 1;
  if (method === 'each') return typeof res === 'number' ? res : 0;
  return stmt && typeof stmt.changes === 'number' ? stmt.changes : 0;
}

/** Index of the completion callback in `args`: the last function (`each` takes a row callback before it). */
function completionIndex(method, args) {
  const fns = args.map((a, i) => (typeof a === 'function' ? i : -1)).filter((i) => i >= 0);
  if (method === 'each') return fns.length >= 2 ? fns[fns.length - 1] : -1;
  return fns.length ? fns[fns.length - 1] : -1;
}

/**
 * sqlite3. Database#run/get/all/each prepare a Statement and run it; a statement that
 * can't be prepared (a syntax error) reports to the Database call's callback only, so
 * those are patched, and Statement#run/get/all/each for prepared statements run again.
 * A Database call runs its statement synchronously inside: it's recorded once, there.
 */
function patchSqlite3(sqlite3, monitor) {
  const { Statement, Database } = sqlite3 || {};
  if (typeof Statement !== 'function' || typeof Database !== 'function' || Statement.prototype.run.__querylens) return sqlite3;
  let inDatabaseCall = false;

  const wrap = (proto, method, sqlOf, paramsOf, nested) => {
    const original = proto[method];
    if (typeof original !== 'function') return;
    proto[method] = function (...args) {
      const done = completionIndex(method, args);
      const sql = sqlOf(this, args);
      if (inDatabaseCall || done === -1 || typeof sql !== 'string') return original.apply(this, args);
      const finish = startStatement(monitor, { sql, params: paramsOf(args, done), dialect: 'sqlite' });
      const callback = inCallerContext(args[done]);
      args[done] = function (err, res) {
        finish(err, callbackRows(method, this, res));
        return callback.apply(this, arguments);
      };
      if (!nested) return original.apply(this, args);
      inDatabaseCall = true;
      try {
        return original.apply(this, args);
      } finally {
        inDatabaseCall = false;
      }
    };
    proto[method].__querylens = true;
  };

  const firstFn = (args) => args.findIndex((a) => typeof a === 'function');
  for (const method of ['run', 'get', 'all', 'each']) {
    wrap(Statement.prototype, method, (stmt) => stmt.sql, (args) => boundValues(args.slice(0, firstFn(args))), false);
    wrap(Database.prototype, method, (db, args) => args[0], (args) => boundValues(args.slice(1, firstFn(args))), true);
  }
  wrap(Database.prototype, 'exec', (db, args) => args[0], () => [], false);
  return sqlite3;
}

/** Whether Node has loaded one of its own modules, without loading it (node:sqlite warns when it loads). */
function builtinLoaded(name) {
  return Array.isArray(process.moduleLoadList) && process.moduleLoadList.includes(`NativeModule ${name}`);
}

module.exports = { patchBetterSqlite3, patchNodeSqlite, patchSqlite3, builtinLoaded, boundValues };
