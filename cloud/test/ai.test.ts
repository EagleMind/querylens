import assert from 'node:assert/strict'
import { test } from 'node:test'

import { FILTER_SCHEMA, describeFields, draftFilter, filterMessages } from '../worker/ai/filters.ts'
import { AiError, parseReply, replyOf } from '../worker/ai/model.ts'
import { checkRewrite, contextHash, locate, suggestRewrite, unavailable } from '../worker/ai/rewrite.ts'
import { parseDraft } from '../shared/filters.ts'
import { SOURCE_LINES, context, fakeModel } from './fixtures.ts'

const GOOD = {
  summary: 'Load the items with the orders in one query.',
  origin: 'src/routes/orders.js:42',
  before: '  const orders = await Order.findAll()\n  for (const order of orders) {\n    order.items = await OrderItem.findAll({ where: { orderId: order.id } })\n  }',
  after: '  const orders = await Order.findAll({ include: OrderItem })',
  notes: ['Check that the Order hasMany OrderItem association exists.', ''],
}

test('replies are parsed, fenced or not', () => {
  assert.deepEqual(parseReply('```json\n{"a":1}\n```'), { a: 1 })
  assert.deepEqual(parseReply({ a: 1 }), { a: 1 })
  assert.throws(() => parseReply('nope'), AiError)
  assert.throws(() => parseReply(''), AiError)
  assert.equal(replyOf({ response: { a: 1 } }).a, 1)
  assert.equal(replyOf({ choices: [{ message: { content: '{"a":1}' }, finish_reason: 'stop' }] }), '{"a":1}')
  assert.throws(() => replyOf({ choices: [{ message: { content: '' }, finish_reason: 'length' }] }), /ran out of room/)
})

test('a rewrite needs a line of code and the code around it', () => {
  assert.equal(unavailable(context()), null)
  assert.equal(unavailable(context({ sources: [] })), 'needs_source')
  const ctx = context()
  ctx.detail = { ...ctx.detail, origins: [] }
  assert.equal(unavailable(ctx), 'no_origin')
})

test('the rewrite is placed where its lines really are', async () => {
  const model = fakeModel(GOOD)
  const s = await suggestRewrite(model, context(), new Date('2026-10-20T00:00:00Z'))
  assert.equal(s.file, 'src/routes/orders.js')
  assert.equal(s.line, 40, 'line 2 of a snippet starting at 39')
  assert.deepEqual(s.notes, ['Check that the Order hasMany OrderItem association exists.'])
  assert.equal(s.model, '@cf/test/model')
  assert.equal(model.asked[0].messages[1].content.includes('## The code, as the SDK read it'), true, 'the model gets the fix brief')
})

test('a rewrite copied without indentation is shown with the file’s', () => {
  const s = checkRewrite(
    {
      ...GOOD,
      before: 'for (const order of orders) {\n  order.items = await OrderItem.findAll({ where: { orderId: order.id } })\n}\n',
      after: 'for (const order of orders) {\n  order.items = byOrder.get(order.id) ?? []\n}',
    },
    context(),
  )
  assert.equal(s.line, 41)
  assert.equal(s.before, SOURCE_LINES.slice(2, 5).join('\n'), 'what’s replaced, as it is in the file')
  assert.equal(s.after, '  for (const order of orders) {\n    order.items = byOrder.get(order.id) ?? []\n  }')
})

test('a rewrite of code that isn’t there is refused', () => {
  assert.throws(() => checkRewrite({ ...GOOD, before: 'const x = invented()' }, context()), /isn’t in your file/)
  assert.throws(() => checkRewrite({ ...GOOD, after: GOOD.before }, context()), /no change/)
  assert.throws(() => checkRewrite({ summary: 'x' }, context()), /incomplete/)
})

test('lines are found whatever their indentation', () => {
  const snippet = { origin: 'a.js:1', firstLine: 1, lines: SOURCE_LINES }
  assert.equal(locate(snippet, 'res.json(orders)'), 5)
  assert.equal(locate(snippet, '\n  })\n'), 6)
  assert.equal(locate(snippet, ''), -1)
})

test('the stored rewrite is reused until the issue or its code changes', async () => {
  const a = await contextHash(context(), 'm')
  assert.equal(a, await contextHash(context(), 'm'))
  const changed = context()
  changed.sources = [{ ...changed.sources[0], lines: [...SOURCE_LINES, '// edited'] }]
  assert.notEqual(a, await contextHash(changed, 'm'))
  assert.notEqual(a, await contextHash(context(), 'other model'))
})

test('filters are drafted within the dashboard’s schema', async () => {
  const model = fakeModel({
    name: 'Slow checkout writes',
    match: 'all',
    conditions: [
      { field: 'request', op: 'contains', value: 'checkout' },
      { field: 'duration', op: 'gte', value: 100 },
      { field: 'type', op: 'is_not', value: 'select' },
      { field: 'color', op: 'is', value: 'red' },
      { field: 'duration', op: 'contains', value: 'slow' },
    ],
  })
  const draft = await draftFilter(model, { text: 'slow writes on checkout', releases: ['r9', 'r8'] })
  assert.deepEqual(draft, {
    name: 'Slow checkout writes',
    match: 'all',
    conditions: [
      { field: 'request', op: 'contains', value: 'checkout' },
      { field: 'duration', op: 'gte', value: '100' },
      { field: 'type', op: 'is_not', value: 'select' },
    ],
  })
  assert.ok(model.asked[0].messages[0].content.includes('"The last release" is r9'))
  await assert.rejects(draftFilter(fakeModel({ conditions: [] }), { text: 'x' }), AiError)
})

test('the model is told every field and value', () => {
  const fields = describeFields()
  for (const s of ['- duration:', 'gte, lte', '"n_plus_one" (N+1 query)', '"failed" (Failed)']) assert.ok(fields.includes(s), s)
  assert.equal(FILTER_SCHEMA.properties.conditions.items.properties.field.enum.length, 9)
  assert.equal(filterMessages({ text: '  x  ' })[1].content, 'x')
  assert.equal(parseDraft({ conditions: [{ field: 'issue', op: 'is', value: 'nonsense' }] }), null)
})
