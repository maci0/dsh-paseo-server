/**
 * Bridge tests against a fake host context.
 *
 * These pin the behaviour that matters when the harness restarts: every
 * persisted Session is still an agent a client can see and prompt, even
 * though nothing is attached to it yet.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDshBridge, promptParts } from '../src/dsh/bridge.ts'
import { parseUnifiedDiff } from '../src/dsh/git.ts'
import { readWorkspaceScripts } from '../src/dsh/scripts.ts'
import type { HostContext, SessionEventLike } from '../src/host.ts'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { scratchDir } from './scratch.ts'

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
          projections: { kind: 'cached', asOfSeq: 1, values: { title: 'Cold title', modelSelection: { lastUsed: { provider: 'stub', model: 'stub-model' }, next: null } } },
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
  assert.equal(agents[0]?.provider, 'stub')
  assert.equal(agents[0]?.model, 'stub-model')
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

test('a prompt becomes text and image content parts', () => {
  const parts = promptParts({
    text: 'look at this',
    images: [
      { data: 'AAAA', mimeType: 'image/png' },
      { data: 'BBBB', mimeType: 'application/pdf' },
      { data: 'CCCC', mimeType: 'image/jpeg' },
    ],
  })
  assert.deepEqual(parts, [
    { type: 'text', text: 'look at this' },
    { type: 'image', mediaType: 'image/png', data: 'AAAA' },
    { type: 'image', mediaType: 'image/jpeg', data: 'CCCC' },
  ])
})

test('an image-only prompt carries no empty text part', () => {
  assert.deepEqual(promptParts({ text: '   ', images: [{ data: 'AAAA', mimeType: 'image/webp' }] }), [
    { type: 'image', mediaType: 'image/webp', data: 'AAAA' },
  ])
})

test('a text-only prompt carries one text part', () => {
  assert.deepEqual(promptParts({ text: 'hello' }), [{ type: 'text', text: 'hello' }])
})

test('a unified diff parses into files, hunks, and lines', () => {
  const diff = [
    'diff --git a/src/a.ts b/src/a.ts',
    'index 111..222 100644',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1,3 +1,4 @@',
    ' const one = 1',
    '-const two = 2',
    '+const two = 22',
    '+const three = 3',
    ' const four = 4',
    'diff --git a/new.txt b/new.txt',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/new.txt',
    '@@ -0,0 +1,1 @@',
    '+hello',
  ].join('\n')
  const files = parseUnifiedDiff(diff)
  assert.equal(files.length, 2)
  assert.deepEqual(files[0], {
    path: 'src/a.ts',
    oldPath: 'src/a.ts',
    isNew: false,
    isDeleted: false,
    additions: 2,
    deletions: 1,
    hunks: [{
      oldStart: 1,
      oldCount: 3,
      newStart: 1,
      newCount: 4,
      lines: [
        { type: 'context', content: 'const one = 1' },
        { type: 'remove', content: 'const two = 2' },
        { type: 'add', content: 'const two = 22' },
        { type: 'add', content: 'const three = 3' },
        { type: 'context', content: 'const four = 4' },
      ],
    }],
  })
  assert.equal(files[1]?.path, 'new.txt')
  assert.equal(files[1]?.isNew, true)
  assert.equal(files[1]?.additions, 1)
  assert.equal(files[1]?.deletions, 0)
})

test('a binary file is reported as binary, not as empty text', () => {
  const files = parseUnifiedDiff([
    'diff --git a/logo.png b/logo.png',
    'index 111..222 100644',
    'Binary files a/logo.png and b/logo.png differ',
  ].join('\n'))
  assert.equal(files[0]?.status, 'binary')
  assert.equal(files[0]?.path, 'logo.png')
})

test('an empty diff parses to no files', () => {
  assert.deepEqual(parseUnifiedDiff(''), [])
})

test('workspace scripts come from paseo.json', async () => {
  const directory = scratchDir('scripts')
  await writeFile(join(directory, 'paseo.json'), JSON.stringify({
    scripts: {
      dev: { type: 'service', command: 'bun run dev', port: 3000 },
      lint: { command: 'bun run lint' },
      broken: { command: '   ' },
    },
  }))
  const scripts = await readWorkspaceScripts(directory)
  assert.deepEqual(scripts, [
    { name: 'dev', type: 'service', command: 'bun run dev', port: 3000 },
    { name: 'lint', type: 'service', command: 'bun run lint', port: null },
  ])
})

test('a workspace without paseo.json declares no scripts', async () => {
  assert.deepEqual(await readWorkspaceScripts(scratchDir('scripts-empty')), [])
})
