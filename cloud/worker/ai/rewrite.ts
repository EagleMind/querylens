// A rewrite of the app's own code for an issue. querylens-core has already diagnosed the issue
// and written the fix for the ORM; the model only applies that fix to the code the SDK sent
// (source context). Its answer is checked against that code: the lines it says it replaces
// must be lines that are really there, which is also how its file and line are found. A
// rewrite of code it was never shown is refused, not passed on.
import type { SourceSnippet } from '../../bindings/SourceSnippet'
import type { IssueContext, Suggestion, SuggestionUnavailable } from '../../shared/api'
import { fixPrompt } from '../issues/prompt.ts'
import { AiError, type ChatMessage, type JsonModel } from './model.ts'

const MAX_NOTES = 5

export const REWRITE_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'One or two plain sentences: what the change does and why it fixes the issue. Not the file name.' },
    origin: { type: 'string', description: 'The file:line heading of the code block the rewrite applies to.' },
    before: { type: 'string', description: 'The lines being replaced, copied exactly from that block, without line numbers.' },
    after: { type: 'string', description: 'The replacement lines.' },
    notes: { type: 'array', items: { type: 'string' }, description: 'Things to check: other call sites, a migration, behaviour that changes.' },
  },
  required: ['summary', 'origin', 'before', 'after', 'notes'],
} as const

const SYSTEM = `You fix database performance problems in application code.
You are given an issue QueryLens found in production, the code that runs the statement, and the fix QueryLens recommends for the ORM.
Apply that fix to the code shown. Rules:
- Change as few lines as possible, and keep the style, names and formatting of the code.
- Keep the behaviour the same: the same rows, in the same order, the same response. Code that uses the loaded rows afterwards must keep working, so keep the property names it reads (an alias in the ORM, or a mapping).
- "before" must be lines copied exactly from one code block, without the line numbers, and "origin" that block's file:line heading.
- "after" is code only: no comments about the change. If the fix needs changes outside the code shown (an association, a migration), say so in "notes".
Answer with JSON only.`

/** Why no rewrite can be written for this issue, or `null` when one can. */
export function unavailable(ctx: IssueContext): SuggestionUnavailable | null {
  if (ctx.detail.origins.length === 0) return 'no_origin'
  if (ctx.sources.length === 0) return 'needs_source'
  return null
}

export function rewriteMessages(ctx: IssueContext): ChatMessage[] {
  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: fixPrompt(ctx) },
  ]
}

/** What the model is given, hashed: a stored suggestion is reused while it's unchanged. */
export async function contextHash(ctx: IssueContext, model: string): Promise<string> {
  const input = JSON.stringify([model, rewriteMessages(ctx)])
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** `text`'s lines without the blank ones around them. */
function body(text: string): string[] {
  const lines = text.split('\n')
  while (lines.length > 0 && !lines[0].trim()) lines.shift()
  while (lines.length > 0 && !lines[lines.length - 1].trim()) lines.pop()
  return lines
}

const indentOf = (line: string) => /^\s*/.exec(line)![0]

/** Where `before` sits in a snippet: the index of its first line, or -1. Indentation is ignored. */
export function locate(snippet: SourceSnippet, before: string): number {
  const wanted = body(before).map((l) => l.trim())
  if (wanted.length === 0) return -1
  const lines = snippet.lines.map((l) => l.trim())
  for (let i = 0; i + wanted.length <= lines.length; i++) {
    if (wanted.every((w, j) => lines[i + j] === w)) return i
  }
  return -1
}

/**
 * The replacement indented like the code it replaces: models often drop the indentation of
 * the lines they copy, and write the replacement at that same (wrong) level.
 */
export function reindent(after: string, modelBefore: string, fileBefore: string[]): string {
  const theirs = indentOf(body(modelBefore)[0] ?? '')
  const ours = indentOf(fileBefore[0] ?? '')
  const lines = body(after)
  if (theirs === ours) return lines.join('\n')
  return lines.map((l) => (l.trim() ? ours + (l.startsWith(theirs) ? l.slice(theirs.length) : l.trimStart()) : '')).join('\n')
}

/** The model's answer as a suggestion, or why it can't be one. */
export function checkRewrite(raw: unknown, ctx: IssueContext): Omit<Suggestion, 'model' | 'createdAt'> {
  const r = (raw ?? {}) as Record<string, unknown>
  const text = (v: unknown) => (typeof v === 'string' ? v : '')
  const summary = text(r.summary).trim()
  const before = text(r.before)
  const after = text(r.after)
  if (!summary || !before.trim() || !after.trim()) throw new AiError('bad_output', 'The model’s answer was incomplete. Try again.')
  if (before.trim() === after.trim()) throw new AiError('bad_output', 'The model suggested no change. Try again.')
  // The block it names first, then the others: the lines may be in any of them.
  const named = ctx.sources.find((s) => s.origin === text(r.origin).trim())
  for (const snippet of named ? [named, ...ctx.sources.filter((s) => s !== named)] : ctx.sources) {
    const at = locate(snippet, before)
    if (at === -1) continue
    // What's replaced is shown as it is in the file, not as the model copied it.
    const replaced = snippet.lines.slice(at, at + body(before).length)
    const notes = (Array.isArray(r.notes) ? r.notes : [])
      .filter((n): n is string => typeof n === 'string' && n.trim() !== '')
      .map((n) => n.trim())
      .slice(0, MAX_NOTES)
    return {
      issueId: ctx.detail.issue.id,
      summary,
      file: snippet.origin.replace(/:\d+$/, ''),
      line: snippet.firstLine + at,
      before: replaced.join('\n'),
      after: reindent(after, before, replaced),
      notes,
    }
  }
  throw new AiError('bad_output', 'The model rewrote code that isn’t in your file. Try again, or use the fix prompt with your coding agent.')
}

export async function suggestRewrite(model: JsonModel, ctx: IssueContext, now = new Date()): Promise<Suggestion> {
  const raw = await model.json({ messages: rewriteMessages(ctx), schema: REWRITE_SCHEMA, maxTokens: 4000 })
  return { ...checkRewrite(raw, ctx), model: model.name, createdAt: now.toISOString() }
}
