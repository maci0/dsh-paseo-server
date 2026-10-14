/**
 * Bridge tests against a fake host context.
 *
 * These pin the behaviour that matters when the harness restarts: every
 * persisted Session is still an agent a client can see and prompt, even
 * though nothing is attached to it yet.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDshBridge } from '../src/dsh/bridge.ts'
import type { HostContext, SessionEventLike } from '../src/host.ts'

/** Context whose services the test drives directly. */
function fakeContext(services: Record<string, unknown>) {
  const listeners = new Map<string, Array<(...args: never[]) => void>>()
  const ctx: HostContext = {
    logger: { debug: () => {}, info: () => {}, warn: () => {} },
    get: (name: string) => services[name],
    on: (event, listener) => {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return () => {}
    },
    effect: () => {},
  }
  return { ctx, emit: (event: string, ...args: unknown[]) => { for (const listener of listeners.get(event) ?? []) (listener as (...a: unknown[]) => void)(...args) } }
}

const coldEvents: SessionEventLike[] = [
  { type: 'user/message', seq: 0, time: 1_760_000_000_000, data: { id: 'm1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'old prompt' }] } },
  { type: 'assistant/message', seq: 1, time: 1_760_000_001_000, data: { turn: 1, step: 0, message: { id: 'm2', role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: 'old reply' }] }, stream: [] } },
]

function coldHost() {
  const pageCalls: unknown[] = []
  const cancelled: string[] = []
  const services: Record<string, unknown> = {
    sessionController: {
      list: async () => ({
        items: [{
          sessionId: 'session-cold',
          cwd: '/repo',
          running: false,
          agentAvailable: false,
          blank: false,
          updatedAt: 1_760_000_001_000,
          projections: { kind: 'cached', asOfSeq: 1, values: { title: 'Cold title' } },
        }],
      }),
      projections: async () => ({ kind: "sequenced", asOfSeq: 1, values: {} }),
      page: async (request: unknown) => {
        pageCalls.push(request)
        return { records: coldEvents.map((event) => ({ event })), hasMore: false }
      },
      cancel: async (request: { sessionId: string }) => {
        cancelled.push(request.sessionId)
        throw new Error('no live agent')
      },
      prompt: async () => ({ accepted: true }),
      create: async () => ({ sessionId: 'session-new' }),
    },
    workspaceRegistry: { list: () => [], create: async () => { throw new Error('unused') } },
    sessions: { get: () => undefined, list: () => [] },
    agents: { get: () => undefined, list: () => [] },
  }
  return { services, pageCalls, cancelled }
}

test('a cold session is still an agent, with its projected title', async () => {
  const { services } = coldHost()
  const bridge = createDshBridge({ ctx: fakeContext(services).ctx, defaultProvider: 'deepseek', defaultModel: 'deepseek-flash' })
  const agents = await bridge.listAgents()
  assert.equal(agents.length, 1)
  assert.equal(agents[0]?.id, 'session-cold')
  assert.equal(agents[0]?.title, 'Cold title')
  assert.equal(agents[0]?.status, 'idle')
  assert.equal(agents[0]?.provider, 'deepseek')
  assert.equal((await bridge.getAgent('session-cold'))?.id, 'session-cold')
  assert.equal(await bridge.getAgent('missing'), null)
})

test('a cold session timeline comes from the durable history page', async () => {
  const { services, pageCalls } = coldHost()
  const bridge = createDshBridge({ ctx: fakeContext(services).ctx, defaultProvider: 'deepseek', defaultModel: 'deepseek-flash' })
  const entries = await bridge.getTimeline('session-cold')
  assert.deepEqual(entries.map((entry) => entry.item.type), ['user_message', 'assistant_message'])
  assert.deepEqual(entries.map((entry) => entry.seq), [0, 1])
  assert.equal(pageCalls.length, 1)
  assert.deepEqual(pageCalls[0], {
    address: { kind: 'session', sessionId: 'session-cold' },
    throughSeq: 1,
    maxMessages: 200,
  })
})

test('stopping a cold session is a no-op rather than an error', async () => {
  const { services, cancelled } = coldHost()
  const bridge = createDshBridge({ ctx: fakeContext(services).ctx, defaultProvider: 'deepseek', defaultModel: 'deepseek-flash' })
  await bridge.cancelAgent('session-cold')
  assert.deepEqual(cancelled, ['session-cold'])
})

test('a cold session joins the workspace its directory names', async () => {
  const { services } = coldHost()
  const bridge = createDshBridge({ ctx: fakeContext(services).ctx, defaultProvider: 'deepseek', defaultModel: 'deepseek-flash' })
  const [agent] = await bridge.listAgents()
  const workspaces = await bridge.listWorkspaces()
  assert.ok(workspaces.some((workspace) => workspace.id === agent?.workspaceId))
  assert.equal(workspaces.find((workspace) => workspace.id === agent?.workspaceId)?.directory, '/repo')
})

test('an archived session is not listed as an active agent', async () => {
  const { services } = coldHost()
  ;(services.workspaceRegistry as { archivedSessionIds?: readonly string[] }).archivedSessionIds = ['session-cold']
  const bridge = createDshBridge({ ctx: fakeContext(services).ctx, defaultProvider: 'deepseek', defaultModel: 'deepseek-flash' })
  assert.deepEqual(await bridge.listAgents(), [])
  // The agent itself still resolves, because a client that already holds its
  // tab may ask for it by id.
  assert.equal((await bridge.getAgent('session-cold'))?.id, 'session-cold')
})
