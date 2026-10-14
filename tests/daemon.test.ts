/**
 * Daemon-level tests: one fake Paseo client drives the protocol state machine
 * over a fake transport, with a fake bridge behind it.
 *
 * These cover the request and response pairs a client actually uses, including
 * the legacy creation path the shipped CLI still sends.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PaseoDaemon } from '../src/paseo/daemon.ts'
import type { AgentRecord, BridgeEvent, PaseoBridge, WorkspaceRecord } from '../src/bridge.ts'
import type { WireSocket } from '../src/paseo/transport.ts'

const now = '2026-01-01T00:00:00.000Z'

function workspace(): WorkspaceRecord {
  return {
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
    createdAt: now,
    updatedAt: now,
    checkout: { repoRoot: '/repo', isGit: false },
  }
}

function agent(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: 'ses_1',
    shortId: 'ses_1',
    title: 'hello',
    provider: 'stub',
    model: 'stub-model',
    status: 'idle',
    cwd: '/repo',
    workspaceId: 'ws_1',
    createdAt: now,
    updatedAt: now,
    lastUserMessageAt: null,
    ...overrides,
  }
}

/** Bridge whose state the test controls directly. */
function fakeBridge() {
  const listeners = new Set<(event: BridgeEvent) => void>()
  const prompts: Array<{ agentId: string; text: string }> = []
  const created: Array<Record<string, unknown>> = []
  const state = { agents: [agent()] }
  const bridge: PaseoBridge = {
    serverId: 'srv_test',
    version: '0.1.0',
    async listProviders() { return [{ provider: 'stub', available: true }] },
    async listProviderModels() { return [{ id: 'stub-model', label: 'Stub Model' }] },
    async listWorkspaces() { return [workspace()] },
    async listAgents() { return state.agents },
    async getAgent(id) { return state.agents.find((item) => item.id === id) ?? null },
    async getTimeline() { return [{ item: { type: 'user_message', text: 'hi' }, timestamp: now, seq: 1 }] },
    async sendPrompt(agentId, text) { prompts.push({ agentId, text }) },
    async createAgent(input) { created.push(input); return agent({ id: 'ses_new', workspaceId: 'ws_1' }) },
    async cancelAgent() {},
    async archiveAgent() { return new Date().toISOString() },
    async createWorkspace(input) { created.push(input); return workspace() },
    async archiveWorkspace() {},
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
  return { bridge, prompts, created, state, emit: (event: BridgeEvent) => { for (const listener of listeners) listener(event) } }
}

/** Client harness: records every frame the daemon sends. */
function connect(daemon: PaseoDaemon) {
  const sent: Array<Record<string, unknown>> = []
  const handlers = { receive: (_text: string) => {} }
  const socket: WireSocket = {
    send: (text) => { sent.push(JSON.parse(text) as Record<string, unknown>) },
    close: () => {},
    detach: () => {},
  }
  const connection = daemon.attach(socket)
  handlers.receive = (text) => { connection.receive(text) }
  const client = {
    sent,
    hello() {
      handlers.receive(JSON.stringify({ type: 'hello', clientId: 'cid', clientType: 'cli', protocolVersion: 1 }))
    },
    request(message: Record<string, unknown>) {
      handlers.receive(JSON.stringify({ type: 'session', message }))
    },
    /** The last message the daemon sent. */
    last(): Record<string, unknown> {
      const frame = sent[sent.length - 1]
      assert.ok(frame !== undefined)
      return frame.message as Record<string, unknown>
    },
    payloads(type: string): Array<Record<string, unknown>> {
      return sent
        .map((frame) => frame.message as Record<string, unknown>)
        .filter((message) => message.type === type)
        .map((message) => message.payload as Record<string, unknown>)
    },
    async settle() { await new Promise((resolve) => setImmediate(resolve)) },
  }
  return client
}

function makeDaemon(bridge: PaseoBridge, options: Partial<ConstructorParameters<typeof PaseoDaemon>[0]> = {}) {
  const daemon = new PaseoDaemon({
    bridge,
    logger: { debug: () => {}, info: () => {}, warn: () => {} },
    hostname: 'test',
    pairingOffer: () => ({ url: 'https://app.paseo.sh/#offer=x', relayEnabled: false }),
    ...options,
  })
  daemon.start()
  return daemon
}

test('hello is answered with server_info before any request', async () => {
  const { bridge } = fakeBridge()
  const client = connect(makeDaemon(bridge))
  client.hello()
  const info = client.last()
  assert.equal(info.type, 'status')
  assert.equal((info.payload as Record<string, unknown>).status, 'server_info')
})

test('requests before hello are ignored', async () => {
  const { bridge } = fakeBridge()
  const client = connect(makeDaemon(bridge))
  client.request({ type: 'fetch_agents_request', requestId: 'r1' })
  await client.settle()
  assert.deepEqual(client.sent, [])
})

test('fetch_agents answers with the agent and its placement', async () => {
  const { bridge } = fakeBridge()
  const client = connect(makeDaemon(bridge))
  client.hello()
  client.request({ type: 'fetch_agents_request', requestId: 'r1' })
  await client.settle()
  const payload = client.last().payload as Record<string, unknown>
  assert.equal(payload.requestId, 'r1')
  const entries = payload.entries as Array<Record<string, unknown>>
  assert.equal(entries.length, 1)
  assert.equal((entries[0]?.agent as Record<string, unknown>).id, 'ses_1')
  assert.equal((entries[0]?.project as Record<string, unknown>).projectName, 'repo')
})

test('an unknown request type answers with a correlated rpc_error', async () => {
  const { bridge } = fakeBridge()
  const client = connect(makeDaemon(bridge))
  client.hello()
  client.request({ type: 'something.else.request', requestId: 'r9' })
  await client.settle()
  const payload = client.last().payload as Record<string, unknown>
  assert.equal(client.last().type, 'rpc_error')
  assert.equal(payload.requestId, 'r9')
})

test('send_agent_message_request reaches the bridge and is acknowledged', async () => {
  const { bridge, prompts } = fakeBridge()
  const client = connect(makeDaemon(bridge))
  client.hello()
  client.request({ type: 'send_agent_message_request', requestId: 'r1', agentId: 'ses_1', text: 'do it' })
  await client.settle()
  assert.deepEqual(prompts, [{ agentId: 'ses_1', text: 'do it' }])
  const payload = client.last().payload as Record<string, unknown>
  assert.equal(payload.accepted, true)
  assert.equal(payload.error, null)
})

test('a prompt for an unknown agent is refused, not accepted', async () => {
  const { bridge, prompts } = fakeBridge()
  const client = connect(makeDaemon(bridge))
  client.hello()
  client.request({ type: 'send_agent_message_request', requestId: 'r1', agentId: 'nope', text: 'do it' })
  await client.settle()
  assert.deepEqual(prompts, [])
  const payload = client.last().payload as Record<string, unknown>
  assert.equal(payload.accepted, false)
})

test('wait_for_finish resolves when the agent settles', async () => {
  const { bridge, state, emit } = fakeBridge()
  state.agents = [agent({ status: 'running' })]
  const client = connect(makeDaemon(bridge))
  client.hello()
  client.request({ type: 'wait_for_finish_request', requestId: 'r1', agentId: 'ses_1' })
  await client.settle()
  assert.deepEqual(client.payloads('wait_for_finish_response'), [])

  state.agents = [agent({ status: 'idle' })]
  emit({ kind: 'agent_upsert', agent: agent({ status: 'idle' }) })
  await client.settle()
  const payload = client.last().payload as Record<string, unknown>
  assert.equal(payload.status, 'idle')
  assert.equal(payload.requestId, 'r1')
})

test('wait_for_finish returns immediately for a settled agent', async () => {
  const { bridge } = fakeBridge()
  const client = connect(makeDaemon(bridge))
  client.hello()
  client.request({ type: 'wait_for_finish_request', requestId: 'r1', agentId: 'ses_1' })
  await client.settle()
  assert.equal((client.last().payload as Record<string, unknown>).status, 'idle')
})

test('the legacy create_agent_request answers with an agent_created status', async () => {
  const { bridge, created } = fakeBridge()
  const client = connect(makeDaemon(bridge))
  client.hello()
  client.request({
    type: 'create_agent_request',
    requestId: 'r1',
    config: { provider: 'stub', cwd: '/repo', model: 'stub-model' },
    initialPrompt: 'go',
  })
  await client.settle()
  assert.deepEqual(created, [{ directory: '/repo', provider: 'stub', model: 'stub-model', prompt: 'go' }])
  const message = client.last()
  assert.equal(message.type, 'status')
  const payload = message.payload as Record<string, unknown>
  assert.equal(payload.status, 'agent_created')
  assert.equal(payload.agentId, 'ses_new')
  assert.equal((payload.agent as Record<string, unknown>).id, 'ses_new')
})

test('the correlated agent.create.request answers with agent.create.response', async () => {
  const { bridge } = fakeBridge()
  const client = connect(makeDaemon(bridge))
  client.hello()
  client.request({ type: 'agent.create.request', requestId: 'r2', config: { provider: 'stub', cwd: '/repo', model: 'stub-model', title: 'Named' }, initialPrompt: 'go' })
  await client.settle()
  const message = client.last()
  assert.equal(message.type, 'agent.create.response')
  const payload = message.payload as Record<string, unknown>
  assert.equal(payload.requestId, 'r2')
  assert.equal(payload.error, null)
  assert.equal((payload.agent as Record<string, unknown>).id, 'ses_new')
})

test('a create request without a directory or workspace is refused', async () => {
  const { bridge, created } = fakeBridge()
  const client = connect(makeDaemon(bridge))
  client.hello()
  client.request({ type: 'create_agent_request', requestId: 'r1', config: { provider: 'stub' } })
  await client.settle()
  assert.deepEqual(created, [])
  const payload = client.last().payload as Record<string, unknown>
  assert.equal(payload.status, 'agent_create_failed')
})

test('workspace.create.request creates a directory workspace', async () => {
  const { bridge, created } = fakeBridge()
  const client = connect(makeDaemon(bridge))
  client.hello()
  client.request({ type: 'workspace.create.request', requestId: 'r1', source: { kind: 'directory', path: '/repo' } })
  await client.settle()
  assert.deepEqual(created, [{ directory: '/repo' }])
  const payload = client.last().payload as Record<string, unknown>
  assert.equal(payload.error, null)
  assert.equal((payload.workspace as Record<string, unknown>).id, 'ws_1')
})

test('a worktree workspace source is refused with a reason', async () => {
  const { bridge, created } = fakeBridge()
  const client = connect(makeDaemon(bridge))
  client.hello()
  client.request({ type: 'workspace.create.request', requestId: 'r1', source: { kind: 'worktree', branchName: 'x' } })
  await client.settle()
  assert.deepEqual(created, [])
  const payload = client.last().payload as Record<string, unknown>
  assert.equal(payload.workspace, null)
  assert.match(String(payload.error), /directory/)
})

test('a password-configured daemon rejects and closes an unauthenticated hello', () => {
  const { bridge } = fakeBridge()
  const daemon = makeDaemon(bridge, { password: 'secret' })
  const sent: Array<Record<string, unknown>> = []
  const closed: Array<{ code: number }> = []
  const connection = daemon.attach({
    send: (text) => { sent.push(JSON.parse(text) as Record<string, unknown>) },
    close: (code) => { closed.push({ code }) },
    detach: () => {},
  })
  connection.receive(JSON.stringify({ type: 'hello', clientId: 'cid', clientType: 'cli', protocolVersion: 1 }))
  assert.equal(sent[0]?.type, 'hello.rejected')
  assert.deepEqual(closed, [{ code: 4401 }])

  connection.receive(JSON.stringify({
    type: 'hello',
    clientId: 'cid',
    clientType: 'cli',
    protocolVersion: 1,
    auth: { kind: 'password', password: 'secret' },
  }))
  assert.equal(sent[1]?.type, 'session')
})

test('daemon.get_status reports the runtime providers', async () => {
  const { bridge } = fakeBridge()
  const client = connect(makeDaemon(bridge, { listen: '127.0.0.1:1234' }))
  client.hello()
  client.request({ type: 'daemon.get_status.request', requestId: 'r1' })
  await client.settle()
  const payload = client.last().payload as Record<string, unknown>
  assert.equal(payload.serverId, 'srv_test')
  assert.equal(payload.listen, '127.0.0.1:1234')
  assert.deepEqual(payload.providers, [{ provider: 'stub', available: true, error: null }])
})

test('archive_agent_request answers with agent_archived', async () => {
  const { bridge } = fakeBridge()
  const client = connect(makeDaemon(bridge))
  client.hello()
  client.request({ type: 'archive_agent_request', requestId: 'r1', agentId: 'ses_1' })
  await client.settle()
  const message = client.last()
  assert.equal(message.type, 'agent_archived')
  const payload = message.payload as Record<string, unknown>
  assert.equal(payload.agentId, 'ses_1')
  assert.equal(payload.requestId, 'r1')
  assert.match(String(payload.archivedAt), /^\d{4}-/)
})

test('close_items_request is acknowledged without inventing archived rows', async () => {
  const { bridge } = fakeBridge()
  const client = connect(makeDaemon(bridge))
  client.hello()
  client.request({ type: 'close_items_request', requestId: 'r1', agentIds: ['ses_1'], terminalIds: [] })
  await client.settle()
  const payload = client.last().payload as Record<string, unknown>
  assert.equal(client.last().type, 'close_items_response')
  assert.deepEqual(payload.agents, [])
  assert.deepEqual(payload.terminals, [])
})
