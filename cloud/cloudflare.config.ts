import { bindings, defineConfig, exports } from "cf/config";
import * as entrypoint from "./worker/index.ts" with { type: "cf-worker" };

// One Worker: the dashboard (static assets), its API, the SDK ingest endpoint, the MCP server
// for coding agents, and two SQLite-backed Durable Objects: `Project` (one per monitored app:
// issues, stats, live feed) and `Registry` (the list of projects). Workers AI writes code
// rewrites and filters on demand. Everything fits the Workers Free plan.
export default defineConfig({
	worker: {
		name: "querylens",
		compatibilityDate: "2026-10-06",
		// The Worker reaches its own Durable Objects through `ctx.exports`.
		compatibilityFlags: ["enable_ctx_exports"],
		entrypoint,
		assets: {
			notFoundHandling: "single-page-application",
			runWorkerFirst: ["/api/*", "/mcp"],
		},
		exports: {
			Project: exports.durableObject({ storage: "sqlite" }),
			Registry: exports.durableObject({ storage: "sqlite" }),
		},
		env: {
			ASSETS: bindings.assets(),
			/** The dashboard's sign-in token. */
			ADMIN_TOKEN: bindings.secret(),
			/** Code rewrites and filters from descriptions, on demand (worker/ai). */
			// Workers AI has no local simulation: in `pnpm dev` it calls your account (cf auth login).
			AI: bindings.ai({ dev: { remote: true } }),
		},
		observability: { enabled: true },
	},
});
