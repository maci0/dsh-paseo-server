/**
 * Reminder cadence conversion tests.
 *
 * The two models disagree on what a cadence is, so the conversion is the part
 * worth pinning: a wrong one either fires a reminder that should have run once
 * or refuses a schedule the phone can express.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fromPaseoCadence, toPaseoCadence } from '../src/dsh/schedules.ts'

test('a fixed interval keeps its length', () => {
  assert.deepEqual(toPaseoCadence({ kind: 'every', everySeconds: 90 }), { type: 'every', everyMs: 90_000 })
  assert.deepEqual(fromPaseoCadence({ type: 'every', everyMs: 90_000 }), { every_seconds: 90 })
})

test('a cron cadence keeps its zone', () => {
  assert.deepEqual(
    toPaseoCadence({ kind: 'cron', expression: '0 9 * * 1-5', timeZone: 'Asia/Singapore' }),
    { type: 'cron', expression: '0 9 * * 1-5', timezone: 'Asia/Singapore' },
  )
  assert.deepEqual(
    fromPaseoCadence({ type: 'cron', expression: '0 9 * * 1-5' }),
    { cron: { expression: '0 9 * * 1-5', time_zone: 'UTC' } },
  )
})

test('an interval shorter than the floor is refused with the reason', () => {
  const result = fromPaseoCadence({ type: 'every', everyMs: 30_000 })
  assert.ok('error' in result)
  assert.match(result.error, /60 seconds/)
})

test('a one-shot reminder has no Paseo cadence', () => {
  assert.equal(toPaseoCadence({ kind: 'at' }), null)
  assert.equal(toPaseoCadence({ kind: 'after' }), null)
})

test('a daily reminder becomes a daily cron in its zone', () => {
  assert.deepEqual(
    toPaseoCadence({ kind: 'daily', dailyTime: '09:30:00', timeZone: 'Europe/Berlin' }),
    { type: 'cron', expression: '30 9 * * *', timezone: 'Europe/Berlin' },
  )
})

test('a weekly reminder maps Sunday back to cron day zero', () => {
  assert.deepEqual(
    toPaseoCadence({ kind: 'weekly', dailyTime: '07:05:00', weekdays: [1, 5, 7], timeZone: 'UTC' }),
    { type: 'cron', expression: '5 7 * * 1,5,0', timezone: 'UTC' },
  )
})
