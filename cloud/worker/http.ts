// HTTP plumbing shared by the Worker's endpoints: errors, JSON replies, bounded bodies, auth.

/** Request bodies, compressed or not, and after decompression. */
const MAX_BODY = 4 * 1024 * 1024
const MAX_INFLATED = 16 * 1024 * 1024

export { authorized, sameSecret } from './auth'

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
