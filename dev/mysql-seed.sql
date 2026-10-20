-- Demo data for dev/sequelize-demo (MySQL). Same data as seed.sql (PostgreSQL).
--   1,000 users · 1,500 products · 10,000 orders (10 per user) · 20,000 order items · 5,000 events
SET SESSION cte_max_recursion_depth = 20000;

CREATE TABLE users (
  id         BIGINT PRIMARY KEY,
  email      VARCHAR(255) NOT NULL UNIQUE,
  country    CHAR(2) NOT NULL,
  created_at DATETIME NOT NULL
);

CREATE TABLE products (
  id       BIGINT PRIMARY KEY,
  name     VARCHAR(255) NOT NULL,
  category VARCHAR(32) NOT NULL,
  price    DECIMAL(10,2) NOT NULL
);

CREATE TABLE orders (
  id         BIGINT PRIMARY KEY,
  user_id    BIGINT NOT NULL,
  status     VARCHAR(16) NOT NULL,
  total      DECIMAL(12,2) NOT NULL,
  created_at DATETIME NOT NULL
);

CREATE TABLE order_items (
  order_id   BIGINT NOT NULL,
  product_id BIGINT NOT NULL,
  quantity   INT NOT NULL
);

CREATE TABLE events (
  id         BIGINT PRIMARY KEY,
  user_id    BIGINT NOT NULL,
  kind       VARCHAR(16) NOT NULL,
  created_at DATETIME NOT NULL
);

INSERT INTO users
WITH RECURSIVE g(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM g WHERE n < 1000)
SELECT n, CONCAT('user', n, '@example.com'), ELT(1 + n % 6, 'US', 'DE', 'FR', 'TN', 'JP', 'BR'), NOW() - INTERVAL (n % 365) DAY
FROM g;

INSERT INTO products
WITH RECURSIVE g(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM g WHERE n < 1500)
SELECT n, CONCAT('Product ', n), ELT(1 + n % 4, 'books', 'games', 'tools', 'food'), (n % 500) + 0.99
FROM g;

INSERT INTO orders
WITH RECURSIVE g(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM g WHERE n < 10000)
SELECT n, 1 + n % 1000, ELT(1 + n % 5, 'pending', 'paid', 'shipped', 'delivered', 'cancelled'),
       ((n * 31) % 100000) / 100.0, NOW() - INTERVAL (n % 365) DAY
FROM g;

INSERT INTO order_items
WITH RECURSIVE g(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM g WHERE n < 20000)
SELECT 1 + n % 10000, 1 + (n * 13) % 1500, 1 + n % 4
FROM g;

INSERT INTO events
WITH RECURSIVE g(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM g WHERE n < 5000)
SELECT n, 1 + n % 1000,
       CASE WHEN n % 100 = 0 THEN 'purchase' WHEN n % 10 = 0 THEN 'click' ELSE 'view' END,
       NOW() - INTERVAL (n % 365) DAY
FROM g;
