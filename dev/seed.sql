-- Demo dataset with deliberate performance problems for QueryLens to find:
--   * orders.user_id has no index (seq scan + hash join on every lookup)
--   * orders.status is low-cardinality and unindexed
--   * statistics on order_items are stale (ANALYZE skipped) → row misestimates
CREATE TABLE users (
  id         bigint PRIMARY KEY,
  email      text NOT NULL UNIQUE,
  country    text NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE products (
  id       bigint PRIMARY KEY,
  name     text NOT NULL,
  category text NOT NULL,
  price    numeric(10,2) NOT NULL
);

CREATE TABLE orders (
  id         bigint PRIMARY KEY,
  user_id    bigint NOT NULL REFERENCES users(id),
  status     text NOT NULL,
  total      numeric(12,2) NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE order_items (
  order_id   bigint NOT NULL,
  product_id bigint NOT NULL,
  quantity   int NOT NULL
);

INSERT INTO users
SELECT g, 'user' || g || '@example.com',
       (ARRAY['US','DE','FR','TN','JP','BR'])[1 + g % 6],
       now() - (g % 1000) * interval '1 day'
FROM generate_series(1, 100000) g;

INSERT INTO products
SELECT g, 'Product ' || g, (ARRAY['books','games','tools','food'])[1 + g % 4], (g % 500) + 0.99
FROM generate_series(1, 5000) g;

INSERT INTO orders
SELECT g, 1 + (g * 7919) % 100000,
       (ARRAY['pending','paid','shipped','delivered','cancelled'])[1 + g % 5],
       ((g * 31) % 100000) / 100.0,
       now() - (g % 730) * interval '1 day'
FROM generate_series(1::bigint, 1000000) g;

ANALYZE users;
ANALYZE products;
ANALYZE orders;

-- Load order_items AFTER disabling autovacuum so planner stats stay stale.
ALTER TABLE order_items SET (autovacuum_enabled = false);
INSERT INTO order_items
SELECT 1 + (g % 1000000), 1 + (g * 13) % 5000, 1 + g % 4
FROM generate_series(1::bigint, 2000000) g;
