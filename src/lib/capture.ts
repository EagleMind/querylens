/** Presentation of capture findings: labels, severity styling, ORM names. */
import type { FindingKind } from '@/bindings/FindingKind'
import type { Orm } from '@/bindings/Orm'
import type { SuggestionSeverity } from '@/bindings/SuggestionSeverity'

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

export const SEVERITIES: Record<SuggestionSeverity, { label: string; swatch: string; text: string }> = {
  high: { label: 'High', swatch: 'bg-heat-high', text: 'text-heat-high' },
  medium: { label: 'Medium', swatch: 'bg-heat-medium', text: 'text-heat-medium' },
  low: { label: 'Low', swatch: 'bg-heat-low', text: 'text-muted-foreground' },
}

export const ORMS: Record<Orm, { label: string; codeLanguage: string }> = {
  sequelize: { label: 'Sequelize', codeLanguage: 'js' },
  prisma: { label: 'Prisma', codeLanguage: 'ts' },
  type_orm: { label: 'TypeORM', codeLanguage: 'ts' },
  django: { label: 'Django ORM', codeLanguage: 'python' },
  active_record: { label: 'Active Record', codeLanguage: 'ruby' },
  sql_alchemy: { label: 'SQLAlchemy', codeLanguage: 'python' },
  hibernate: { label: 'Hibernate', codeLanguage: 'java' },
}

/** Where the SDK reports by default (the collector of a running capture). */
export const SDK_URL = 'http://127.0.0.1:7343'

/** The app URL with its password hidden, for display (copying uses the real one). */
export function maskUrl(url: string): string {
  return url.replace(/(\/\/[^:/@]+:)[^@]+@/, '$1••••@')
}
