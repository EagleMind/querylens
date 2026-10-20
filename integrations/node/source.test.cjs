// node --test "integrations/node/*.test.cjs"
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { createSourceReader, redact, parseOrigin } = require('./source.cjs');
const { createMonitor } = require('./monitor.cjs');

const DSN = 'https://k3y@querylens.example.workers.dev/0123456789ab';

test('secrets in code are masked', () => {
  assert.equal(redact(`const apiKey = 'abcd1234efgh';`), `const apiKey = '***';`);
  assert.equal(redact(`  password: "hunter2!",`), `  password: "***",`);
  assert.equal(redact(`DB_URL = "postgres://app:s3cret@db:5432/shop"`), `DB_URL = "postgres://app:***@db:5432/shop"`);
  assert.equal(redact(`stripe('sk_live_${'a1'.repeat(16)}')`), `stripe('***')`);
  const plain = `const orders = await Order.findAll({ where: { userId } })`;
  assert.equal(redact(plain), plain, 'ordinary code is left alone');
  assert.equal(redact(`const token = req.headers.authorization`), `const token = req.headers.authorization`, 'no literal, nothing to mask');
});

test('only relative paths inside the project are read', () => {
  assert.deepEqual(parseOrigin('src/orders.js:42'), { file: 'src/orders.js', line: 42 });
  assert.equal(parseOrigin('../outside.js:3'), null);
  assert.equal(parseOrigin('src/../../etc/passwd:1'), null);
  assert.equal(parseOrigin(path.resolve('/etc/app.js') + ':3'), null);
  assert.equal(parseOrigin('src/a.js'), null);
  assert.equal(parseOrigin('src/a.js:0'), null);
});

test('a snippet is the lines around the origin, read once per file', async () => {
  const reads = [];
  const file = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join('\n');
  const reader = createSourceReader({
    root: '/app',
    readFile: async (p) => {
      reads.push(p);
      return file;
    },
  });
  const s = await reader.snippet('src/orders.js:42');
  assert.deepEqual([s.type, s.origin, s.firstLine, s.lines.length], ['source', 'src/orders.js:42', 32, 21]);
  assert.equal(s.lines[42 - 32], 'line 42');
  const top = await reader.snippet('src/orders.js:3');
  assert.equal(top.firstLine, 1, 'clipped at the top of the file');
  assert.equal(reads.length, 1, 'the file is cached');
  assert.equal(await reader.snippet('src/orders.js:61'), null, 'past the end');
});

test('unreadable files give no snippet and never throw', async () => {
  const reader = createSourceReader({
    readFile: async () => {
      throw new Error('ENOENT');
    },
  });
  assert.equal(await reader.snippet('src/missing.js:1'), null);
});

test('with sourceContext, each origin of a sent request is sent once, in the background', async () => {
  const bodies = [];
  const send = async (lines) => {
    bodies.push(lines.trim().split('\n').map((l) => JSON.parse(l)));
    return { status: 202, body: '{}' };
  };
  const sourceReader = { snippet: async (origin) => ({ type: 'source', origin, firstLine: 1, lines: ['x'] }) };
  const m = createMonitor({ dsn: DSN, environment: 'development', sourceContext: true, sourceReader, send }, {});
  const q = { started: 0, durationMs: 500, sql: 'SELECT 1', params: [], rows: 1, error: null, origin: () => 'src/app.js:3', conn: 1 };
  for (let i = 0; i < 2; i++) {
    const t = m.startTransaction(`GET /x${i}`);
    m.record(t, { ...q });
    m.endTransaction(t);
    await m.flush();
  }
  const sources = bodies.flat().filter((i) => i.type === 'source');
  assert.deepEqual(sources.map((s) => s.origin), ['src/app.js:3']);
});

test('without sourceContext no code is sent', async () => {
  const bodies = [];
  const send = async (lines) => {
    bodies.push(lines);
    return { status: 202, body: '{}' };
  };
  const m = createMonitor({ dsn: DSN, environment: 'development', send }, {});
  assert.equal(m.sourceContext, false);
  const t = m.startTransaction('GET /x');
  m.record(t, { started: 0, durationMs: 500, sql: 'SELECT 1', params: [], rows: 1, error: null, origin: () => 'src/app.js:3', conn: 1 });
  m.endTransaction(t);
  await m.flush();
  assert.ok(!bodies.join('').includes('"type":"source"'));
});
