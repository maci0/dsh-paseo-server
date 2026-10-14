/**
 * Paseo daemon: one WebSocket session per connected Paseo client, plus the
 * fan-out of live agent, workspace, and timeline events from the bridge.
 *
 * @module dsh-paseo-server/paseo/daemon
 */

import type { AgentRecord, BridgeEvent, PaseoBridge, WorkspaceRecord } from '../bridge.ts'
import type { WireSocket } from './transport.ts'
import {
  agentRemoved,
  agentCreateFailedStatus,
  agentCreateResponse,
  agentCreatedStatus,
  agentResponse,
  agentStatus,
  agentStream,
  availableProvidersResponse,
  agentUpdate,
  agentsResponse,
  attentionCleared,
  cancelResponse,
  checkoutStatusResponse,
  daemonStatus,
  eventsSubscriptionSet,
  envelope,
  noTerminals,
  parseInbound,
  pong,
  providerModelsResponse,
  providerModesResponse,
  providersSnapshotResponse,
  projectsResponse,
  rpcError,
  sendMessageRejected,
  sendMessageResponse,
  serverInfo,
  subscriptionReleased,
  timelineResponse,
  waitForFinishResponse,
  workspaceUpdate,
  workspaceCreateResponse,
  workspacesResponse,
  isSettledStatus,
} from './wire.ts'

/** Default `wait_for_finish_request` deadline when the client names none. */
const DEFAULT_WAIT_TIMEOUT_MS = 600_000

/** Minimal logger surface; matches Cordis `ctx.logger`. */
export interface Logger {
  debug(message: string): void
  info(message: string): void
  warn(message: string): void
}

/** What the daemon needs to publish a pairing offer. */
export interface PairingOffer {
  readonly url: string
  /** Terminal-renderable QR of that URL, or null when rendering failed. */
  readonly qr: string | null
  readonly relayEnabled: boolean
}

/** Daemon construction options. */
export interface DaemonOptions {
  readonly bridge: PaseoBridge
  readonly logger: Logger
  readonly hostname: string
  /** Relay endpoint host:port, when relay transport is enabled. */
  readonly relayEndpoint?: string
  /** Shared secret a client must present in `hello`; empty accepts anyone. */
  readonly password?: string
  /** Address the daemon listens on, for the status report; null when unknown. */
  readonly listen?: string
  /** Supplies the current pairing offer, evaluated per request. */
  readonly pairingOffer: () => PairingOffer
}

/** One connected client. */
interface Connection {
  readonly socket: WireSocket
  ready: boolean
  closed: boolean
}

/** Live event fan-out plus request dispatch for every connected client. */
export class PaseoDaemon {
  private readonly connections = new Set<Connection>()
  private unsubscribe: (() => void) | undefined
  private closed = false

  constructor(private readonly options: DaemonOptions) {}

  /** Start listening to bridge events. */
  start(): void {
    if (this.unsubscribe !== undefined) return
    this.unsubscribe = this.options.bridge.subscribe((event) => { this.onBridgeEvent(event) })
  }

  /** Stop the fan-out; transport sockets are owned by the caller. */
  stop(): void {
    this.closed = true
    this.unsubscribe?.()
    this.unsubscribe = undefined
    for (const connection of this.connections) {
      connection.socket.detach()
      this.connections.delete(connection)
    }
  }

  /** Number of admitted clients, for diagnostics. */
  get size(): number {
    return this.connections.size
  }

  /**
   * Admit one transport socket as a Paseo client.
   *
   * The transport owns its own listeners and drives this handle: it calls
   * {@link PaseoConnection.receive} per text frame and
   * {@link PaseoConnection.dispose} when the peer goes away.
   * @param socket - transport to speak the protocol over.
   * @returns the connection handle for that socket.
   */
  attach(socket: WireSocket): PaseoConnection {
    const connection: Connection = { socket, ready: false, closed: false }
    this.connections.add(connection)
    return {
      receive: (text: string) => { this.onFrame(connection, text) },
      dispose: () => {
        connection.closed = true
        this.connections.delete(connection)
      },
    }
  }

  /** Route one inbound text frame. */
  private onFrame(connection: Connection, text: string): void {
    if (this.closed || connection.closed) return
    const frame = parseInbound(text)
    if (frame === null) return
    if (frame.kind === 'ping') {
      connection.socket.send(pong())
      return
    }
    if (frame.kind === 'recording_state') return
    if (frame.kind === 'hello') {
      if (this.options.password !== undefined && this.options.password.length > 0) {
        const provided = frame.hello.auth?.kind === 'password' ? frame.hello.auth.password : undefined
        if (provided !== this.options.password) {
          connection.socket.send(JSON.stringify({
            type: 'hello.rejected',
            reason: provided === undefined ? 'password_required' : 'incorrect_password',
            accepts: ['password'],
          }))
          connection.socket.close(4401, 'auth failed')
          return
        }
      }
      connection.ready = true
      connection.socket.send(envelope(serverInfo(this.options.bridge, this.options.hostname)))
      return
    }
    if (!connection.ready) return
    void this.dispatch(connection, frame.message)
  }

  /** Answer one request message. */
  private async dispatch(connection: Connection, message: Record<string, unknown>): Promise<void> {
    const type = typeof message.type === 'string' ? message.type : ''
    const requestId = typeof message.requestId === 'string' ? message.requestId : ''
    const reply = (payload: Record<string, unknown>): void => {
      if (connection.closed) return
      connection.socket.send(envelope(payload))
    }
    try {
      switch (type) {
        case 'fetch_workspaces_request': {
          const workspaces = await this.options.bridge.listWorkspaces()
          this.cacheWorkspaces(workspaces)
          reply(workspacesResponse(requestId, subscriptionIdOf(message), workspaces))
          return
        }
        case 'project.list.request': {
          reply(projectsResponse(requestId, await this.options.bridge.listWorkspaces()))
          return
        }
        case 'fetch_agents_request': {
          const [agents, workspaces] = await Promise.all([this.options.bridge.listAgents(), this.options.bridge.listWorkspaces()])
          this.cacheWorkspaces(workspaces)
          const byId = new Map(workspaces.map((workspace) => [workspace.id, workspace]))
          const entries = agents.flatMap((agent) => {
            const workspace = byId.get(agent.workspaceId)
            return workspace === undefined ? [] : [{ agent, workspace }]
          })
          reply(agentsResponse(requestId, subscriptionIdOf(message), entries))
          return
        }
        case 'fetch_agent_request': {
          const agentId = stringField(message, 'agentId')
          const agent = agentId === undefined ? null : await this.options.bridge.getAgent(agentId)
          const workspace = agent === null ? null : (await this.workspaceFor(agent.workspaceId)) ?? null
          reply(agentResponse(requestId, agent, workspace, agent === null ? 'agent not found' : null))
          return
        }
        case 'fetch_agent_timeline_request': {
          const agentId = stringField(message, 'agentId')
          const agent = agentId === undefined ? null : await this.options.bridge.getAgent(agentId)
          if (agent === null) {
            reply(rpcError(requestId, type, 'agent not found', 'agent_not_found'))
            return
          }
          const entries = await this.options.bridge.getTimeline(agent.id)
          reply(timelineResponse(requestId, agent, epochFor(agent.id), entries))
          return
        }
        case 'send_agent_message_request':
        case 'send_agent_message': {
          const agentId = stringField(message, 'agentId')
          const text = stringField(message, 'text') ?? ''
          if (agentId === undefined) {
            reply(rpcError(requestId, type, 'agentId is required', 'invalid_request'))
            return
          }
          const agent = await this.options.bridge.getAgent(agentId)
          if (agent === null) {
            reply(sendMessageRejected(requestId, agentId, 'agent not found'))
            return
          }
          await this.options.bridge.sendPrompt(agent.id, {
            text,
            ...(stringField(message, 'messageId') === undefined ? {} : { clientMessageId: stringField(message, 'messageId') }),
            ...(imagesOf(message) === undefined ? {} : { images: imagesOf(message) }),
          })
          const updated = (await this.options.bridge.getAgent(agent.id)) ?? agent
          reply(sendMessageResponse(requestId, updated))
          return
        }
        case 'cancel_agent_request': {
          const agentId = stringField(message, 'agentId')
          if (agentId === undefined) {
            reply(rpcError(requestId, type, 'agentId is required', 'invalid_request'))
            return
          }
          await this.options.bridge.cancelAgent(agentId)
          reply(cancelResponse(requestId, agentId, await this.options.bridge.getAgent(agentId)))
          return
        }
        case 'archive_agent_request': {
          const agentId = stringField(message, 'agentId')
          if (agentId === undefined) {
            reply(rpcError(requestId, type, 'agentId is required', 'invalid_request'))
            return
          }
          try {
            const archivedAt = await this.options.bridge.archiveAgent(agentId)
            reply({ type: 'agent_archived', payload: { agentId, archivedAt, requestId } })
          } catch (error) {
            reply(rpcError(requestId, type, error instanceof Error ? error.message : String(error), 'archive_failed'))
          }
          return
        }
        case 'close_items_request': {
          // Closing a tab synchronizes client state. There is no daemon-side
          // item to close, so every requested agent is already gone from this
          // client's view and nothing is reported as archived.
          reply({ type: 'close_items_response', payload: { requestId, agents: [], terminals: [] } })
          return
        }
        case 'workspace.create.request': {
          const source = recordValue(message.source)
          if (source === undefined || source.kind !== 'directory' || typeof source.path !== 'string') {
            reply(workspaceCreateResponse(requestId, null, null, 'only a directory workspace source is supported'))
            return
          }
          const workspace = await this.options.bridge.createWorkspace({
            directory: source.path,
            ...(typeof message.title === 'string' ? { name: message.title } : {}),
          })
          this.workspaceCache.set(workspace.id, workspace)
          reply(workspaceCreateResponse(requestId, workspace, null, null))
          return
        }
        case 'agent.create.request':
        case 'create_agent_request': {
          const legacy = type === 'create_agent_request'
          const config = recordValue(message.config)
          const provider = config === undefined ? undefined : stringField(config, 'provider')
          const model = config === undefined ? undefined : stringField(config, 'model')
          const workspaceId = stringField(message, 'workspaceId')
          const directory = config === undefined ? undefined : stringField(config, 'cwd')
          if (workspaceId === undefined && directory === undefined) {
            const failure = 'agent creation needs workspaceId or config.cwd'
            reply(legacy ? agentCreateFailedStatus(requestId, failure) : agentCreateResponse(requestId, null, failure))
            return
          }
          try {
            const agent = await this.options.bridge.createAgent({
              ...(workspaceId === undefined ? {} : { workspaceId }),
              ...(directory === undefined ? {} : { directory }),
              ...(provider === undefined ? {} : { provider }),
              ...(model === undefined ? {} : { model }),
              ...(config === undefined || typeof config.title !== 'string' ? {} : { title: config.title }),
              ...(typeof message.initialPrompt === 'string' ? { prompt: message.initialPrompt } : {}),
              ...(imagesOf(message) === undefined ? {} : { images: imagesOf(message) }),
            })
            reply(legacy ? agentCreatedStatus(requestId, agent) : agentCreateResponse(requestId, agent, null))
          } catch (error) {
            this.options.logger.warn(`paseo: agent creation failed: ${error instanceof Error ? error.message : String(error)}`)
            const failure = error instanceof Error ? error.message : String(error)
            if (!legacy) throw error
            reply(agentCreateFailedStatus(requestId, failure))
          }
          return
        }
        case 'get_providers_snapshot_request': {
          const providers = await this.options.bridge.listProviders()
          const entries = await Promise.all(providers.map(async (entry) => ({
            provider: entry.provider,
            available: entry.available,
            models: await this.options.bridge.listProviderModels(entry.provider),
          })))
          reply(providersSnapshotResponse(requestId, entries))
          return
        }
        case 'list_available_providers_request': {
          reply(availableProvidersResponse(requestId, await this.options.bridge.listProviders()))
          return
        }
        case 'list_provider_models_request': {
          const provider = stringField(message, 'provider')
          if (provider === undefined) {
            reply(rpcError(requestId, type, 'provider is required', 'invalid_request'))
            return
          }
          reply(providerModelsResponse(requestId, provider, await this.options.bridge.listProviderModels(provider)))
          return
        }
        case 'list_provider_modes_request': {
          const provider = stringField(message, 'provider')
          if (provider === undefined) {
            reply(rpcError(requestId, type, 'provider is required', 'invalid_request'))
            return
          }
          reply(providerModesResponse(requestId, provider))
          return
        }
        case 'list_provider_features_request': {
          const provider = stringField(message, 'provider')
          if (provider === undefined) {
            reply(rpcError(requestId, type, 'provider is required', 'invalid_request'))
            return
          }
          reply({
            type: 'list_provider_features_response',
            payload: { provider, features: [], fetchedAt: new Date().toISOString(), requestId },
          })
          return
        }
        case 'wait_for_finish_request': {
          const agentId = stringField(message, 'agentId')
          if (agentId === undefined) {
            reply(rpcError(requestId, type, 'agentId is required', 'invalid_request'))
            return
          }
          const agent = await this.options.bridge.getAgent(agentId)
          if (agent === null) {
            reply(waitForFinishResponse(requestId, 'error', null, null, 'agent not found'))
            return
          }
          if (isSettledStatus(agent.status)) {
            reply(waitForFinishResponse(requestId, 'idle', agent, null))
            return
          }
          const timeoutMs = typeof message.timeoutMs === 'number' && message.timeoutMs > 0 ? message.timeoutMs : DEFAULT_WAIT_TIMEOUT_MS
          this.waitForSettle(connection, requestId, agent, timeoutMs)
          return
        }
        case 'checkout_status_request': {
          const directory = stringField(message, 'cwd') ?? stringField(message, 'workspaceDirectory')
          if (directory === undefined) {
            reply(rpcError(requestId, type, 'cwd is required', 'invalid_request'))
            return
          }
          // Only directories this daemon advertised are read: the request would
          // otherwise be an arbitrary path probe into the operator's machine.
          const known = await this.knownDirectory(directory)
          if (known === null) {
            reply(rpcError(requestId, type, `unknown workspace directory: ${directory}`, 'workspace_not_found'))
            return
          }
          reply(checkoutStatusResponse(requestId, known, await this.options.bridge.checkoutStatus(known)))
          return
        }
        case 'daemon.get_status.request': {
          reply(daemonStatus({
            requestId,
            serverId: this.options.bridge.serverId,
            version: this.options.bridge.version,
            listen: this.options.listen ?? null,
            providers: await this.options.bridge.listProviders(),
          }))
          return
        }
        case 'daemon.get_pairing_offer.request': {
          const offer = this.options.pairingOffer()
          reply({
            type: 'daemon.get_pairing_offer.response',
            payload: { requestId, url: offer.url, qr: offer.qr, relayEnabled: offer.relayEnabled },
          })
          return
        }
        case 'list_terminals_request': {
          reply(noTerminals(requestId))
          return
        }
        case 'subscription.release.request': {
          reply(subscriptionReleased(requestId))
          return
        }
        case 'session.events.set_subscription.request': {
          reply(eventsSubscriptionSet(requestId))
          return
        }
        case 'clear_agent_attention': {
          reply(attentionCleared(requestId))
          return
        }
        case 'client_heartbeat':
        case 'subscribe_terminals_request':
        case 'unsubscribe_terminals_request':
        case 'workspace.mark_unread.request':
          return
        default:
          reply(rpcError(requestId, type, `unsupported request: ${type}`, 'unsupported'))
      }
    } catch (error) {
      this.options.logger.warn(`paseo: ${type} failed: ${error instanceof Error ? error.message : String(error)}`)
      reply(rpcError(requestId, type, error instanceof Error ? error.message : String(error), 'internal_error'))
    }
  }

  private readonly workspaceCache = new Map<string, WorkspaceRecord>()

  /** Pending `wait_for_finish_request` waiters, keyed by agent id. */
  private readonly waiters = new Map<string, Set<{ connection: Connection; requestId: string; timer: ReturnType<typeof setTimeout> }>>()

  /** Resolve when an agent settles, or after the client's timeout. */
  private waitForSettle(connection: Connection, requestId: string, agent: AgentRecord, timeoutMs: number): void {
    const waiter = {
      connection,
      requestId,
      timer: setTimeout(() => {
        this.dropWaiter(agent.id, requestId)
        if (connection.closed) return
        connection.socket.send(envelope(waitForFinishResponse(requestId, 'timeout', null, null)))
      }, timeoutMs),
    }
    const set = this.waiters.get(agent.id) ?? new Set()
    set.add(waiter)
    this.waiters.set(agent.id, set)
  }

  private dropWaiter(agentId: string, requestId: string): void {
    const set = this.waiters.get(agentId)
    if (set === undefined) return
    for (const waiter of set) {
      if (waiter.requestId !== requestId) continue
      clearTimeout(waiter.timer)
      set.delete(waiter)
    }
    if (set.size === 0) this.waiters.delete(agentId)
  }

  /** Settle every waiter watching an agent that just finished. */
  private settleWaiters(agent: AgentRecord): void {
    const set = this.waiters.get(agent.id)
    if (set === undefined || !isSettledStatus(agent.status)) return
    this.waiters.delete(agent.id)
    for (const waiter of set) {
      clearTimeout(waiter.timer)
      if (waiter.connection.closed) continue
      const status = agent.status === 'error' ? 'error' : 'idle'
      waiter.connection.socket.send(envelope(waitForFinishResponse(waiter.requestId, status, agent, null)))
    }
  }

  private cacheWorkspaces(workspaces: readonly WorkspaceRecord[]): void {
    for (const workspace of workspaces) this.workspaceCache.set(workspace.id, workspace)
  }

  private async workspaceFor(workspaceId: string): Promise<WorkspaceRecord | undefined> {
    const cached = this.workspaceCache.get(workspaceId)
    if (cached !== undefined) return cached
    this.cacheWorkspaces(await this.options.bridge.listWorkspaces())
    return this.workspaceCache.get(workspaceId)
  }

  /**
   * Resolve a requested directory to one this daemon advertised.
   * @param directory - directory the client asked about.
   * @returns the canonical known directory, or null when nothing matches.
   */
  private async knownDirectory(directory: string): Promise<string | null> {
    const cached = [...this.workspaceCache.values()].find((workspace) => workspace.directory === directory)
    if (cached !== undefined) return cached.directory
    this.cacheWorkspaces(await this.options.bridge.listWorkspaces())
    const found = [...this.workspaceCache.values()].find((workspace) => workspace.directory === directory)
    return found?.directory ?? null
  }

  /** Push one bridge event to every admitted client. */
  private onBridgeEvent(event: BridgeEvent): void {
    if (event.kind === 'agent_upsert' || event.kind === 'agent_remove') {
      void this.publishAgentEvent(event)
      return
    }
    if (event.kind === 'workspace_upsert') {
      this.workspaceCache.set(event.workspace.id, event.workspace)
      this.broadcast(workspaceUpdate(event.workspace))
      return
    }
    void this.publishTimeline(event.agentId, event.entry)
  }

  private async publishAgentEvent(event: Extract<BridgeEvent, { kind: 'agent_upsert' | 'agent_remove' }>): Promise<void> {
    if (event.kind === 'agent_remove') {
      this.broadcast(agentRemoved(event.agentId))
      return
    }
    const workspace = (await this.workspaceFor(event.agent.workspaceId)) ?? null
    this.broadcast(agentUpdate(event.agent, workspace))
    this.broadcast(agentStatus(event.agent))
    this.settleWaiters(event.agent)
  }

  private async publishTimeline(agentId: string, entry: Extract<BridgeEvent, { kind: 'timeline' }>['entry']): Promise<void> {
    const agent = await this.options.bridge.getAgent(agentId)
    if (agent === null) return
    this.broadcast(agentStream(agent, entry, epochFor(agent.id)))
  }

  private broadcast(message: Record<string, unknown>): void {
    const text = envelope(message)
    for (const connection of this.connections) {
      if (!connection.ready || connection.closed) continue
      connection.socket.send(text)
    }
  }
}

/** Stable per-agent epoch the client uses to reject cross-epoch cursors. */
export function epochFor(agentId: string): string {
  return `epoch/${agentId}`
}

function subscriptionIdOf(message: Record<string, unknown>): string | null {
  const subscribe = message.subscribe
  if (subscribe !== null && typeof subscribe === 'object') {
    const id = (subscribe as Record<string, unknown>).subscriptionId
    if (typeof id === 'string') return id
  }
  return null
}

function stringField(message: Record<string, unknown>, key: string): string | undefined {
  const value = message[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Handle for one admitted transport socket. */
export interface PaseoConnection {
  /** Feed one inbound text frame. */
  receive(text: string): void
  /** Drop the connection without touching the socket. */
  dispose(): void
}

/** Narrow a value to an agent record, for embedders. */
export function isAgentRecord(value: unknown): value is AgentRecord {
  return value !== null && typeof value === 'object' && typeof (value as AgentRecord).id === 'string'
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

/** Images a client attached to one request, or undefined when it attached none. */
function imagesOf(message: Record<string, unknown>): readonly { readonly data: string; readonly mimeType: string }[] | undefined {
  const raw = message.images
  if (!Array.isArray(raw)) return undefined
  const images = raw.flatMap((entry) => {
    if (entry === null || typeof entry !== 'object') return []
    const record = entry as Record<string, unknown>
    const data = record.data
    const mimeType = record.mimeType
    return typeof data === 'string' && typeof mimeType === 'string' ? [{ data, mimeType }] : []
  })
  return images.length === 0 ? undefined : images
}
