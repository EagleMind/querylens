-- MySQL demo dataset with the same deliberate problems as seed.sql:
--   * orders.user_id has no index (no FOREIGN KEY either: InnoDB would add one)
--   * orders.status is low-cardinality and unindexed
--   * events.kind is skewed and indexed
SET SESSION cte_max_recursion_depth = 2000000;

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

CREATE TABLE events (
  id         BIGINT PRIMARY KEY,
  user_id    BIGINT NOT NULL,
  kind       VARCHAR(16) NOT NULL,
  created_at DATETIME NOT NULL,
  INDEX events_kind_idx (kind)
);

INSERT INTO users
WITH RECURSIVE g(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM g WHERE n < 100000)
SELECT n, CONCAT('user', n, '@example.com'),
       ELT(1 + n % 6, 'US', 'DE', 'FR', 'TN', 'JP', 'BR'),
       NOW() - INTERVAL (n % 1000) DAY
FROM g;

INSERT INTO products
WITH RECURSIVE g(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM g WHERE n < 5000)
SELECT n, CONCAT('Product ', n), ELT(1 + n % 4, 'books', 'games', 'tools', 'food'), (n % 500) + 0.99
FROM g;

INSERT INTO orders
WITH RECURSIVE g(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM g WHERE n < 1000000)
SELECT n, 1 + (n * 7919) % 100000,
       ELT(1 + n % 5, 'pending', 'paid', 'shipped', 'delivered', 'cancelled'),
       ((n * 31) % 100000) / 100.0,
       NOW() - INTERVAL (n % 730) DAY
FROM g;

INSERT INTO events
WITH RECURSIVE g(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM g WHERE n < 1000000)
SELECT n, 1 + (n * 7919) % 100000,
       CASE WHEN n % 10000 = 0 THEN 'refund'
            WHEN n % 100 = 0   THEN 'purchase'
            WHEN n % 10 = 0    THEN 'click'
            ELSE 'view' END,
       NOW() - INTERVAL (n % 365) DAY
FROM g;

ANALYZE TABLE users, products, orders, events;

-- Top queries reads statement digests.
GRANT SELECT ON performance_schema.* TO 'querylens'@'%';
