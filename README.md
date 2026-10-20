<div align="center">

<img src="docs/assets/logo.svg" width="96" alt="QueryLens logo">

# QueryLens

**Monitor the queries your app sends, in production, and find the N+1s, loops and slow
statements, with the fix written for your ORM.**

[![CI](https://github.com/EagleMind/querylens/actions/workflows/ci.yml/badge.svg)](https://github.com/EagleMind/querylens/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-f2d84a.svg)](LICENSE)
![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-4169E1?logo=postgresql&logoColor=white)
![MySQL](https://img.shields.io/badge/MySQL-4479A1?logo=mysql&logoColor=white)

</div>

QueryLens works like an error tracker for your database traffic. An SDK in your Node.js
backend watches every query your ORM sends to PostgreSQL or MySQL. It reports the requests that look wrong, with
values removed, to a backend you deploy on Cloudflare's free plan. The web dashboard shows a
live feed of requests and statements, and the issues it found, grouped across requests and
releases, each with the line of code responsible and the fix for your ORM.

## Set up

1. **Deploy the backend** (Cloudflare Workers + Durable Objects, free plan). See
   [cloud/README.md](cloud/README.md):

   ```bash
   cd cloud && pnpm install && pnpm deploy
   ```

2. **Create a project** in the dashboard and copy its DSN from Settings.

3. **Add the SDK** to your app:

   ```bash
   npm install querylens-node
   ```

   ```bash
   QUERYLENS_DSN=https://<key>@querylens.<you>.workers.dev/<project>
   ```

   ```js
   require('querylens-node/register') // first line of your entry file (or: import 'querylens-node/register')
   ```

## What it finds

| Finding | How |
|---|---|
| **N+1 queries** | The same SELECT run once per row of the previous result, with different values |
| **Duplicate queries** | The identical statement repeated back to back |
| **Writes in a loop** | INSERT / UPDATE / DELETE one row at a time (→ `bulkCreate`, one `UPDATE … WHERE id IN`) |
| **Large results** | Thousands of rows with no LIMIT |
| **Slow and failing statements** | Including errors the ORM swallowed |
| **Chatty requests** | A request that runs dozens of statements |

Sequelize gets code-level fixes (`include` with `separate`, `bulkCreate`, `findAndCountAll`…).
Prisma, TypeORM, Django, Active Record, SQLAlchemy and Hibernate are recognized, and the fix
names the right API.

The dashboard has:
- **Live:** requests as they arrive, with their statements and findings, plus statements per minute.
- **Evaluation:** open, resolved and ignored issues. A resolved issue that comes back is
  flagged as regressed. Also the statements costing the most time.
- **Settings:** DSN and setup, detection thresholds, live-feed sampling, projects.

## Private by default

In production the SDK sends no values. Literals become `?`, bound parameters are dropped, and
only a hash of the values tells an N+1 from a repeated query. Your queries are never modified,
and sending happens in the background with bounded memory. The backend runs in your own
Cloudflare account.

## Repository

```
integrations/node/   the SDK (querylens-node)
cloud/               the backend (Worker + Durable Objects) and the dashboard (React)
crates/core/         the analysis: fingerprints, pattern detection, ORM fixes (Rust)
crates/wasm/         crates/core as WebAssembly, run by the backend
dev/                 demo PostgreSQL and MySQL, and a Sequelize app with the usual ORM mistakes
docs/                architecture
```

## Development

| Command | What it does |
|---|---|
| `cargo test --workspace` | Rust tests (also regenerates `cloud/bindings` from the Rust types) |
| `node --test "integrations/node/*.test.cjs"` | SDK tests |
| `cd cloud && pnpm dev` | Backend and dashboard locally, at http://localhost:5173 |
| `cd cloud && pnpm build:core` | Rebuild the WebAssembly module after changing `crates/` |
| `cd cloud && pnpm typecheck` | TypeScript (Worker and dashboard) |
| `docker compose -f dev/docker-compose.yml up -d` | The demo databases (PostgreSQL and MySQL) for `dev/sequelize-demo` |

See [docs/architecture.md](docs/architecture.md) for how the pieces fit.

## License

[MIT](LICENSE)
