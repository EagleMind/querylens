// Filters for the Live page: built-in views, and custom filters the user saves.
// A custom filter's fields are described in shared/filters.ts; here each gets its test.
import {
  type Condition,
  type CustomFilter,
  FIELD_KEYS,
  FIELD_SPECS,
  type FieldKey,
  type FieldSpec,
  OPERATORS,
  type Operator,
  isComplete,
} from '../../shared/filters'
import type { LiveQuery } from './queries'

export { FIELD_KEYS, OPERATORS, isComplete }
export type { Condition, CustomFilter, FieldKey, Operator }

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

/** A field of the shared schema (shared/filters.ts), and how it tests a query. */
export interface Field extends FieldSpec {
  test: (q: LiveQuery, op: Operator, value: string) => boolean
}

function text(read: (q: LiveQuery) => string | null): Field['test'] {
  return (q, op, value) => {
    const actual = (read(q) ?? '').toLowerCase()
    const v = value.trim().toLowerCase()
    if (op === 'contains') return actual.includes(v)
    if (op === 'not_contains') return !actual.includes(v)
    return op === 'is' ? actual === v : actual !== v
  }
}

function number(read: (q: LiveQuery) => number): Field['test'] {
  return (q, op, value) => (op === 'gte' ? read(q) >= Number(value) : read(q) <= Number(value))
}

function choice(read: (q: LiveQuery) => string[]): Field['test'] {
  return (q, op, value) => read(q).includes(value) === (op === 'is')
}

const TESTS: Record<FieldKey, Field['test']> = {
  sql: text((q) => q.statement.sql),
  origin: text((q) => q.statement.origin),
  request: text((q) => q.request.name),
  type: choice((q) => [q.type]),
  duration: number((q) => q.statement.durationMs),
  rows: number((q) => q.statement.rows),
  outcome: choice((q) => [q.statement.error ? 'failed' : 'succeeded']),
  issue: choice((q) => (q.findings.length ? ['any', ...q.findings.map((f) => f.kind)] : [])),
  release: text((q) => q.request.release),
}

export const FIELDS = Object.fromEntries(FIELD_KEYS.map((k) => [k, { ...FIELD_SPECS[k], test: TESTS[k] }])) as Record<FieldKey, Field>

export function newCondition(field: FieldKey = 'sql'): Condition {
  const f = FIELDS[field]
  return { field, op: f.ops[0], value: f.input.kind === 'choice' ? f.input.options[0].value : '' }
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
