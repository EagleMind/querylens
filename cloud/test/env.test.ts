import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ENV_VARS, envFile, envValue, initialChoice, problem } from '../web/lib/env.ts'

const orders = { name: 'orders', dsn: 'https://k3y@querylens.example.workers.dev/0123456789ab' }

test('the DSN always comes first; suggested variables start chosen', () => {
  assert.equal(
    envFile(orders, initialChoice()),
    ['# QueryLens: orders', 'QUERYLENS_DSN=https://k3y@querylens.example.workers.dev/0123456789ab', 'QUERYLENS_SOURCE_CONTEXT=1'].join('\n'),
  )
})

test('chosen variables follow in a fixed order, flags as 1, values as typed', () => {
  const choice = {
    ...initialChoice(),
    QUERYLENS_SAMPLE_RATE: { on: true, value: ' 0.2 ' },
    QUERYLENS_ENVIRONMENT: { on: true, value: 'staging' },
    QUERYLENS_SOURCE_CONTEXT: { on: false, value: '' },
    QUERYLENS_DISABLED: { on: true, value: '' },
  }
  assert.deepEqual(envFile(orders, choice).split('\n').slice(2), ['QUERYLENS_ENVIRONMENT=staging', 'QUERYLENS_SAMPLE_RATE=0.2', 'QUERYLENS_DISABLED=1'])
})

test('invalid values are flagged and left out of the file', () => {
  const rate = ENV_VARS.find((v) => v.name === 'QUERYLENS_SAMPLE_RATE')!
  assert.equal(problem(rate, '1.5'), 'A number from 0 to 1, like 0.05.')
  assert.equal(problem(rate, '0'), null)
  const release = ENV_VARS.find((v) => v.name === 'QUERYLENS_RELEASE')!
  assert.equal(problem(release, '  '), 'Fill in a value, or untick it.')
  const file = envFile(orders, { ...initialChoice(), QUERYLENS_SAMPLE_RATE: { on: true, value: 'lots' }, QUERYLENS_RELEASE: { on: true, value: '' } })
  assert.ok(!file.includes('SAMPLE_RATE') && !file.includes('RELEASE'))
})

test('values with spaces or quotes are quoted', () => {
  assert.equal(envValue('4f2c1e0'), '4f2c1e0')
  assert.equal(envValue('v1.2.0+build.7'), 'v1.2.0+build.7')
  assert.equal(envValue('eu west'), '"eu west"')
  assert.equal(envValue('say "hi"'), '"say \\"hi\\""')
})
