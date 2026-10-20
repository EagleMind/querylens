// The one place that talks to a language model. Features ask a `JsonModel` for JSON that
// follows a schema; `workersAi` is the implementation on the Worker's Workers AI binding
// (it runs in the user's own Cloudflare account, like everything else), and tests pass a fake.

/**
 * The default model. Compared on the same N+1 rewrite (2026-10), it wrote correct code where
 * Llama 3.3 70B didn't, for about 100 neurons a call: around a hundred calls a day fit the
 * free allowance. Kimi K2.7 Code did a little better at five times the cost.
 */
export const DEFAULT_MODEL = '@cf/openai/gpt-oss-120b'

export interface ChatMessage {
  role: 'system' | 'user'
  content: string
}

export interface JsonRequest {
  messages: ChatMessage[]
  /** JSON Schema the reply must follow. */
  schema: Record<string, unknown>
  maxTokens: number
  temperature?: number
}

export interface JsonModel {
  readonly name: string
  /** The model's reply, parsed; throws `AiError` when there's none or it isn't JSON. */
  json(request: JsonRequest): Promise<unknown>
}

export type AiErrorKind =
  /** The model couldn't be reached or failed. */
  | 'failed'
  /** It answered, but not with something usable. */
  | 'bad_output'

export class AiError extends Error {
  readonly kind: AiErrorKind

  constructor(kind: AiErrorKind, message: string) {
    super(message)
    this.kind = kind
  }
}

/** Parse a model's text reply as JSON, tolerating a Markdown fence around it. */
export function parseReply(reply: unknown): unknown {
  if (reply !== null && typeof reply === 'object') return reply
  if (typeof reply !== 'string' || !reply.trim()) throw new AiError('bad_output', 'The model returned nothing.')
  const text = reply.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  try {
    return JSON.parse(text)
  } catch {
    throw new AiError('bad_output', 'The model’s reply wasn’t valid JSON.')
  }
}

type Completion = {
  /** Workers AI's own shape. */
  response?: unknown
  /** The OpenAI chat completion shape, which newer models answer in. */
  choices?: { message?: { content?: unknown }; finish_reason?: string }[]
}

/** The reply's content, from either shape a model answers in. */
export function replyOf(result: unknown): unknown {
  const r = (result ?? {}) as Completion
  if (r.response !== undefined) return r.response
  const choice = r.choices?.[0]
  if (choice?.finish_reason === 'length' && !choice.message?.content) {
    throw new AiError('bad_output', 'The model ran out of room before answering. Try again.')
  }
  return choice?.message?.content
}

export function workersAi(ai: Ai, model: string = DEFAULT_MODEL): JsonModel {
  return {
    name: model,
    async json({ messages, schema, maxTokens, temperature = 0.2 }) {
      let result: unknown
      try {
        // The binding's types list every model's own input type; this is the chat shape they share.
        result = await (ai.run as (model: string, input: unknown) => Promise<unknown>)(model, {
          messages,
          response_format: { type: 'json_schema', json_schema: schema },
          max_tokens: maxTokens,
          temperature,
        })
      } catch (e) {
        console.error('workers ai', e)
        throw new AiError('failed', 'Workers AI didn’t answer. Try again in a moment.')
      }
      return parseReply(replyOf(result))
    },
  }
}
