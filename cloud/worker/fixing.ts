// Helping fix issues, as the dashboard API and the MCP server both offer it: an issue's
// context and fix prompt, AI rewrites (stored per issue, written again only when the issue
// or its code changed), and filters drafted from a description. Model calls count against a
// daily allowance; failures come out as HTTP errors.
import type { DraftFilterReply, DraftFilterRequest, IssueContext, SuggestionState } from '../shared/api'
import { draftFilter } from './ai/filters'
import { AiError, type JsonModel, workersAi } from './ai/model'
import { contextHash, suggestRewrite, unavailable } from './ai/rewrite'
import { type Exports, project, registry } from './backend'
import { HttpError } from './http'
import { fixPrompt } from './issues/prompt'

/** AI calls per day across the backend: about 100 neurons each, inside Workers AI's free 10,000 a day. */
const DAILY_AI_CALLS = 80

function model(env: Env): JsonModel | null {
  return env.AI ? workersAi(env.AI) : null
}

export async function issueContext(ns: Exports, projectId: string, issueId: number): Promise<IssueContext> {
  const ctx = await project(ns, projectId).issueContext(issueId)
  if (!ctx) throw new HttpError(404, 'No such issue.')
  return ctx
}

export async function issuePrompt(ns: Exports, projectId: string, issueId: number): Promise<string> {
  return fixPrompt(await issueContext(ns, projectId, issueId))
}

async function call<T>(ns: Exports, run: () => Promise<T>): Promise<T> {
  if (!(await registry(ns).takeAiCall(DAILY_AI_CALLS))) {
    throw new HttpError(429, `The backend’s ${DAILY_AI_CALLS} AI calls for today are used up. They reset at midnight UTC.`)
  }
  try {
    return await run()
  } catch (e) {
    if (e instanceof AiError) throw new HttpError(502, e.message)
    throw e
  }
}

/** The stored suggestion and whether a new one can be written; calls no model. */
export async function suggestionState(env: Env, ns: Exports, projectId: string, issueId: number): Promise<SuggestionState> {
  const ctx = await issueContext(ns, projectId, issueId)
  const m = model(env)
  const stored = await project(ns, projectId).storedSuggestion(issueId)
  return {
    suggestion: stored?.suggestion ?? null,
    stale: stored !== null && m !== null && stored.inputHash !== (await contextHash(ctx, m.name)),
    unavailable: m ? unavailable(ctx) : 'ai_unavailable',
  }
}

/** Write a suggestion, unless the stored one is still current (`refresh` writes one anyway). */
export async function suggest(env: Env, ns: Exports, projectId: string, issueId: number, refresh: boolean): Promise<SuggestionState> {
  const ctx = await issueContext(ns, projectId, issueId)
  const m = model(env)
  if (!m) throw new HttpError(503, 'Workers AI isn’t bound to this Worker: add the AI binding and deploy again.')
  const why = unavailable(ctx)
  if (why === 'no_origin') throw new HttpError(409, 'No line of your code is known for this issue, so there’s nothing to rewrite.')
  if (why === 'needs_source') {
    throw new HttpError(409, 'The SDK hasn’t sent the code around this issue. Turn on source context (QUERYLENS_SOURCE_CONTEXT=1) in the app.')
  }
  const stub = project(ns, projectId)
  const hash = await contextHash(ctx, m.name)
  const stored = await stub.storedSuggestion(issueId)
  if (stored && stored.inputHash === hash && !refresh) return { suggestion: stored.suggestion, stale: false, unavailable: null }
  const suggestion = await call(ns, () => suggestRewrite(m, ctx))
  await stub.saveSuggestion(suggestion, hash)
  return { suggestion, stale: false, unavailable: null }
}

export async function draft(env: Env, ns: Exports, req: DraftFilterRequest): Promise<DraftFilterReply> {
  if (typeof req.text !== 'string' || !req.text.trim()) throw new HttpError(400, 'Describe the queries to show.')
  const m = model(env)
  if (!m) throw new HttpError(503, 'Workers AI isn’t bound to this Worker: add the AI binding and deploy again.')
  const releases = Array.isArray(req.releases) ? req.releases.filter((r): r is string => typeof r === 'string') : []
  return { draft: await call(ns, () => draftFilter(m, { text: req.text, releases })), model: m.name }
}
