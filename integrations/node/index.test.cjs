// node --test "integrations/node/*.test.cjs"
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const sdk = require('./index.cjs');

test('routes group requests by replacing ids', () => {
  assert.equal(sdk.routeOf({ method: 'GET', url: '/users/42/orders?page=2' }), 'GET /users/:id/orders');
  assert.equal(sdk.routeOf({ method: 'PATCH', url: '/orders/3f2b8c1e-0b7a-4d3e-9c5f-2a1b0c9d8e7f' }), 'PATCH /orders/:id');
});

test('values, errors and row counts are reported like the server would', () => {
  assert.equal(sdk.paramText(new Date(0)), '1970-01-01T00:00:00.000Z');
  assert.equal(sdk.paramText(Buffer.from([1, 255])), '\\x01ff');
  assert.equal(sdk.paramText({ a: 1 }), '{"a":1}');
  assert.equal(sdk.paramText(null), null);
  assert.equal(sdk.errorText({ severity: 'ERROR', message: 'duplicate key', code: '23505' }), 'ERROR: duplicate key (23505)');
  assert.equal(sdk.rowCount({ rowCount: 3 }), 3);
  assert.equal(sdk.rowCount([{ rowCount: 1 }, { rows: [1, 2] }]), 3);
});

test('promise and callback queries are recorded and sent unchanged', async () => {
  const recorded = [];
  const monitor = { record: (txn, q) => recorded.push(q) };
  const sent = [];
  class Client {
    query(config, values, callback) {
      sent.push(typeof config === 'string' ? config : config.text);
      const cb = [values, callback].find((a) => typeof a === 'function');
      const text = typeof config === 'string' ? config : config.text;
      const err = text.includes('missing') ? Object.assign(new Error('relation "missing" does not exist'), { code: '42P01' }) : null;
      const res = err ? null : { rowCount: 2, rows: [{}, {}] };
      if (cb) return setImmediate(() => cb(err, res));
      return err ? Promise.reject(err) : Promise.resolve(res);
    }
  }
  sdk._internal.patchPg({ Client }, monitor);
  const client = new Client();
  await client.query('SELECT * FROM orders WHERE user_id = $1', [42]);
  await client.query({ text: 'SELECT * FROM missing' }).catch(() => {});
  await new Promise((resolve) => client.query('SELECT 1', resolve));

  assert.deepEqual(sent, ['SELECT * FROM orders WHERE user_id = $1', 'SELECT * FROM missing', 'SELECT 1']);
  assert.equal(recorded.length, 3);
  assert.deepEqual(recorded[0].params, ['42']);
  assert.equal(recorded[0].rows, 2);
  assert.match(recorded[0].origin(), /index\.test\.cjs:\d+$/);
  assert.equal(recorded[1].error, 'ERROR: relation "missing" does not exist (42P01)');
  assert.ok(recorded.every((q) => q.conn === 1 && q.durationMs >= 0));
});

test('without a DSN the SDK stays off', () => {
  const saved = process.env.QUERYLENS_DSN;
  delete process.env.QUERYLENS_DSN;
  delete globalThis[Symbol.for('querylens.sdk')];
  try {
    assert.equal(sdk.init().enabled, false);
  } finally {
    delete globalThis[Symbol.for('querylens.sdk')];
    if (saved !== undefined) process.env.QUERYLENS_DSN = saved;
  }
});

test('mysql2: callbacks, pool commands and emitters are recorded, as MySQL', async () => {
  const { EventEmitter } = require('node:events');
  const recorded = [];
  const monitor = { record: (txn, q) => recorded.push(q) };
  class Query extends EventEmitter {
    constructor(options, cb) {
      super();
      this.sql = options.sql;
      this.values = options.values;
      this.onResult = cb;
    }
  }
  // Like mysql2: query/execute on a base class, Connection extends it.
  class BaseConnection {
    query(sql, values, cb) {
      const cmd = sql instanceof Query ? sql : new Query({ sql, values: Array.isArray(values) ? values : undefined }, typeof values === 'function' ? values : cb);
      setImmediate(() => {
        const rows = cmd.sql.startsWith('INSERT') ? { affectedRows: 3 } : [{ id: 1 }, { id: 2 }];
        if (cmd.onResult) return cmd.onResult(null, rows, []);
        for (const r of Array.isArray(rows) ? rows : [rows]) cmd.emit('result', r);
        cmd.emit('end');
      });
      return cmd;
    }
    execute(sql, values, cb) {
      setImmediate(() => cb(Object.assign(new Error("Duplicate entry 'ada@x.io' for key 'users.email'"), { code: 'ER_DUP_ENTRY' })));
    }
  }
  class Connection extends BaseConnection {}
  sdk._internal.patchMysql2({ Connection }, monitor);
  const conn = new Connection();

  await new Promise((ok) => conn.query('SELECT * FROM `users` WHERE `id` = ?', [7], ok));
  await new Promise((ok) => conn.query(new Query({ sql: 'INSERT INTO `events` (`kind`) VALUES (?)', values: ['x'] }, ok)));
  await new Promise((ok) => conn.query('SELECT 1').once('end', ok));
  await new Promise((ok) => conn.execute('INSERT INTO `users` (`email`) VALUES (?)', ['ada@x.io'], ok));

  assert.equal(recorded.length, 4);
  assert.ok(recorded.every((q) => q.dialect === 'mysql'));
  assert.deepEqual(recorded[0].params, ['7']);
  assert.equal(recorded[0].rows, 2);
  assert.equal(recorded[1].rows, 3, 'affected rows of the pool command');
  assert.equal(recorded[2].rows, 2, 'rows counted from result events');
  assert.equal(recorded[3].error, "ERROR: Duplicate entry 'ada@x.io' for key 'users.email' (ER_DUP_ENTRY)");
  assert.match(recorded[0].origin(), /index\.test\.cjs:\d+$/);
  assert.equal(sdk._internal.mysqlRows([[{}, {}], { affectedRows: 4 }]), 6, 'multiple statements');
});
