// The admin token check, kept out of http.ts so it can be unit-tested without the Worker runtime.

/** Compare secrets without leaking how much of them matched through timing. */
export function sameSecret(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/**
 * Whether the request carries the admin token: `Authorization: Bearer …`, or — for a WebSocket,
 * where a browser can set a subprotocol but not an Authorization header — `Sec-WebSocket-Protocol`.
 */
export function authorized(request: Request, env: Env, allowProtocol = false): boolean {
  if (!env.ADMIN_TOKEN) return false
  const header = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim()
  const protocol = allowProtocol ? request.headers.get('sec-websocket-protocol')?.split(',')[0]?.trim() : ''
  const token = header || protocol || ''
  return sameSecret(token, env.ADMIN_TOKEN)
}
