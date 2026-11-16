import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

// The asset layer serves the dashboard without running the Worker (`runWorkerFirst` only covers
// /api/* and /mcp), so its response headers come from public/_headers.
const rules = readFileSync(new URL('../public/_headers', import.meta.url), 'utf8')

test('the dashboard cannot be framed by another site', () => {
  assert.match(rules, /^\/\*$/m)
  assert.match(rules, /Content-Security-Policy:\s*frame-ancestors 'none'/)
  assert.match(rules, /X-Frame-Options:\s*DENY/)
})
