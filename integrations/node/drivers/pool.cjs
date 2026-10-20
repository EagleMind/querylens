// Connection pools (pg-pool, mysql2's pools): their queries keep the app's line and request.
'use strict';

const { operations, stackSite, inCallerContext } = require('../context.cjs');

/**
 * A pool runs a query on a connection once it has one, later and outside the app's code
 * (pg-pool's `query`, mysql2's `query` and `execute`): the app's line is taken when one of
 * `queries` is called, and the query runs inside an operation holding it (unless an ORM
 * operation already holds one). A pool out of connections queues `acquire` callbacks and
 * calls them from the query that frees a connection, in that query's request: they're run
 * in their own.
 */
function patchPool(Pool, queries, acquire) {
  let proto = Pool && Pool.prototype;
  while (proto && !Object.prototype.hasOwnProperty.call(proto, queries[0])) proto = Object.getPrototypeOf(proto);
  if (!proto || typeof proto[queries[0]] !== 'function' || typeof proto[acquire] !== 'function' || proto[queries[0]].__querylens) return Pool;

  const connect = proto[acquire];
  proto[acquire] = function (cb) {
    if (typeof cb !== 'function') return connect.apply(this, arguments);
    const args = Array.prototype.slice.call(arguments);
    args[0] = inCallerContext(cb);
    return connect.apply(this, args);
  };
  for (const method of queries) {
    const query = proto[method];
    if (typeof query !== 'function') continue;
    proto[method] = function () {
      if (operations.getStore()) return query.apply(this, arguments);
      return operations.run({ site: stackSite(), viaDriver: false }, () => query.apply(this, arguments));
    };
    proto[method].__querylens = true;
  }
  return Pool;
}

module.exports = { patchPool };
