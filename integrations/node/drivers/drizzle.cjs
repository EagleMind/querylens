// Drizzle: its queries are thenables, so the app's line is taken when they're awaited.
'use strict';

const { operations, stackSite } = require('../context.cjs');

/**
 * Give Drizzle's queries the line of the app that awaited them. A Drizzle query is a
 * thenable (QueryPromise): `await` calls its `then` from a microtask, so the driver hooks
 * see no app frame. But `await` (like `Promise.all`, `.catch`) reads `then` right away, in
 * the app's code: a getter takes the stack there and starts the query inside an operation
 * holding that line. `then` itself is unchanged, and assigning one still works.
 * Select builders copy QueryPromise's methods when they load: patch it before that.
 */
function patchDrizzle(QueryPromise) {
  const proto = QueryPromise && QueryPromise.prototype;
  const desc = proto && Object.getOwnPropertyDescriptor(proto, 'then');
  // Already patched (a getter), or not Drizzle's.
  if (typeof QueryPromise !== 'function' || !desc || typeof desc.value !== 'function') return QueryPromise;
  const then = desc.value;
  Object.defineProperty(proto, 'then', {
    configurable: true,
    enumerable: desc.enumerable,
    get() {
      const own = stackSite();
      // Drizzle awaiting one of its own queries: the app's line is the outer one's.
      const outer = operations.getStore();
      let site;
      const operation = {
        site: () => (site === undefined ? (site = own() || (outer ? outer.site() : null)) : site),
        viaDriver: false,
      };
      return function () {
        return operations.run(operation, () => then.apply(this, arguments));
      };
    },
    set(value) {
      Object.defineProperty(this, 'then', { value, writable: true, enumerable: true, configurable: true });
    },
  });
  return QueryPromise;
}

module.exports = { patchDrizzle };
