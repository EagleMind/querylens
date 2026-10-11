// Models over the demo database (dev/seed.sql). Associations are declared, but
// the routes in app.js mostly use them lazily, the way N+1s happen in real code.
const { Sequelize, DataTypes } = require('sequelize');

const sequelize = new Sequelize(process.env.DATABASE_URL || 'postgres://querylens@localhost:54329/shop', {
  logging: false,
  define: { timestamps: false, underscored: true },
});

const User = sequelize.define('User', {
  id: { type: DataTypes.BIGINT, primaryKey: true },
  email: DataTypes.TEXT,
  country: DataTypes.TEXT,
}, { tableName: 'users' });

const Order = sequelize.define('Order', {
  id: { type: DataTypes.BIGINT, primaryKey: true },
  status: DataTypes.TEXT,
  total: DataTypes.DECIMAL(12, 2),
}, { tableName: 'orders' });

const OrderItem = sequelize.define('OrderItem', {
  orderId: { type: DataTypes.BIGINT, primaryKey: true },
  productId: { type: DataTypes.BIGINT, primaryKey: true },
  quantity: DataTypes.INTEGER,
}, { tableName: 'order_items' });

const Product = sequelize.define('Product', {
  id: { type: DataTypes.BIGINT, primaryKey: true },
  name: DataTypes.TEXT,
  category: DataTypes.TEXT,
  price: DataTypes.DECIMAL(10, 2),
}, { tableName: 'products' });

const Event = sequelize.define('Event', {
  id: { type: DataTypes.BIGINT, primaryKey: true },
  userId: DataTypes.BIGINT,
  kind: DataTypes.TEXT,
  createdAt: DataTypes.DATE,
}, { tableName: 'events' });

User.hasMany(Order, { foreignKey: 'user_id' });
Order.belongsTo(User, { foreignKey: 'user_id' });
Order.hasMany(OrderItem, { foreignKey: 'order_id', as: 'items' });
OrderItem.belongsTo(Product, { foreignKey: 'product_id' });

module.exports = { sequelize, User, Order, OrderItem, Product, Event };
