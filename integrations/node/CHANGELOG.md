# Changelog

## 0.3.0

Upgrading from 0.2.0 needs no change in your app. The new drivers are picked up as soon as
they're installed; source context is off until you turn it on.

### New databases and drivers

- **SQLite**: [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3),
  [`sqlite3`](https://github.com/TryGhost/node-sqlite3), `node:sqlite` (the SDK never loads it
  itself, so it doesn't print Node's experimental warning), and
  [libSQL / Turso](https://github.com/tursodatabase/libsql-client-ts) (HTTP, WebSocket and
  local files).
- **MongoDB**: the [`mongodb`](https://www.mongodb.com/docs/drivers/node/) driver and
  [Mongoose](https://mongoosejs.com/). Commands are sent as value-free shapes
  (`db.orders.find({"userId": ?})`, or `Order.find(…)` through a Mongoose model), and a cursor
  read in batches counts as one query. The SDK turns on the driver's command monitoring when
  a client connects.
- **Neon** (`@neondatabase/serverless`): HTTP queries and the WebSocket `Pool` / `Client`.
- **PlanetScale** (`@planetscale/database`).
- **postgres.js** (`postgres`), and Drizzle's postgres-js driver.
- **Prisma**, with the new `querylens-node/prisma` client extension: queries carry the line
  of your Prisma call. See the README.

Drivers that ship separate CommonJS and ES module builds (Neon, PlanetScale, libSQL) are
patched in both, so apps using `import` are covered.

### Better attribution

- Drizzle queries carry the line of code that awaited them.
- `pg` and `mysql2` pool queries carry the line that called `pool.query`, and queries waiting
  for a free connection stay in their own request.

### Source context (opt-in)

`sourceContext: true` or `QUERYLENS_SOURCE_CONTEXT=1` sends the code around each line that ran
a reported query, so the dashboard can show it and write fixes against it. Lines are read in
the background, once per process. Only files inside the project are read, and anything that
looks like a secret is masked before sending.

### Compatibility

- Node.js 18 or later, as before. `node:sqlite` needs a Node version that has it (22.5+).
- Works with older QueryLens backends: they skip what they don't know (source context,
  MongoDB shapes). Deploy the latest backend to get SQLite and MongoDB findings and fixes.
