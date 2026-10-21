import assert from 'node:assert/strict'
import { test } from 'node:test'

import { isHousekeeping, splitOrigin, summarizeSql } from '../web/lib/queries.ts'

test('a select list folds to an ellipsis, up to the top-level FROM', () => {
  assert.equal(
    summarizeSql('SELECT `id`, `meeting_id`, `user_id` FROM `scheduled_reminders` WHERE `sent_at` IS NULL'),
    'SELECT … FROM `scheduled_reminders` WHERE `sent_at` IS NULL',
  )
  assert.equal(summarizeSql('SELECT DISTINCT a, b FROM t'), 'SELECT DISTINCT … FROM t')
})

test('a FROM inside a subquery or a string is not the statement’s FROM', () => {
  assert.equal(summarizeSql('SELECT (SELECT max(x) FROM y) AS m, \'from\' FROM t'), 'SELECT … FROM t')
})

test('a select without FROM stays as it is', () => {
  assert.equal(summarizeSql('SELECT 1+1 AS result'), 'SELECT 1+1 AS result')
})

test('insert keeps its table, update its table and condition', () => {
  assert.equal(summarizeSql('INSERT INTO "events" ("id","kind") VALUES ($1,$2)'), 'INSERT INTO "events" …')
  assert.equal(summarizeSql('UPDATE users SET name = ?, email = ? WHERE id = ?'), 'UPDATE users SET … WHERE id = ?')
  assert.equal(summarizeSql('UPDATE users SET seen = now()'), 'UPDATE users SET …')
})

test('other statements and whitespace', () => {
  assert.equal(summarizeSql('  DELETE FROM t\n  WHERE id = 1 '), 'DELETE FROM t WHERE id = 1')
  assert.equal(summarizeSql('db.orders.find({})'), 'db.orders.find({})')
})

test('transactions and session settings are housekeeping', () => {
  for (const sql of ["SET time_zone = '+00:00'", 'START TRANSACTION;', 'COMMIT;', 'SAVEPOINT `sp-1`', 'ROLLBACK']) assert.ok(isHousekeeping(sql), sql)
  for (const sql of ['SELECT 1', 'UPDATE t SET a = 1', 'select * from settings']) assert.ok(!isHousekeeping(sql), sql)
})

test('an origin splits into its directory and its file with the line', () => {
  assert.deepEqual(splitOrigin('src/routes/orders.js:16'), { dir: 'src/routes/', file: 'orders.js:16' })
  assert.deepEqual(splitOrigin('server.js:30'), { dir: '', file: 'server.js:30' })
  assert.deepEqual(splitOrigin('src\\db\\pool.ts:8'), { dir: 'src\\db\\', file: 'pool.ts:8' })
})
