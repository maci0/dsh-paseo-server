/**
 * DeepSeek Harness binding for the Paseo bridge.
 *
 * One DSH Session is one Paseo agent, one DSH workspace record is one Paseo
 * workspace, and the repository root behind a workspace directory is the Paseo
 * project. Prompts enter through the session controller, and the timeline is
 * folded from the durable session log, so the two sides never disagree about
 * what happened.
 *
 * @module dsh-paseo-server/dsh/bridge
 */

import { createHash, randomUUID } from 'node:crypto'
import type {
  AgentRecord,
  AgentStatus,
  BridgeEvent,
  Disposable as BridgeDisposable,
  PaseoBridge,
  TimelineEntry,
  TimelineItem,
  WorkspaceRecord,
  WorkspaceStatus,
} from '../bridge.ts'
import type {
  AgentsLike,
  HostContext,
  SessionControllerLike,
  SessionEventLike,
  SessionLike,
  SessionSummaryLike,
  SessionsLike,
  WorkspaceLike,
  WorkspaceRegistryLike,
} from '../host.ts'

/** Options for {@link createDshBridge}. */
export interface DshBridgeOptions {
  readonly ctx: HostContext
  /** Fallback provider id when a session has no recorded request header. */
  readonly defaultProvider: string
  /** Fallback model id when a session has no recorded request header. */
  readonly defaultModel: string
}

/** Longest agent title derived from a first prompt. */
const TITLE_MAX_CHARS = 80

/** A bridge whose daemon identity can be installed after construction. */
export interface DshBridgeHandle extends PaseoBridge {
  bindIdentity(serverId: string, version: string): void
}

/** Binding that presents a DSH composition as a Paseo bridge. */
export function createDshBridge(options: DshBridgeOptions): DshBridgeHandle {
  return new DshBridge(options)
}

class DshBridge implements PaseoBridge {
  private readonly ctx: HostContext
  private readonly defaultProvider: string
  private readonly defaultModel: string
  private readonly listeners = new Set<(event: BridgeEvent) => void>()
  private readonly disposers: BridgeDisposable[] = []
  private readonly workspaceCache = new Map<string, WorkspaceRecord>()
  private readonly titles = new Map<string, string | null>()
  private readonly failed = new Set<string>()
  /** Client-minted prompt identities awaiting their user/message event, oldest first. */
  private readonly pendingClientMessageIds: Array<{ agentId: string; clientMessageId: string }> = []
  private started = false

  constructor(options: DshBridgeOptions) {
    this.ctx = options.ctx
    this.defaultProvider = options.defaultProvider
    this.defaultModel = options.defaultModel
  }

  /** Placeholder identity until {@link bindIdentity} installs the real one. */
  serverId = 'srv_pending00000'

  /** Placeholder version until {@link bindIdentity} installs the real one. */
  version = '0.0.0'

  /** Install the daemon identity reported to clients. */
  bindIdentity(serverId: string, version: string): void {
    this.serverId = serverId
    this.version = version
  }

  async listProviders(): Promise<readonly { readonly provider: string; readonly available: boolean }[]> {
    const llm = this.ctx.get('llm') as { listProviders?(): readonly { readonly id: string }[] } | undefined
    const providers = llm?.listProviders?.() ?? []
    if (providers.length === 0) return [{ provider: this.defaultProvider, available: true }]
    return providers.map((entry) => ({ provider: entry.id, available: true }))
  }

  async listProviderModels(provider: string): Promise<readonly { readonly id: string; readonly label: string; readonly description?: string }[]> {
    const llm = this.ctx.get('llm') as { listModels?(provider: string): Promise<readonly { readonly id: string; readonly name?: string; readonly description?: string }[]> } | undefined
    if (llm?.listModels === undefined) return []
    try {
      const models = await llm.listModels(provider)
      return models.map((model) => ({
        id: model.id,
        label: model.name ?? model.id,
        ...(model.description === undefined ? {} : { description: model.description }),
      }))
    } catch (error) {
      this.ctx.logger.warn(`paseo: model catalog for ${provider} failed: ${String(error)}`)
      return []
    }
  }

  async listWorkspaces(): Promise<readonly WorkspaceRecord[]> {
    const registry = this.ctx.get('workspaceRegistry') as WorkspaceRegistryLike | undefined
    const records = new Map<string, WorkspaceRecord>()
    if (registry !== undefined) {
      for (const workspace of registry.list()) {
        const record = this.workspaceRecord(workspace, workspace.path, workspace.title, workspace.createdAt, workspace.updatedAt, [])
        records.set(record.id, record)
      }
    }
    for (const summary of await this.summaries()) {
      const cwd = summary.cwd
      if (cwd === undefined) continue
      const record = this.workspaceForCwd(cwd)
      records.set(record.id, record)
    }
    const list = [...records.values()]
    for (const record of list) this.workspaceCache.set(record.id, record)
    return list
  }

  async listAgents(): Promise<readonly AgentRecord[]> {
    const workspaces = await this.listWorkspaces()
    const byCwd = new Map(workspaces.map((workspace) => [workspace.directory, workspace]))
    const agents: AgentRecord[] = []
    for (const summary of await this.summaries()) {
      if (summary.parentSessionId !== undefined || summary.origin === 'subagent') continue
      if (!summary.agentAvailable) continue
      agents.push(this.agentRecord(summary, byCwd.get(summary.cwd ?? '')))
    }
    return agents
  }

  async getAgent(id: string): Promise<AgentRecord | null> {
    const summary = (await this.summaries()).find((item) => item.sessionId === id)
    if (summary === undefined || !summary.agentAvailable) return null
    const workspace = summary.cwd === undefined ? undefined : this.workspaceForCwd(summary.cwd)
    return this.agentRecord(summary, workspace)
  }

  async getTimeline(agentId: string, options?: { readonly limit?: number }): Promise<readonly TimelineEntry[]> {
    const session = this.session(agentId)
    if (session === undefined) return []
    const entries = foldEvents(session.snapshotEvents(0, session.seq))
    const limit = options?.limit
    return limit === undefined || entries.length <= limit ? entries : entries.slice(entries.length - limit)
  }

  async sendPrompt(agentId: string, text: string, clientMessageId?: string): Promise<void> {
    const controller = this.requireController()
    if (clientMessageId !== undefined) this.pendingClientMessageIds.push({ agentId, clientMessageId })
    await controller.prompt({
      requestId: randomUUID(),
      sessionId: agentId,
      mode: 'queue',
      content: [{ type: 'text', text }],
    }, new AbortController().signal)
    this.titles.set(agentId, titleFrom(text) ?? this.titles.get(agentId) ?? null)
  }

  /**
   * Take the client-minted identity of the submission whose message event is
   * being folded, oldest first.
   *
   * A client renders its own prompt immediately, so echoing the row back
   * without the identity it minted makes it appear twice. The queue is FIFO
   * because a session admits prompts in arrival order.
   */
  private claimClientMessageId(agentId: string): string | undefined {
    const index = this.pendingClientMessageIds.findIndex((entry) => entry.agentId === agentId)
    if (index < 0) return undefined
    return this.pendingClientMessageIds.splice(index, 1)[0]?.clientMessageId
  }

  async createAgent(input: {
    readonly workspaceId?: string
    readonly directory?: string
    readonly provider?: string
    readonly model?: string
    readonly title?: string
    readonly prompt?: string
  }): Promise<AgentRecord> {
    const controller = this.requireController()
    const directory = await this.directoryFor(input)
    const created = await controller.create({ cwd: directory })
    if (input.provider !== undefined && input.model !== undefined && controller.selectModel !== undefined) {
      await controller.selectModel({ sessionId: created.sessionId, provider: input.provider, model: input.model })
    }
    if (input.title !== undefined && controller.rename !== undefined) {
      await controller.rename({ sessionId: created.sessionId, title: input.title })
    }
    if (input.title !== undefined) this.titles.set(created.sessionId, input.title)
    if (input.prompt !== undefined && input.prompt.length > 0) await this.sendPrompt(created.sessionId, input.prompt)
    const agent = await this.getAgent(created.sessionId)
    if (agent === null) throw new Error(`created session ${created.sessionId} has no live agent`)
    return agent
  }

  /** Resolve the directory a new agent runs in. */
  private async directoryFor(input: { readonly workspaceId?: string; readonly directory?: string }): Promise<string> {
    if (input.workspaceId !== undefined) {
      const workspace = await this.workspaceFor(input.workspaceId)
      if (workspace === undefined) throw new Error(`unknown workspace ${input.workspaceId}`)
      return workspace.directory
    }
    if (input.directory !== undefined && input.directory.length > 0) return input.directory
    throw new Error('agent creation needs a workspace or a directory')
  }

  async cancelAgent(agentId: string): Promise<void> {
    await this.requireController().cancel({ sessionId: agentId })
  }

  async createWorkspace(input: { readonly directory: string; readonly name?: string }): Promise<WorkspaceRecord> {
    const registry = this.ctx.get('workspaceRegistry') as WorkspaceRegistryLike | undefined
    if (registry === undefined) throw new Error('the workspaceRegistry service is not mounted')
    const workspace = await registry.create(input.directory, input.name)
    const record = this.workspaceRecord(workspace, workspace.path, workspace.title, workspace.createdAt, workspace.updatedAt, [])
    this.workspaceCache.set(record.id, record)
    return record
  }

  async archiveWorkspace(workspaceId: string): Promise<void> {
    const record = await this.workspaceFor(workspaceId)
    if (record === undefined) throw new Error(`unknown workspace ${workspaceId}`)
    const registry = this.ctx.get('workspaceRegistry') as (WorkspaceRegistryLike & { delete(id: string): Promise<boolean> }) | undefined
    if (registry === undefined) throw new Error('the workspaceRegistry service is not mounted')
    await registry.delete(workspaceId)
    this.workspaceCache.delete(workspaceId)
  }

  subscribe(listener: (event: BridgeEvent) => void): BridgeDisposable {
    this.listeners.add(listener)
    this.start()
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0) this.stop()
    }
  }

  /** Attach host listeners once, while at least one client is subscribed. */
  private start(): void {
    if (this.started) return
    this.started = true
    this.disposers.push(this.ctx.on('session/event', ((session: SessionLike, event: SessionEventLike) => {
      this.onSessionEvent(session, event)
    }) as (...args: never[]) => void))
    this.disposers.push(this.ctx.on('api-session/added', ((summary: SessionSummaryLike) => {
      void this.publishAgent(summary.sessionId)
    }) as (...args: never[]) => void))
    this.disposers.push(this.ctx.on('api-session/removed', ((sessionId: string) => {
      this.emit({ kind: 'agent_remove', agentId: sessionId })
    }) as (...args: never[]) => void))
    this.disposers.push(this.ctx.on('api-session/status', ((sessionId: string, running: boolean) => {
      if (running) this.failed.delete(sessionId)
      void this.publishAgent(sessionId)
    }) as (...args: never[]) => void))
  }

  private stop(): void {
    this.started = false
    for (const dispose of this.disposers.splice(0)) dispose()
  }

  private onSessionEvent(session: SessionLike, event: SessionEventLike): void {
    if (event.type === 'turn/end') {
      const reason = stringField(event.data, 'reason')
      if (reason === 'error' || reason === 'failure') this.failed.add(session.id)
      else if (reason !== undefined) this.failed.delete(session.id)
      void this.publishAgent(session.id)
    }
    const clientMessageId = event.type === 'user/message' ? this.claimClientMessageId(session.id) : undefined
    for (const entry of foldEvent(event, clientMessageId)) {
      this.emit({ kind: 'timeline', agentId: session.id, entry })
    }
  }

  private async publishAgent(sessionId: string): Promise<void> {
    const agent = await this.getAgent(sessionId)
    if (agent === null) return
    this.emit({ kind: 'agent_upsert', agent })
  }

  private emit(event: BridgeEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (error) {
        this.ctx.logger.warn(`paseo: bridge listener failed: ${String(error)}`)
      }
    }
  }

  private requireController(): SessionControllerLike {
    const controller = this.ctx.get('sessionController') as SessionControllerLike | undefined
    if (controller === undefined) throw new Error('the sessionController service is not mounted')
    return controller
  }

  private async summaries(): Promise<readonly SessionSummaryLike[]> {
    const controller = this.ctx.get('sessionController') as SessionControllerLike | undefined
    if (controller !== undefined) {
      const value = await controller.list({}, new AbortController().signal)
      return value.items
    }
    const sessions = this.ctx.get('sessions') as SessionsLike | undefined
    const agents = this.ctx.get('agents') as AgentsLike | undefined
    if (sessions === undefined) return []
    const live = new Set(agents?.list().map((agent) => agent.id) ?? [])
    return sessions.list().map((session) => ({
      sessionId: session.id,
      cwd: session.header.cwd,
      running: false,
      agentAvailable: live.has(session.id),
      blank: false,
      updatedAt: Date.now(),
    }))
  }

  private session(id: string): SessionLike | undefined {
    return (this.ctx.get('sessions') as SessionsLike | undefined)?.get(id)
  }

  private agentRecord(summary: SessionSummaryLike, workspace: WorkspaceRecord | undefined): AgentRecord {
    const session = this.session(summary.sessionId)
    const header = session?.requestHeader?.()
    const directory = summary.cwd ?? workspace?.directory ?? session?.header.cwd ?? ''
    const status: AgentStatus = this.failed.has(summary.sessionId)
      ? 'error'
      : summary.running
        ? 'running'
        : 'idle'
    const updatedAt = new Date(summary.updatedAt).toISOString()
    return {
      id: summary.sessionId,
      shortId: summary.sessionId.slice(-8),
      title: this.titles.get(summary.sessionId) ?? this.titleOf(session),
      provider: header?.config?.provider ?? this.defaultProvider,
      model: header?.config?.model ?? this.defaultModel,
      status,
      cwd: directory,
      workspaceId: workspace?.id ?? this.workspaceForCwd(directory).id,
      createdAt: new Date(summary.updatedAt).toISOString(),
      updatedAt,
      lastUserMessageAt: updatedAt,
      archivedAt: null,
      activeTurn: null,
    }
  }

  /** First human prompt, used as the agent title when DSH has no title. */
  private titleOf(session: SessionLike | undefined): string | null {
    if (session === undefined) return null
    const cached = this.titles.get(session.id)
    if (cached !== undefined) return cached
    let title: string | null = null
    for (const event of session.snapshotEvents(0, session.seq)) {
      if (event.type !== 'user/message') continue
      if (messageSourceKind(event.data) !== 'user') continue
      title = titleFrom(messageText(event.data)) ?? null
      break
    }
    this.titles.set(session.id, title)
    return title
  }

  /** Directories are workspaces even when the registry never recorded them. */
  private workspaceForCwd(cwd: string): WorkspaceRecord {
    const id = `ws_${digest(cwd)}`
    const cached = this.workspaceCache.get(id)
    if (cached !== undefined) return cached
    const now = new Date().toISOString()
    const record = this.workspaceRecord(
      { id, path: cwd, title: basenameOf(cwd), createdAt: now, updatedAt: now, sessionIds: [] },
      cwd,
      basenameOf(cwd),
      now,
      now,
      [],
    )
    this.workspaceCache.set(id, record)
    return record
  }

  private async workspaceFor(workspaceId: string): Promise<WorkspaceRecord | undefined> {
    const cached = this.workspaceCache.get(workspaceId)
    if (cached !== undefined) return cached
    await this.listWorkspaces()
    return this.workspaceCache.get(workspaceId)
  }

  private workspaceRecord(
    workspace: WorkspaceLike,
    directory: string,
    name: string,
    createdAt: string,
    updatedAt: string,
    agentStatuses: readonly AgentStatus[],
  ): WorkspaceRecord {
    const projectRootPath = directory
    return {
      id: workspace.id,
      projectId: `prj_${digest(projectRootPath)}`,
      projectKey: projectRootPath,
      projectName: basenameOf(projectRootPath),
      projectRootPath,
      projectKind: 'directory',
      name,
      directory,
      status: workspaceStatus(agentStatuses),
      statusEnteredAt: updatedAt,
      activityAt: updatedAt,
      createdAt,
      updatedAt,
      checkout: { repoRoot: projectRootPath, isGit: false },
    }
  }
}

/** Fold a whole log into timeline rows. */
export function foldEvents(events: readonly SessionEventLike[]): TimelineEntry[] {
  const entries: TimelineEntry[] = []
  for (const event of events) entries.push(...foldEvent(event))
  return entries
}

/**
 * Fold one durable session event into zero or more timeline rows.
 *
 * A tool call is emitted once, when its result arrives, so the timeline shows
 * no duplicate running and completed rows. A live running indicator needs the
 * Paseo timeline-replacement surface, which this daemon does not advertise.
 * @param event - committed session event.
 * @param clientMessageId - identity the client minted for this submission, when it made it.
 * @returns the rows this event contributes.
 */
export function foldEvent(event: SessionEventLike, clientMessageId?: string): TimelineEntry[] {
  const timestamp = new Date(event.time).toISOString()
  switch (event.type) {
    case 'user/message': {
      if (messageSourceKind(event.data) !== 'user') return []
      const text = messageText(event.data)
      if (text === undefined || text.length === 0) return []
      const messageId = stringField(event.data, 'id')
      return [{
        item: {
          type: 'user_message',
          text,
          ...(messageId === undefined ? {} : { messageId }),
          ...(clientMessageId === undefined ? {} : { clientMessageId }),
        },
        timestamp,
        seq: event.seq,
      }]
    }
    case 'assistant/message': {
      const message = recordField(event.data, 'message')
      if (message === undefined) return []
      const text = messageText(message)
      const messageId = stringField(message, 'id')
      const rows: TimelineEntry[] = []
      const reasoning = messageReasoning(message)
      if (reasoning !== undefined && reasoning.length > 0) rows.push({ item: { type: 'reasoning', text: reasoning }, timestamp, seq: event.seq })
      if (text !== undefined && text.length > 0) {
        rows.push({
          item: { type: 'assistant_message', text, ...(messageId === undefined ? {} : { messageId }) },
          timestamp,
          seq: event.seq,
        })
      }
      return rows
    }
    case 'tool/call':
      // Held until the matching result arrives; see the function contract.
      return []
    case 'tool/result':
      return [toolResultEntry(event, timestamp)]
    default:
      return []
  }
}

function toolResultEntry(event: SessionEventLike, timestamp: string): TimelineEntry {
  const message = recordField(event.data, 'message')
  const callId = message === undefined ? undefined : stringField(message, 'toolCallId')
  const error = recordField(event.data, 'error')
  const isError = message !== undefined && message['isError'] === true
  const item: TimelineItem = {
    type: 'tool_call',
    callId: callId ?? `call_${event.seq}`,
    name: stringField(event.data, 'name') ?? 'tool',
    status: isError ? 'failed' : 'completed',
    input: null,
    output: messageText(message ?? {}) ?? null,
    ...(error === undefined ? {} : { error: stringField(error, 'reason') ?? stringField(error, 'name') ?? 'tool failed' }),
  }
  return { item, timestamp, seq: event.seq }
}

/** Concatenate the text blocks of one message. */
export function messageText(message: Record<string, unknown>): string | undefined {
  const content = message['content']
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  const parts: string[] = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const record = block as Record<string, unknown>
    if (record.type !== 'text') continue
    if (typeof record.text === 'string') parts.push(record.text)
  }
  return parts.length === 0 ? undefined : parts.join('\n')
}

/** Concatenate the reasoning blocks of one assistant message. */
export function messageReasoning(message: Record<string, unknown>): string | undefined {
  const content = message['content']
  if (!Array.isArray(content)) return undefined
  const parts: string[] = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const record = block as Record<string, unknown>
    if (record.type !== 'reasoning') continue
    if (typeof record.text === 'string') parts.push(record.text)
  }
  return parts.length === 0 ? undefined : parts.join('\n')
}

/** `source.kind` of one message, when it carries a source. */
function messageSourceKind(message: Record<string, unknown>): string | undefined {
  const source = recordField(message, 'source')
  return source === undefined ? undefined : stringField(source, 'kind')
}

function recordField(record: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = record[key]
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' ? value : undefined
}

/** Workspace status bucket from the statuses of its agents, most severe first. */
export function workspaceStatus(statuses: readonly AgentStatus[]): WorkspaceStatus {
  if (statuses.includes('initializing') || statuses.includes('running')) return 'running'
  if (statuses.includes('error')) return 'failed'
  return 'done'
}

function titleFrom(text: string | undefined): string | undefined {
  if (text === undefined) return undefined
  const line = text.trim().split('\n', 1)[0]?.trim() ?? ''
  if (line.length === 0) return undefined
  return line.length <= TITLE_MAX_CHARS ? line : `${line.slice(0, TITLE_MAX_CHARS - 1)}…`
}

function basenameOf(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return index < 0 ? trimmed : trimmed.slice(index + 1)
}

function digest(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 16)
}
