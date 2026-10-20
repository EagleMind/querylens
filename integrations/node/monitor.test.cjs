// node --test "integrations/node/*.test.cjs"
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const { scrub, scrubError, valueHash } = require('./scrub.cjs');
const { createMonitor, detectRelease, parseDsn } = require('./monitor.cjs');
const sdk = require('./index.cjs');

const DSN = 'https://k3y@querylens.example.workers.dev/0123456789ab';

test('scrubbing matches the cases shared with the Rust fingerprint tests', () => {
  const cases = JSON.parse(fs.readFileSync(path.join(__dirname, 'test', 'scrub-cases.json'), 'utf8'));
  for (const c of cases) {
    const out = scrub(c.sql, c.dialect);
    assert.equal(out.sql, c.scrubbed, c.sql);
    assert.deepEqual(out.values, c.values, c.sql);
  }
});

test('value hashes tell different values apart without revealing them', () => {
  const a = valueHash(['7'], []);
  assert.match(a, /^[0-9a-f]{8}$/);
  assert.equal(a, valueHash(['7'], []));
  assert.notEqual(a, valueHash(['8'], []));
  assert.notEqual(valueHash([], ['1']), valueHash([], ['2']));
  assert.equal(scrubError('ERROR: invalid input syntax for type integer: "abc" (22P02)'), 'ERROR: invalid input syntax for type integer: "?" (22P02)');
  assert.equal(scrubError('Key (email)=(ada@example.com) already exists'), 'Key (email)=(?) already exists');
});

test('DSNs and releases', () => {
  const t = parseDsn(DSN);
  assert.equal(t.key, 'k3y');
  assert.equal(t.project, '0123456789ab');
  assert.equal(t.endpoint.toString(), 'https://querylens.example.workers.dev/api/0123456789ab/envelope');
  assert.equal(parseDsn('not a url'), null);
  assert.equal(parseDsn('https://host/project'), null, 'no key');
  assert.equal(detectRelease({ GITHUB_SHA: 'a'.repeat(40) }), 'aaaaaaaaaaaa');
  assert.equal(detectRelease({ QUERYLENS_RELEASE: 'v1.2.3', GITHUB_SHA: 'b'.repeat(40) }), 'v1.2.3');
});

function fakeBackend(reply = { status: 202, body: '{"accepted":true,"config":{"loopMin":4}}' }) {
  const bodies = [];
  return {
    bodies,
    send: async (lines) => {
      bodies.push(lines.trim().split('\n').map((l) => JSON.parse(l)));
      return typeof reply === 'function' ? reply() : reply;
    },
  };
}

const q = (sql, extra = {}) => ({ started: 0, durationMs: 1, sql, params: [], rows: 1, error: null, origin: () => 'src/app.js:3', conn: 1, ...extra });

test('flagged transactions are sent scrubbed, clean ones sampled, every statement counted', async () => {
  const backend = fakeBackend();
  const m = createMonitor({ dsn: DSN, environment: 'production', release: 'r1', sampleRate: 0, send: backend.send }, {});
  const loop = m.startTransaction('GET /orders');
  m.record(loop, q(`SELECT * FROM "orders" WHERE "user_id" = 7`, { rows: 6 }));
  for (let i = 0; i < 6; i++) m.record(loop, q(`SELECT * FROM "items" WHERE "order_id" = ${i}`));
  m.endTransaction(loop);
  const fine = m.startTransaction('GET /health');
  m.record(fine, q('SELECT 1'));
  m.endTransaction(fine);
  await m.flush();

  const [items] = backend.bodies;
  const header = items[0];
  assert.deepEqual([header.type, header.environment, header.release], ['header', 'production', 'r1']);
  const txns = items.filter((i) => i.type === 'transaction');
  assert.equal(txns.length, 1, 'the clean request is not sampled at rate 0');
  const [txn] = txns;
  assert.equal(txn.name, 'GET /orders');
  assert.equal(txn.queries.length, 7);
  assert.equal(txn.queries[1].sql, 'SELECT * FROM "items" WHERE "order_id" = ?');
  assert.equal(txn.queries[1].params, undefined, 'no values');
  assert.notEqual(txn.queries[1].vh, txn.queries[2].vh, 'different values, different hashes');
  assert.equal(txn.queries[0].origin, 'src/app.js:3');

  const stats = items.find((i) => i.type === 'stats');
  const items_ = stats.queries.find((s) => s.sql.includes('"items"'));
  assert.equal(items_.calls, 6, 'one shape for all six');
  assert.ok(stats.queries.some((s) => s.sql === 'SELECT ?'));
  // The reply's settings apply from now on.
  assert.equal(m._internal.config.loopMin, 4);
});

test('the same problem on the same route is sent once per window', async () => {
  const backend = fakeBackend();
  const m = createMonitor({ dsn: DSN, sampleRate: 0, send: backend.send }, {});
  for (let r = 0; r < 3; r++) {
    const t = m.startTransaction('GET /slow');
    m.record(t, q('SELECT pg_sleep(1)', { durationMs: 900 }));
    m.endTransaction(t);
  }
  await m.flush();
  assert.equal(backend.bodies[0].filter((i) => i.type === 'transaction').length, 1);
});

test('sendValues sends SQL and parameters as they are', async () => {
  const backend = fakeBackend();
  const m = createMonitor({ dsn: DSN, sendValues: true, sampleRate: 1, send: backend.send }, {});
  const t = m.startTransaction('GET /x');
  m.record(t, q('SELECT * FROM t WHERE id = $1', { params: ['42'] }));
  m.endTransaction(t);
  await m.flush();
  const txn = backend.bodies[0].find((i) => i.type === 'transaction');
  assert.equal(txn.queries[0].sql, 'SELECT * FROM t WHERE id = $1');
  assert.deepEqual(txn.queries[0].params, ['42']);
});

test('a refused DSN turns sending off; failures back off and keep the newest data', async () => {
  const refused = fakeBackend({ status: 401, body: '{}' });
  const warn = console.warn;
  console.warn = () => {};
  try {
    const m = createMonitor({ dsn: DSN, sampleRate: 1, send: refused.send }, {});
    const t = m.startTransaction('GET /a');
    m.record(t, q('SELECT 1'));
    m.endTransaction(t);
    await m.flush();
    const t2 = m.startTransaction('GET /b');
    m.record(t2, q('SELECT 1'));
    m.endTransaction(t2);
    await m.flush();
    assert.equal(refused.bodies.length, 1, 'nothing sent after the 401');
  } finally {
    console.warn = warn;
  }

  const down = fakeBackend({ status: 503, body: '' });
  const m = createMonitor({ dsn: DSN, sampleRate: 1, send: down.send }, {});
  const t = m.startTransaction('GET /a');
  m.record(t, q('SELECT 1'));
  m.endTransaction(t);
  await m.flush();
  assert.ok(m._internal.queue.length > 0, 'kept for a retry');
});

test('a pg client inside withTransaction: values scrubbed, SQL untouched', async () => {
  delete globalThis[Symbol.for('querylens.sdk')];
  const backend = fakeBackend();
  const api = sdk.init({ dsn: DSN, environment: 'test', send: backend.send });
  assert.equal(api.enabled, true);
  const sent = [];
  class Client {
    query(config, values) {
      sent.push(typeof config === 'string' ? config : config.text);
      return Promise.resolve({ rowCount: 1, rows: [{}] });
    }
  }
  sdk._internal.patchPg({ Client }, api.monitor);
  const client = new Client();
  await sdk.withTransaction('job:send-emails', async () => {
    for (let i = 0; i < 5; i++) await client.query('SELECT * FROM users WHERE id = $1', [i]);
  });
  assert.equal(sent[0], 'SELECT * FROM users WHERE id = $1', 'queries are never changed');
  await sdk.flush();
  const items = backend.bodies.flat();
  const txn = items.find((i) => i.type === 'transaction');
  assert.equal(txn.name, 'job:send-emails');
  assert.equal(txn.queries.length, 5);
  assert.match(txn.queries[0].origin, /monitor\.test\.cjs:\d+$/);
  assert.notEqual(txn.queries[0].vh, txn.queries[1].vh);
  delete globalThis[Symbol.for('querylens.sdk')];
});

test('gzip round trip of what the HTTP transport would send', () => {
  const lines = '{"type":"header"}\n';
  assert.equal(zlib.gunzipSync(zlib.gzipSync(lines)).toString(), lines);
});
