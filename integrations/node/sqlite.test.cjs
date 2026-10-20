// node --test "integrations/node/*.test.cjs"
// SQLite drivers, with fakes shaped like the real ones (checked against better-sqlite3 13,
// sqlite3 6 and node:sqlite in Node 22).
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

const { requestContext } = require('./context.cjs');
const { patchBetterSqlite3, patchNodeSqlite, patchSqlite3, boundValues } = require('./drivers/sqlite.cjs');

function recorder() {
  const recorded = [];
  return { recorded, monitor: { record: (txn, q) => recorded.push({ txn, ...q, origin: q.origin() }) } };
}

const HERE = /sqlite\.test\.cjs:\d+$/;
const ROWS = [{ id: 1 }, { id: 2 }];

/** better-sqlite3 and node:sqlite statements: synchronous, keeping their SQL. */
function syncStatementClass(sqlKey) {
  return class Statement {
    constructor(sql, database) {
      this[sqlKey] = sql;
      this.database = database;
    }
    run() {
      return { changes: 1 };
    }
    get() {
      return ROWS[0];
    }
    all() {
      if (this[sqlKey].includes('locked')) throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
      return ROWS;
    }
    *iterate() {
      yield* ROWS;
    }
  };
}

function syncDatabaseClass(Statement) {
  return class Database {
    prepare(sql) {
      if (sql.includes('nope')) throw Object.assign(new Error('no such column: nope'), { code: 'SQLITE_ERROR' });
      return new Statement(sql, this);
    }
    exec() {
      return this;
    }
  };
}

test('better-sqlite3: statements are timed around each call, failed prepares recorded', () => {
  const Database = syncDatabaseClass(syncStatementClass('source'));
  const { recorded, monitor } = recorder();
  patchBetterSqlite3(Database, monitor);
  requestContext.run({ txn: 't' }, () => {
    const db = new Database();
    db.exec('CREATE TABLE t (id INTEGER)');
    const insert = db.prepare('INSERT INTO t (id) VALUES (?)');
    insert.run(1);
    insert.run(2);
    assert.deepEqual(db.prepare('SELECT * FROM t WHERE id > @min').all({ min: 0 }), ROWS, 'results unchanged');
    assert.throws(() => db.prepare('SELECT * FROM locked').all());
    let n = 0;
    for (const row of db.prepare('SELECT * FROM t').iterate()) n += row.id;
    assert.equal(n, 3);
    assert.throws(() => db.prepare('SELECT nope FROM t'));
  });
  assert.deepEqual(
    recorded.map((q) => [q.txn, q.sql, q.params, q.rows, q.error]),
    [
      ['t', 'CREATE TABLE t (id INTEGER)', [], 0, null],
      ['t', 'INSERT INTO t (id) VALUES (?)', ['1'], 1, null],
      ['t', 'INSERT INTO t (id) VALUES (?)', ['2'], 1, null],
      ['t', 'SELECT * FROM t WHERE id > @min', ['0'], 2, null],
      ['t', 'SELECT * FROM locked', [], 0, 'ERROR: database is locked (SQLITE_BUSY)'],
      ['t', 'SELECT * FROM t', [], 2, null],
      ['t', 'SELECT nope FROM t', [], 0, 'ERROR: no such column: nope (SQLITE_ERROR)'],
    ],
  );
  assert.ok(recorded.every((q) => q.dialect === 'sqlite' && HERE.test(q.origin)));
  assert.equal(new Set(recorded.slice(1, 4).map((q) => q.conn)).size, 1, 'one connection number per database');
});

test('node:sqlite: StatementSync and DatabaseSync', () => {
  const StatementSync = syncStatementClass('sourceSQL');
  const DatabaseSync = syncDatabaseClass(StatementSync);
  const { recorded, monitor } = recorder();
  patchNodeSqlite({ StatementSync, DatabaseSync }, monitor);
  const db = new DatabaseSync();
  db.prepare('SELECT * FROM t WHERE id = ?').get(5);
  assert.deepEqual(
    recorded.map((q) => [q.sql, q.params, q.rows]),
    [['SELECT * FROM t WHERE id = ?', ['5'], 1]],
  );
});

test('sqlite3: recorded when the callback runs, once per statement, syntax errors included', async () => {
  // sqlite3's shape: Database#run/get/all/each prepare a Statement and run it right away;
  // a statement that can't be prepared reports to the Database call's callback only.
  class Statement {
    constructor(db, sql, errBack) {
      this.sql = sql;
      this.broken = sql.startsWith('SELEC ');
      if (this.broken && errBack) setImmediate(() => errBack(new Error('SQLITE_ERROR: near "SELEC": syntax error')));
    }
    run(...args) {
      const cb = args.findLast((a) => typeof a === 'function');
      if (!this.broken && cb) setImmediate(() => cb.call({ changes: 3 }, null));
      return this;
    }
    get(...args) {
      const cb = args.findLast((a) => typeof a === 'function');
      if (!this.broken && cb) setImmediate(() => cb.call(this, null, ROWS[0]));
      return this;
    }
    all(...args) {
      const cb = args.findLast((a) => typeof a === 'function');
      if (!this.broken && cb) setImmediate(() => cb.call(this, null, ROWS));
      return this;
    }
    each(...args) {
      const fns = args.filter((a) => typeof a === 'function');
      if (fns.length >= 2) setImmediate(() => fns[1].call(this, null, ROWS.length));
      return this;
    }
  }
  class Database {
    exec(sql, cb) {
      setImmediate(() => cb.call(this, null));
      return this;
    }
  }
  for (const method of ['run', 'get', 'all', 'each']) {
    Database.prototype[method] = function (sql, ...args) {
      const cb = args[args.length - 1];
      const errBack = typeof cb === 'function' ? (err) => err && cb(err) : undefined;
      new Statement(this, sql, errBack)[method](...args);
      return this;
    };
  }
  const { recorded, monitor } = recorder();
  patchSqlite3({ Statement, Database }, monitor);
  const db = new Database();
  const call = (fn) => new Promise((ok) => fn(ok));
  await requestContext.run({ txn: 't' }, async () => {
    await call((ok) => db.exec('CREATE TABLE u (id INTEGER)', ok));
    await call((ok) => db.run('UPDATE u SET id = ? WHERE id = ?', [1, 2], ok));
    await call((ok) => db.all('SELECT * FROM u WHERE id > ?', 0, ok));
    await call((ok) => db.get('SELEC broken', ok));
    await call((ok) => db.each('SELECT * FROM u', () => {}, ok));
    const stmt = new Statement(db, 'SELECT * FROM u WHERE id = ?');
    await call((ok) => stmt.get(7, ok));
    db.run('DELETE FROM u');
  });
  assert.deepEqual(
    recorded.map((q) => [q.txn, q.sql, q.params, q.rows, q.error]),
    [
      ['t', 'CREATE TABLE u (id INTEGER)', [], 0, null],
      ['t', 'UPDATE u SET id = ? WHERE id = ?', ['1', '2'], 3, null],
      ['t', 'SELECT * FROM u WHERE id > ?', ['0'], 2, null],
      ['t', 'SELEC broken', [], 0, 'ERROR: SQLITE_ERROR: near "SELEC": syntax error'],
      ['t', 'SELECT * FROM u', [], 2, null],
      ['t', 'SELECT * FROM u WHERE id = ?', ['7'], 1, null],
    ],
    'a call without a callback is left alone',
  );
  assert.ok(recorded.every((q) => HERE.test(q.origin)));
});

test('bound values: positional, an array, or named', () => {
  assert.deepEqual(boundValues([1, 'a']), [1, 'a']);
  assert.deepEqual(boundValues([[1, 'a']]), [1, 'a']);
  assert.deepEqual(boundValues([{ id: 1, name: 'a' }]), [1, 'a']);
  assert.deepEqual(boundValues([]), []);
});
