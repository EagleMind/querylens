// Routes with deliberate ORM performance problems (and one fixed version).
const express = require('express');
const { sequelize, User, Order, OrderItem, Product, Event } = require('./models');

const app = express();
app.use(express.json());

// N+1 twice over: one query per order for its items, then one per item for its product.
app.get('/users/:id/orders', async (req, res) => {
  const orders = await Order.findAll({ where: { user_id: req.params.id } });
  const out = [];
  for (const order of orders) {
    const items = await order.getItems();
    for (const item of items) {
      const product = await item.getProduct();
      out.push({ order: order.id, product: product.name, quantity: item.quantity });
    }
  }
  res.json(out);
});

// The same data, eager-loaded: three queries in total.
app.get('/users/:id/orders-fixed', async (req, res) => {
  const orders = await Order.findAll({
    where: { user_id: req.params.id },
    include: [{ model: OrderItem, as: 'items', separate: true, include: [Product] }],
  });
  res.json(orders.flatMap((o) => o.items.map((i) => ({ order: o.id, product: i.Product.name, quantity: i.quantity }))));
});

// Every product, no pagination.
app.get('/products', async (req, res) => {
  res.json(await Product.findAll());
});

// The same count, recomputed for every row.
app.get('/dashboard', async (req, res) => {
  const users = await User.findAll({ limit: 8, order: [['id', 'ASC']] });
  const rows = [];
  for (const user of users) {
    const totalUsers = await User.count();
    rows.push({ email: user.email, share: 1 / totalUsers });
  }
  res.json(rows);
});

// One INSERT per event (rolled back, so the demo database stays as seeded).
app.post('/events', async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const base = Date.now() * 1000;
    for (let i = 0; i < 20; i++) {
      await Event.create({ id: base + i, userId: 1, kind: 'demo', createdAt: new Date() }, { transaction: t });
    }
  } finally {
    await t.rollback();
  }
  res.status(201).json({ ok: true });
});

module.exports = app;
