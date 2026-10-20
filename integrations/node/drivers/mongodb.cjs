// The MongoDB driver (`mongodb`, also what Mongoose runs on), through its own command
// monitoring: `connect()` turns `monitorCommands` on for the client, and each data command's
// started / succeeded / failed events become one statement (shaped by mongo-shape.cjs).
// The started event fires inside the operation that sent the command, so the request, the
// line of code and, under Mongoose, the model are read there. A cursor's later batches
// (`getMore`) are added to the query that opened it, which is recorded when the cursor is
// exhausted or closed. Write errors reported in a successful reply count as failures.
'use strict';

const { operations } = require('../context.cjs');
const { shapeCommand, replyRows, COMMANDS } = require('./mongo-shape.cjs');
const { connectionIds, startStatement } = require('./record.cjs');

/** Commands in flight, and cursors still open, at most. */
const MAX_PENDING = 1000;
const CLIENTS = new WeakSet();

const cursorId = (reply) => {
  const id = reply && reply.cursor && reply.cursor.id;
  if (id === undefined || id === null) return null;
  const text = typeof id === 'object' && typeof id.toString === 'function' ? id.toString() : String(id);
  return text === '0' ? null : text;
};

/** The error a reply reports for a write (`ok: 1` with `writeErrors`), if any. */
function writeError(reply) {
  const e = reply && ((Array.isArray(reply.writeErrors) && reply.writeErrors[0]) || reply.writeConcernError);
  return e ? Object.assign(new Error(e.errmsg || 'write error'), { code: e.code }) : null;
}

/** Listen to one client's command events (once per client). */
function watchClient(client, monitor) {
  if (CLIENTS.has(client) || typeof client.on !== 'function') return;
  CLIENTS.add(client);
  const connOf = connectionIds();
  const connKeys = new Map();
  /** requestId → in-flight statement */
  const inFlight = new Map();
  /** `address/cursor id` → the query that opened the cursor */
  const cursors = new Map();

  const connection = (event) => {
    const key = `${event.address}#${event.connectionId}`;
    let obj = connKeys.get(key);
    if (!obj) {
      if (connKeys.size >= MAX_PENDING) connKeys.clear();
      connKeys.set(key, (obj = {}));
    }
    return connOf(obj);
  };

  client.on('commandStarted', (event) => {
    try {
      const name = event.commandName;
      if (name === 'getMore') {
        const open = cursors.get(`${event.address}/${String(event.command.getMore)}`);
        if (open && inFlight.size < MAX_PENDING) inFlight.set(event.requestId, { getMore: open });
        return;
      }
      if (!COMMANDS.has(name)) return;
      const op = operations.getStore();
      // Under Mongoose, the model it went through, when it's this collection's.
      const model = op && op.model && op.collection === event.command[name] ? op.model : null;
      const shape = shapeCommand(name, event.command, model);
      if (!shape || inFlight.size >= MAX_PENDING) return;
      const finish = startStatement(monitor, { sql: shape.text, params: shape.values, dialect: 'mongo', conn: connection(event) });
      inFlight.set(event.requestId, { name, finish, rows: 0, durationMs: 0 });
    } catch {}
  });

  const settle = (event, err) => {
    const pending = inFlight.get(event.requestId);
    if (!pending) return;
    inFlight.delete(event.requestId);
    const stmt = pending.getMore || pending;
    const reply = err ? null : event.reply;
    stmt.durationMs += Number(event.duration) || 0;
    stmt.rows += replyRows(stmt.name, reply);
    const id = err ? null : cursorId(reply);
    const key = `${event.address}/${id}`;
    if (pending.getMore) {
      if (id) return;
      for (const [k, v] of cursors) if (v === stmt) cursors.delete(k);
    } else if (id && cursors.size < MAX_PENDING) {
      // More batches to come: recorded when the cursor is exhausted or killed.
      cursors.set(key, stmt);
      return;
    }
    stmt.finish(err || writeError(reply), stmt.rows, stmt.durationMs);
  };
  client.on('commandSucceeded', (event) => {
    try {
      if (event.commandName === 'killCursors') {
        for (const id of (event.reply && event.reply.cursorsKilled) || []) {
          const key = `${event.address}/${String(id)}`;
          const stmt = cursors.get(key);
          cursors.delete(key);
          if (stmt) stmt.finish(null, stmt.rows, stmt.durationMs);
        }
        return;
      }
      settle(event, null);
    } catch {}
  });
  client.on('commandFailed', (event) => {
    try {
      settle(event, event.failure || new Error('command failed'));
    } catch {}
  });
}

/** Patch `MongoClient.prototype.connect`: every client turns command monitoring on as it connects. */
function patchMongodb(mongodb, monitor) {
  const MongoClient = mongodb && mongodb.MongoClient;
  const proto = MongoClient && MongoClient.prototype;
  if (typeof MongoClient !== 'function' || typeof proto.connect !== 'function' || proto.connect.__querylens) return mongodb;
  const connect = proto.connect;
  proto.connect = function () {
    try {
      // Read by each connection as it's created: set before the first one is.
      if (!this.monitorCommands) this.monitorCommands = true;
      watchClient(this, monitor);
    } catch {}
    return connect.apply(this, arguments);
  };
  proto.connect.__querylens = true;
  return mongodb;
}

module.exports = { patchMongodb, watchClient };
