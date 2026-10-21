import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { Issue } from '../bindings/Issue'
import type { Project } from '../bindings/Project'
import { PROTOCOL_VERSIONS, handle, handleBody } from '../worker/mcp/protocol.ts'
import { type McpBackend, SERVER_INFO, tools } from '../worker/mcp/tools.ts'
import { context } from './fixtures.ts'

const issue: Issue = context().detail.issue
const project = (id: string, name: string): Project => ({
  id,
  name,
  backends: [
    { id: '1a2b3c4d', name: 'orders', dsn: 'https://k@h/x', orm: 'sequelize', createdAt: '', lastSeen: null },
    { id: '5e6f7a8b', name: 'billing', dsn: null, orm: 'prisma', createdAt: '', lastSeen: null },
  ],
  settings: {} as Project['settings'],
  createdAt: '',
})

function backend(projects = [project('0123456789ab', 'Shop API')]): McpBackend & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    projects: async () => projects,
    issues: async (id, q) => {
      calls.push(`issues ${id} ${q.backend ?? 'all'} ${q.status} ${q.sort} ${q.limit}`)
      return [issue]
    },
    issuePrompt: async (id, n) => `brief for ${id} #${n}`,
    setStatus: async (_id, n, status) => ({ ...issue, id: n, status }),
    regressions: async () => [],
  }
}

const info = SERVER_INFO('test')
const call = (name: string, args: Record<string, unknown>, b = backend()) =>
  handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, info, tools(b))

test('initialize negotiates the protocol version', async () => {
  const r = await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }, info, [])
  assert.equal((r!.result as { protocolVersion: string }).protocolVersion, '2025-03-26')
  const newer = await handle({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2099-01-01' } }, info, [])
  assert.equal((newer!.result as { protocolVersion: string }).protocolVersion, PROTOCOL_VERSIONS[0])
})

test('notifications get no answer; unknown methods and bad JSON get errors', async () => {
  assert.equal(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' }, info, []), null)
  assert.equal((await handle({ jsonrpc: '2.0', id: 3, method: 'nope' }, info, []))!.error!.code, -32601)
  assert.equal(((await handleBody('{', info, [])) as { error: { code: number } }).error.code, -32700)
  const batch = await handleBody(JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', method: 'x' }]), info, [])
  assert.deepEqual(batch, [{ jsonrpc: '2.0', id: 1, result: {} }])
})

test('tools are listed with schemas and hints', async () => {
  const r = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, info, tools(backend()))
  const listed = (r!.result as { tools: { name: string; annotations: { readOnlyHint?: boolean } }[] }).tools
  assert.deepEqual(
    listed.map((t) => t.name),
    ['list_projects', 'list_issues', 'get_issue', 'list_regressions', 'set_issue_status'],
  )
  assert.equal(listed.find((t) => t.name === 'set_issue_status')!.annotations.readOnlyHint, false)
})

test('the only project is used when none is named', async () => {
  const b = backend()
  const r = await call('list_issues', {}, b)
  assert.deepEqual(b.calls, ['issues 0123456789ab all unresolved impact 20'])
  const text = (r!.result as { content: { text: string }[] }).content[0].text
  assert.match(text, /#7 \[high\] N\+1 query: N\+1: order_items loaded once per order/)
  assert.match(text, / · orders, production · /)
})

test('a backend is picked by name or id, and an unknown one is an error', async () => {
  const b = backend()
  await call('list_issues', { backend: 'Billing' }, b)
  await call('list_issues', { backend: '1a2b3c4d' }, b)
  assert.deepEqual(b.calls, ['issues 0123456789ab 5e6f7a8b unresolved impact 20', 'issues 0123456789ab 1a2b3c4d unresolved impact 20'])
  const r = await call('list_issues', { backend: 'search' }, b)
  assert.equal((r!.result as { isError: boolean }).isError, true)
  assert.match((r!.result as { content: { text: string }[] }).content[0].text, /No backend "search" in Shop API\. Backends: orders, billing\./)
  const listed = (await call('list_projects', {}, b))!.result as { content: { text: string }[] }
  assert.match(listed.content[0].text, /- backend billing \(id 5e6f7a8b\), Prisma, disconnected/)
})

test('with several projects, one is picked by name or id', async () => {
  const b = backend([project('0123456789ab', 'Shop API'), project('ba9876543210', 'Admin')])
  const unnamed = await call('get_issue', { issue: 7 }, b)
  assert.equal((unnamed!.result as { isError: boolean }).isError, true)
  assert.match((unnamed!.result as { content: { text: string }[] }).content[0].text, /Say which project: Shop API \(0123456789ab\), Admin/)
  const named = await call('get_issue', { project: 'admin', issue: '#7' }, b)
  assert.equal((named!.result as { content: { text: string }[] }).content[0].text, 'brief for ba9876543210 #7')
})

test('bad arguments are tool errors the agent can read', async () => {
  const r = await call('set_issue_status', { issue: 7, status: 'deleted' })
  assert.equal((r!.result as { isError: boolean }).isError, true)
  const ok = await call('set_issue_status', { issue: 7, status: 'resolved' })
  assert.equal((ok!.result as { content: { text: string }[] }).content[0].text, 'Issue #7 is now resolved.')
  assert.equal((await call('nope', {}))!.error!.code, -32602)
})
