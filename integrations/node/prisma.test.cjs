// node --test "integrations/node/*.test.cjs"
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const sdk = require('./index.cjs');

const GLOBAL = Symbol.for('querylens.sdk');
const TRACING = 'V6_PRISMA_INSTRUMENTATION';

// Installed before the extension turns tracing on: like Sentry's, it must keep working.
const otherSpans = [];
globalThis[TRACING] = {
  helper: {
    isEnabled: () => true,
    getTraceParent: () => '00-11111111111111111111111111111111-2222222222222222-01',
    dispatchEngineSpans: (spans) => otherSpans.push(...spans),
    getActiveContext: () => 'other-context',
    runInChildSpan: (options, fn) => fn(),
  },
};
const { queryLens, _internal: prisma } = require('./prisma.cjs');

/** Like Prisma's `callsite`: a stack that starts in its runtime, generated into the app. */
const callsite = {
  _error: {
    stack: [
      'Error',
      `    at new Hn (${path.join(process.cwd(), 'generated', 'runtime', 'client.js')}:15:1823)`,
      `    at Proxy.findMany (${path.join(process.cwd(), 'generated', 'runtime', 'client.js')}:15:2556)`,
      `    at listUsers (${path.join(process.cwd(), 'src', 'users.js')}:12:5)`,
    ].join('\n'),
  },
};

/** A Prisma client as far as the extension sees it, and a way to run one operation through it. */
function fakeClient({ adapter = false } = {}) {
  const client = {
    _engineConfig: adapter ? { adapter: {} } : {},
    $extends(extension) {
      client.extension = extension;
      return client;
    },
  };
  client.run = (args, query) => client.extension.query.$allOperations({ args, query: () => query(), __internalParams: { callsite } });
  return client;
}

function withMonitor(fn) {
  const recorded = [];
  const monitor = { record: (txn, q) => recorded.push({ txn: txn && txn.name, ...q }), startTransaction: (name) => ({ name }), endTransaction() {} };
  globalThis[GLOBAL] = { monitor };
  return Promise.resolve(fn(recorded)).finally(() => delete globalThis[GLOBAL]);
}

const now = () => {
  const ms = Date.now();
  return [Math.floor(ms / 1000), (ms % 1000) * 1e6];
};
const span = (sql, system = 'postgresql') => ({ name: 'prisma:engine:db_query', startTime: now(), endTime: now(), attributes: { 'db.query.text': sql, 'db.system': system } });
/** What Prisma's engine does: run, then hand its spans to the tracing helper, in the caller's context. */
const engineRun = (spans, outcome) => async () => {
  await new Promise((r) => setTimeout(r, 2));
  globalThis[TRACING].helper.dispatchEngineSpans([{ name: 'prisma:engine:query', attributes: {} }, ...spans]);
  if (outcome instanceof Error) throw outcome;
  return outcome;
};

test('prisma: without a DSN the client is left as it is', () => {
  const client = fakeClient();
  assert.strictEqual(client.$extends(queryLens({ engine: true })), client);
  assert.equal(client.extension(client), client);
});

test('prisma: queries a driver records get the line of the Prisma call', () =>
  withMonitor(async (recorded) => {
    const client = fakeClient();
    client.$extends(queryLens()).extension(client);
    let site;
    // Like pg under @prisma/adapter-pg: the driver hook runs inside the operation.
    const rows = await client.run({ where: { id: 1 } }, async () => {
      await 1;
      site = sdk._internal.lazySite();
      return [{ id: 1 }];
    });
    assert.deepEqual(rows, [{ id: 1 }], 'result unchanged');
    assert.equal(site(), 'src/users.js:12');
    assert.equal(recorded.length, 0, 'nothing recorded twice');
  }));

test('prisma: the engine SQL of each operation is recorded in its request', () =>
  withMonitor(async (recorded) => {
    const client = fakeClient();
    client.$extends(queryLens({ engine: true })).extension(client);
    const users = (id) =>
      client.run({ where: { userId: BigInt(id) } }, engineRun([span(`SELECT "id" FROM "orders" WHERE "user_id" = $1 /* traceparent='00-ab-cd-01' */`)], [{}, {}, {}]));
    await Promise.all([sdk.withTransaction('GET /a', () => users(1)), sdk.withTransaction('GET /b', () => users(2))]);
    const failed = Object.assign(new Error('\nInvalid `prisma.users.create()` invocation:\n\n\nUnique constraint failed on the fields: (`email`)'), { code: 'P2002' });
    await assert.rejects(
      sdk.withTransaction('POST /users', () => client.run({ data: { email: 'ada@x.io' } }, engineRun([span('INSERT INTO "users" ("email") VALUES ($1)')], failed))),
      (e) => e === failed,
    );
    await sdk.withTransaction('GET /count', () => client.run({}, engineRun([span('BEGIN'), span('SELECT COUNT(*) FROM "users"'), span('COMMIT')], [{}, {}])));

    assert.deepEqual(recorded.map((q) => q.txn).sort(), ['GET /a', 'GET /b', 'GET /count', 'GET /count', 'GET /count', 'POST /users']);
    const [a, b] = recorded.filter((q) => q.txn.startsWith('GET /a') || q.txn.startsWith('GET /b'));
    assert.equal(a.sql, 'SELECT "id" FROM "orders" WHERE "user_id" = $1', 'its traceparent comment removed');
    assert.notDeepEqual(a.params, b.params, 'arguments tell iterations apart');
    assert.equal(a.rows, 3);
    assert.equal(a.origin(), 'src/users.js:12');
    assert.ok(a.durationMs >= 0 && a.dialect === 'postgres');
    assert.equal(recorded.find((q) => q.txn === 'POST /users').error, 'ERROR: Unique constraint failed on the fields: (`email`) (P2002)');
    assert.deepEqual(recorded.filter((q) => q.txn === 'GET /count').map((q) => q.rows), [0, 2, 0], 'rows go to the statement after BEGIN');
    assert.ok(otherSpans.length > 0, 'the tracing helper already there still gets its spans');
    assert.equal(globalThis[TRACING].helper.getActiveContext(), 'other-context');
  }));

test('prisma: engine mode leaves SQL a driver recorded alone', () =>
  withMonitor(async (recorded) => {
    // A client with an adapter: the driver hooks have its SQL.
    const adapted = fakeClient({ adapter: true });
    adapted.$extends(queryLens({ engine: true })).extension(adapted);
    await adapted.run({}, engineRun([span('SELECT 1')], []));
    // An operation whose SQL a driver hook saw.
    const client = fakeClient();
    client.$extends(queryLens({ engine: true })).extension(client);
    await client.run({}, async () => {
      sdk._internal.lazySite();
      return engineRun([span('SELECT 2')], [])();
    });
    assert.equal(recorded.length, 0);
  }));

test('prisma: results, arguments and errors as recorded', () => {
  assert.equal(prisma.resultRows([1, 2]), 2);
  assert.equal(prisma.resultRows({ count: 4 }), 4);
  assert.equal(prisma.resultRows(7), 1, 'count() is one row');
  assert.equal(prisma.resultRows(null), 0);
  assert.equal(prisma.argsText({ id: 10n }), '{"id":"10n"}');
  assert.equal(prisma.argsText(undefined), null);
  assert.equal(prisma.callSite({ _error: { stack: 'Error\n    at x (/nowhere/runtime.js:1:1)' } })(), null);
  assert.equal(prisma.callSite(undefined)(), null);
});
