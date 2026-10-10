import { Allow, parse } from 'partial-json'

import type { Suggestion } from '@/bindings/Suggestion'
import type { SuggestionSeverity } from '@/bindings/SuggestionSeverity'

export type DraftSuggestion = Partial<Suggestion> & { title: string }

export interface Draft {
  summary: string | null
  suggestions: DraftSuggestion[]
}

/** Drop `<think>` blocks (including an unterminated trailing one). */
function stripThink(text: string): string {
  return text.replace(/<think>[\s\S]*?(<\/think>|$)/g, '')
}

const SEVERITIES: SuggestionSeverity[] = ['high', 'medium', 'low']

/**
 * Best-effort parse of a partially streamed suggestions object, so cards can render
 * while the model is still writing. The backend's final parse is authoritative.
 */
export function parseDraft(streamed: string): Draft {
  const text = stripThink(streamed)
  const start = text.indexOf('{')
  if (start < 0) return { summary: null, suggestions: [] }
  try {
    const v = parse(text.slice(start), Allow.ALL) as Record<string, unknown> | null
    if (!v || typeof v !== 'object') return { summary: null, suggestions: [] }
    const raw = Array.isArray(v.suggestions) ? v.suggestions : []
    const suggestions = raw
      .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object' && typeof s.title === 'string')
      .map((s) => ({
        title: String(s.title),
        severity: SEVERITIES.includes(s.severity as SuggestionSeverity)
          ? (s.severity as SuggestionSeverity)
          : undefined,
        explanation: typeof s.explanation === 'string' ? s.explanation : undefined,
        sqlFix: typeof s.sqlFix === 'string' ? s.sqlFix : null,
        nodeId: typeof s.nodeId === 'string' ? s.nodeId : null,
      }))
    return { summary: typeof v.summary === 'string' ? v.summary : null, suggestions }
  } catch {
    return { summary: null, suggestions: [] }
  }
}
