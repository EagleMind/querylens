import type { FindingKind } from '../../../src/bindings/FindingKind'
import type { Orm } from '../../../src/bindings/Orm'
import type { SuggestionSeverity } from '../../../src/bindings/SuggestionSeverity'

export function fmtMs(ms: number): string {
  if (!Number.isFinite(ms)) return '–'
  if (ms < 1) return `${ms.toFixed(2)} ms`
  if (ms < 100) return `${ms.toFixed(1)} ms`
  if (ms < 10_000) return `${Math.round(ms)} ms`
  if (ms < 120_000) return `${(ms / 1000).toFixed(1)} s`
  return `${(ms / 60_000).toFixed(1)} min`
}

export function fmtCount(n: number): string {
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K`
  return `${(n / 1_000_000).toFixed(1)}M`
}

export function fmtRelative(iso: string, now = Date.now()): string {
  const s = Math.max(0, (now - new Date(iso).getTime()) / 1000)
  if (s < 5) return 'just now'
  if (s < 60) return `${Math.floor(s)}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86_400)}d ago`
}

export function fmtClock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
}

export const FINDING_KINDS: Record<FindingKind, string> = {
  n_plus_one: 'N+1 query',
  duplicate_query: 'Duplicate query',
  looped_writes: 'Writes in a loop',
  plan_issue: 'Plan issue',
  slow_query: 'Slow query',
  large_result: 'Large result',
  query_errors: 'Failing statement',
  chatty_request: 'Chatty request',
}

export const SEVERITY: Record<SuggestionSeverity, { label: string; swatch: string; text: string }> = {
  high: { label: 'High', swatch: 'bg-sev-high', text: 'text-sev-high' },
  medium: { label: 'Medium', swatch: 'bg-sev-medium', text: 'text-sev-medium' },
  low: { label: 'Low', swatch: 'bg-sev-low', text: 'text-muted' },
}

export const ORMS: Record<Orm, string> = {
  sequelize: 'Sequelize',
  prisma: 'Prisma',
  type_orm: 'TypeORM',
  django: 'Django ORM',
  active_record: 'Active Record',
  sql_alchemy: 'SQLAlchemy',
  hibernate: 'Hibernate',
}
