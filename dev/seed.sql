-- Demo data for dev/sequelize-demo (PostgreSQL). Small on purpose: enough for the demo's
-- N+1s, loops and large result to show up, nothing more. Same data as mysql-seed.sql.
--   1,000 users · 1,500 products · 10,000 orders (10 per user) · 20,000 order items · 5,000 events

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

CREATE TABLE events (
  id         bigint PRIMARY KEY,
  user_id    bigint NOT NULL,
  kind       text NOT NULL,
  created_at timestamptz NOT NULL
);

INSERT INTO users
SELECT g, 'user' || g || '@example.com', (ARRAY['US','DE','FR','TN','JP','BR'])[1 + g % 6], now() - (g % 365) * interval '1 day'
FROM generate_series(1, 1000) g;

INSERT INTO products
SELECT g, 'Product ' || g, (ARRAY['books','games','tools','food'])[1 + g % 4], (g % 500) + 0.99
FROM generate_series(1, 1500) g;

INSERT INTO orders
SELECT g, 1 + g % 1000, (ARRAY['pending','paid','shipped','delivered','cancelled'])[1 + g % 5],
       ((g * 31) % 100000) / 100.0, now() - (g % 365) * interval '1 day'
FROM generate_series(1, 10000) g;

INSERT INTO order_items
SELECT 1 + g % 10000, 1 + (g * 13) % 1500, 1 + g % 4
FROM generate_series(1, 20000) g;

INSERT INTO events
SELECT g, 1 + g % 1000,
       CASE WHEN g % 100 = 0 THEN 'purchase' WHEN g % 10 = 0 THEN 'click' ELSE 'view' END,
       now() - (g % 365) * interval '1 day'
FROM generate_series(1, 5000) g;
