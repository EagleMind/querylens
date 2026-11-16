import assert from 'node:assert/strict'
import { test } from 'node:test'

import { authorized } from '../worker/auth.ts'

const env = { ADMIN_TOKEN: 'dev-admin-token' } as Env
const live = (headers: Record<string, string>) =>
  new Request('https://querylens.example/api/0/live?project=0123456789ab', { headers })

test('the live feed takes the admin token in its WebSocket subprotocol', () => {
  assert.equal(authorized(live({ 'sec-websocket-protocol': 'dev-admin-token' }), env, true), true)
  assert.equal(authorized(live({ 'sec-websocket-protocol': 'wrong' }), env, true), false)
  assert.equal(authorized(live({}), env, true), false)
  assert.equal(authorized(live({ authorization: 'Bearer dev-admin-token' }), env, true), true)
})

test('a query-string token is not accepted', () => {
  const url = new URL('https://querylens.example/api/0/live?project=0123456789ab&token=dev-admin-token')
  assert.equal(authorized(new Request(url), env, true), false)
  assert.equal(authorized(new Request(url, { headers: { 'sec-websocket-protocol': 'dev-admin-token' } }), env, true), true)
})
