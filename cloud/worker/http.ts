// HTTP plumbing shared by the Worker's endpoints: errors, JSON replies, bounded bodies, auth.

/** Request bodies, compressed or not, and after decompression. */
const MAX_BODY = 4 * 1024 * 1024
const MAX_INFLATED = 16 * 1024 * 1024

/** Thrown anywhere under a handler; the entry point turns it into a JSON error reply. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export function json(value: unknown, status = 200, headers: HeadersInit = {}): Response {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store', ...headers } })
}

export function fail(status: number, message: string): Response {
  const kind = (
    { 401: 'unauthorized', 404: 'not_found', 409: 'conflict', 429: 'rate_limited', 502: 'upstream', 503: 'unavailable' } as Record<number, string>
  )[status] ?? 'validation'
  return json({ kind, message }, status)
}

export function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Compare secrets without leaking how much of them matched through timing. */
export function sameSecret(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/**
 * Whether the request carries the admin token: `Authorization: Bearer …`, or `?token=` where
 * headers can't be set (browsers' WebSockets) when `allowQuery` is on.
 */
export function authorized(request: Request, env: Env, url: URL, allowQuery = false): boolean {
  if (!env.ADMIN_TOKEN) return false
  const header = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim()
  const token = header || (allowQuery ? url.searchParams.get('token') : null) || ''
  return sameSecret(token, env.ADMIN_TOKEN)
}

/** The body as text, gunzipped when the SDK compressed it, never more than the limits. */
export async function readBody(request: Request): Promise<string> {
  const declared = Number(request.headers.get('content-length') ?? 0)
  if (declared > MAX_BODY) throw new HttpError(413, 'Body too large.')
  if (!request.body) return ''
  let stream: ReadableStream<Uint8Array> = request.body
  const gzip = request.headers.get('content-encoding')?.toLowerCase() === 'gzip'
  if (gzip) stream = stream.pipeThrough(new DecompressionStream('gzip'))
  const limit = gzip ? MAX_INFLATED : MAX_BODY
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) {
      await reader.cancel()
      throw new HttpError(413, 'Body too large.')
    }
    chunks.push(value)
  }
  const all = new Uint8Array(size)
  let offset = 0
  for (const c of chunks) {
    all.set(c, offset)
    offset += c.byteLength
  }
  return new TextDecoder().decode(all)
}

export async function readJson<T>(request: Request): Promise<T> {
  try {
    return JSON.parse(await readBody(request)) as T
  } catch (e) {
    if (e instanceof HttpError) throw e
    throw new HttpError(400, 'Invalid JSON.')
  }
}
