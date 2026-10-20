// node --test "integrations/node/*.test.cjs"
// MongoDB: shaping commands, the driver's command events, and Mongoose's operations, with
// fakes shaped like the real ones (checked against MongoDB 8, driver 7 and Mongoose 9).
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');

const { operations, requestContext } = require('./context.cjs');
const { shapeCommand, replyRows } = require('./drivers/mongo-shape.cjs');
const { patchMongodb, watchClient } = require('./drivers/mongodb.cjs');
const { patchMongoose } = require('./drivers/mongoose.cjs');

const objectId = (hex) => ({ _bsontype: 'ObjectId', toHexString: () => hex });

test('commands become value-free shapes, values kept apart', () => {
  const find = shapeCommand('find', { find: 'orders', filter: { userId: 7, status: { $in: ['paid', 'sent', 'done'] } }, sort: { createdAt: -1 }, limit: 20 });
  assert.equal(find.text, 'db.orders.find({"userId": ?, "status": {"$in": [?]}}).sort({"createdAt": -1}).limit(?)');
  assert.deepEqual(find.values, ['7', 'paid', 'sent', 'done', '20'], 'an $in list is one `?`, whatever its length');

  const agg = shapeCommand('aggregate', {
    aggregate: 'orders',
    pipeline: [
      { $match: { $or: [{ total: { $gte: 100 } }, { vip: true }] } },
      { $lookup: { from: 'users', localField: 'userId', foreignField: '_id', as: 'user' } },
      { $group: { _id: '$userId', n: { $sum: 1 }, bonus: { $sum: 5 } } },
      { $sort: { n: -1 } },
      { $limit: 10 },
    ],
  });
  assert.equal(
    agg.text,
    'db.orders.aggregate([{"$match": {"$or": [{"total": {"$gte": ?}}, {"vip": ?}]}}, {"$lookup": {"from": "users", "localField": "userId", "foreignField": "_id", "as": "user"}}, {"$group": {"_id": "$userId", "n": {"$sum": 1}, "bonus": {"$sum": ?}}}, {"$sort": {"n": -1}}, {"$limit": ?}])',
  );

  const insert = shapeCommand('insert', { insert: 'events', documents: [{ _id: objectId('abc'), kind: 'click', at: new Date(0) }] }, 'Event');
  assert.equal(insert.text, 'Event.insert([?])', 'through a model, the model is the target');
  assert.deepEqual(insert.values, ['abc', 'click', '1970-01-01T00:00:00.000Z']);

  assert.equal(shapeCommand('update', { update: 'orders', updates: [{ q: { _id: 3 }, u: { $set: { status: 'paid' }, $unset: { draft: '' } } }] }).text, 'db.orders.update({"_id": ?}, {"$set": {"status": ?}, "$unset": {"draft": ""}})');
  assert.equal(shapeCommand('update', { update: 'orders', updates: [{ q: { _id: 3 }, u: { status: 'paid' } }] }).text, 'db.orders.update({"_id": ?}, ?)', 'a replacement document is a value');
  assert.equal(shapeCommand('delete', { delete: 'sessions', deletes: [{ q: { expires: { $lt: new Date(0) } }, limit: 0 }] }).text, 'db.sessions.delete({"expires": {"$lt": ?}})');
  assert.equal(shapeCommand('distinct', { distinct: 'orders', key: 'status', query: { userId: 1 } }).text, 'db.orders.distinct("status", {"userId": ?})');
  assert.equal(shapeCommand('find', { find: 'orders', filter: { tags: { $exists: true, $size: 2 } } }).text, 'db.orders.find({"tags": {"$exists": true, "$size": 2}})');
  assert.equal(shapeCommand('hello', { hello: 1 }), null, 'handshakes and other commands are not statements');
  const huge = shapeCommand('find', { find: 'orders', filter: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`field_with_a_long_name_${i}`, { $in: [1] }])) });
  assert.ok(huge.text.length < 4000);
});

test('rows come from the reply: a cursor batch, n, values', () => {
  assert.equal(replyRows('find', { cursor: { firstBatch: [{}, {}] } }), 2);
  assert.equal(replyRows('insert', { n: 4 }), 4);
  assert.equal(replyRows('distinct', { values: ['a', 'b', 'c'] }), 3);
  assert.equal(replyRows('findAndModify', { value: null }), 0);
});

function fakeClient() {
  const client = new EventEmitter();
  let requestId = 0;
  /** Send one command: its events, as the driver emits them. */
  client.command = (name, command, reply, { error, address = 'db:27017' } = {}) => {
    const id = ++requestId;
    client.emit('commandStarted', { commandName: name, command, requestId: id, address, connectionId: 1 });
    if (error) client.emit('commandFailed', { commandName: name, failure: error, requestId: id, address, duration: 3 });
    else client.emit('commandSucceeded', { commandName: name, reply, requestId: id, address, duration: 2 });
  };
  return client;
}

test('the driver’s command events become statements, cursors folded, write errors kept', () => {
  const recorded = [];
  const client = fakeClient();
  watchClient(client, { record: (txn, q) => recorded.push({ txn, ...q, origin: q.origin() }) });
  requestContext.run({ txn: 't' }, () => {
    client.command('find', { find: 'orders', filter: { userId: 7 } }, { cursor: { id: 0, firstBatch: [{}, {}] } });
    // A cursor read in batches: one statement, its rows and time summed.
    client.command('find', { find: 'orders', filter: {} }, { cursor: { id: 42, firstBatch: [{}, {}] } });
    client.command('getMore', { getMore: 42, collection: 'orders' }, { cursor: { id: 42, nextBatch: [{}, {}] } });
    client.command('getMore', { getMore: 42, collection: 'orders' }, { cursor: { id: 0, nextBatch: [{}] } });
    // Closed early.
    client.command('find', { find: 'logs', filter: {} }, { cursor: { id: 7, firstBatch: [{}] } });
    client.command('killCursors', { killCursors: 'logs', cursors: [7] }, { cursorsKilled: [7] });
    client.command('insert', { insert: 'users', documents: [{ email: 'a@b.c' }] }, { ok: 1, n: 0, writeErrors: [{ code: 11000, errmsg: 'E11000 duplicate key error' }] });
    client.command('update', { update: 'orders', updates: [{ q: { _id: 1 }, u: { $inc: { n: 1 } } }] }, null, { error: Object.assign(new Error('WriteConflict'), { code: 112 }) });
    client.command('ping', { ping: 1 }, { ok: 1 });
  });
  assert.deepEqual(
    recorded.map((q) => [q.sql, q.rows, q.durationMs, q.error, q.dialect]),
    [
      ['db.orders.find({"userId": ?})', 2, 2, null, 'mongo'],
      ['db.orders.find({})', 5, 6, null, 'mongo'],
      ['db.logs.find({})', 1, 2, null, 'mongo'],
      ['db.users.insert([?])', 0, 2, 'ERROR: E11000 duplicate key error (11000)', 'mongo'],
      ['db.orders.update({"_id": ?}, {"$inc": {"n": ?}})', 0, 3, 'ERROR: WriteConflict (112)', 'mongo'],
    ],
  );
  assert.ok(recorded.every((q) => q.txn === 't' && /mongo\.test\.cjs:\d+$/.test(q.origin)));
});

test('connecting turns command monitoring on', async () => {
  class MongoClient extends EventEmitter {
    constructor() {
      super();
      this.monitorCommands = false;
    }
    async connect() {
      return this;
    }
  }
  const mongodb = patchMongodb({ MongoClient }, { record() {} });
  assert.strictEqual(patchMongodb(mongodb, {}), mongodb, 'patching twice is a no-op');
  const client = new MongoClient();
  assert.strictEqual(await client.connect(), client);
  assert.equal(client.monitorCommands, true);
  assert.equal(client.listenerCount('commandStarted'), 1);
  await client.connect();
  assert.equal(client.listenerCount('commandStarted'), 1, 'listened to once');
});

test('Mongoose operations carry their model and the line that awaited them', async () => {
  const seen = [];
  const look = (label) => {
    const op = operations.getStore();
    seen.push([label, op && op.model, op && op.collection, op && op.site()]);
  };
  class Query {
    constructor(model) {
      this.model = model;
    }
    exec() {
      look('query');
      // A query run inside another (populate): its own model, the outer line.
      if (this.model.modelName === 'Order') return new Query(Customer).exec().then(() => [1]);
      return Promise.resolve([]);
    }
    then(a, b) {
      return this.exec().then(a, b);
    }
  }
  class Aggregate {
    exec() {
      look('aggregate');
      return Promise.resolve([]);
    }
    then(a, b) {
      return this.exec().then(a, b);
    }
  }
  class Model {
    save() {
      look('save');
      return Promise.resolve(this);
    }
    static insertMany() {
      look('insertMany');
      return Promise.resolve([]);
    }
  }
  Model.prototype.$save = Model.prototype.save;
  const Order = class extends Model {};
  Object.assign(Order, { modelName: 'Order', collection: { collectionName: 'orders' } });
  const Customer = class extends Model {};
  Object.assign(Customer, { modelName: 'Customer', collection: { collectionName: 'customers' } });
  patchMongoose({ Query, Aggregate, Model });

  await new Query(Order);
  const agg = new Aggregate();
  agg._model = Order;
  await agg;
  await new Order().$save();
  await Customer.insertMany([]);
  const here = (s) => /mongo\.test\.cjs:\d+$/.test(s);
  assert.deepEqual(
    seen.map(([label, model, collection]) => [label, model, collection]),
    [
      ['query', 'Order', 'orders'],
      ['query', 'Customer', 'customers'],
      ['aggregate', 'Order', 'orders'],
      ['save', 'Order', 'orders'],
      ['insertMany', 'Customer', 'customers'],
    ],
  );
  assert.ok(seen.every(([, , , site]) => here(site)), JSON.stringify(seen));
  assert.equal(seen[0][3], seen[1][3], 'populate keeps the line of the query that ran it');
});
