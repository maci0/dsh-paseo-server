/**
 * Paused reminder store tests.
 *
 * The file is what makes a paused reminder survive a restart, so a lossy write
 * silently drops a reminder the user expects to resume.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { loadPausedReminders, savePausedReminders } from '../src/dsh/paused-reminders.ts'
import { scratchDir } from './scratch.ts'

test('paused reminders round trip through the store', async () => {
  const root = scratchDir('paused-store')
  const home = (...segments: string[]): string => `${root}/${segments.join('/')}`
  await savePausedReminders(home, [
    {
      id: 'sch_1',
      sessionId: 'ses_1',
      title: 'nightly',
      prompt: 'check the build',
      cadence: { type: 'every', everyMs: 120_000 },
      pausedAt: '2026-10-14T07:00:00.000Z',
    },
  ])
  const loaded = await loadPausedReminders(home)
  assert.equal(loaded.length, 1)
  assert.equal(loaded[0]?.id, 'sch_1')
  assert.deepEqual(loaded[0]?.cadence, { type: 'every', everyMs: 120_000 })
})

test('an absent store reads as nothing paused', async () => {
  const root = scratchDir('paused-missing')
  const home = (...segments: string[]): string => `${root}/${segments.join('/')}`
  assert.deepEqual(await loadPausedReminders(home), [])
})

test('a corrupt store reads as nothing paused instead of failing', async () => {
  const root = scratchDir('paused-corrupt')
  const home = (...segments: string[]): string => `${root}/${segments.join('/')}`
  await mkdir(join(root, 'paseo'), { recursive: true })
  await writeFile(join(root, 'paseo', 'paused-reminders.json'), 'not json')
  assert.deepEqual(await loadPausedReminders(home), [])
})
