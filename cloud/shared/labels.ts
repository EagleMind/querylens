// Names the dashboard shows and the backend writes into prompts: one place for both.
import type { FindingKind } from '../bindings/FindingKind'
import type { Orm } from '../bindings/Orm'

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

export const ORMS: Record<Orm, string> = {
  sequelize: 'Sequelize',
  prisma: 'Prisma',
  type_orm: 'TypeORM',
  drizzle: 'Drizzle',
  mikro_orm: 'MikroORM',
  objection: 'Objection.js',
  knex: 'Knex / Kysely',
  django: 'Django ORM',
  active_record: 'Active Record',
  sql_alchemy: 'SQLAlchemy',
  hibernate: 'Hibernate',
}

export type StatementType = 'select' | 'insert' | 'update' | 'delete' | 'other'

export const STATEMENT_TYPES: Record<StatementType, string> = {
  select: 'SELECT',
  insert: 'INSERT',
  update: 'UPDATE',
  delete: 'DELETE',
  other: 'Other',
}
