// Calls each route once, the way an integration test suite would.
const { test, after } = require('node:test');
const assert = require('node:assert');
const app = require('../app');
const { sequelize } = require('../models');

const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
after(async () => {
  server.close();
  await sequelize.close();
});

test('orders of a user', async () => {
  const res = await fetch(`${base}/users/42/orders`);
  assert.equal(res.status, 200);
  assert.ok((await res.json()).length > 0);
});

test('orders of a user, eager-loaded', async () => {
  const res = await fetch(`${base}/users/42/orders-fixed`);
  assert.equal(res.status, 200);
});

test('product list', async () => {
  const res = await fetch(`${base}/products`);
  assert.equal((await res.json()).length, 5000);
});

test('dashboard', async () => {
  assert.equal((await fetch(`${base}/dashboard`)).status, 200);
});

test('record events', async () => {
  assert.equal((await fetch(`${base}/events`, { method: 'POST' })).status, 201);
});
