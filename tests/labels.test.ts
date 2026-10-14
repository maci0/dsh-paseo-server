/**
 * Workspace label store tests.
 *
 * A rename has to carry its assignments, and a delete has to clear them, or
 * the sidebar keeps a label that no longer exists.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  EMPTY_LABELS,
  applyAssignment,
  applyLabelDelete,
  applyLabelUpdate,
  labelsOf,
  loadLabels,
  saveLabels,
} from '../src/dsh/labels.ts'
import { scratchDir } from './scratch.ts'

test('a label is created with its color and can be renamed', () => {
  const created = applyLabelUpdate(EMPTY_LABELS, { name: 'urgent', color: 'red' })
  assert.deepEqual(created.label, { name: 'urgent', color: 'red' })
  const assigned = applyAssignment(created.state, 'ws_1', created.label, true)
  const renamed = applyLabelUpdate(assigned.state, { name: 'urgent', newName: 'blocked' })
  assert.equal(renamed.label.name, 'blocked')
  assert.equal(renamed.affected, 1)
  assert.deepEqual(labelsOf(renamed.state, 'ws_1'), ['blocked'])
})

test('deleting a label clears its assignments', () => {
  const created = applyLabelUpdate(EMPTY_LABELS, { name: 'urgent', color: 'red' })
  const assigned = applyAssignment(created.state, 'ws_1', created.label, true)
  const removed = applyLabelDelete(assigned.state, 'urgent')
  assert.equal(removed.affected, 1)
  assert.deepEqual(removed.state.labels, [])
  assert.deepEqual(labelsOf(removed.state, 'ws_1'), [])
})

test('assigning twice keeps one entry and clearing removes it', () => {
  const created = applyLabelUpdate(EMPTY_LABELS, { name: 'urgent', color: 'red' })
  const once = applyAssignment(created.state, 'ws_1', created.label, true)
  const twice = applyAssignment(once.state, 'ws_1', created.label, true)
  assert.deepEqual(twice.workspaceLabels, ['urgent'])
  const cleared = applyAssignment(twice.state, 'ws_1', created.label, false)
  assert.deepEqual(cleared.workspaceLabels, [])
})

test('the catalog round trips through the store', async () => {
  const root = scratchDir('labels')
  const home = (...segments: string[]): string => `${root}/${segments.join('/')}`
  const created = applyLabelUpdate(EMPTY_LABELS, { name: 'urgent', color: 'teal' })
  await saveLabels(home, created.state)
  const loaded = await loadLabels(home)
  assert.deepEqual(loaded.labels, [{ name: 'urgent', color: 'teal' }])
  assert.equal(loaded.seq, 1)
})

test('an absent or corrupt store reads as empty', async () => {
  const root = scratchDir('labels-missing')
  const home = (...segments: string[]): string => `${root}/${segments.join('/')}`
  assert.deepEqual(await loadLabels(home), EMPTY_LABELS)
})
