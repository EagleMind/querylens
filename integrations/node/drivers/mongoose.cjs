// Mongoose: its commands go through the MongoDB driver (mongodb.cjs records them). This
// gives each Mongoose operation (a query, an aggregation, `save`, `insertMany`, `bulkWrite`)
// what the driver can't see: the app's line, taken where the operation is awaited or run,
// and the model, so statements read `OrderItem.find(…)`. Queries are thenables, like
// Drizzle's: the line is taken when `await` reads `then`. A query Mongoose runs inside
// another (`populate`) keeps the outer line and gets its own model.
'use strict';

const { operations, stackSite } = require('../context.cjs');

/** Run `fn` in an operation for `model`, its line `own()` or the enclosing operation's. */
function inOperation(model, own, fn) {
  const outer = operations.getStore();
  let site;
  const operation = {
    site: () => (site === undefined ? (site = (outer && outer.site()) || own() || null) : site),
    viaDriver: false,
    model: model && model.modelName,
    collection: model && model.collection && model.collection.collectionName,
  };
  return operations.run(operation, fn);
}

/** `exec` runs the operation; `then`, read by `await`, takes the line first. */
function patchThenable(proto, modelOf) {
  if (!proto || typeof proto.exec !== 'function' || proto.exec.__querylens) return;
  const exec = proto.exec;
  proto.exec = function () {
    const own = stackSite();
    return inOperation(modelOf(this), own, () => exec.apply(this, arguments));
  };
  proto.exec.__querylens = true;

  const desc = Object.getOwnPropertyDescriptor(proto, 'then');
  if (!desc || typeof desc.value !== 'function') return;
  const then = desc.value;
  Object.defineProperty(proto, 'then', {
    configurable: true,
    enumerable: desc.enumerable,
    get() {
      const own = stackSite();
      return function () {
        // `then` calls `exec`: the line read here is the one it uses.
        return inOperation(modelOf(this), own, () => then.apply(this, arguments));
      };
    },
    set(value) {
      Object.defineProperty(this, 'then', { value, writable: true, enumerable: true, configurable: true });
    },
  });
}

/** Wrap a method so it runs in an operation for the model `modelOf(this)`. */
function patchMethod(target, method, modelOf) {
  const original = target && target[method];
  if (typeof original !== 'function' || original.__querylens) return;
  target[method] = function () {
    const own = stackSite();
    return inOperation(modelOf(this), own, () => original.apply(this, arguments));
  };
  target[method].__querylens = true;
}

function patchMongoose(mongoose) {
  if (!mongoose || typeof mongoose.Query !== 'function' || typeof mongoose.Model !== 'function') return mongoose;
  patchThenable(mongoose.Query.prototype, (q) => q.model);
  if (typeof mongoose.Aggregate === 'function') patchThenable(mongoose.Aggregate.prototype, (a) => a._model);
  // Documents: `save` on an instance (`create` calls `$save`, an alias taken before this
  // patch); statics are inherited by every compiled model.
  for (const method of ['save', '$save']) patchMethod(mongoose.Model.prototype, method, (doc) => doc.constructor);
  for (const method of ['insertMany', 'bulkWrite']) patchMethod(mongoose.Model, method, (Model) => Model);
  return mongoose;
}

module.exports = { patchMongoose };
