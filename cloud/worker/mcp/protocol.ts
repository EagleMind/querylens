// The Model Context Protocol, as much of it as a stateless tools-only server needs: JSON-RPC
// 2.0 messages over Streamable HTTP, answered with plain JSON (no sessions, no server-sent
// events). `initialize`, `ping`, `tools/list` and `tools/call`; notifications are accepted
// and ignored. Pure: tools are given, I/O is the caller's.

/** Versions this server speaks, newest first. */
export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26']

export interface ServerInfo {
  name: string
  version: string
  /** How to use the tools, for the client's model. */
  instructions: string
}

export interface ToolAnnotations {
  title?: string
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint?: boolean
}

export interface ToolResult {
  content: { type: 'text'; text: string }[]
  structuredContent?: Record<string, unknown>
  isError?: boolean
}

export interface Tool {
  name: string
  title: string
  description: string
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[]; additionalProperties?: boolean }
  annotations: ToolAnnotations
  run(args: Record<string, unknown>): Promise<ToolResult>
}

/** A problem the caller's model can act on (bad arguments, no such issue): a tool result, not a protocol error. */
export class ToolError extends Error {}

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: string | number | null
  method: string
  params?: Record<string, unknown>
}

export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: string | number | null
  result?: unknown
  error?: { code: number; message: string }
}

export const ERRORS = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
} as const

export function text(value: string, structured?: Record<string, unknown>): ToolResult {
  return { content: [{ type: 'text', text: value }], ...(structured ? { structuredContent: structured } : {}) }
}

function isRequest(m: unknown): m is JsonRpcRequest {
  return m !== null && typeof m === 'object' && (m as JsonRpcRequest).jsonrpc === '2.0' && typeof (m as JsonRpcRequest).method === 'string'
}

function failure(id: JsonRpcResponse['id'], code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

export function negotiate(requested: unknown): string {
  return typeof requested === 'string' && PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0]
}

/** One message; `null` for notifications (and responses a client sends), which get no answer. */
export async function handle(message: unknown, info: ServerInfo, tools: Tool[]): Promise<JsonRpcResponse | null> {
  if (!isRequest(message)) {
    const id = (message as JsonRpcResponse | null)?.id
    // A response to nothing we asked: ignore it. Anything else is malformed.
    if (message !== null && typeof message === 'object' && 'id' in message && ('result' in message || 'error' in message)) return null
    return failure(typeof id === 'string' || typeof id === 'number' ? id : null, ERRORS.invalidRequest, 'Not a JSON-RPC 2.0 request.')
  }
  if (message.id === undefined || message.id === null) return null
  const { id, method, params = {} } = message
  switch (method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: negotiate(params.protocolVersion),
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: info.name, version: info.version },
          instructions: info.instructions,
        },
      }
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} }
    case 'tools/list':
      return {
        jsonrpc: '2.0',
        id,
        result: { tools: tools.map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations })) },
      }
    case 'tools/call': {
      const tool = tools.find((t) => t.name === params.name)
      if (!tool) return failure(id, ERRORS.invalidParams, `Unknown tool: ${String(params.name)}`)
      const args = params.arguments
      if (args !== undefined && (args === null || typeof args !== 'object' || Array.isArray(args))) {
        return failure(id, ERRORS.invalidParams, 'Tool arguments must be an object.')
      }
      try {
        return { jsonrpc: '2.0', id, result: await tool.run((args ?? {}) as Record<string, unknown>) }
      } catch (e) {
        if (e instanceof ToolError) return { jsonrpc: '2.0', id, result: { ...text(e.message), isError: true } }
        console.error('mcp tool', tool.name, e)
        return failure(id, ERRORS.internal, 'Internal error.')
      }
    }
    default:
      return failure(id, ERRORS.methodNotFound, `Method not found: ${method}`)
  }
}

/** A POST body: one message or (2025-03-26) a batch. `null` when nothing needs an answer. */
export async function handleBody(body: string, info: ServerInfo, tools: Tool[]): Promise<JsonRpcResponse | JsonRpcResponse[] | null> {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return failure(null, ERRORS.parse, 'Invalid JSON.')
  }
  if (Array.isArray(parsed)) {
    if (parsed.length === 0) return failure(null, ERRORS.invalidRequest, 'Empty batch.')
    const answers = (await Promise.all(parsed.map((m) => handle(m, info, tools)))).filter((a) => a !== null)
    return answers.length ? answers : null
  }
  return handle(parsed, info, tools)
}
