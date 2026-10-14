/**
 * Directory query tests.
 *
 * The client pages through this listing, so a wrong filter or cursor shows the
 * operator agents that are not there, or hides ones that are.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { listPrompts, queryDirectory, searchTimeline } from '../src/paseo/directory.ts'
import type { AgentRecord, WorkspaceRecord } from '../src/bridge.ts'
import type { TimelineEntry } from '../src/bridge.ts'

function agent(overrides: Partial<AgentRecord> & { readonly id: string }): AgentRecord {
  return {
    shortId: overrides.id,
    title: overrides.title ?? overrides.id,
    provider: 'stub',
    model: 'stub-model',
    status: 'idle',
    cwd: '/repo',
    workspaceId: 'ws_1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    lastUserMessageAt: null,
    ...overrides,
  }
}

const workspace: WorkspaceRecord = {
  id: 'ws_1',
  projectId: 'prj_1',
  projectKey: 'prj_1',
  projectName: 'repo',
  projectRootPath: '/repo',
  projectKind: 'git',
  name: 'repo',
  directory: '/repo',
  status: 'running',
  statusEnteredAt: null,
  activityAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  checkout: { repoRoot: '/repo', isGit: true },
}

test('a directory page respects its limit and reports the next cursor', () => {
  const rows = ['a', 'b', 'c'].map((id) => ({ agent: agent({ id }), workspace }))
  const first = queryDirectory(rows, { page: { limit: 2 }, sort: [{ key: 'title', direction: 'asc' }] })
  assert.deepEqual(first.rows.map((row) => row.agent.id), ['a', 'b'])
  assert.equal(first.hasMore, true)
  assert.equal(first.nextCursor, '2')

  const second = queryDirectory(rows, { page: { limit: 2, cursor: '2' }, sort: [{ key: 'title', direction: 'asc' }] })
  assert.deepEqual(second.rows.map((row) => row.agent.id), ['c'])
  assert.equal(second.hasMore, false)
})

test('an archived agent is hidden unless the filter asks for it', () => {
  const rows = [
    { agent: agent({ id: 'a' }), workspace },
    { agent: agent({ id: 'b', archivedAt: '2026-01-03T00:00:00.000Z' }), workspace },
  ]
  assert.deepEqual(queryDirectory(rows, {}).rows.map((row) => row.agent.id), ['a'])
  assert.equal(queryDirectory(rows, { filter: { includeArchived: true } }).rows.length, 2)
})

test('status and project filters narrow the listing', () => {
  const other: WorkspaceRecord = { ...workspace, id: 'ws_2', projectId: 'prj_2' }
  const rows = [
    { agent: agent({ id: 'a', status: 'running' }), workspace },
    { agent: agent({ id: 'b', status: 'error' }), workspace: other },
  ]
  assert.deepEqual(queryDirectory(rows, { filter: { statuses: ['error'] } }).rows.map((row) => row.agent.id), ['b'])
  assert.deepEqual(queryDirectory(rows, { filter: { projectKeys: ['prj_1'] } }).rows.map((row) => row.agent.id), ['a'])
})

test('search matches a title, a directory, or a project', () => {
  const rows = [
    { agent: agent({ id: 'a', title: 'fix the parser' }), workspace },
    { agent: agent({ id: 'b', title: 'other' }), workspace },
  ]
  assert.deepEqual(queryDirectory(rows, { search: 'PARSER' }).rows.map((row) => row.agent.id), ['a'])
  assert.deepEqual(queryDirectory(rows, { search: '/repo' }).rows.map((row) => row.agent.id), ['a', 'b'])
  assert.equal(queryDirectory(rows, { search: 'nothing' }).rows.length, 0)
})

test('running agents sort first when status is the key', () => {
  const rows = [
    { agent: agent({ id: 'idle', status: 'idle' }), workspace },
    { agent: agent({ id: 'busy', status: 'running' }), workspace },
  ]
  const sorted = queryDirectory(rows, { sort: [{ key: 'status_priority', direction: 'asc' }] })
  assert.deepEqual(sorted.rows.map((row) => row.agent.id), ['busy', 'idle'])
})

function entry(seq: number, item: TimelineEntry['item'], timestamp = `2026-01-01T00:00:0${String(seq)}.000Z`): TimelineEntry {
  return { seq, item, timestamp }
}

test('timeline search reports the rows that contain the term', () => {
  const entries = [
    entry(1, { type: 'user_message', text: 'find the bug' }),
    entry(2, { type: 'assistant_message', text: 'the bug is in the parser' }),
    entry(3, { type: 'assistant_message', text: 'nothing here' }),
  ]
  const result = searchTimeline(entries, 'bug')
  assert.deepEqual(result.locations, [
    { seq: 1, role: 'user', count: 1 },
    { seq: 2, role: 'assistant', count: 1 },
  ])
  assert.equal(result.nextCursor, null)
})

test('timeline search resumes from its cursor', () => {
  const entries = [entry(1, { type: 'user_message', text: 'a' }), entry(2, { type: 'user_message', text: 'a' })]
  const result = searchTimeline(entries, 'a', 1)
  assert.deepEqual(result.locations.map((location) => location.seq), [2])
})

test('an empty search term matches nothing', () => {
  assert.deepEqual(searchTimeline([entry(1, { type: 'user_message', text: 'a' })], ''), { locations: [], nextCursor: null })
})

test('prompt listing keeps user rows in order with a bounded preview', () => {
  const long = 'x'.repeat(300)
  const prompts = listPrompts([
    entry(1, { type: 'user_message', text: 'first' }),
    entry(2, { type: 'assistant_message', text: 'reply' }),
    entry(3, { type: 'user_message', text: long }),
  ])
  assert.deepEqual(prompts.map((prompt) => prompt.seq), [1, 3])
  assert.equal(prompts[1]?.preview.length, 201)
})
