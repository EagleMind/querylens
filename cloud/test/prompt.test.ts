import assert from 'node:assert/strict'
import { test } from 'node:test'

import { fenceFor, fixPrompt, numbered, timeline } from '../worker/issues/prompt.ts'
import { ITEMS_SQL, context, statement } from './fixtures.ts'

test('the prompt carries the evidence and the fix', () => {
  const p = fixPrompt(context())
  for (const part of [
    '# Fix a database issue QueryLens found: N+1: order_items loaded once per order',
    'ORM: Sequelize',
    '- `src/routes/orders.js:42` (37×)',
    ITEMS_SQL,
    'It runs once per row returned by:',
    '## The request it was last seen in: GET /orders',
    '## The code, as the SDK read it',
    '42→     order.items = await OrderItem.findAll',
    '## The fix QueryLens suggests for Sequelize',
    '```js\nOrder.findAll({ include: OrderItem })\n```',
    '## What to do',
  ]) {
    assert.ok(p.includes(part), `missing: ${part}`)
  }
})

test('without source or a fix, the prompt says what it has', () => {
  const ctx = context({ sources: [], latest: null })
  ctx.detail = { ...ctx.detail, fix: null, origins: [] }
  const p = fixPrompt(ctx)
  assert.ok(!p.includes('## The code'))
  assert.ok(!p.includes('## The fix'))
  assert.ok(p.includes('No line of application code was on the stack'))
})

test('the timeline folds runs of one statement', () => {
  const lines = timeline(context().latest!.statements, 'fp-items')
  assert.equal(lines.length, 2)
  assert.match(lines[0], /^ {2}#1 /)
  assert.match(lines[1], /^→ #2–9 ×8 .*order_items.*← src\/routes\/orders\.js:42$/)
  const many = Array.from({ length: 100 }, (_, i) => statement(i + 1, `SELECT ${i}`, { fingerprint: `f${i}` }))
  const long = timeline(many, 'x')
  assert.equal(long.length, 41)
  assert.equal(long[40], '  … 60 more lines')
})

test('code blocks are numbered, fenced by language and safe from backticks', () => {
  assert.equal(numbered({ origin: 'a.ts:10', firstLine: 9, lines: ['a', 'b', 'c'] }), ' 9  a\n10→ b\n11  c')
  assert.equal(fenceFor('src/a.tsx:3'), 'tsx')
  assert.equal(fenceFor('lib/x.py'), 'python')
  assert.equal(fenceFor('Makefile:1'), '')
  const ctx = context()
  ctx.detail = { ...ctx.detail, fix: { orm: null, text: 'x', code: 'sql`SELECT ```', ddl: null } }
  assert.ok(fixPrompt(ctx).includes('````js\nsql`SELECT ```\n````'))
})
