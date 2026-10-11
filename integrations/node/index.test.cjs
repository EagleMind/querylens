// node --test "integrations/node/*.test.cjs"
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sdk = require('./index.cjs');

const { patchPg, createRecorder, fileTransport } = sdk._internal;

test('tags a query with the calling file and the sdk marker, before the final semicolon', () => {
  const sql = sdk.tag('SELECT 1;');
  // Relative to the working directory, so only the file name is fixed.
  assert.match(sql, /^SELECT 1 \/\*file='(.*%2F)?index\.test\.cjs%3A\d+',ql_sdk='1'\*\/;$/);
  assert.equal(sdk.tag(sql), sql, 'already tagged');
  assert.equal(sdk.tag(42), 42);
});

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

test('records promise and callback queries to the spool, tagging what is sent', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-sdk-'));
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
  patchPg({ Client }, createRecorder(fileTransport(dir)));
  const client = new Client();
  await client.query('SELECT * FROM orders WHERE user_id = $1', [42]);
  await client.query({ text: 'SELECT * FROM missing' }).catch(() => {});
  await new Promise((resolve) => client.query('SELECT 1', resolve));
  await client.query({ name: 'stmt1', text: 'SELECT 2' });
  await new Promise((r) => setTimeout(r, 300));

  assert.match(sent[0], /^SELECT \* FROM orders WHERE user_id = \$1 \/\*file='.*',ql_sdk='1'\*\/$/);
  assert.equal(sent[3], 'SELECT 2', 'named statements keep their text');
  const events = fs
    .readFileSync(path.join(dir, `${process.pid}.ndjson`), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  assert.equal(events.length, 4);
  assert.equal(events[0].sql, 'SELECT * FROM orders WHERE user_id = $1');
  assert.deepEqual(events[0].params, ['42']);
  assert.equal(events[0].rows, 2);
  assert.match(events[0].origin, /index\.test\.cjs:\d+$/);
  assert.equal(events[1].error, 'ERROR: relation "missing" does not exist (42P01)');
  assert.ok(events.every((e) => e.v === 1 && e.pid === process.pid && e.conn === 1 && e.durationMs >= 0));
});
