/**
 * Wire-format tests: the frames this daemon emits and accepts.
 *
 * The shipped Paseo CLI is the strong check for these shapes; these tests pin
 * the parts that a refactor could silently drop, notably the required
 * `accepted`/`error` pair on a send response and the envelope every session
 * message rides in.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseInbound, envelope, serverInfo, sendMessageResponse, sendMessageRejected, agentSnapshot, timelineResponse } from '../src/paseo/wire.ts'
import type { AgentRecord, WorkspaceRecord } from '../src/bridge.ts'

const workspace: WorkspaceRecord = {
  id: 'ws_1',
  projectId: 'prj_1',
  projectKey: '/repo',
  projectName: 'repo',
  projectRootPath: '/repo',
  projectKind: 'directory',
  name: 'repo',
  directory: '/repo',
  status: 'done',
  statusEnteredAt: null,
  activityAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  checkout: { repoRoot: '/repo', isGit: false },
}

const agent: AgentRecord = {
  id: 'ses_1',
  shortId: 'ses_1',
  title: 'hello',
  provider: 'deepseek',
  model: 'deepseek-flash',
  status: 'idle',
  cwd: '/repo',
  workspaceId: 'ws_1',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  lastUserMessageAt: null,
}

test('parseInbound reads the frames a Paseo client sends', () => {
  assert.deepEqual(parseInbound('{"type":"ping"}'), { kind: 'ping' })
  const hello = parseInbound('{"type":"hello","clientId":"cid_1","clientType":"cli","protocolVersion":1}')
  assert.equal(hello?.kind, 'hello')
  const request = parseInbound('{"type":"session","message":{"type":"fetch_agents_request","requestId":"r1"}}')
  assert.equal(request?.kind, 'request')
  assert.equal(request?.kind === 'request' ? request.message.type : null, 'fetch_agents_request')
})

test('parseInbound refuses malformed and unknown frames', () => {
  for (const raw of ['', 'not json', '{"type":"hello"}', '{"type":"hello","clientId":"c","clientType":"nope","protocolVersion":1}', '{"type":"unknown"}', '{"type":"session"}']) {
    assert.equal(parseInbound(raw), null, raw)
  }
})

test('every session message rides the session envelope', () => {
  const frame = JSON.parse(envelope({ type: 'pong' })) as Record<string, unknown>
  assert.deepEqual(Object.keys(frame), ['type', 'message'])
  assert.equal(frame.type, 'session')
})

test('the server_info frame carries the fields the client requires', () => {
  const payload = serverInfo({ serverId: 'srv_abc', version: '0.1.0' }, 'host') as { type: string; payload: Record<string, unknown> }
  assert.equal(payload.type, 'status')
  assert.equal(payload.payload.status, 'server_info')
  assert.equal(payload.payload.serverId, 'srv_abc')
  assert.equal(payload.payload.protocolVersion, 1)
  // Permissions must come from the protocol enum; a free-form name fails the
  // client's schema and the whole status frame is dropped.
  assert.deepEqual(payload.payload.permissions, ['daemon.read', 'workspace.read', 'workspace.write', 'workspace.manage'])
})

test('a send response always carries both accepted and error', () => {
  const accepted = sendMessageResponse('r1', agent) as { payload: Record<string, unknown> }
  assert.equal(accepted.payload.accepted, true)
  assert.equal(accepted.payload.error, null)
  const rejected = sendMessageRejected('r2', 'ses_1', 'agent not found') as { payload: Record<string, unknown> }
  assert.equal(rejected.payload.accepted, false)
  assert.equal(rejected.payload.error, 'agent not found')
})

test('an agent snapshot reports workspace placement and streaming support', () => {
  const snapshot = agentSnapshot(agent) as Record<string, unknown>
  assert.equal(snapshot.id, 'ses_1')
  assert.equal(snapshot.workspaceId, 'ws_1')
  assert.equal((snapshot.capabilities as Record<string, unknown>).supportsStreaming, true)
  assert.equal(snapshot.persistence === undefined, false)
})

test('an empty timeline still reports a valid window', () => {
  const response = timelineResponse('r1', agent, 'epoch/ses_1', []) as { payload: Record<string, unknown> }
  assert.deepEqual(response.payload.window, { minSeq: 0, maxSeq: 0, nextSeq: 1 })
  assert.deepEqual(response.payload.entries, [])
  assert.equal(response.payload.epoch, 'epoch/ses_1')
  void workspace
})
