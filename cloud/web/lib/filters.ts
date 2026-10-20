// Filters for the Live page: built-in views, and custom filters the user saves.
// Each field of a custom filter is a small strategy: how it's edited and how it tests a query.
import type { FindingKind } from '../../bindings/FindingKind'
import { FINDING_KINDS } from './format'
import { type LiveQuery, STATEMENT_TYPES, type StatementType } from './queries'

// ───────────────────────────── built-in views ─────────────────────────────

export type Preset = 'all' | 'slow' | 'failed' | 'issues'

export const PRESETS: { id: Preset; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'slow', label: 'Slow' },
  { id: 'failed', label: 'Failed' },
  { id: 'issues', label: 'With issues' },
]

/** `slowMs`: the query's project threshold for a slow statement. */
export function matchesPreset(preset: Preset, q: LiveQuery, slowMs: number): boolean {
  switch (preset) {
    case 'all':
      return true
    case 'slow':
      return q.statement.durationMs >= slowMs
    case 'failed':
      return q.statement.error !== null
    case 'issues':
      return q.findings.length > 0
  }
}

/** The search box: SQL, code location or request. */
export function matchesSearch(q: LiveQuery, search: string): boolean {
  const s = search.trim().toLowerCase()
  if (!s) return true
  return (
    q.statement.sql.toLowerCase().includes(s) ||
    (q.statement.origin ?? '').toLowerCase().includes(s) ||
    q.request.name.toLowerCase().includes(s)
  )
}

// ───────────────────────────── custom filters ─────────────────────────────

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

export interface Field {
  label: string
  ops: Operator[]
  /** Free text, a number (with its unit), or one of a fixed set of values. */
  input: { kind: 'text'; placeholder: string } | { kind: 'number'; unit: string } | { kind: 'choice'; options: { value: string; label: string }[] }
  test: (q: LiveQuery, op: Operator, value: string) => boolean
}

function text(read: (q: LiveQuery) => string | null, placeholder: string): Pick<Field, 'ops' | 'input' | 'test'> {
  return {
    ops: ['contains', 'not_contains', 'is', 'is_not'],
    input: { kind: 'text', placeholder },
    test: (q, op, value) => {
      const actual = (read(q) ?? '').toLowerCase()
      const v = value.trim().toLowerCase()
      if (op === 'contains') return actual.includes(v)
      if (op === 'not_contains') return !actual.includes(v)
      return op === 'is' ? actual === v : actual !== v
    },
  }
}

function number(read: (q: LiveQuery) => number, unit: string): Pick<Field, 'ops' | 'input' | 'test'> {
  return {
    ops: ['gte', 'lte'],
    input: { kind: 'number', unit },
    test: (q, op, value) => (op === 'gte' ? read(q) >= Number(value) : read(q) <= Number(value)),
  }
}

function choice(read: (q: LiveQuery) => string[], options: { value: string; label: string }[]): Pick<Field, 'ops' | 'input' | 'test'> {
  return {
    ops: ['is', 'is_not'],
    input: { kind: 'choice', options },
    test: (q, op, value) => read(q).includes(value) === (op === 'is'),
  }
}

export const FIELDS: Record<FieldKey, Field> = {
  sql: { label: 'SQL', ...text((q) => q.statement.sql, 'e.g. FROM "orders"') },
  origin: { label: 'Code location', ...text((q) => q.statement.origin, 'e.g. src/routes/orders.js') },
  request: { label: 'Request', ...text((q) => q.request.name, 'e.g. GET /orders') },
  type: {
    label: 'Statement type',
    ...choice(
      (q) => [q.type],
      (Object.keys(STATEMENT_TYPES) as StatementType[]).map((t) => ({ value: t, label: STATEMENT_TYPES[t] })),
    ),
  },
  duration: { label: 'Duration', ...number((q) => q.statement.durationMs, 'ms') },
  rows: { label: 'Rows', ...number((q) => q.statement.rows, 'rows') },
  outcome: {
    label: 'Outcome',
    ...choice(
      (q) => [q.statement.error ? 'failed' : 'succeeded'],
      [
        { value: 'succeeded', label: 'Succeeded' },
        { value: 'failed', label: 'Failed' },
      ],
    ),
  },
  issue: {
    label: 'Issue',
    ...choice(
      (q) => (q.findings.length ? ['any', ...q.findings.map((f) => f.kind)] : []),
      [
        { value: 'any', label: 'Any issue' },
        ...(Object.keys(FINDING_KINDS) as FindingKind[]).map((k) => ({ value: k, label: FINDING_KINDS[k] })),
      ],
    ),
  },
  release: { label: 'Release', ...text((q) => q.request.release, 'e.g. 2026.10.1') },
}

export const FIELD_KEYS = Object.keys(FIELDS) as FieldKey[]

export function newCondition(field: FieldKey = 'sql'): Condition {
  const f = FIELDS[field]
  return { field, op: f.ops[0], value: f.input.kind === 'choice' ? f.input.options[0].value : '' }
}

export function isComplete(c: Condition): boolean {
  const f = FIELDS[c.field]
  if (!f.ops.includes(c.op)) return false
  if (f.input.kind === 'number') return c.value.trim() !== '' && Number.isFinite(Number(c.value))
  return c.value.trim() !== ''
}

export function matchesFilter(q: LiveQuery, filter: CustomFilter): boolean {
  const conditions = filter.conditions.filter(isComplete)
  if (conditions.length === 0) return true
  const test = (c: Condition) => FIELDS[c.field].test(q, c.op, c.value)
  return filter.match === 'all' ? conditions.every(test) : conditions.some(test)
}

/** "Duration is at least 50 ms", for the filter's summary. */
export function describe(c: Condition): string {
  const f = FIELDS[c.field]
  const value =
    f.input.kind === 'choice'
      ? (f.input.options.find((o) => o.value === c.value)?.label ?? c.value)
      : f.input.kind === 'number'
        ? `${c.value} ${f.input.unit}`
        : `“${c.value}”`
  return `${f.label} ${OPERATORS[c.op]} ${value}`
}

// ───────────────────────────── saved in this browser ─────────────────────────────

const FILTERS_KEY = 'querylens.filters'

export function loadFilters(): CustomFilter[] {
  try {
    const raw = JSON.parse(localStorage.getItem(FILTERS_KEY) ?? '[]') as CustomFilter[]
    return Array.isArray(raw) ? raw.filter((f) => f && Array.isArray(f.conditions) && f.conditions.every((c) => c.field in FIELDS)) : []
  } catch {
    return []
  }
}

export function saveFilters(filters: CustomFilter[]) {
  try {
    localStorage.setItem(FILTERS_KEY, JSON.stringify(filters))
  } catch {
    // Blocked storage: the filters last until the page reloads.
  }
}
