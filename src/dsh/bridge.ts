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

import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { commitCheckout, pullCheckout, pushCheckout, readDiff, readGitStatus } from './git.ts'
import type { DiffCompare, DiffFile, GitOperationResult, GitStatus } from './git.ts'
import { readWorkspaceScripts } from './scripts.ts'
import type { WorkspaceScriptDefinition } from './scripts.ts'
import type {
  AgentRecord,
  AgentStatus,
  BridgeEvent,
  PromptInput,
  Disposable as BridgeDisposable,
  PaseoBridge,
  TimelineEntry,
  TerminalEvent,
  TerminalRecord,
  TimelineItem,
  WorkspaceRecord,
  WorkspaceScriptRecord,
  WorkspaceStatus,
} from '../bridge.ts'
import type {
  AgentsLike,
  HostContext,
  SessionControllerLike,
  SessionEventLike,
  SessionLike,
  PromptPart,
  ImageMediaType,
  SessionSummaryLike,
  SessionsLike,
  TerminalControllerLike,
  TerminalFrameLike,
  JobViewLike,
  JobsLike,
  TerminalInfoLike,
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

/** Messages one cold session's history page returns, matching the client's tail window. */
const COLD_TIMELINE_PAGE_MESSAGES = 200

/** PTY size a terminal starts with when the client names none. */
const DEFAULT_TERMINAL_COLS = 80
const DEFAULT_TERMINAL_ROWS = 24

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
  /** Owning session and writable attachment of every terminal this daemon saw. */
  /** Running script jobs, keyed by workspace and script name. */
  private readonly scriptJobs = new Map<string, string>()

  private readonly terminalOwners = new Map<string, { sessionId: string; attachmentId?: string }>()

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
    const archived = this.archivedSessionIds()
    const agents: AgentRecord[] = []
    for (const summary of await this.summaries()) {
      if (summary.parentSessionId !== undefined || summary.origin === 'subagent') continue
      if (archived.has(summary.sessionId)) continue
      agents.push(this.agentRecord(summary, byCwd.get(summary.cwd ?? '')))
    }
    return agents
  }

  /** Read one directory's checkout state. */
  async checkoutStatus(directory: string): Promise<GitStatus> {
    return readGitStatus(directory)
  }

  /** Read one directory's parsed diff. */
  async checkoutDiff(directory: string, compare: DiffCompare): Promise<readonly DiffFile[]> {
    return readDiff(directory, compare)
  }

  /** Commit one directory's working tree. */
  async commitCheckout(directory: string, message: string | undefined, addAll: boolean): Promise<GitOperationResult> {
    return commitCheckout(directory, message, addAll)
  }

  /** Push one directory's current branch. */
  async pushCheckout(directory: string): Promise<GitOperationResult> {
    return pushCheckout(directory)
  }

  /** Fast-forward one directory from its upstream. */
  async pullCheckout(directory: string): Promise<GitOperationResult> {
    return pullCheckout(directory)
  }

  /** Archive one session, which removes it from the active agent list. */
  async archiveAgent(agentId: string): Promise<string> {
    const registry = this.ctx.get('workspaceRegistry') as WorkspaceRegistryLike | undefined
    if (registry?.archiveSession === undefined) throw new Error('the workspace registry cannot archive sessions')
    await registry.archiveSession(agentId)
    return new Date().toISOString()
  }

  /** Session ids the operator archived. */
  private archivedSessionIds(): ReadonlySet<string> {
    const registry = this.ctx.get('workspaceRegistry') as WorkspaceRegistryLike | undefined
    return new Set(registry?.archivedSessionIds ?? [])
  }

  async getAgent(id: string): Promise<AgentRecord | null> {
    const summary = (await this.summaries()).find((item) => item.sessionId === id)
    if (summary === undefined) return null
    const workspace = summary.cwd === undefined ? undefined : this.workspaceForCwd(summary.cwd)
    return this.agentRecord(summary, workspace)
  }

  async getTimeline(agentId: string, options?: { readonly limit?: number }): Promise<readonly TimelineEntry[]> {
    const limit = options?.limit
    const session = this.session(agentId)
    // A cold Session has no attached log, so its transcript comes from the
    // durable history page instead. Sending it a prompt resumes it.
    const entries = session === undefined
      ? await this.coldTimeline(agentId)
      : foldEvents(session.snapshotEvents(0, session.seq))
    return limit === undefined || entries.length <= limit ? entries : entries.slice(entries.length - limit)
  }

  /** Read one page of a cold Session's log and fold it into timeline rows. */
  private async coldTimeline(agentId: string): Promise<TimelineEntry[]> {
    const controller = this.ctx.get('sessionController') as SessionControllerLike | undefined
    if (controller?.page === undefined || controller.projections === undefined) return []
    const signal = new AbortController().signal
    try {
      // A page needs an inclusive log cut, and only the projection watermark
      // carries one for a Session nothing is attached to.
      const projections = await controller.projections({ sessionId: agentId }, signal)
      if (projections?.kind !== 'sequenced' || typeof projections.asOfSeq !== 'number') return []
      const page = await controller.page({
        address: { kind: 'session', sessionId: agentId },
        throughSeq: projections.asOfSeq,
        maxMessages: COLD_TIMELINE_PAGE_MESSAGES,
      }, signal)
      return foldEvents(page.records.map((record) => record.event))
    } catch (error) {
      this.ctx.logger.warn(`paseo: cold timeline for ${agentId} failed: ${String(error)}`)
      return []
    }
  }

  async sendPrompt(agentId: string, prompt: PromptInput): Promise<void> {
    const controller = this.requireController()
    if (prompt.clientMessageId !== undefined) {
      this.pendingClientMessageIds.push({ agentId, clientMessageId: prompt.clientMessageId })
    }
    await controller.prompt({
      requestId: randomUUID(),
      sessionId: agentId,
      mode: 'queue',
      content: promptParts(prompt),
    }, new AbortController().signal)
    this.titles.set(agentId, titleFrom(prompt.text) ?? this.titles.get(agentId) ?? null)
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
    readonly images?: readonly { readonly data: string; readonly mimeType: string }[]
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
    if (input.prompt !== undefined && input.prompt.length > 0) await this.sendPrompt(created.sessionId, { text: input.prompt, ...(input.images === undefined ? {} : { images: input.images }) })
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
    // Stopping a cold session is a no-op, not a failure: it has no turn to
    // interrupt, and the client shows the same stopped state either way.
    try {
      await this.requireController().cancel({ sessionId: agentId })
    } catch (error) {
      if (this.session(agentId) !== undefined) throw error
      this.ctx.logger.debug(`paseo: cancel on cold session ${agentId} ignored: ${String(error)}`)
    }
  }

  /** Terminals retained by the sessions this daemon shows as agents. */
  async listTerminals(): Promise<readonly TerminalRecord[]> {
    const controller = this.ctx.get('terminalController') as TerminalControllerLike | undefined
    if (controller === undefined) return []
    const records: TerminalRecord[] = []
    for (const summary of await this.summaries()) {
      for (const info of controller.list(summary.sessionId)) {
        const record = this.terminalRecord(summary.sessionId, summary.cwd, info)
        this.terminalOwners.set(record.id, { sessionId: summary.sessionId, attachmentId: info.controllerId })
        records.push(record)
      }
    }
    return records
  }

  /** Allocate one terminal, owned by a live agent in the requested workspace. */
  async createTerminal(input: {
    readonly workspaceId: string
    readonly name?: string
    readonly cols?: number
    readonly rows?: number
  }): Promise<TerminalRecord> {
    const controller = this.requireTerminalController()
    const workspace = await this.workspaceFor(input.workspaceId)
    if (workspace === undefined) throw new Error(`unknown workspace ${input.workspaceId}`)
    const sessionId = await this.liveSessionIn(workspace.directory)
    if (sessionId === null) throw new Error(`no live agent in ${workspace.directory} can own a terminal`)
    const terminalId = `term_${randomUUID().replace(/-/g, '').slice(0, 16)}`
    const info = await controller.create(this.requireAgent(sessionId), {
      id: terminalId,
      cols: input.cols ?? DEFAULT_TERMINAL_COLS,
      rows: input.rows ?? DEFAULT_TERMINAL_ROWS,
    }, new AbortController().signal)
    const record = this.terminalRecord(sessionId, workspace.directory, info)
    this.terminalOwners.set(record.id, { sessionId, attachmentId: info.controllerId })
    if (input.name !== undefined && input.name.length > 0) {
      try {
        controller.rename(this.requireAgent(sessionId), record.id, input.name)
      } catch (error) {
        this.ctx.logger.warn(`paseo: naming terminal ${record.id} failed: ${String(error)}`)
      }
    }
    return record
  }

  /** Attach to one terminal and pump its frames to the listener. */
  async followTerminal(terminalId: string, listener: (event: TerminalEvent) => void): Promise<BridgeDisposable> {
    const controller = this.requireTerminalController()
    const owner = this.terminalOwners.get(terminalId)
    if (owner === undefined) throw new Error(`unknown terminal ${terminalId}`)
    const agent = this.requireAgent(owner.sessionId)
    const attachmentId = `att_${randomUUID().replace(/-/g, '').slice(0, 16)}`
    const abort = new AbortController()
    this.terminalOwners.set(terminalId, { sessionId: owner.sessionId, attachmentId })
    const pump = async (): Promise<void> => {
      try {
        for await (const frame of controller.follow(agent, terminalId, attachmentId, abort.signal)) {
          if (abort.signal.aborted) return
          listener(this.terminalEvent(owner.sessionId, frame))
        }
      } catch (error) {
        if (!abort.signal.aborted) this.ctx.logger.debug(`paseo: terminal ${terminalId} stream ended: ${String(error)}`)
      }
    }
    void pump()
    return () => { abort.abort() }
  }

  async writeTerminal(terminalId: string, data: string): Promise<void> {
    const { agent, attachmentId } = this.requireTerminalOwner(terminalId)
    await this.requireTerminalController().write(agent, terminalId, attachmentId, data)
  }

  async resizeTerminal(terminalId: string, cols: number, rows: number): Promise<void> {
    const { agent, attachmentId } = this.requireTerminalOwner(terminalId)
    await this.requireTerminalController().resize(agent, terminalId, attachmentId, cols, rows)
  }

  async renameTerminal(terminalId: string, title: string): Promise<void> {
    const { agent } = this.requireTerminalOwner(terminalId)
    this.requireTerminalController().rename(agent, terminalId, title)
  }

  async closeTerminal(terminalId: string): Promise<void> {
    const { agent } = this.requireTerminalOwner(terminalId)
    await this.requireTerminalController().close(agent, terminalId)
    this.terminalOwners.delete(terminalId)
  }

  /** Declared scripts of one workspace, each with its current lifecycle. */
  async listWorkspaceScripts(workspaceId: string): Promise<readonly WorkspaceScriptRecord[]> {
    const workspace = await this.workspaceFor(workspaceId)
    if (workspace === undefined) throw new Error(`unknown workspace ${workspaceId}`)
    const definitions = await readWorkspaceScripts(workspace.directory)
    return definitions.map((definition) => this.scriptRecord(workspaceId, definition))
  }

  /** Start one declared script as a background job. */
  async startWorkspaceScript(workspaceId: string, name: string): Promise<WorkspaceScriptRecord> {
    const workspace = await this.workspaceFor(workspaceId)
    if (workspace === undefined) throw new Error(`unknown workspace ${workspaceId}`)
    const definition = (await readWorkspaceScripts(workspace.directory)).find((entry) => entry.name === name)
    if (definition === undefined) throw new Error(`workspace declares no script named ${name}`)
    const key = scriptKey(workspaceId, name)
    if (this.scriptJobs.get(key) !== undefined) return this.scriptRecord(workspaceId, definition)

    const jobs = this.requireJobs()
    const jobId = jobs.start({
      kind: 'paseo-script',
      label: `${name}: ${definition.command}`,
      run: (job) => {
        // The command is the workspace's own declaration, run through a shell
        // for the same reason Paseo runs it that way: a declared script is a
        // command line, not an argv array. The spawn sits inside the starter so
        // a refused registration cannot leave an orphan process behind.
        const child = spawn(definition.command, { cwd: workspace.directory, shell: true, env: process.env })
        return {
          cancel: () => { child.kill('SIGTERM') },
          done: new Promise((resolve) => {
            const forward = (chunk: Buffer): void => { job.append(chunk.toString('utf8')) }
            child.stdout?.on('data', forward)
            child.stderr?.on('data', forward)
            child.on('error', (error: Error) => { resolve({ ok: false, detail: error.message }) })
            child.on('close', (code: number | null, signal: string | null) => {
              resolve({ ok: code === 0, detail: signal === null ? `exit code: ${String(code)}` : `signal: ${signal}` })
            })
          }),
        }
      },
    })
    this.scriptJobs.set(key, jobId)
    return this.scriptRecord(workspaceId, definition)
  }

  /** Stop one running script. */
  async stopWorkspaceScript(workspaceId: string, name: string): Promise<WorkspaceScriptRecord> {
    const workspace = await this.workspaceFor(workspaceId)
    if (workspace === undefined) throw new Error(`unknown workspace ${workspaceId}`)
    const key = scriptKey(workspaceId, name)
    const jobId = this.scriptJobs.get(key)
    if (jobId !== undefined) {
      this.requireJobs().kill(jobId, undefined, 'stopped from Paseo')
      this.scriptJobs.delete(key)
    }
    const definition = (await readWorkspaceScripts(workspace.directory)).find((entry) => entry.name === name)
    if (definition === undefined) throw new Error(`workspace declares no script named ${name}`)
    return this.scriptRecord(workspaceId, definition)
  }

  /** Project one declaration plus its job, when it has one. */
  private scriptRecord(workspaceId: string, definition: WorkspaceScriptDefinition): WorkspaceScriptRecord {
    const jobId = this.scriptJobs.get(scriptKey(workspaceId, definition.name))
    const job = jobId === undefined ? undefined : this.jobsView(jobId)
    return {
      name: definition.name,
      type: definition.type,
      command: definition.command,
      port: definition.port,
      lifecycle: job?.status === 'running' || job?.status === 'stopping' ? 'running' : 'stopped',
      health: null,
      exitCode: job === undefined ? null : exitCodeOf(job.detail),
    }
  }

  private jobsView(jobId: string): JobViewLike | undefined {
    const jobs = this.ctx.get('jobs') as JobsLike | undefined
    if (jobs === undefined) return undefined
    try {
      return jobs.get(jobId)
    } catch {
      return undefined
    }
  }

  private requireJobs(): JobsLike {
    const jobs = this.ctx.get('jobs') as JobsLike | undefined
    if (jobs === undefined) throw new Error('the jobs service is not mounted')
    return jobs
  }

  private requireTerminalController(): TerminalControllerLike {
    const controller = this.ctx.get('terminalController') as TerminalControllerLike | undefined
    if (controller === undefined) throw new Error('the terminalController service is not mounted')
    return controller
  }

  /** The opaque Agent that owns a terminal, plus the attachment it is writable through. */
  private requireTerminalOwner(terminalId: string): { agent: unknown; attachmentId: string } {
    const owner = this.terminalOwners.get(terminalId)
    if (owner === undefined) throw new Error(`unknown terminal ${terminalId}`)
    return { agent: this.requireAgent(owner.sessionId), attachmentId: owner.attachmentId ?? '' }
  }

  /** The live Agent for one session, which every terminal call must name as owner. */
  private requireAgent(sessionId: string): unknown {
    const agents = this.ctx.get('agents') as AgentsLike | undefined
    const agent = agents?.get(sessionId)
    if (agent === undefined) throw new Error(`session ${sessionId} has no live agent`)
    return agent
  }

  /** Most recently active live session whose working directory is this one. */
  private async liveSessionIn(directory: string): Promise<string | null> {
    const summaries = await this.summaries()
    const live = summaries.filter((summary) => summary.agentAvailable && summary.cwd === directory)
    if (live.length === 0) return null
    return live.reduce((newest, candidate) => candidate.updatedAt > newest.updatedAt ? candidate : newest).sessionId
  }

  private terminalRecord(sessionId: string, cwd: string | undefined, info: TerminalInfoLike): TerminalRecord {
    const directory = info.cwd.length > 0 ? info.cwd : cwd ?? ''
    return {
      id: info.id,
      sessionId,
      workspaceId: this.workspaceForCwd(directory).id,
      title: info.title,
      cwd: directory,
      cols: info.cols,
      rows: info.rows,
      state: info.state,
      exitCode: info.exitCode,
    }
  }

  private terminalEvent(sessionId: string, frame: TerminalFrameLike): TerminalEvent {
    if (frame.type === 'snapshot') return { type: 'snapshot', screen: frame.screen }
    if (frame.type === 'output') return { type: 'output', data: frame.data }
    return { type: 'state', record: this.terminalRecord(sessionId, frame.info.cwd, frame.info) }
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
      title: this.titles.get(summary.sessionId) ?? this.titleOf(session) ?? projectedTitle(summary),
      provider: header?.config?.provider ?? projectedSelection(summary)?.provider ?? this.defaultProvider,
      model: header?.config?.model ?? projectedSelection(summary)?.model ?? this.defaultModel,
      status,
      cwd: directory,
      workspaceId: workspace?.id ?? this.workspaceForCwd(directory).id,
      createdAt: updatedAt,
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

/**
 * Model selection a cold listing already carries.
 *
 * The session controller projects the durable selection and the list service
 * ships that projection as a hint, so a session with nothing attached still
 * reports the provider and model it last ran.
 */
function projectedSelection(summary: SessionSummaryLike): { provider?: string; model?: string } | undefined {
  const value = summary.projections?.values?.['modelSelection']
  if (value === null || typeof value !== 'object') return undefined
  const projection = value as { readonly next?: unknown; readonly lastUsed?: unknown }
  const selection = projection.next ?? projection.lastUsed
  if (selection === null || typeof selection !== 'object') return undefined
  return selection as { provider?: string; model?: string }
}

/**
 * Title a cold listing already carries.
 *
 * The session-title plugin projects the current title, and the list service
 * ships that projection as a hint for exactly this case: a Session with no
 * attached log still has a name.
 */
function projectedTitle(summary: SessionSummaryLike): string | null {
  const title = summary.projections?.values?.['title']
  return typeof title === 'string' && title.length > 0 ? title : null
}

/**
 * Turn one submitted prompt into session content parts.
 *
 * The text part is omitted when a client sent only images, and an image whose
 * media type the attachment seam does not accept is dropped rather than
 * failing the whole prompt.
 * @param prompt - submitted prompt.
 * @returns the content parts to admit.
 */
export function promptParts(prompt: PromptInput): PromptPart[] {
  const parts: PromptPart[] = []
  if (prompt.text.trim().length > 0) parts.push({ type: 'text', text: prompt.text })
  for (const image of prompt.images ?? []) {
    if (!isImageMediaType(image.mimeType)) continue
    parts.push({ type: 'image', mediaType: image.mimeType, data: image.data })
  }
  return parts
}

/** Whether the attachment seam accepts this media type. */
export function isImageMediaType(value: string): value is ImageMediaType {
  return value === 'image/png' || value === 'image/jpeg' || value === 'image/webp' || value === 'image/gif'
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

/** Key one running script by workspace and name. */
function scriptKey(workspaceId: string, name: string): string {
  return `${workspaceId}\u0000${name}`
}

/** Exit code git-style detail carries, when it names one. */
function exitCodeOf(detail: string | undefined): number | null {
  const match = detail?.match(/exit code: (\d+)/)
  return match === null || match === undefined ? null : Number(match[1])
}
