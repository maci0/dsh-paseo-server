/**
 * Concept-mapping tests: DSH session events become Paseo timeline rows.
 *
 * The mapping is the point of the plugin, so it is tested directly against
 * event shapes taken from DSH's own session vocabulary rather than through a
 * live harness.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { foldEvent, foldEvents, messageText, messageReasoning, workspaceStatus } from '../src/dsh/bridge.ts'
import type { SessionEventLike } from '../src/host.ts'

function event(type: string, seq: number, data: Record<string, unknown>): SessionEventLike {
  return { type, seq, time: 1_760_000_000_000 + seq, data }
}

test('a human prompt becomes a user_message row', () => {
  const rows = foldEvent(event('user/message', 3, {
    id: 'm1',
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text: 'hello there' }],
  }))
  assert.deepEqual(rows, [{ item: { type: 'user_message', text: 'hello there' }, timestamp: new Date(1_760_000_000_003).toISOString(), seq: 3 }])
})

test('injected context is not shown as a human prompt', () => {
  const rows = foldEvent(event('user/message', 4, {
    id: 'm2',
    role: 'user',
    source: { kind: 'file-change-notice' },
    content: [{ type: 'text', text: 'src/a.ts changed' }],
  }))
  assert.deepEqual(rows, [])
})

test('an assistant message contributes text and reasoning rows', () => {
  const rows = foldEvent(event('assistant/message', 5, {
    turn: 1,
    step: 0,
    message: {
      id: 'm3',
      role: 'assistant',
      source: { kind: 'model', provider: 'deepseek', model: 'deepseek-flash' },
      content: [
        { type: 'reasoning', text: 'thinking' },
        { type: 'text', text: 'answer' },
      ],
    },
    stream: [],
  }))
  assert.deepEqual(rows.map((row) => row.item.type), ['reasoning', 'assistant_message'])
  assert.deepEqual(rows.map((row) => row.seq), [5, 5])
})

test('a tool call is emitted once, when its result arrives', () => {
  assert.deepEqual(foldEvent(event('tool/call', 6, { turn: 1, step: 0, callId: 'c1', name: 'bash', arguments: '{}' })), [])
  const rows = foldEvent(event('tool/result', 7, {
    turn: 1,
    step: 0,
    message: {
      id: 'm4',
      role: 'tool',
      toolCallId: 'c1',
      source: { kind: 'tool', name: 'bash' },
      content: [{ type: 'text', text: 'ok' }],
    },
  }))
  assert.equal(rows.length, 1)
  const item = rows[0]?.item
  assert.equal(item?.type, 'tool_call')
  assert.equal(item?.type === 'tool_call' ? item.status : null, 'completed')
  assert.equal(item?.type === 'tool_call' ? item.callId : null, 'c1')
})

test('a failed tool result reports failure and its reason', () => {
  const rows = foldEvent(event('tool/result', 8, {
    turn: 1,
    step: 0,
    message: { id: 'm5', role: 'tool', toolCallId: 'c2', isError: true, source: { kind: 'tool', name: 'bash' }, content: [] },
    error: { name: 'ToolError', code: 'nonzero', reason: 'exit 1' },
  }))
  const item = rows[0]?.item
  assert.equal(item?.type === 'tool_call' ? item.status : null, 'failed')
  assert.equal(item?.type === 'tool_call' ? item.error : null, 'exit 1')
})

test('unrelated session events contribute nothing', () => {
  for (const type of ['turn/start', 'turn/end', 'step/start', 'step/end', 'request/header', 'assistant/attempt', 'system/message']) {
    assert.deepEqual(foldEvent(event(type, 9, {})), [], type)
  }
  assert.deepEqual(foldEvents([event('turn/start', 1, {}), event('turn/end', 2, {})]), [])
})

test('text and reasoning extraction ignore non-text blocks', () => {
  assert.equal(messageText({ content: [{ type: 'image' }, { type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }), 'a\nb')
  assert.equal(messageText({ content: [] }), undefined)
  assert.equal(messageText({ content: 'raw' }), 'raw')
  assert.equal(messageReasoning({ content: [{ type: 'reasoning', text: 'r' }] }), 'r')
  assert.equal(messageReasoning({ content: [{ type: 'text', text: 'x' }] }), undefined)
})

test('workspace status is the most severe status among its agents', () => {
  assert.equal(workspaceStatus([]), 'done')
  assert.equal(workspaceStatus(['idle', 'closed']), 'done')
  assert.equal(workspaceStatus(['idle', 'running']), 'running')
  assert.equal(workspaceStatus(['running', 'error']), 'running')
  assert.equal(workspaceStatus(['idle', 'error']), 'failed')
})
