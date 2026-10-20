// The Live page's custom filters as data: their fields, operators and values. The dashboard
// adds how each field tests a query (web/lib/filters.ts); the backend checks filters it
// drafts from a description against the same schema (worker/ai/filters.ts).
import type { FindingKind } from '../bindings/FindingKind'
import { FINDING_KINDS, STATEMENT_TYPES, type StatementType } from './labels.ts'

export type Operator = 'contains' | 'not_contains' | 'is' | 'is_not' | 'gte' | 'lte'

export const OPERATORS: Record<Operator, string> = {
  contains: 'contains',
  not_contains: 'does not contain',
  is: 'is',
  is_not: 'is not',
  gte: 'is at least',
  lte: 'is at most',
}

export type FieldKey = 'sql' | 'origin' | 'request' | 'type' | 'duration' | 'rows' | 'outcome' | 'issue' | 'release'

export interface Condition {
  field: FieldKey
  op: Operator
  value: string
}

export interface CustomFilter {
  id: string
  name: string
  match: 'all' | 'any'
  conditions: Condition[]
}

/** A filter before it's saved: what the backend drafts from a description. */
export type FilterDraft = Omit<CustomFilter, 'id'>

export type FieldInput =
  | { kind: 'text'; placeholder: string }
  | { kind: 'number'; unit: string }
  | { kind: 'choice'; options: { value: string; label: string }[] }

export interface FieldSpec {
  label: string
  /** What the field means, for people and for the model drafting filters. */
  description: string
  ops: Operator[]
  /** Free text, a number (with its unit), or one of a fixed set of values. */
  input: FieldInput
}

const TEXT_OPS: Operator[] = ['contains', 'not_contains', 'is', 'is_not']
const NUMBER_OPS: Operator[] = ['gte', 'lte']
const CHOICE_OPS: Operator[] = ['is', 'is_not']

export const FIELD_SPECS: Record<FieldKey, FieldSpec> = {
  sql: { label: 'SQL', description: 'The statement text, values replaced by ?', ops: TEXT_OPS, input: { kind: 'text', placeholder: 'e.g. FROM "orders"' } },
  origin: {
    label: 'Code location',
    description: 'The file:line of application code that ran it',
    ops: TEXT_OPS,
    input: { kind: 'text', placeholder: 'e.g. src/routes/orders.js' },
  },
  request: {
    label: 'Request',
    description: 'The route or job it ran for, like "GET /orders/:id"',
    ops: TEXT_OPS,
    input: { kind: 'text', placeholder: 'e.g. GET /orders' },
  },
  type: {
    label: 'Statement type',
    description: 'What the statement does',
    ops: CHOICE_OPS,
    input: {
      kind: 'choice',
      options: (Object.keys(STATEMENT_TYPES) as StatementType[]).map((t) => ({ value: t, label: STATEMENT_TYPES[t] })),
    },
  },
  duration: { label: 'Duration', description: 'How long the statement took', ops: NUMBER_OPS, input: { kind: 'number', unit: 'ms' } },
  rows: { label: 'Rows', description: 'Rows returned or affected', ops: NUMBER_OPS, input: { kind: 'number', unit: 'rows' } },
  outcome: {
    label: 'Outcome',
    description: 'Whether the database returned an error',
    ops: CHOICE_OPS,
    input: {
      kind: 'choice',
      options: [
        { value: 'succeeded', label: 'Succeeded' },
        { value: 'failed', label: 'Failed' },
      ],
    },
  },
  issue: {
    label: 'Issue',
    description: 'A problem QueryLens found with the statement',
    ops: CHOICE_OPS,
    input: {
      kind: 'choice',
      options: [
        { value: 'any', label: 'Any issue' },
        ...(Object.keys(FINDING_KINDS) as FindingKind[]).map((k) => ({ value: k, label: FINDING_KINDS[k] })),
      ],
    },
  },
  release: { label: 'Release', description: 'The app release that ran it', ops: TEXT_OPS, input: { kind: 'text', placeholder: 'e.g. 2026.10.1' } },
}

export const FIELD_KEYS = Object.keys(FIELD_SPECS) as FieldKey[]

export function isComplete(c: Condition): boolean {
  const f = FIELD_SPECS[c.field]
  if (!f || !f.ops.includes(c.op)) return false
  if (f.input.kind === 'number') return c.value.trim() !== '' && Number.isFinite(Number(c.value))
  if (f.input.kind === 'choice') return f.input.options.some((o) => o.value === c.value)
  return c.value.trim() !== ''
}

const MAX_CONDITIONS = 10
const MAX_NAME = 60
const MAX_VALUE = 200

/** `raw` as a filter draft when it's a valid one (conditions that aren't are dropped). */
export function parseDraft(raw: unknown): FilterDraft | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const conditions = (Array.isArray(r.conditions) ? r.conditions : [])
    .map((c): Condition | null => {
      if (!c || typeof c !== 'object') return null
      const { field, op, value } = c as Record<string, unknown>
      if (typeof field !== 'string' || !(field in FIELD_SPECS) || typeof op !== 'string') return null
      const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim().slice(0, MAX_VALUE) : null
      if (text === null) return null
      const condition = { field: field as FieldKey, op: op as Operator, value: text }
      return isComplete(condition) ? condition : null
    })
    .filter((c) => c !== null)
    .slice(0, MAX_CONDITIONS)
  if (conditions.length === 0) return null
  const name = typeof r.name === 'string' && r.name.trim() ? r.name.trim().slice(0, MAX_NAME) : 'New filter'
  return { name, match: r.match === 'any' ? 'any' : 'all', conditions }
}
