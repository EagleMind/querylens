// libSQL / Turso (`@libsql/client`, and Drizzle's libsql driver and Prisma's libsql adapter on
// top of it). One client class per transport, each with `execute` and `batch`: HTTP and
// WebSocket (Turso, sqld) and local files (`file:`, through the `libsql` native module), and
// their transactions. A batch is timed as one and its time shared among its statements.
'use strict';

const { connectionIds, paramList, settle, startBatch, startStatement } = require('./record.cjs');

/** Files holding the clients, in each of the package's builds. */
const BUILDS = ['http', 'ws', 'sqlite3', 'hrana'].flatMap((f) => [`lib-cjs/${f}.js`, `lib-esm/${f}.js`]);

/** Which methods to patch on which class. Hrana transactions run `execute` through `batch`. */
const CLASSES = {
  HttpClient: ['execute', 'batch'],
  WsClient: ['execute', 'batch'],
  Sqlite3Client: ['execute', 'batch'],
  Sqlite3Transaction: ['execute', 'batch'],
  HranaTransaction: ['batch'],
};

/** `{ sql, params }` from what `execute` and `batch` take: a string, `{ sql, args }` or `[sql, args]`. */
function libsqlStatement(stmt, args) {
  if (typeof stmt === 'string') return { sql: stmt, params: paramList(args) };
  if (Array.isArray(stmt) && typeof stmt[0] === 'string') return { sql: stmt[0], params: paramList(stmt[1]) };
  if (stmt && typeof stmt.sql === 'string') return { sql: stmt.sql, params: paramList(stmt.args) };
  return null;
}

/** Rows in a ResultSet: rows read, or rows written. */
function libsqlRows(res) {
  if (!res) return 0;
  return Array.isArray(res.rows) && res.rows.length > 0 ? res.rows.length : Number(res.rowsAffected) || 0;
}

function patchClass(Class, methods, monitor, connOf) {
  const proto = Class && Class.prototype;
  if (typeof Class !== 'function' || !proto) return;
  for (const method of methods) {
    const original = proto[method];
    if (typeof original !== 'function' || original.__querylens) continue;
    let wrapped;
    if (method === 'execute') {
      wrapped = function (stmt, args) {
        const s = libsqlStatement(stmt, args);
        if (!s) return original.apply(this, arguments);
        const finish = startStatement(monitor, { ...s, dialect: 'sqlite', conn: connOf(this) });
        return settle(original.apply(this, arguments), finish, libsqlRows);
      };
    } else {
      wrapped = function (stmts) {
        const statements = Array.isArray(stmts) ? stmts.map((s) => libsqlStatement(s)) : [];
        if (statements.length === 0 || statements.includes(null)) return original.apply(this, arguments);
        const finish = startBatch(monitor, statements, { dialect: 'sqlite', conn: connOf(this) });
        const result = original.apply(this, arguments);
        if (result && typeof result.then === 'function') {
          result.then(
            (sets) => finish(null, Array.isArray(sets) ? sets.map(libsqlRows) : 0),
            (err) => finish(err, 0),
          );
        }
        return result;
      };
    }
    wrapped.__querylens = true;
    proto[method] = wrapped;
  }
}

/** Patch one file's exports (one transport of one build). */
function patchLibsql(exports, monitor) {
  if (!exports || typeof exports !== 'object') return exports;
  const connOf = connectionIds();
  for (const [name, methods] of Object.entries(CLASSES)) patchClass(exports[name], methods, monitor, connOf);
  return exports;
}

module.exports = { patchLibsql, libsqlStatement, libsqlRows, BUILDS };
