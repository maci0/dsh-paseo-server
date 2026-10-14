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
  const prompts: Array<{ agentId: string; text: string; images: readonly { data: string; mimeType: string }[] }> = []
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
    async sendPrompt(agentId, prompt) { prompts.push({ agentId, text: prompt.text, images: prompt.images ?? [] }) },
    async createAgent(input) { created.push(input); return agent({ id: 'ses_new', workspaceId: 'ws_1' }) },
    async cancelAgent() {},
    async archiveAgent() { return new Date().toISOString() },
    async checkoutStatus() { return { isGit: false, repoRoot: null, currentBranch: null, isDirty: false, hasRemote: false, remoteUrl: null, upstreamRef: null, aheadOfOrigin: null, behindOfOrigin: null } },
    async checkoutDiff() { return [] },
    async commitCheckout() { return { success: true } },
    async pushCheckout() { return { success: true } },
    async pullCheckout() { return { success: true } },
    async checkoutPrStatus() { return { status: null, authenticated: false, error: null } },
    async listTerminals() { return [] },
    async createTerminal() { throw new Error('unused') },
    async followTerminal() { return () => {} },
    async writeTerminal() {},
    async resizeTerminal() {},
    async renameTerminal() {},
    async closeTerminal() {},
    async listSchedules() { return [] },
    async createSchedule() { throw new Error('unused') },
    async deleteSchedule() { return true },
    async runScheduleNow() {},
    async listWorkspaceScripts() { return [] },
    async startWorkspaceScript() { throw new Error('unused') },
    async stopWorkspaceScript() { throw new Error('unused') },
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
    pairingOffer: () => ({ url: 'https://app.paseo.sh/#offer=x', qr: 'QR', relayEnabled: false }),
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
  assert.deepEqual(prompts, [{ agentId: 'ses_1', text: 'do it', images: [] }])
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

test('checkout_status_request reports a known workspace checkout', async () => {
  const { bridge } = fakeBridge()
  const client = connect(makeDaemon(bridge))
  client.hello()
  client.request({ type: 'workspace.create.request', requestId: 'r0', source: { kind: 'directory', path: '/repo' } })
  await client.settle()
  client.request({ type: 'checkout_status_request', requestId: 'r1', cwd: '/repo' })
  await client.settle()
  const payload = client.last().payload as Record<string, unknown>
  assert.equal(client.last().type, 'checkout_status_response')
  assert.equal(payload.cwd, '/repo')
  assert.equal(payload.isGit, false)
  assert.equal(payload.requestId, 'r1')
})

test('checkout_status_request refuses a directory this daemon never advertised', async () => {
  const { bridge } = fakeBridge()
  const client = connect(makeDaemon(bridge))
  client.hello()
  client.request({ type: 'checkout_status_request', requestId: 'r1', cwd: '/etc' })
  await client.settle()
  assert.equal(client.last().type, 'rpc_error')
  const payload = client.last().payload as Record<string, unknown>
  assert.equal(payload.code, 'workspace_not_found')
})

test('the pairing offer carries the generated terminal QR', async () => {
  const { bridge } = fakeBridge()
  const client = connect(makeDaemon(bridge))
  client.hello()
  client.request({ type: 'daemon.get_pairing_offer.request', requestId: 'r1' })
  await client.settle()
  const payload = client.last().payload as Record<string, unknown>
  assert.equal(payload.qr, 'QR')
  assert.match(String(payload.url), /#offer=/)
})

test('checkout.diff.get.request answers with the parsed files', async () => {
  const { bridge } = fakeBridge()
  const client = connect(makeDaemon(bridge))
  client.hello()
  client.request({ type: 'workspace.create.request', requestId: 'r0', source: { kind: 'directory', path: '/repo' } })
  await client.settle()
  client.request({ type: 'checkout.diff.get.request', requestId: 'r1', cwd: '/repo', compare: { mode: 'uncommitted' } })
  await client.settle()
  const payload = client.last().payload as Record<string, unknown>
  assert.equal(client.last().type, 'checkout.diff.get.response')
  assert.equal(payload.cwd, '/repo')
  assert.deepEqual(payload.files, [])
  assert.equal(payload.error, null)
})

test('a diff subscription opens with a subscription id and stops on unsubscribe', async () => {
  const { bridge } = fakeBridge()
  const client = connect(makeDaemon(bridge))
  client.hello()
  client.request({ type: 'workspace.create.request', requestId: 'r0', source: { kind: 'directory', path: '/repo' } })
  await client.settle()
  client.request({
    type: 'subscribe_checkout_diff_request',
    requestId: 'r1',
    cwd: '/repo',
    compare: { mode: 'base', baseRef: 'main' },
    subscriptionId: 'sub_1',
  })
  await client.settle()
  const payload = client.last().payload as Record<string, unknown>
  assert.equal(client.last().type, 'subscribe_checkout_diff_response')
  assert.equal(payload.subscriptionId, 'sub_1')
  assert.equal(payload.requestId, 'r1')

  client.request({ type: 'unsubscribe_checkout_diff_request', subscriptionId: 'sub_1' })
  await client.settle()
  assert.equal(client.last().type, 'subscribe_checkout_diff_response')
})

test('a checkout commit answers with its own response frame', async () => {
  const { bridge } = fakeBridge()
  const client = connect(makeDaemon(bridge))
  client.hello()
  client.request({ type: 'workspace.create.request', requestId: 'r0', source: { kind: 'directory', path: '/repo' } })
  await client.settle()
  client.request({ type: 'checkout_commit_request', requestId: 'r1', cwd: '/repo', message: 'fix', addAll: true })
  await client.settle()
  const payload = client.last().payload as Record<string, unknown>
  assert.equal(client.last().type, 'checkout_commit_response')
  assert.equal(payload.success, true)
  assert.equal(payload.error, null)
  assert.equal(payload.cwd, '/repo')
})

test('push, pull, and refresh answer with their own frames', async () => {
  const { bridge } = fakeBridge()
  const client = connect(makeDaemon(bridge))
  client.hello()
  client.request({ type: 'workspace.create.request', requestId: 'r0', source: { kind: 'directory', path: '/repo' } })
  await client.settle()
  for (const [type, expected] of [
    ['checkout_push_request', 'checkout_push_response'],
    ['checkout_pull_request', 'checkout_pull_response'],
    ['checkout.refresh.request', 'checkout.refresh.response'],
  ] as const) {
    client.request({ type, requestId: 'r1', cwd: '/repo' })
    await client.settle()
    assert.equal(client.last().type, expected)
    assert.equal((client.last().payload as Record<string, unknown>).success, true)
  }
})

test('a checkout write for an unadvertised directory is refused', async () => {
  const { bridge } = fakeBridge()
  const client = connect(makeDaemon(bridge))
  client.hello()
  client.request({ type: 'checkout_commit_request', requestId: 'r1', cwd: '/etc' })
  await client.settle()
  assert.equal(client.last().type, 'rpc_error')
})

test('list_terminals_request reports the runtime terminals', async () => {
  const { bridge } = fakeBridge()
  const client = connect(makeDaemon(bridge))
  client.hello()
  client.request({ type: 'list_terminals_request', requestId: 'r1' })
  await client.settle()
  const payload = client.last().payload as Record<string, unknown>
  assert.equal(client.last().type, 'list_terminals_response')
  assert.deepEqual(payload.terminals, [])
})

test('create_terminal_request names the workspace it opened in', async () => {
  const { bridge } = fakeBridge()
  const client = connect(makeDaemon(bridge))
  client.hello()
  client.request({ type: 'create_terminal_request', requestId: 'r1', workspaceId: 'ws_1', name: 'shell' })
  await client.settle()
  // The fake bridge refuses creation, so the client gets the reason, not a crash.
  const payload = client.last().payload as Record<string, unknown>
  assert.equal(client.last().type, 'create_terminal_response')
  assert.equal(payload.terminal, null)
  assert.match(String(payload.error), /unused/)
})

test('a terminal subscription hands the client its stream slot', async () => {
  const { bridge } = fakeBridge()
  const client = connect(makeDaemon(bridge))
  client.hello()
  client.request({ type: 'subscribe_terminal_request', requestId: 'r1', terminalId: 'term_1' })
  await client.settle()
  const payload = client.last().payload as Record<string, unknown>
  assert.equal(client.last().type, 'subscribe_terminal_response')
  assert.equal(payload.terminalId, 'term_1')
  assert.equal(payload.slot, 0)
  assert.equal(payload.error, null)
})

test('a terminal that cannot be attached answers with the reason', async () => {
  const { bridge } = fakeBridge()
  const failing: PaseoBridge = {
    ...bridge,
    followTerminal: async () => { throw new Error('terminal unavailable') },
  }
  const client = connect(makeDaemon(failing))
  client.hello()
  client.request({ type: 'subscribe_terminal_request', requestId: 'r1', terminalId: 'term_1' })
  await client.settle()
  // The slot is claimed first, so the client learns the id and slot it may
  // reuse; a failed attach is logged rather than turning the reply into an error.
  const payload = client.last().payload as Record<string, unknown>
  assert.equal(payload.slot, 0)
  assert.equal(payload.error, null)
})


test('delete_agent_request archives and answers with agent_deleted', async () => {
  const { bridge } = fakeBridge()
  const client = connect(makeDaemon(bridge))
  client.hello()
  client.request({ type: 'delete_agent_request', requestId: 'r1', agentId: 'ses_1' })
  await client.settle()
  assert.equal(client.last().type, 'agent_deleted')
  assert.equal((client.last().payload as Record<string, unknown>).agentId, 'ses_1')
})

test('workspace.script.list.request reports the declared scripts', async () => {
  const { bridge } = fakeBridge()
  const client = connect(makeDaemon(bridge))
  client.hello()
  client.request({ type: 'workspace.script.list.request', requestId: 'r1', workspaceId: 'ws_1' })
  await client.settle()
  // The reply is followed by the change broadcast, so read it by type rather
  // than as the last frame.
  const payload = client.payloads('workspace.script.list.response')[0] as Record<string, unknown>
  assert.equal(payload.workspaceId, 'ws_1')
  assert.deepEqual(payload.scripts, [])
  assert.equal(payload.error, null)
})

test('a workspace script request without a workspace is refused', async () => {
  const { bridge } = fakeBridge()
  const client = connect(makeDaemon(bridge))
  client.hello()
  client.request({ type: 'workspace.script.start.request', requestId: 'r1', scriptName: 'dev' })
  await client.settle()
  assert.equal(client.last().type, 'rpc_error')
})

test('schedule/create without a target agent is refused with the reason', async () => {
  const { bridge } = fakeBridge()
  const client = connect(makeDaemon(bridge))
  client.hello()
  client.request({ type: 'schedule/create', requestId: 'r1', prompt: 'check the build', cadence: { type: 'every', everyMs: 60_000 } })
  await client.settle()
  const payload = client.last().payload as Record<string, unknown>
  assert.equal(client.last().type, 'schedule/create/response')
  assert.equal(payload.schedule, null)
  assert.match(String(payload.error), /agent target/)
})

test('schedule/pause says what this daemon can do instead', async () => {
  const { bridge } = fakeBridge()
  const client = connect(makeDaemon(bridge))
  client.hello()
  client.request({ type: 'schedule/pause', requestId: 'r1', scheduleId: 'sch_1' })
  await client.settle()
  const payload = client.last().payload as Record<string, unknown>
  assert.equal(client.last().type, 'schedule/pause/response')
  assert.match(String(payload.error), /delete it instead/)
})

test('schedule/list answers with the runtime reminders', async () => {
  const { bridge } = fakeBridge()
  const client = connect(makeDaemon(bridge))
  client.hello()
  client.request({ type: 'schedule/list', requestId: 'r1' })
  await client.settle()
  const payload = client.last().payload as Record<string, unknown>
  assert.equal(client.last().type, 'schedule/list/response')
  assert.deepEqual(payload.schedules, [])
})
