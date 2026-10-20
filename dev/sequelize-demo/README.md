# Sequelize demo

A small Express + Sequelize app over the demo database, with the mistakes ORMs make easy:
lazy-loaded associations in loops (N+1), an unpaginated list, a query repeated per row, and
inserts one at a time. `/users/:id/orders-fixed` is the eager-loaded version of `/users/:id/orders`.

It's set up with the SDK: the first line of `server.js` loads it, and the package comes from
`integrations/node`.

Start a demo database (from the repository root), then install. Both have the same data:

```bash
docker compose -f dev/docker-compose.yml up -d postgres
```

```bash
docker compose -f dev/docker-compose.yml up -d mysql
```

```bash
npm install
```

Run the backend (`pnpm dev` in `cloud/`), create a project in the dashboard, and start the app
with its DSN. `NODE_ENV=production` behaves as it would in production (values removed,
sampling):

```bash
QUERYLENS_DSN="<DSN>" NODE_ENV=production PORT=3000 npm start
```

On MySQL, add `DATABASE_URL=mysql://querylens:querylens@localhost:33069/shop`.

Then open http://localhost:3000/users/1/orders a few times and watch the dashboard's Live and
Evaluation pages.
