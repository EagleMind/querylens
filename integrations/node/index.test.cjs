// node --test "integrations/node/*.test.cjs"
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const vm = require('vm');
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

test('postgres.js: tagged, unsafe and failing queries are recorded where they were written', async () => {
  const recorded = [];
  const monitor = { record: (txn, q) => recorded.push(q) };
  // Like postgres.js: a lazy Promise subclass, run on its first then() by a connection.
  class Query extends Promise {
    constructor(strings, args, handler) {
      let resolve;
      let reject;
      super((a, b) => {
        resolve = a;
        reject = b;
      });
      this.tagged = Array.isArray(strings.raw);
      this.strings = strings;
      this.args = args;
      this.handler = handler;
      this.executed = false;
      this.resolve = (x) => resolve(x);
      this.reject = (x) => reject(x);
    }
    static get [Symbol.species]() {
      return Promise;
    }
    async handle() {
      !this.executed && (this.executed = true) && (await 1) && this.handler(this);
    }
    then() {
      this.handle();
      return super.then.apply(this, arguments);
    }
  }
  const backends = [{ pid: 101 }, { pid: 102 }];
  const result = (rows, command, count) => Object.defineProperties(rows, { command: { value: command }, count: { value: count } });
  const handler = (q) => {
    q.string = q.tagged ? q.strings.reduce((s, part, i) => `${s}$${i}${part}`) : q.strings[0];
    q.parameters = q.args.map(String);
    q.state = backends[q.string.includes('orders') ? 1 : 0];
    setImmediate(() => {
      if (q.string.includes('missing')) q.reject(Object.assign(new Error('relation "missing" does not exist'), { severity: 'ERROR', code: '42P01' }));
      else if (q.string.startsWith('update')) q.resolve(result([], 'UPDATE', 3));
      else if (q.string.includes(';')) q.resolve([result([{}], 'SELECT', 1), result([{}, {}], 'SELECT', 2), result([], null, null)]);
      else q.resolve(result([{ id: 1 }, { id: 2 }], 'SELECT', 2));
    });
  };
  function execute(q) {
    q.string = q.strings[0];
    setImmediate(() => q.resolve(result([], 'SELECT', 0)));
  }
  const sql = (strings, ...args) => new Query(strings, args, handler);
  const unsafe = (text, args = []) => new Query([text], args, handler);

  const before = sql`select 0`;
  sdk._internal.patchPostgres(Query, monitor);
  assert.strictEqual(sdk._internal.patchPostgres(Query, monitor), Query, 'patching twice is a no-op');

  const rows = await sql`select * from users where id = ${42}`;
  assert.deepEqual([...rows], [{ id: 1 }, { id: 2 }], 'results unchanged');
  await unsafe('select * from orders where user_id = $1', [7]);
  await assert.rejects(sql`select * from missing`, /relation "missing" does not exist/);
  await sql`update users set seen = true where id = ${1}`;
  await unsafe('select 1; select 1, 2');
  await new Query(['select typarray from pg_type'], [], execute);
  await before;
  const fragment = sql`and id = ${1}`; // embedded in another query, never run itself

  assert.ok(fragment instanceof Query && fragment instanceof Promise);
  assert.equal(recorded.length, 5, 'internal, unpatched and unrun queries are left out');
  assert.ok(recorded.every((q) => q.dialect === 'postgres' && q.durationMs >= 0));
  assert.equal(recorded[0].sql, 'select * from users where id = $1');
  assert.deepEqual(recorded[0].params, ['42']);
  assert.equal(recorded[0].rows, 2);
  assert.match(recorded[0].origin(), /index\.test\.cjs:\d+$/);
  assert.deepEqual([recorded[0].conn, recorded[1].conn], [1, 2], 'one id per connection');
  assert.equal(recorded[2].error, 'ERROR: relation "missing" does not exist (42P01)');
  assert.equal(recorded[3].rows, 3, 'rows written');
  assert.equal(recorded[4].rows, 3, 'several statements');
});

test('postgres.js: queries join the request they were created in', async () => {
  const recorded = [];
  const monitor = { record: (txn, q) => recorded.push(txn), startTransaction: (name) => ({ name }), endTransaction() {} };
  globalThis[Symbol.for('querylens.sdk')] = { monitor };
  class Query extends Promise {
    constructor(strings, args, handler) {
      let resolve;
      super((a) => (resolve = a));
      this.strings = strings;
      this.handler = handler;
      this.resolve = resolve;
      this.reject = () => {};
    }
    static get [Symbol.species]() {
      return Promise;
    }
    async handle() {
      !this.executed && (this.executed = true) && (await 1) && this.handler(this);
    }
    then() {
      this.handle();
      return super.then.apply(this, arguments);
    }
  }
  const handler = (q) => setTimeout(() => q.resolve([]), 5);
  sdk._internal.patchPostgres(Query, monitor);
  try {
    // Two jobs at once: each query goes to its own.
    await Promise.all([
      sdk.withTransaction('job:a', () => new Query(['select 1'], [], handler)),
      sdk.withTransaction('job:b', () => new Query(['select 2'], [], handler)),
    ]);
  } finally {
    delete globalThis[Symbol.for('querylens.sdk')];
  }
  assert.deepEqual(recorded.map((t) => t.name).sort(), ['job:a', 'job:b']);
});


/** The line `offset` lines from the one calling this, as the SDK reports lines. */
function here(offset = 0) {
  const [message, , ...frames] = new Error().stack.split('\n');
  const [file, line] = sdk._internal.siteOf([message, ...frames].join('\n')).split(':');
  return `${file}:${Number(line) + offset}`;
}

/**
 * A stand-in for Drizzle, compiled as if it were in node_modules (its frames aren't the
 * app's): its QueryPromise, a query that runs its SQL in then() (which `await` calls from a
 * microtask, where no app frame is on the stack), a select builder that copies
 * QueryPromise's methods like Drizzle's mixins, and a transaction that awaits queries of its own.
 */
function fakeDrizzle(client) {
  const source = `
    class QueryPromise {
      catch(onRejected) { return this.then(undefined, onRejected); }
      then(onFulfilled, onRejected) { return this.execute().then(onFulfilled, onRejected); }
    }
    patchDrizzle(QueryPromise);
    class Raw extends QueryPromise {
      constructor(sql) { super(); this.sql = sql; }
      async execute() { return client.query(this.sql); }
    }
    class Select { constructor(sql) { this.sql = sql; } }
    for (const name of Object.getOwnPropertyNames(QueryPromise.prototype)) {
      if (name !== 'constructor') Object.defineProperty(Select.prototype, name, Object.getOwnPropertyDescriptor(QueryPromise.prototype, name));
    }
    Select.prototype.execute = Raw.prototype.execute;
    class Transaction extends QueryPromise {
      async execute() { await new Raw('begin'); return new Raw('commit'); }
    }
    return { QueryPromise, Raw, Select, Transaction };`;
  const filename = path.join(__dirname, 'node_modules', 'drizzle-orm', 'fake.cjs');
  return vm.compileFunction(source, ['client', 'patchDrizzle'], { filename })(client, sdk._internal.patchDrizzle);
}

test('drizzle: queries get the line that awaited them', async () => {
  const recorded = [];
  const monitor = { record: (txn, q) => recorded.push(q) };
  class Client {
    query(text) {
      if (text.includes('missing')) return Promise.reject(Object.assign(new Error('relation "missing" does not exist'), { code: '42P01' }));
      return Promise.resolve({ rowCount: 1, rows: [{ text }] });
    }
  }
  sdk._internal.patchPg({ Client }, monitor);
  const { Raw, Select, Transaction } = fakeDrizzle(new Client());
  const lines = [];

  const res = await new Select('select 1');
  lines.push(here(-1));
  await Promise.all([new Raw('select 2'), new Select('select 3')]);
  lines.push(here(-1), here(-1));
  const code = await new Raw('select * from missing').catch((e) => e.code);
  lines.push(here(-1));
  await new Transaction();
  lines.push(here(-1), here(-1));
  // The app's own queries after an await get their own line again.
  await new Client().query('select 4');
  lines.push(here(-1));

  assert.deepEqual(res.rows, [{ text: 'select 1' }], 'results are unchanged');
  assert.equal(code, '42P01', 'errors are unchanged');
  assert.equal(recorded[3].error, 'ERROR: relation "missing" does not exist (42P01)');
  assert.deepEqual(recorded.map((q) => q.sql), ['select 1', 'select 2', 'select 3', 'select * from missing', 'begin', 'commit', 'select 4']);
  assert.deepEqual(recorded.map((q) => q.origin()), lines);
});

test('drizzle: then() stays as it was', async () => {
  const { QueryPromise, Raw } = fakeDrizzle({ query: async () => 'ok' });
  const query = new Raw('select 1');
  assert.equal(typeof query.then, 'function');
  assert.equal(await query, 'ok');
  assert.equal(sdk._internal.patchDrizzle(QueryPromise), QueryPromise, 'patching twice does nothing');
  query.then = (resolve) => resolve('own');
  assert.equal(await query, 'own', 'an assigned then() is used');
  assert.equal(await new Raw('select 2'), 'ok');
});
