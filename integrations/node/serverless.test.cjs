// node --test "integrations/node/*.test.cjs"
// Serverless drivers, with fakes shaped like the real ones (checked against
// @neondatabase/serverless 1.2, @planetscale/database 2.0 and @libsql/client 0.18).
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { requestContext } = require('./context.cjs');
const { patchNeon } = require('./drivers/neon.cjs');
const { patchPlanetScale } = require('./drivers/planetscale.cjs');
const { patchLibsql } = require('./drivers/libsql.cjs');
const { packageRoot, patchBuilds } = require('./drivers/builds.cjs');

function recorder() {
  const recorded = [];
  return { recorded, monitor: { record: (txn, q) => recorded.push({ txn, ...q, origin: q.origin() }) } };
}

const HERE = /serverless\.test\.cjs:\d+$/;

test('Neon HTTP queries are recorded when awaited, with the line that awaited them', async () => {
  // Neon's NeonQueryPromise: runs `execute` each time it's awaited.
  class NeonQueryPromise {
    constructor(execute, queryData, opts) {
      Object.assign(this, { execute, queryData, opts });
    }
    then(a, b) {
      return this.execute(this.queryData, this.opts).then(a, b);
    }
    catch(b) {
      return this.execute(this.queryData, this.opts).catch(b);
    }
    finally(f) {
      return this.execute(this.queryData, this.opts).finally(f);
    }
  }
  class SqlTemplate {
    constructor(strings, values) {
      Object.assign(this, { strings, values });
    }
    toParameterizedQuery() {
      return { query: this.strings.reduce((q, s, i) => `${q}$${i}${s}`), params: this.values };
    }
  }
  const execute = async (data) => {
    const { query } = data.toParameterizedQuery ? data.toParameterizedQuery() : data;
    if (query.includes('missing')) throw Object.assign(new Error('relation "missing" does not exist'), { code: '42P01' });
    return [{ id: 1 }, { id: 2 }];
  };
  const sql = (strings, ...values) => new NeonQueryPromise(execute, new SqlTemplate(strings, values));
  sql.query = (query, params) => new NeonQueryPromise(execute, { query, params });

  const { recorded, monitor } = recorder();
  patchNeon({ NeonQueryPromise }, monitor);
  await requestContext.run({ txn: 't' }, async () => {
    const rows = await sql`SELECT id FROM orders WHERE user_id = ${7}`;
    assert.equal(rows.length, 2, 'results unchanged');
    await sql.query('SELECT $1::int', [3]);
    await sql`SELECT * FROM missing`.catch(() => {});
    const lazy = sql`SELECT 'never awaited'`;
    assert.ok(lazy);
  });
  assert.deepEqual(
    recorded.map((q) => [q.txn, q.sql, q.params, q.rows, q.error, q.dialect]),
    [
      ['t', 'SELECT id FROM orders WHERE user_id = $1', ['7'], 2, null, 'postgres'],
      ['t', 'SELECT $1::int', ['3'], 2, null, 'postgres'],
      ['t', 'SELECT * FROM missing', [], 0, 'ERROR: relation "missing" does not exist (42P01)', 'postgres'],
    ],
  );
  assert.ok(recorded.every((q) => HERE.test(q.origin)));
});

test('PlanetScale statements are recorded through Connection.execute', async () => {
  class Connection {
    async execute(query) {
      if (query.includes('nope')) throw Object.assign(new Error("Table 'nope' doesn't exist"), { status: 400 });
      return query.startsWith('SELECT') ? { rows: [{}, {}, {}], rowsAffected: 0 } : { rows: [], rowsAffected: 4 };
    }
  }
  const { recorded, monitor } = recorder();
  const ps = patchPlanetScale({ Connection }, monitor);
  assert.strictEqual(patchPlanetScale(ps, monitor), ps, 'patching twice is a no-op');
  const conn = new Connection();
  await conn.execute("SELECT * FROM users WHERE email = 'a@b.c'");
  await conn.execute('UPDATE users SET seen = 1 WHERE team = 3');
  await assert.rejects(conn.execute('SELECT * FROM nope'));
  assert.deepEqual(
    recorded.map((q) => [q.sql, q.rows, q.error, q.dialect, q.conn]),
    [
      ["SELECT * FROM users WHERE email = 'a@b.c'", 3, null, 'mysql', 1],
      ['UPDATE users SET seen = 1 WHERE team = 3', 4, null, 'mysql', 1],
      ['SELECT * FROM nope', 0, "ERROR: Table 'nope' doesn't exist", 'mysql', 1],
    ],
  );
  assert.ok(recorded.every((q) => HERE.test(q.origin)));
});

test('libSQL execute and batch are recorded, a batch sharing its time', async () => {
  const result = (n) => ({ rows: Array.from({ length: n }, () => ({})), rowsAffected: 0 });
  class HttpClient {
    async execute(stmt) {
      return result(typeof stmt === 'string' ? 1 : 2);
    }
    async batch(stmts) {
      await new Promise((ok) => setTimeout(ok, 20));
      return stmts.map(() => ({ rows: [], rowsAffected: 1 }));
    }
  }
  class HranaTransaction {
    execute(stmt) {
      return this.batch([stmt]).then((r) => r[0]);
    }
    async batch(stmts) {
      return stmts.map(() => result(1));
    }
  }
  const { recorded, monitor } = recorder();
  patchLibsql({ HttpClient, HranaTransaction }, monitor);
  const client = new HttpClient();
  await client.execute('SELECT 1');
  await client.execute({ sql: 'SELECT * FROM t WHERE id = ?', args: [5] });
  await client.batch([{ sql: 'INSERT INTO t (n) VALUES (?)', args: { n: 'a' } }, ['INSERT INTO t (n) VALUES (?)', ['b']]], 'write');
  await new HranaTransaction().execute('DELETE FROM t');
  assert.deepEqual(
    recorded.map((q) => [q.sql, q.params, q.rows, q.dialect]),
    [
      ['SELECT 1', [], 1, 'sqlite'],
      ['SELECT * FROM t WHERE id = ?', ['5'], 2, 'sqlite'],
      ['INSERT INTO t (n) VALUES (?)', ['a'], 1, 'sqlite'],
      ['INSERT INTO t (n) VALUES (?)', ['b'], 1, 'sqlite'],
      ['DELETE FROM t', [], 1, 'sqlite'],
    ],
    'a transaction’s execute is its batch: recorded once',
  );
  const [a, b] = recorded.slice(2, 4);
  assert.ok(a.durationMs >= 9 && Math.abs(a.durationMs - b.durationMs) < 0.001, 'the batch’s time is shared');
  assert.ok(b.started > a.started);
});

test('both builds of a package are patched, by file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-builds-'));
  const pkg = path.join(root, 'node_modules', '@scope', 'driver');
  fs.mkdirSync(path.join(pkg, 'cjs'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'cjs', 'index.js'), 'exports.build = "cjs"');
  fs.writeFileSync(path.join(pkg, 'index.mjs'), 'export const build = "esm"');
  assert.equal(packageRoot(path.join(pkg, 'cjs', 'index.js'), '@scope/driver'), pkg);
  assert.equal(packageRoot('/elsewhere/index.js', '@scope/driver'), null);
  const seen = [];
  patchBuilds(pkg, ['cjs/index.js', 'index.mjs', 'missing.js'], (m) => seen.push(m.build));
  assert.deepEqual(seen, ['cjs', 'esm'], 'ES modules are required where Node can, missing files skipped');
});
