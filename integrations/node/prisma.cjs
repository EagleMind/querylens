// QueryLens for Prisma, opt-in, as a client extension:
//
//   const { queryLens } = require('querylens-node/prisma')
//   const prisma = new PrismaClient({ adapter }).$extends(queryLens())
//
// Prisma 7, and Prisma 6 with a driver adapter (`@prisma/adapter-pg`, …), send their SQL
// through the driver, which the SDK already records. The extension gives those queries the
// line of your code that made the Prisma call: the driver itself only sees Prisma's internals.
//
// Prisma 6 without an adapter runs SQL in its Rust engine, out of the drivers' reach.
// `queryLens({ engine: true })` records it through Prisma's tracing hook (the one
// @prisma/instrumentation uses): the SQL Prisma ran and its timing, per request. That has a
// cost, which is why it's not the default: Prisma's tracing adds about 0.3 ms per query,
// and inside interactive transactions Prisma appends a `/* traceparent='…' */` comment to the
// SQL it sends. Apply the extension before the client's first query.
'use strict';

const crypto = require('crypto');
const { performance } = require('perf_hooks');

const { paramText, errorText, _internal } = require('./index.cjs');

const { operations, requestContext, siteOf, activeMonitor } = _internal;

/** Prisma 6 reads its tracing helper here (before the unversioned `PRISMA_INSTRUMENTATION`). */
const TRACING_KEY = 'V6_PRISMA_INSTRUMENTATION';
const DB_QUERY = 'prisma:engine:db_query';
/** One sampled trace for the process: engine spans need one, and a fixed id keeps SQL text stable. */
const TRACEPARENT = `00-${crypto.randomBytes(16).toString('hex')}-${crypto.randomBytes(8).toString('hex')}-01`;
const TRACEPARENT_COMMENT = / ?\/\* traceparent='[^']*' \*\//g;
const CONTROL = /^\s*(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i;

let tracing = false;

/**
 * The app's line for a Prisma call. Prisma captures the call's stack itself (`callsite`)
 * unless the client has `errorFormat: 'minimal'`. It starts in Prisma's runtime, which since
 * Prisma 7 can be generated into the app's own folder: every frame in that file is skipped.
 */
function callSite(callsite) {
  let site;
  return () => {
    if (site !== undefined) return site;
    site = null;
    try {
      if (callsite && callsite._error && typeof callsite._error.stack === 'string') {
        const [header, ...frames] = callsite._error.stack.split('\n');
        const runtime = frames.length ? frames[0].trim().match(/\(?([^()]+):\d+:\d+\)?$/) : null;
        site = siteOf([header, ...(runtime ? frames.filter((f) => !f.includes(runtime[1])) : frames)].join('\n'));
      } else if (callsite && typeof callsite.getLocation === 'function') {
        const at = callsite.getLocation();
        if (at && at.fileName) site = siteOf(`Error\n    at ${at.fileName}:${at.lineNumber}:${at.columnNumber || 1}`);
      }
    } catch {}
    return site;
  };
}

/** Rows a Prisma operation returned: records found or written (`{ count }`), one for a scalar. */
function resultRows(result) {
  if (result === null || result === undefined) return 0;
  if (Array.isArray(result)) return result.length;
  return typeof result === 'object' && typeof result.count === 'number' ? result.count : 1;
}

/** An operation's arguments, as one value: what tells an N+1's iterations apart. */
function argsText(args) {
  try {
    return paramText(JSON.stringify(args, (k, v) => (typeof v === 'bigint' ? `${v}n` : v)));
  } catch {
    return null;
  }
}

/** "ERROR: Unique constraint failed on the fields: (`email`) (P2002)": Prisma's reason is its last line. */
function prismaError(err) {
  const lines = String((err && err.message) || err).split('\n').map((l) => l.trim()).filter(Boolean);
  return errorText({ message: lines[lines.length - 1] || 'error', code: err && err.code });
}

/** Record an operation's engine spans, once it has settled (its rows and error are known then). */
function recordSpans(operation, err, result) {
  const spans = operation.spans;
  // A driver hook recorded this operation's SQL already (a client with an adapter).
  if (!spans || spans.length === 0 || operation.viaDriver) return;
  const monitor = activeMonitor();
  if (!monitor) return;
  try {
    const ctx = requestContext.getStore();
    const params = [argsText(operation.args)];
    const ms = ([s, ns]) => s * 1000 + ns / 1e6 - performance.timeOrigin;
    // The result's rows are the first statement's (after BEGIN in a batch); the engine doesn't
    // report the others'.
    const first = spans.findIndex((span) => !CONTROL.test(span.attributes['db.query.text']));
    spans.forEach((span, i) => {
      monitor.record(ctx ? ctx.txn : null, {
        started: ms(span.startTime),
        durationMs: ms(span.endTime) - ms(span.startTime),
        sql: span.attributes['db.query.text'].replace(TRACEPARENT_COMMENT, ''),
        params,
        rows: i === first ? resultRows(result) : 0,
        error: err && i === spans.length - 1 ? prismaError(err) : null,
        origin: operation.site,
        conn: 0,
        dialect: span.attributes['db.system'] === 'mysql' ? 'mysql' : 'postgres',
      });
    });
  } catch {}
}

/** Spans arrive in the async context of the request that ran them: keep its SQL ones. */
function collect(spans) {
  const operation = operations.getStore();
  if (!operation || !operation.spans || !Array.isArray(spans)) return;
  for (const span of spans) {
    if (span && span.name === DB_QUERY && span.attributes && typeof span.attributes['db.query.text'] === 'string') {
      operation.spans.push(span);
    }
  }
}

/**
 * Turn on Prisma's engine tracing, through the helper Prisma looks up on `globalThis`. A
 * helper already there (Sentry, OpenTelemetry) keeps working: it gets everything it got before.
 */
function installTracing() {
  if (tracing) return;
  tracing = true;
  const previous = (globalThis[TRACING_KEY] || globalThis.PRISMA_INSTRUMENTATION || {}).helper;
  const other = () => (previous && previous.isEnabled() ? previous : null);
  globalThis[TRACING_KEY] = {
    helper: {
      isEnabled: () => true,
      getTraceParent: (context) => (other() ? other().getTraceParent(context) : TRACEPARENT),
      dispatchEngineSpans(spans) {
        try {
          collect(spans);
        } catch {}
        if (other()) other().dispatchEngineSpans(spans);
      },
      getActiveContext: () => (other() ? other().getActiveContext() : undefined),
      runInChildSpan: (options, fn) => (other() ? other().runInChildSpan(options, fn) : fn()),
    },
  };
}

/**
 * The extension. `{ engine: true }` also records the SQL of Prisma's Rust engine (Prisma 6
 * without a driver adapter). Without a running SDK (no DSN) it leaves the client as it is.
 */
function queryLens(options = {}) {
  if (!activeMonitor()) return (client) => client;
  return (client) => {
    // A client with a driver adapter has its SQL recorded by the driver hooks already.
    const engine = options.engine === true && !(client._engineConfig && client._engineConfig.adapter);
    if (engine) installTracing();
    return client.$extends({
      name: 'querylens',
      query: {
        $allOperations({ args, query, __internalParams }) {
          const operation = {
            site: callSite(__internalParams && __internalParams.callsite),
            viaDriver: false,
            spans: engine ? [] : null,
            args,
          };
          // Start the query inside the operation (Prisma's promise runs on `then`), so the
          // driver hooks and the engine's spans can tell which operation they belong to.
          return operations.run(operation, () =>
            query(args).then(
              (result) => {
                recordSpans(operation, null, result);
                return result;
              },
              (err) => {
                recordSpans(operation, err, null);
                throw err;
              },
            ),
          );
        },
      },
    });
  };
}

module.exports = { queryLens, _internal: { installTracing, collect, recordSpans, callSite, resultRows, argsText, prismaError } };
