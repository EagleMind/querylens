# Sequelize demo

A small Express + Sequelize app over the demo database, with the mistakes ORMs make easy:
lazy-loaded associations in loops (N+1), an unpaginated list, a query repeated per row, and
inserts one at a time. `/users/:id/orders-fixed` is the eager-loaded version of `/users/:id/orders`.

It's already set up with the SDK (`querylens init` added the first line of `server.js`; the
package comes from `integrations/node` until it's published).

Start the demo database (from the repository root), then install:

```bash
docker compose -f dev/docker-compose.yml up -d --build postgres
```

```bash
npm install
```

Record while you use the app: start capturing, then in another terminal `npm start` and open
http://localhost:3000/users/42/orders. Press Ctrl+C in the first terminal for the report.

```bash
npx querylens-cli capture
```

Or record the test suite in one go:

```bash
npx querylens-cli capture -- npm test
```

The database comes from `.env`; there's nothing else to configure.
