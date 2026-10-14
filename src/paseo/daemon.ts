/**
 * Paseo daemon: one WebSocket session per connected Paseo client, plus the
 * fan-out of live agent, workspace, and timeline events from the bridge.
 *
 * @module dsh-paseo-server/paseo/daemon
 */

import type { AgentRecord, BridgeEvent, PaseoBridge, TerminalEvent, TerminalRecord, WorkspaceRecord } from '../bridge.ts'
import type { DiffCompare, DiffFile, GitOperationResult } from '../dsh/git.ts'
import type { PaseoCadence } from '../dsh/schedules.ts'
import {
  FILE_OPCODE,
  decodeFileTransferFrame,
  isTransferOpcode,
} from './file-transfer.ts'
import { createDownloadGrant, discardUpload, finishUpload, appendUpload, mediaTypeOf, startUpload } from '../dsh/files.ts'
import { listPrompts, queryDirectory, searchTimeline } from './directory.ts'
import type { LabelDefinition } from '../dsh/labels.ts'
import type { DirectoryFilter, DirectoryPage, DirectorySort } from './directory.ts'
import { resolve } from 'node:path'
import type { DownloadGrant, UploadTarget } from '../dsh/files.ts'
import {
  TERMINAL_MAX_SLOT,
  TERMINAL_OPCODE,
  decodeResizePayload,
  decodeTerminalFrame,
  encodeOutputFrame,
} from './terminal-frames.ts'
import type { WireSocket } from './transport.ts'
import {
  agentRemoved,
  agentCreateFailedStatus,
  agentDeleted,
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
  checkoutDiffGetResponse,
  checkoutDiffUpdate,
  attentionClearedFor,
  directorySuggestions,
  agentActionResponse,
  forkContextResponse,
  uploadResponse,
  subagentList,
  projectAdded,
  projectConfigMissing,
  projectConfigRead,
  projectConfigWriteFailed,
  projectConfigWritten,
  projectRemoved,
  availableEditors,
  workspaceArchived,
  workspaceMarkedUnread,
  workspacePinned,
  workspaceTitleSet,
  branchSuggestions,
  directoryListing,
  fileContents,
  openedInEditor,
  branchValidated,
  checkDetailsResponse,
  commitDiff,
  commitList,
  stashEntries,
  checkoutPrStatusResponse,
  agentHistory,
  emptyUsage,
  labelAffected,
  projectIconForDirectory,
  projectIconGot,
  projectIconSet,
  projectRenamed,
  projectUpdated,
  labelAssigned,
  labelCatalog,
  labelUpdated,
  labelUpdateEvent,
  commandList,
  subagentTimeline,
  workspaceSetupStarted,
  workspaceSetupStatus,
  forgeSearch,
  providersSnapshotRefreshed,
  repositorySearch,
  daemonConfigResponse,
  diagnosticsResponse,
  projectCloned,
  projectDirectoryCreated,
  worktreeArchived,
  worktreeCreated,
  worktreeList,
  agentUpdateResponse,
  downloadGrantResponse,
  fileSubscribed,
  fileUnsubscribed,
  fileUpdated,
  timelinePrompts,
  timelineSearchResult,
  entryResponse,
  fileWriteResponse,
  pullRequestCreated,
  pullRequestTimelineResponse,
  pullRequestWriteResponse,
  checkoutStatusResponse,
  subscribeCheckoutDiffResponse,
  daemonStatus,
  eventsSubscriptionSet,
  envelope,
  terminalCreated,
  terminalKilled,
  terminalRenamed,
  terminalSubscribeFailed,
  terminalSubscribed,
  terminalsChanged,
  scheduleCreated,
  scheduleDeleted,
  scheduleList,
  schedulePaused,
  scheduleRanOnce,
  scheduleResumed,
  scriptStatusUpdate,
  terminalsResponse,
  workspaceScriptResponse,
  parseInbound,
  REFUSED_REQUESTS,
  refusalResponse,
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
  PASEO_PROTOCOL_VERSION,
} from './wire.ts'

/** Default `wait_for_finish_request` deadline when the client names none. */
const DEFAULT_WAIT_TIMEOUT_MS = 600_000

/** How often a subscribed diff is re-read, in milliseconds. */
const DIFF_POLL_INTERVAL_MS = 4_000

/** How often a watched file is re-read, in milliseconds. */
const FILE_POLL_INTERVAL_MS = 2_000

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
  /** Live checkout-diff subscriptions, keyed by subscription id. */
  readonly diffWatches: Map<string, ReturnType<typeof setInterval>>
  /** Terminal subscriptions by slot, which is how a binary frame names its stream. */
  readonly slots: Map<number, { readonly terminalId: string; readonly subscriptionId?: string }>
  /** Active terminal streams by terminal id. */
  readonly terminalStreams: Map<string, () => void>
  /** Uploads this connection began, keyed by the request id its frames carry. */
  readonly uploads: Map<string, UploadTarget>
  /** Live file watches, keyed by subscription id. */
  readonly fileWatches: Map<string, ReturnType<typeof setInterval>>
  /** Applied in arrival order, so a chunk never overtakes its begin frame. */
  transferQueue: Promise<void>
  /** Base a workspace script's local proxy URL is built from, when the client sent a Host. */
  readonly proxyBase?: string
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
   * Redeem one download token.
   *
   * The token is single use, so a second request for the same one is refused
   * even while the first is still streaming.
   * @param token - token from the download URL.
   * @returns the grant, or null when it is unknown or expired.
   */
  takeDownload(token: string): DownloadGrant | null {
    const grant = this.downloads.get(token)
    if (grant === undefined) return null
    this.downloads.delete(token)
    return grant.expiresAt < Date.now() ? null : grant
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
  attach(socket: WireSocket, host?: string): PaseoConnection {
    const connection: Connection = {
      socket,
      ready: false,
      closed: false,
      proxyBase: host === undefined ? undefined : `http://${host}`,
      diffWatches: new Map(),
      slots: new Map(),
      terminalStreams: new Map(),
      uploads: new Map(),
      fileWatches: new Map(),
      transferQueue: Promise.resolve(),
    }
    this.connections.add(connection)
    return {
      receive: (text: string) => { this.onFrame(connection, text) },
      receiveBinary: (bytes: Uint8Array) => { void this.onBinaryFrame(connection, bytes) },
      dispose: () => {
        connection.closed = true
        for (const subscriptionId of [...connection.diffWatches.keys()]) this.stopDiffWatch(connection, subscriptionId)
        for (const terminalId of [...connection.terminalStreams.keys()]) this.stopTerminalStream(connection, terminalId)
        for (const subscriptionId of [...connection.fileWatches.keys()]) this.stopFileWatch(connection, subscriptionId)
        this.connections.delete(connection)
      },
    }
  }

  /**
   * Route one inbound binary frame.
   *
   * Terminals and uploads share this channel, so the opcode decides which
   * handler sees the frame.
   */
  private async onBinaryFrame(connection: Connection, bytes: Uint8Array): Promise<void> {
    if (this.closed || connection.closed) return
    if (isTransferOpcode(bytes[0] ?? -1)) {
      // One upload's frames must be applied in the order they arrived, and
      // each handler awaits file work, so they are chained rather than raced.
      connection.transferQueue = connection.transferQueue
        .then(() => this.onTransferFrame(connection, bytes))
        .catch(() => undefined)
      return
    }
    const frame = decodeTerminalFrame(bytes)
    if (frame === null) return
    const terminalId = connection.slots.get(frame.slot)?.terminalId
    if (terminalId === undefined) return
    try {
      if (frame.opcode === TERMINAL_OPCODE.INPUT) {
        await this.options.bridge.writeTerminal(terminalId, new TextDecoder().decode(frame.payload))
        return
      }
      if (frame.opcode === TERMINAL_OPCODE.RESIZE) {
        const size = decodeResizePayload(frame.payload)
        if (size !== null) await this.options.bridge.resizeTerminal(terminalId, size.cols, size.rows)
      }
    } catch (error) {
      this.options.logger.warn(`paseo: terminal ${terminalId} input failed: ${String(error)}`)
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
        case 'checkout_pr_status_request': {
          const directory = stringField(message, 'cwd')
          if (directory === undefined) {
            reply(rpcError(requestId, type, 'cwd is required', 'invalid_request'))
            return
          }
          const known = await this.knownDirectory(directory)
          if (known === null) {
            reply(rpcError(requestId, type, `unknown workspace directory: ${directory}`, 'workspace_not_found'))
            return
          }
          try {
            reply(checkoutPrStatusResponse(requestId, known, await this.options.bridge.checkoutPrStatus(known)))
          } catch (error) {
            reply(checkoutPrStatusResponse(requestId, known, {
              status: null,
              authenticated: false,
              error: error instanceof Error ? error.message : String(error),
            }))
          }
          return
        }
        case 'checkout_pr_create_request':
        case 'checkout_pr_merge_request':
        case 'checkout.forge.set_auto_merge.request':
        case 'checkout.github.set_auto_merge.request':
        case 'pull_request_timeline_request':
        case 'checkout.forge.get_check_details.request':
        case 'checkout.github.get_check_details.request': {
          const directory = stringField(message, 'cwd')
          if (directory === undefined) {
            reply(rpcError(requestId, type, 'cwd is required', 'invalid_request'))
            return
          }
          const known = await this.knownDirectory(directory)
          if (known === null) {
            reply(rpcError(requestId, type, `unknown workspace directory: ${directory}`, 'workspace_not_found'))
            return
          }
          if (type === 'pull_request_timeline_request') {
            const timeline = await this.options.bridge.pullRequestTimeline(known)
            reply(pullRequestTimelineResponse(requestId, known, timeline.number, timeline.items, timeline.error))
            return
          }
          if (type === 'checkout.forge.get_check_details.request' || type === 'checkout.github.get_check_details.request') {
            const checkRunId = message.checkRunId
            if (typeof checkRunId !== 'number') {
              reply(rpcError(requestId, type, 'checkRunId is required', 'invalid_request'))
              return
            }
            const details = await this.options.bridge.checkDetails(known, checkRunId)
            reply(checkDetailsResponse(
              type === 'checkout.github.get_check_details.request'
                ? 'checkout.github.get_check_details.response'
                : 'checkout.forge.get_check_details.response',
              requestId,
              known,
              details.details,
              details.error,
            ))
            return
          }
          if (type === 'checkout_pr_create_request') {
            const result = await this.options.bridge.createPullRequest(known, {
              ...(stringField(message, 'title') === undefined ? {} : { title: stringField(message, 'title') }),
              ...(stringField(message, 'body') === undefined ? {} : { body: stringField(message, 'body') }),
              ...(stringField(message, 'baseRef') === undefined ? {} : { baseRef: stringField(message, 'baseRef') }),
            })
            reply(pullRequestCreated(requestId, known, result))
            return
          }
          const method = mergeMethodOf(message.mergeMethod)
          if (type === 'checkout_pr_merge_request') {
            reply(pullRequestWriteResponse(
              'checkout_pr_merge_response',
              requestId,
              known,
              await this.options.bridge.mergePullRequest(known, method),
            ))
            return
          }
          const enabled = message.enabled === true
          const result = await this.options.bridge.setPullRequestAutoMerge(known, enabled, method)
          reply(pullRequestWriteResponse(
            type === 'checkout.github.set_auto_merge.request'
              ? 'checkout.github.set_auto_merge.response'
              : 'checkout.forge.set_auto_merge.response',
            requestId,
            known,
            result,
            enabled,
          ))
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
        case 'checkout.diff.get.request':
        case 'subscribe_checkout_diff_request': {
          const directory = stringField(message, 'cwd')
          if (directory === undefined) {
            reply(rpcError(requestId, type, 'cwd is required', 'invalid_request'))
            return
          }
          const known = await this.knownDirectory(directory)
          if (known === null) {
            reply(rpcError(requestId, type, `unknown workspace directory: ${directory}`, 'workspace_not_found'))
            return
          }
          const compare = compareOf(message)
          const files = await this.options.bridge.checkoutDiff(known, compare)
          if (type === 'checkout.diff.get.request') {
            reply(checkoutDiffGetResponse(requestId, known, files))
            return
          }
          const subscriptionId = stringField(message, 'subscriptionId') ?? `diff_${requestId}`
          reply(subscribeCheckoutDiffResponse(requestId, subscriptionId, known, files))
          this.watchDiff(connection, subscriptionId, known, compare, files)
          return
        }
        case 'unsubscribe_checkout_diff_request': {
          const subscriptionId = stringField(message, 'subscriptionId')
          if (subscriptionId !== undefined) this.stopDiffWatch(connection, subscriptionId)
          return
        }
        case 'branch_suggestions_request': {
          const directory = stringField(message, 'cwd')
          if (directory === undefined) {
            reply(rpcError(requestId, type, 'cwd is required', 'invalid_request'))
            return
          }
          const known = await this.knownDirectory(directory)
          if (known === null) {
            reply(rpcError(requestId, type, `unknown workspace directory: ${directory}`, 'workspace_not_found'))
            return
          }
          const limit = typeof message.limit === 'number' ? message.limit : 100
          reply(branchSuggestions(requestId, await this.options.bridge.listBranches(known, stringField(message, 'query'), limit)))
          return
        }
        case 'validate_branch_request': {
          const directory = stringField(message, 'cwd')
          const branchName = stringField(message, 'branchName')
          if (directory === undefined || branchName === undefined) {
            reply(rpcError(requestId, type, 'cwd and branchName are required', 'invalid_request'))
            return
          }
          const known = await this.knownDirectory(directory)
          if (known === null) {
            reply(rpcError(requestId, type, `unknown workspace directory: ${directory}`, 'workspace_not_found'))
            return
          }
          reply(branchValidated(requestId, await this.options.bridge.resolveBranch(known, branchName)))
          return
        }
        case 'checkout_switch_branch_request':
        case 'checkout.rename_branch.request':
        case 'checkout.discard_changes.request':
        case 'stash_save_request':
        case 'stash_pop_request':
        case 'stash_list_request':
        case 'checkout_merge_request':
        case 'checkout_merge_from_base_request':
        case 'checkout.commits.list.request':
        case 'checkout.commits.file_diff.request': {
          const directory = stringField(message, 'cwd')
          if (directory === undefined) {
            reply(rpcError(requestId, type, 'cwd is required', 'invalid_request'))
            return
          }
          const known = await this.knownDirectory(directory)
          if (known === null) {
            reply(rpcError(requestId, type, `unknown workspace directory: ${directory}`, 'workspace_not_found'))
            return
          }
          const bridge = this.options.bridge
          switch (type) {
            case 'checkout_switch_branch_request':
              reply(checkoutOperationResponse(type, requestId, known, await bridge.switchBranch(known, stringField(message, 'branch') ?? '')))
              return
            case 'checkout.rename_branch.request':
              reply(checkoutOperationResponse(type, requestId, known, await bridge.renameBranch(known, stringField(message, 'branch') ?? '')))
              return
            case 'checkout.discard_changes.request': {
              const paths = Array.isArray(message.paths) ? message.paths.filter((path): path is string => typeof path === 'string') : []
              reply(checkoutOperationResponse(type, requestId, known, await bridge.discardChanges(known, paths)))
              return
            }
            case 'stash_save_request':
              reply(checkoutOperationResponse(type, requestId, known, await bridge.stashSave(known, stringField(message, 'branch'))))
              return
            case 'stash_pop_request':
              reply(checkoutOperationResponse(type, requestId, known, await bridge.stashPop(known)))
              return
            case 'stash_list_request':
              reply(stashEntries(requestId, known, await bridge.stashList(known, message.paseoOnly !== false)))
              return
            case 'checkout_merge_request':
              reply(checkoutOperationResponse(
                type,
                requestId,
                known,
                await bridge.mergeRef(known, stringField(message, 'baseRef') ?? 'main', message.strategy === 'squash' ? 'squash' : 'merge'),
              ))
              return
            case 'checkout_merge_from_base_request':
              reply(checkoutOperationResponse(
                type,
                requestId,
                known,
                await bridge.mergeRef(known, stringField(message, 'baseRef') ?? 'main', 'merge'),
              ))
              return
            case 'checkout.commits.list.request':
              reply(commitList(requestId, known, await bridge.listCommits(known)))
              return
            default: {
              const sha = stringField(message, 'sha')
              const path = stringField(message, 'path')
              if (sha === undefined || path === undefined) {
                reply(rpcError(requestId, type, 'sha and path are required', 'invalid_request'))
                return
              }
              reply(commitDiff(requestId, known, sha, path, await bridge.commitFileDiff(known, sha, path)))
              return
            }
          }
        }
        case 'checkout_commit_request':
        case 'checkout_push_request':
        case 'checkout_pull_request':
        case 'checkout.refresh.request': {
          const directory = stringField(message, 'cwd')
          if (directory === undefined) {
            reply(rpcError(requestId, type, 'cwd is required', 'invalid_request'))
            return
          }
          const known = await this.knownDirectory(directory)
          if (known === null) {
            reply(rpcError(requestId, type, `unknown workspace directory: ${directory}`, 'workspace_not_found'))
            return
          }
          reply(await this.runCheckoutOperation(type, requestId, known, message))
          return
        }
        case 'delete_agent_request': {
          const agentId = stringField(message, 'agentId')
          if (agentId === undefined) {
            reply(rpcError(requestId, type, 'agentId is required', 'invalid_request'))
            return
          }
          // DSH has no session delete, so delete and archive land in the same
          // place: the agent leaves every list and stops running.
          try {
            await this.options.bridge.archiveAgent(agentId)
          } catch (error) {
            this.options.logger.warn(`paseo: deleting agent ${agentId} failed: ${String(error)}`)
          }
          reply(agentDeleted(agentId))
          return
        }
        case 'workspace.script.list.request':
        case 'workspace.script.start.request':
        case 'start_workspace_script_request':
        case 'workspace.script.stop.request': {
          const workspaceId = stringField(message, 'workspaceId')
          if (workspaceId === undefined) {
            reply(rpcError(requestId, type, 'workspaceId is required', 'invalid_request'))
            return
          }
          const responseType = (type === 'start_workspace_script_request'
            ? 'workspace.script.start.response'
            : type.replace('.request', '.response')) as
            | 'workspace.script.list.response'
            | 'workspace.script.start.response'
            | 'workspace.script.stop.response'
          const scriptName = stringField(message, 'scriptName')
          try {
            if ((type === 'workspace.script.start.request' || type === 'start_workspace_script_request') && scriptName !== undefined) {
              await this.options.bridge.startWorkspaceScript(workspaceId, scriptName)
            }
            if (type === 'workspace.script.stop.request' && scriptName !== undefined) {
              await this.options.bridge.stopWorkspaceScript(workspaceId, scriptName)
            }
            const scripts = await this.options.bridge.listWorkspaceScripts(workspaceId)
            reply(workspaceScriptResponse(responseType, requestId, workspaceId, scripts, null, scriptName, connection.proxyBase))
            for (const peer of this.connections) {
              peer.socket.send(envelope(scriptStatusUpdate(workspaceId, scripts, peer.proxyBase)))
            }
          } catch (error) {
            reply(workspaceScriptResponse(
              responseType,
              requestId,
              workspaceId,
              [],
              error instanceof Error ? error.message : String(error),
              scriptName,
            ))
          }
          return
        }
        case 'schedule/list': {
          reply(scheduleList(requestId, await this.options.bridge.listSchedules()))
          return
        }
        case 'schedule/create': {
          const prompt = stringField(message, 'prompt')
          const target = recordValue(message.target)
          const agentId = target === undefined ? undefined : stringField(target, 'agentId')
          if (prompt === undefined || agentId === undefined) {
            reply(scheduleCreated(requestId, null, 'a reminder needs a prompt and an agent target'))
            return
          }
          const cadence = paseoCadence(message.cadence)
          if (cadence === null) {
            reply(scheduleCreated(requestId, null, 'the request carries no cadence this daemon understands'))
            return
          }
          try {
            const created = await this.options.bridge.createSchedule({
              agentId,
              prompt,
              ...(stringField(message, 'name') === undefined ? {} : { name: stringField(message, 'name') }),
              cadence,
            })
            reply(scheduleCreated(requestId, created, null))
          } catch (error) {
            reply(scheduleCreated(requestId, null, error instanceof Error ? error.message : String(error)))
          }
          return
        }
        case 'schedule/delete': {
          const scheduleId = stringField(message, 'scheduleId')
          if (scheduleId === undefined) {
            reply(scheduleDeleted(requestId, '', 'scheduleId is required'))
            return
          }
          const removed = await this.options.bridge.deleteSchedule(scheduleId)
          reply(scheduleDeleted(requestId, scheduleId, removed ? null : 'the reminder is gone already'))
          return
        }
        case 'schedule/run-once': {
          const scheduleId = stringField(message, 'scheduleId')
          if (scheduleId === undefined) {
            reply(scheduleRanOnce(requestId, '', 'scheduleId is required'))
            return
          }
          try {
            await this.options.bridge.runScheduleNow(scheduleId)
            reply(scheduleRanOnce(requestId, scheduleId))
          } catch (error) {
            reply(scheduleRanOnce(requestId, scheduleId, error instanceof Error ? error.message : String(error)))
          }
          return
        }
        case 'schedule/inspect': {
          const scheduleId = stringField(message, 'scheduleId')
          const found = (await this.options.bridge.listSchedules()).find((entry) => entry.id === scheduleId)
          if (found === undefined) {
            reply({ type: 'schedule/inspect/response', payload: { requestId, schedule: null, error: 'unknown reminder' } })
            return
          }
          reply({ type: 'schedule/inspect/response', payload: { requestId, schedule: found, error: null } })
          return
        }
        case 'schedule/pause': {
          const scheduleId = stringField(message, 'scheduleId')
          if (scheduleId === undefined) {
            reply(schedulePaused(requestId, '', 'scheduleId is required'))
            return
          }
          const paused = await this.options.bridge.pauseSchedule(scheduleId)
          reply(schedulePaused(requestId, scheduleId, paused ? null : 'unknown reminder'))
          return
        }
        case 'schedule/resume': {
          const scheduleId = stringField(message, 'scheduleId')
          if (scheduleId === undefined) {
            reply(scheduleResumed(requestId, '', null, 'scheduleId is required'))
            return
          }
          try {
            reply(scheduleResumed(requestId, scheduleId, await this.options.bridge.resumeSchedule(scheduleId), null))
          } catch (error) {
            reply(scheduleResumed(requestId, scheduleId, null, error instanceof Error ? error.message : String(error)))
          }
          return
        }
        case 'schedule/update': {
          reply(rpcError(requestId, type, 'this daemon cannot retime a reminder in place', 'unsupported'))
          return
        }
        case 'schedule/logs': {
          const scheduleId = stringField(message, 'scheduleId')
          if (scheduleId === undefined) {
            reply(rpcError(requestId, type, 'scheduleId is required', 'invalid_request'))
            return
          }
          reply({ type: 'schedule/logs/response', payload: { requestId, scheduleId, runs: [], error: null } })
          return
        }
        case 'fs.file.write.request':
        case 'fs.entry.create.request':
        case 'fs.entry.rename.request':
        case 'fs.entry.duplicate.request':
        case 'fs.entry.delete.request': {
          const directory = stringField(message, 'cwd')
          if (directory === undefined) {
            reply(rpcError(requestId, type, 'cwd is required', 'invalid_request'))
            return
          }
          const known = await this.knownDirectory(directory)
          if (known === null) {
            reply(rpcError(requestId, type, `unknown workspace directory: ${directory}`, 'workspace_not_found'))
            return
          }
          const bridge = this.options.bridge
          if (type === 'fs.file.write.request') {
            const path = stringField(message, 'path') ?? ''
            const content = typeof message.content === 'string' ? message.content : ''
            const expected = stringField(message, 'expectedModifiedAt') ?? new Date(0).toISOString()
            reply(fileWriteResponse(requestId, await bridge.writeWorkspaceFile(known, path, content, expected)))
            return
          }
          if (type === 'fs.entry.create.request') {
            const parentPath = stringField(message, 'parentPath') ?? ''
            const name = stringField(message, 'name') ?? ''
            const kind = message.kind === 'directory' ? 'directory' : 'file'
            reply(entryResponse('fs.entry.create.response', requestId, known, parentPath, await bridge.createEntry(known, parentPath, name, kind)))
            return
          }
          const path = stringField(message, 'path') ?? ''
          if (type === 'fs.entry.rename.request') {
            const name = stringField(message, 'name') ?? ''
            reply(entryResponse('fs.entry.rename.response', requestId, known, path, await bridge.renameEntry(known, path, name)))
            return
          }
          if (type === 'fs.entry.duplicate.request') {
            reply(entryResponse('fs.entry.duplicate.response', requestId, known, path, await bridge.duplicateEntry(known, path)))
            return
          }
          reply(entryResponse('fs.entry.delete.response', requestId, known, path, await bridge.deleteEntry(known, path)))
          return
        }
        case 'file_download_token_request': {
          const directory = stringField(message, 'cwd')
          const path = stringField(message, 'path')
          if (directory === undefined || path === undefined) {
            reply(downloadGrantResponse(requestId, directory ?? '', path ?? '', null, 'cwd and path are required'))
            return
          }
          const known = await this.knownDirectory(directory)
          if (known === null) {
            reply(downloadGrantResponse(requestId, directory, path, null, 'unknown workspace directory'))
            return
          }
          const info = await this.options.bridge.statEntry(known, path)
          if (info === null) {
            reply(downloadGrantResponse(requestId, directory, path, null, 'the file is unreadable'))
            return
          }
          const fileName = path.split('/').pop() ?? 'download'
          const grant = createDownloadGrant(resolve(known, path), fileName, mediaTypeOf(fileName))
          this.downloads.set(grant.token, grant)
          reply(downloadGrantResponse(requestId, directory, path, { ...grant, size: info.size }, null))
          return
        }
        case 'file.upload.request': {
          const fileName = stringField(message, 'fileName')
          const mimeType = stringField(message, 'mimeType')
          if (fileName === undefined || mimeType === undefined) {
            connection.socket.send(envelope(uploadResponse(requestId, null, 'fileName and mimeType are required')))
            return
          }
          const target = await this.options.bridge.beginUpload({
            fileName,
            mimeType,
            size: typeof message.size === 'number' ? message.size : 0,
          })
          // The response follows the last chunk, so the upload is registered
          // against the request id the frames will carry.
          connection.uploads.set(requestId, target)
          return
        }
        case 'paseo_worktree_list_request': {
          const directory = stringField(message, 'repoRoot') ?? stringField(message, 'cwd')
          if (directory === undefined) {
            reply(rpcError(requestId, type, 'repoRoot is required', 'invalid_request'))
            return
          }
          const known = await this.knownDirectory(directory)
          if (known === null) {
            reply(rpcError(requestId, type, `unknown workspace directory: ${directory}`, 'workspace_not_found'))
            return
          }
          reply(worktreeList(requestId, await this.options.bridge.listWorktrees(known)))
          return
        }
        case 'create_paseo_worktree_request': {
          const directory = stringField(message, 'cwd')
          if (directory === undefined) {
            reply(worktreeCreated(requestId, null, 'cwd is required'))
            return
          }
          const known = await this.knownDirectory(directory)
          if (known === null) {
            reply(worktreeCreated(requestId, null, `unknown workspace directory: ${directory}`))
            return
          }
          const branch = stringField(message, 'refName')
            ?? stringField(message, 'worktreeSlug')
            ?? `worktree-${String(Date.now())}`
          try {
            const created = await this.options.bridge.createWorktree(known, { branch })
            reply('error' in created
              ? worktreeCreated(requestId, null, created.error)
              : worktreeCreated(requestId, created.workspace, null))
          } catch (error) {
            reply(worktreeCreated(requestId, null, error instanceof Error ? error.message : String(error)))
          }
          return
        }
        case 'paseo_worktree_archive_request': {
          const target = stringField(message, 'worktreePath')
          const repoRoot = stringField(message, 'repoRoot')
          if (target === undefined || repoRoot === undefined) {
            reply(worktreeArchived(requestId, false, 'worktreePath and repoRoot are required'))
            return
          }
          const known = await this.knownDirectory(repoRoot)
          if (known === null) {
            reply(worktreeArchived(requestId, false, `unknown workspace directory: ${repoRoot}`))
            return
          }
          const removed = await this.options.bridge.removeWorktree(known, target)
          reply(worktreeArchived(requestId, removed.success, removed.error?.message ?? null))
          return
        }
        case 'workspace.github.search_repositories.request': {
          const query = stringField(message, 'query')
          if (query === undefined) {
            reply(rpcError(requestId, type, 'query is required', 'invalid_request'))
            return
          }
          const limit = typeof message.limit === 'number' ? message.limit : 20
          const found = await this.options.bridge.searchRepositories(query, limit)
          reply(repositorySearch(requestId, found.repositories, found.error, found.authenticated))
          return
        }
        case 'forge.search.request':
        case 'github_search_request': {
          const query = stringField(message, 'query')
          if (query === undefined) {
            reply(rpcError(requestId, type, 'query is required', 'invalid_request'))
            return
          }
          const limit = typeof message.limit === 'number' ? message.limit : 20
          const found = await this.options.bridge.searchForge(query, limit)
          reply(forgeSearch(
            type === 'github_search_request' ? 'github_search_response' : 'forge.search.response',
            requestId,
            found.items,
            found.error,
            found.authenticated,
          ))
          return
        }
        case 'refresh_providers_snapshot_request': {
          reply(providersSnapshotRefreshed(requestId, true))
          return
        }
        case 'resume_agent_request': {
          const handle = recordValue(message.handle)
          const sessionId = handle === undefined ? undefined : stringField(handle, 'sessionId')
          if (sessionId === undefined) {
            reply(agentResponse(requestId, null, null, 'a resume handle needs a session id'))
            return
          }
          const resumed = await this.options.bridge.resumeAgent(sessionId)
          const workspace = resumed === null ? null : await this.workspaceFor(resumed.workspaceId) ?? null
          reply(agentResponse(requestId, resumed, workspace, resumed === null ? 'no such session' : null))
          return
        }
        case 'agent.provider_subagents.timeline.get.request': {
          const parentAgentId = stringField(message, 'parentAgentId')
          const subagentId = stringField(message, 'subagentId')
          if (parentAgentId === undefined || subagentId === undefined) {
            reply(rpcError(requestId, type, 'parentAgentId and subagentId are required', 'invalid_request'))
            return
          }
          const agent = await this.options.bridge.getAgent(subagentId)
          if (agent === null) {
            reply(subagentTimeline(requestId, parentAgentId, subagentId, 'stub', [], 'subagent not found'))
            return
          }
          reply(subagentTimeline(requestId, parentAgentId, subagentId, agent.provider, await this.options.bridge.getTimeline(subagentId), null))
          return
        }
        case 'set_agent_thinking_request': {
          const agentId = stringField(message, 'agentId')
          if (agentId === undefined) {
            reply(agentActionResponse('set_agent_thinking_response', requestId, '', false, 'agentId is required'))
            return
          }
          try {
            await this.options.bridge.selectAgentThinking(agentId, stringField(message, 'thinkingOptionId') ?? null)
            reply(agentActionResponse('set_agent_thinking_response', requestId, agentId, true, null))
          } catch (error) {
            reply(agentActionResponse('set_agent_thinking_response', requestId, agentId, false, error instanceof Error ? error.message : String(error)))
          }
          return
        }
        case 'set_agent_mode_request': {
          const agentId = stringField(message, 'agentId') ?? ''
          // A DSH session has no mode selector; the model and its reasoning
          // effort are the whole selection surface.
          reply(agentActionResponse('set_agent_mode_response', requestId, agentId, false, 'this harness selects a model, not a mode'))
          return
        }
        case 'set_agent_feature_request': {
          const agentId = stringField(message, 'agentId') ?? ''
          reply(agentActionResponse('set_agent_feature_response', requestId, agentId, false, 'this harness has no per-agent feature toggles'))
          return
        }
        case 'workspace.setup.run.request': {
          const workspaceId = stringField(message, 'workspaceId')
          if (workspaceId === undefined) {
            reply(workspaceSetupStarted(requestId, '', false, 'workspaceId is required'))
            return
          }
          try {
            const started = await this.options.bridge.runWorkspaceSetup(workspaceId)
            reply(workspaceSetupStarted(requestId, workspaceId, started, null))
          } catch (error) {
            reply(workspaceSetupStarted(requestId, workspaceId, false, error instanceof Error ? error.message : String(error)))
          }
          return
        }
        case 'workspace_setup_status_request': {
          const workspaceId = stringField(message, 'workspaceId') ?? ''
          reply(workspaceSetupStatus(requestId, workspaceId, await this.options.bridge.workspaceSetupStatus(workspaceId)))
          return
        }
        case 'list_commands_request': {
          const agentId = stringField(message, 'agentId')
          if (agentId === undefined) {
            reply(rpcError(requestId, type, 'agentId is required', 'invalid_request'))
            return
          }
          reply(commandList(requestId, agentId, await this.options.bridge.listCommands(agentId)))
          return
        }
        case 'provider.usage.list.request':
        case 'usage.list_reports.request': {
          reply(emptyUsage(
            type === 'provider.usage.list.request' ? 'provider.usage.list.response' : 'usage.list_reports.response',
            requestId,
          ))
          return
        }
        case 'diagnostics.request': {
          const [agents, workspaces] = await Promise.all([
            this.options.bridge.listAgents(),
            this.options.bridge.listWorkspaces(),
          ])
          reply(diagnosticsResponse(requestId, {
            serverId: this.options.bridge.serverId,
            version: this.options.bridge.version,
            protocolVersion: PASEO_PROTOCOL_VERSION,
            connectedClients: this.connections.size,
            agents: agents.length,
            workspaces: workspaces.length,
            terminals: (await this.options.bridge.listTerminals()).length,
            uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1_000),
            listen: this.options.listen ?? null,
            relay: this.options.pairingOffer().relayEnabled,
          }))
          return
        }
        case 'get_daemon_config_request': {
          reply(daemonConfigResponse(requestId, this.daemonConfig()))
          return
        }
        case 'project.create_directory.request': {
          const parentPath = stringField(message, 'parentPath')
          const name = stringField(message, 'name')
          if (parentPath === undefined || name === undefined) {
            reply(projectDirectoryCreated(requestId, null, null, 'parentPath and name are required'))
            return
          }
          const created = await this.options.bridge.createDirectory(parentPath, name)
          if ('error' in created) {
            reply(projectDirectoryCreated(requestId, null, null, created.error))
            return
          }
          try {
            reply(projectDirectoryCreated(requestId, created.path, await this.options.bridge.createWorkspace({ directory: created.path }), null))
          } catch (error) {
            reply(projectDirectoryCreated(requestId, created.path, null, error instanceof Error ? error.message : String(error)))
          }
          return
        }
        case 'project.github.clone.request': {
          const repo = stringField(message, 'repo')
          const target = stringField(message, 'targetDirectory')
          if (repo === undefined || target === undefined) {
            reply(projectCloned(requestId, repo ?? '', null, null, 'repo and targetDirectory are required'))
            return
          }
          const cloned = await this.options.bridge.cloneRepository(repo, target)
          reply('error' in cloned
            ? projectCloned(requestId, repo, null, null, cloned.error)
            : projectCloned(requestId, repo, target, cloned.workspace, null))
          return
        }
        case 'fetch_agent_history_request': {
          const [agents, workspaces] = await Promise.all([
            this.options.bridge.listAgents(),
            this.options.bridge.listWorkspaces(),
          ])
          this.cacheWorkspaces(workspaces)
          const byId = new Map(workspaces.map((workspace) => [workspace.id, workspace]))
          const rows = agents.flatMap((agent) => {
            const workspace = byId.get(agent.workspaceId)
            return workspace === undefined ? [] : [{ agent, workspace }]
          })
          const result = queryDirectory(rows, {
            ...(recordValue(message.filter) === undefined ? {} : { filter: directoryFilter(recordValue(message.filter) as Record<string, unknown>) }),
            ...(stringField(message, 'search') === undefined ? {} : { search: stringField(message, 'search') }),
            ...(Array.isArray(message.sort) ? { sort: directorySort(message.sort) } : {}),
            ...(recordValue(message.page) === undefined ? {} : { page: directoryPage(recordValue(message.page) as Record<string, unknown>) }),
          })
          reply(agentHistory(requestId, result.rows, result.nextCursor, result.hasMore))
          return
        }
        case 'refresh_agent_request': {
          const agentId = stringField(message, 'agentId')
          if (agentId === undefined) {
            reply(rpcError(requestId, type, 'agentId is required', 'invalid_request'))
            return
          }
          const agent = await this.options.bridge.getAgent(agentId)
          const workspace = agent === null ? null : await this.workspaceFor(agent.workspaceId) ?? null
          reply(agentResponse(requestId, agent, workspace, agent === null ? 'agent not found' : null))
          return
        }
        case 'update_agent_request': {
          const agentId = stringField(message, 'agentId')
          const name = stringField(message, 'name')
          if (agentId === undefined) {
            reply(rpcError(requestId, type, 'agentId is required', 'invalid_request'))
            return
          }
          if (name !== undefined && name.trim().length > 0) {
            try {
              await this.options.bridge.renameAgent(agentId, name.trim())
            } catch (error) {
              this.options.logger.warn(`paseo: renaming ${agentId} failed: ${String(error)}`)
            }
          }
          const agent = await this.options.bridge.getAgent(agentId)
          const workspace = agent === null ? null : await this.workspaceFor(agent.workspaceId) ?? null
          reply(agentUpdateResponse(requestId, agent, workspace, agent === null ? 'agent not found' : null))
          return
        }
        case 'abort_request': {
          const agentId = stringField(message, 'agentId')
          if (agentId !== undefined) {
            try {
              await this.options.bridge.cancelAgent(agentId)
            } catch (error) {
              this.options.logger.warn(`paseo: aborting ${agentId} failed: ${String(error)}`)
            }
          }
          reply({ type: 'abort_response', payload: { requestId } })
          return
        }
        case 'agent.timeline.set_subscription.request': {
          // Every event already reaches every admitted client, so a timeline
          // subscription is an acknowledgement rather than new bookkeeping.
          reply({ type: 'agent.timeline.set_subscription.response', payload: { requestId, accepted: true, error: null } })
          return
        }
        case 'agent.timeline.search.request':
        case 'agent.timeline.list_prompts.request': {
          const agentId = stringField(message, 'agentId')
          if (agentId === undefined) {
            reply(rpcError(requestId, type, 'agentId is required', 'invalid_request'))
            return
          }
          const agent = await this.options.bridge.getAgent(agentId)
          if (agent === null) {
            reply(rpcError(requestId, type, 'agent not found', 'agent_not_found'))
            return
          }
          const entries = await this.options.bridge.getTimeline(agent.id)
          if (type === 'agent.timeline.search.request') {
            const cursor = typeof message.cursor === 'number' ? message.cursor : undefined
            reply(timelineSearchResult(requestId, agent.id, epochFor(agent.id), searchTimeline(entries, stringField(message, 'query') ?? '', cursor)))
            return
          }
          reply(timelinePrompts(requestId, agent.id, epochFor(agent.id), listPrompts(entries)))
          return
        }
        case 'fs.file.subscribe.request': {
          const directory = stringField(message, 'cwd')
          const path = stringField(message, 'path')
          if (directory === undefined || path === undefined) {
            reply(rpcError(requestId, type, 'cwd and path are required', 'invalid_request'))
            return
          }
          const known = await this.knownDirectory(directory)
          if (known === null) {
            reply(rpcError(requestId, type, `unknown workspace directory: ${directory}`, 'workspace_not_found'))
            return
          }
          const subscriptionId = stringField(message, 'subscriptionId') ?? `file_${requestId}`
          const initial = await this.fileVersion(known, path)
          reply(fileSubscribed(requestId, subscriptionId, initial))
          this.watchFile(connection, subscriptionId, known, path)
          return
        }
        case 'fs.file.unsubscribe.request': {
          const subscriptionId = stringField(message, 'subscriptionId')
          if (subscriptionId !== undefined) {
            this.stopFileWatch(connection, subscriptionId)
            reply(fileUnsubscribed(requestId, subscriptionId))
          }
          return
        }
        case 'file_explorer_request': {
          const directory = stringField(message, 'cwd')
          if (directory === undefined) {
            reply(rpcError(requestId, type, 'cwd is required', 'invalid_request'))
            return
          }
          const known = await this.knownDirectory(directory)
          if (known === null) {
            reply(rpcError(requestId, type, `unknown workspace directory: ${directory}`, 'workspace_not_found'))
            return
          }
          const path = stringField(message, 'path') ?? ''
          if (message.mode === 'file') {
            if (path.length === 0) {
              reply(fileContents(requestId, known, path, null, 'path is required to read a file'))
              return
            }
            const file = await this.options.bridge.readWorkspaceFile(known, path)
            reply(fileContents(requestId, known, path, file, file === null ? 'the file is unreadable or too large' : null))
            return
          }
          const entries = await this.options.bridge.listDirectory(known, path)
          if (entries === null) {
            reply(rpcError(requestId, type, `cannot list ${path}`, 'invalid_request'))
            return
          }
          reply(directoryListing(requestId, known, path, entries))
          return
        }
        case 'list_available_editors_request': {
          // Nothing here launches a desktop editor, and claiming otherwise
          // would make the client offer an action that cannot work.
          reply(availableEditors(requestId, []))
          return
        }
        case 'open_in_editor_request': {
          reply(openedInEditor(requestId, 'this daemon runs headless; it has no editor to open a file in'))
          return
        }
        case 'set_agent_model_request': {
          const agentId = stringField(message, 'agentId')
          if (agentId === undefined) {
            reply(agentActionResponse('set_agent_model_response', requestId, '', false, 'agentId is required'))
            return
          }
          try {
            await this.options.bridge.selectAgentModel(agentId, stringField(message, 'modelId') ?? null)
            reply(agentActionResponse('set_agent_model_response', requestId, agentId, true, null))
          } catch (error) {
            reply(agentActionResponse('set_agent_model_response', requestId, agentId, false, error instanceof Error ? error.message : String(error)))
          }
          return
        }
        case 'agent.provider_subagents.list.request': {
          const parentAgentId = stringField(message, 'parentAgentId')
          if (parentAgentId === undefined) {
            reply(rpcError(requestId, type, 'parentAgentId is required', 'invalid_request'))
            return
          }
          reply(subagentList(requestId, parentAgentId, await this.options.bridge.listSubagents(parentAgentId)))
          return
        }
        case 'agent.fork_context.request': {
          const agentId = stringField(message, 'agentId')
          if (agentId === undefined) {
            reply(rpcError(requestId, type, 'agentId is required', 'invalid_request'))
            return
          }
          const context = await this.options.bridge.forkContext(agentId, stringField(message, 'boundaryMessageId'))
          reply(forkContextResponse(requestId, agentId, context))
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
          reply(terminalsResponse(requestId, await this.options.bridge.listTerminals()))
          return
        }
        case 'create_terminal_request': {
          const workspaceId = stringField(message, 'workspaceId')
            ?? await this.workspaceIdForDirectory(stringField(message, 'cwd'))
          if (workspaceId === null) {
            reply(terminalCreated(requestId, null, 'the request names no workspace this daemon knows'))
            return
          }
          const size = recordValue(message.size)
          try {
            const terminal = await this.options.bridge.createTerminal({
              workspaceId,
              ...(stringField(message, 'name') === undefined ? {} : { name: stringField(message, 'name') }),
              ...(size === undefined || typeof size.cols !== 'number' ? {} : { cols: size.cols }),
              ...(size === undefined || typeof size.rows !== 'number' ? {} : { rows: size.rows }),
            })
            reply(terminalCreated(requestId, terminal, null))
            this.broadcast(terminalsChanged(await this.options.bridge.listTerminals()))
          } catch (error) {
            reply(terminalCreated(requestId, null, error instanceof Error ? error.message : String(error)))
          }
          return
        }
        case 'subscribe_terminal_request': {
          const terminalId = stringField(message, 'terminalId')
          if (terminalId === undefined) {
            reply(rpcError(requestId, type, 'terminalId is required', 'invalid_request'))
            return
          }
          const slot = this.allocateSlot(connection, terminalId, stringField(message, 'subscriptionId'))
          if (slot === null) {
            reply(terminalSubscribeFailed(requestId, terminalId, 'no free terminal slot on this connection'))
            return
          }
          reply(terminalSubscribed(requestId, terminalId, slot, stringField(message, 'subscriptionId')))
          try {
            const detach = await this.options.bridge.followTerminal(terminalId, (event) => {
              this.sendTerminalEvent(connection, slot, event)
            })
            connection.terminalStreams.set(terminalId, detach)
          } catch (error) {
            this.options.logger.warn(`paseo: attaching to terminal ${terminalId} failed: ${String(error)}`)
          }
          return
        }
        case 'unsubscribe_terminal_request': {
          const terminalId = stringField(message, 'terminalId')
          if (terminalId !== undefined) this.stopTerminalStream(connection, terminalId)
          return
        }
        case 'kill_terminal_request': {
          const terminalId = stringField(message, 'terminalId')
          if (terminalId === undefined) {
            reply(rpcError(requestId, type, 'terminalId is required', 'invalid_request'))
            return
          }
          let success = true
          try {
            this.stopTerminalStream(connection, terminalId)
            await this.options.bridge.closeTerminal(terminalId)
          } catch (error) {
            success = false
            this.options.logger.warn(`paseo: closing terminal ${terminalId} failed: ${String(error)}`)
          }
          reply(terminalKilled(requestId, terminalId, success))
          this.broadcast(terminalsChanged(await this.options.bridge.listTerminals()))
          return
        }
        case 'terminal.rename.request': {
          const terminalId = stringField(message, 'terminalId')
          const title = stringField(message, 'title')
          if (terminalId === undefined || title === undefined) {
            reply(rpcError(requestId, type, 'terminalId and title are required', 'invalid_request'))
            return
          }
          await this.options.bridge.renameTerminal(terminalId, title)
          reply(terminalRenamed(requestId, terminalId, title))
          return
        }
        case 'terminal_input': {
          const terminalId = stringField(message, 'terminalId')
          const input = recordValue(message.message)
          if (terminalId === undefined || input === undefined) return
          await this.applyTerminalInput(terminalId, input)
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
        case 'project.add.request': {
          const directory = stringField(message, 'cwd')
          if (directory === undefined) {
            reply(projectAdded(requestId, null, 'cwd is required'))
            return
          }
          try {
            reply(projectAdded(requestId, await this.options.bridge.createWorkspace({ directory }), null))
          } catch (error) {
            reply(projectAdded(requestId, null, error instanceof Error ? error.message : String(error)))
          }
          return
        }
        case 'project.rename.request': {
          const projectId = stringField(message, 'projectId')
          if (projectId === undefined) {
            reply(projectRenamed(requestId, '', null, 'projectId is required'))
            return
          }
          const customName = message.customName === null ? null : stringField(message, 'customName') ?? null
          const result = await this.options.bridge.setProjectName(projectId, customName)
          reply(projectRenamed(requestId, projectId, result.customName, null))
          const workspaces = await this.options.bridge.workspacesOfProject(projectId)
          for (const workspace of workspaces) this.broadcast(projectUpdated(workspace))
          return
        }
        case 'project.icon.set.request': {
          const projectId = stringField(message, 'projectId')
          const source = recordValue(message.source)
          if (projectId === undefined || source === undefined) {
            reply(projectIconSet(requestId, projectId ?? '', false, 'projectId and source are required'))
            return
          }
          const type = stringField(source, 'type')
          const data = stringField(source, 'data')
          if (type === 'upload' && data !== undefined) {
            await this.options.bridge.setProjectIcon(projectId, { data, mimeType: iconMediaType(data) })
          } else {
            // "Automatic" clears the stored icon: this daemon has no icon
            // discovery to fall back to, and saying so beats a stale image.
            await this.options.bridge.setProjectIcon(projectId, null)
          }
          reply(projectIconSet(requestId, projectId, true, null))
          const workspaces = await this.options.bridge.workspacesOfProject(projectId)
          for (const workspace of workspaces) this.broadcast(projectUpdated(workspace))
          return
        }
        case 'project.icon.get.request': {
          const projectId = stringField(message, 'projectId') ?? ''
          reply(projectIconGot(requestId, projectId, await this.options.bridge.projectIcon(projectId)))
          return
        }
        case 'project_icon_request': {
          const directory = stringField(message, 'cwd')
          if (directory === undefined) {
            reply(projectIconForDirectory(requestId, '', null, 'cwd is required'))
            return
          }
          const projectId = await this.options.bridge.projectIdForDirectory(directory)
          reply(projectIconForDirectory(
            requestId,
            directory,
            projectId === null ? null : await this.options.bridge.projectIcon(projectId),
            null,
          ))
          return
        }
        case 'project.remove.request': {
          const projectId = stringField(message, 'projectId')
          if (projectId === undefined) {
            reply(projectRemoved(requestId, '', [], 'projectId is required'))
            return
          }
          const workspaces = await this.options.bridge.workspacesOfProject(projectId)
          if (workspaces.length === 0) {
            reply(projectRemoved(requestId, projectId, [], 'no workspace belongs to that project'))
            return
          }
          const removed: string[] = []
          for (const workspace of workspaces) {
            if (await this.options.bridge.deleteWorkspace(workspace.id)) removed.push(workspace.id)
          }
          reply(projectRemoved(requestId, projectId, removed, null))
          return
        }
        case 'directory_suggestions_request': {
          const query = stringField(message, 'query') ?? ''
          const cwd = stringField(message, 'cwd') ?? (await this.defaultDirectory())
          const limit = typeof message.limit === 'number' ? message.limit : 20
          const includeFiles = message.includeFiles === true
          const entries = await this.options.bridge.suggestPaths(query, cwd, limit)
          reply(directorySuggestions(requestId, includeFiles ? entries : entries.filter((entry) => entry.kind === 'directory'), includeFiles))
          return
        }
        case 'read_project_config_request': {
          const repoRoot = stringField(message, 'repoRoot')
          if (repoRoot === undefined) {
            reply(projectConfigMissing(requestId, '', 'project_not_found'))
            return
          }
          const known = await this.knownDirectory(repoRoot)
          if (known === null) {
            reply(projectConfigMissing(requestId, repoRoot, 'project_not_found'))
            return
          }
          const file = await this.options.bridge.readProjectConfig(known)
          reply(projectConfigRead(requestId, repoRoot, file?.config ?? null, file?.revision ?? null))
          return
        }
        case 'write_project_config_request': {
          const repoRoot = stringField(message, 'repoRoot')
          if (repoRoot === undefined) {
            reply(projectConfigWriteFailed(requestId, '', 'project_not_found'))
            return
          }
          const known = await this.knownDirectory(repoRoot)
          if (known === null) {
            reply(projectConfigWriteFailed(requestId, repoRoot, 'project_not_found'))
            return
          }
          const expected = revisionOf(message.expectedRevision)
          const written = await this.options.bridge.writeProjectConfig(known, message.config, expected)
          if ('error' in written) {
            reply(projectConfigWriteFailed(
              requestId,
              repoRoot,
              written.error === 'stale_project_config'
                ? 'stale_project_config'
                : written.error === 'invalid_project_config' ? 'invalid_project_config' : 'write_failed',
            ))
            return
          }
          reply(projectConfigWritten(requestId, repoRoot, message.config, written.revision))
          return
        }
        case 'workspace.label.list.request': {
          const catalog = await this.options.bridge.listWorkspaceLabels()
          const subscribe = recordValue(message.subscribe)
          const subscriptionId = subscribe === undefined ? undefined : stringField(subscribe, 'subscriptionId')
          reply(labelCatalog(requestId, catalog.labels, catalog.generation, catalog.headSeq, subscriptionId))
          return
        }
        case 'workspace.label.update.request': {
          const name = stringField(message, 'name')
          if (name === undefined) {
            reply(rpcError(requestId, type, 'name is required', 'invalid_request'))
            return
          }
          const result = await this.options.bridge.updateWorkspaceLabel({
            name,
            ...(stringField(message, 'newName') === undefined ? {} : { newName: stringField(message, 'newName') }),
            ...(stringField(message, 'color') === undefined ? {} : { color: stringField(message, 'color') }),
          })
          reply(labelUpdated(requestId, result.label, result.affectedWorkspaceCount))
          this.broadcast(labelUpdateEvent(result.label, []))
          return
        }
        case 'workspace.label.delete.request': {
          const name = stringField(message, 'name')
          if (name === undefined) {
            reply(rpcError(requestId, type, 'name is required', 'invalid_request'))
            return
          }
          const removed = await this.options.bridge.deleteWorkspaceLabel(name)
          reply(labelAffected('workspace.label.delete.response', requestId, removed.affectedWorkspaceCount))
          return
        }
        case 'workspace.label.delete.inspect.request': {
          const name = stringField(message, 'name')
          if (name === undefined) {
            reply(rpcError(requestId, type, 'name is required', 'invalid_request'))
            return
          }
          const inspected = await this.options.bridge.inspectWorkspaceLabelDelete(name)
          reply(labelAffected('workspace.label.delete.inspect.response', requestId, inspected.affectedWorkspaceCount))
          return
        }
        case 'workspace.label.assignment.set.request': {
          const workspaceId = stringField(message, 'workspaceId')
          const definition = recordValue(message.label)
          const name = definition === undefined ? undefined : stringField(definition, 'name')
          if (workspaceId === undefined || name === undefined) {
            reply(rpcError(requestId, type, 'workspaceId and label are required', 'invalid_request'))
            return
          }
          const color = definition === undefined ? undefined : stringField(definition, 'color')
          const label: LabelDefinition = { name, color: (color ?? 'sky') as LabelDefinition['color'] }
          const result = await this.options.bridge.setWorkspaceLabelAssignment(workspaceId, label, message.assigned !== false)
          reply(labelAssigned(requestId, label, result.workspaceLabels))
          this.broadcast(labelUpdateEvent(label, result.workspaceLabels))
          this.broadcast(workspaceUpdate(await this.requireWorkspace(workspaceId)))
          return
        }
        case 'archive_workspace_request': {
          const workspaceId = stringField(message, 'workspaceId')
          if (workspaceId === undefined) {
            reply(rpcError(requestId, type, 'workspaceId is required', 'invalid_request'))
            return
          }
          const removed = await this.options.bridge.deleteWorkspace(workspaceId)
          reply(workspaceArchived(requestId, workspaceId, removed))
          return
        }
        case 'workspace.pin.set.request': {
          const workspaceId = stringField(message, 'workspaceId')
          if (workspaceId === undefined) {
            reply(workspacePinned(requestId, '', false, null, 'workspaceId is required'))
            return
          }
          const pinned = message.pinned === true
          const pinnedAt = await this.options.bridge.setWorkspacePinned(workspaceId, pinned)
          reply(workspacePinned(
            requestId,
            workspaceId,
            pinned ? pinnedAt !== null : true,
            pinnedAt,
            pinned && pinnedAt === null ? 'this daemon cannot pin a workspace' : null,
          ))
          return
        }
        case 'workspace.title.set.request': {
          const workspaceId = stringField(message, 'workspaceId') ?? ''
          // DSH keeps a workspace title as it was created; there is no rename.
          reply(workspaceTitleSet(requestId, workspaceId, false, null, 'this daemon cannot retitle a workspace'))
          return
        }
        case 'workspace.mark_unread.request': {
          const workspaceId = stringField(message, 'workspaceId') ?? ''
          reply(workspaceMarkedUnread(requestId, workspaceId, null, false, 'this daemon keeps no unread mark'))
          return
        }
        case 'workspace.clear_attention.request': {
          const requested = message.workspaceId
          const workspaceIds = Array.isArray(requested)
            ? requested.filter((id): id is string => typeof id === 'string')
            : typeof requested === 'string' ? [requested] : []
          reply(attentionClearedFor(requestId, workspaceIds, []))
          return
        }
        case 'client_heartbeat':
        case 'subscribe_terminals_request':
        case 'unsubscribe_terminals_request':
        // Server-to-client messages: a client that echoes one gets no answer
        // rather than an error about a request it never needed to send.
        case 'assistant_message':
        case 'user_message':
        case 'permission_requested':
        case 'agent_permission_request':
        case 'pull_request_timeline_response':
        case 'forge_change_request':
          return
        default: {
          const refused = REFUSED_REQUESTS[type]
          if (refused !== undefined) {
            reply(refusalResponse(refused.response, requestId, refused.reason))
            return
          }
          reply(rpcError(requestId, type, `unsupported request: ${type}`, 'unsupported'))
        }
      }
    } catch (error) {
      this.options.logger.warn(`paseo: ${type} failed: ${error instanceof Error ? error.message : String(error)}`)
      reply(rpcError(requestId, type, error instanceof Error ? error.message : String(error), 'internal_error'))
    }
  }

  private readonly workspaceCache = new Map<string, WorkspaceRecord>()

  /** Last known descriptor of every terminal, for change notifications. */
  private readonly terminalCache = new Map<string, TerminalRecord>()

  /** Configuration facts the harness knows about this daemon. */
  private daemonConfig(): Record<string, unknown> {
    return {
      serverId: this.options.bridge.serverId,
      version: this.options.bridge.version,
      hostname: this.options.hostname,
      listen: this.options.listen ?? null,
      passwordRequired: this.options.password !== undefined && this.options.password.length > 0,
      relayEnabled: this.options.pairingOffer().relayEnabled,
      // Editing the harness composition is the operator's job, so the config
      // this daemon reports is read-only.
      writable: false,
    }
  }

  /** Instant this daemon started, for the diagnostics snapshot. */
  private readonly startedAt = Date.now()

  /** Outstanding download tokens, redeemed by the HTTP route. */
  private readonly downloads = new Map<string, DownloadGrant>()

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
  /**
   * Poll one directory's diff and tell the client when it changed.
   *
   * Git has no watch API, so a subscription is a bounded poll. Only a changed
   * serialization is sent, which keeps an idle working tree silent.
   */
  private watchDiff(
    connection: Connection,
    subscriptionId: string,
    directory: string,
    compare: DiffCompare,
    initial: readonly DiffFile[],
  ): void {
    this.stopDiffWatch(connection, subscriptionId)
    let previous = JSON.stringify(initial)
    const timer = setInterval(() => {
      if (connection.closed) {
        this.stopDiffWatch(connection, subscriptionId)
        return
      }
      void this.options.bridge.checkoutDiff(directory, compare).then((files) => {
        const next = JSON.stringify(files)
        if (connection.closed || next === previous) return
        previous = next
        connection.socket.send(envelope(checkoutDiffUpdate(subscriptionId, directory, files)))
      }).catch(() => {
        // A poll that fails leaves the previous diff in place; the next tick retries.
      })
    }, DIFF_POLL_INTERVAL_MS)
    timer.unref?.()
    connection.diffWatches.set(subscriptionId, timer)
  }

  /** Drop one live diff subscription. */
  private stopDiffWatch(connection: Connection, subscriptionId: string): void {
    const timer = connection.diffWatches.get(subscriptionId)
    if (timer === undefined) return
    clearInterval(timer)
    connection.diffWatches.delete(subscriptionId)
  }

  /**
   * Run one checkout write and build its response frame.
   *
   * The directory is already resolved to one this daemon advertised, and the
   * commit message travels as its own argument, never through a shell.
   */
  private async runCheckoutOperation(
    type: string,
    requestId: string,
    directory: string,
    message: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const bridge = this.options.bridge
    switch (type) {
      case 'checkout_commit_request':
        return checkoutOperationResponse(
          type,
          requestId,
          directory,
          await bridge.commitCheckout(directory, stringField(message, 'message'), message.addAll === true),
        )
      case 'checkout_push_request':
        return checkoutOperationResponse(type, requestId, directory, await bridge.pushCheckout(directory))
      case 'checkout_pull_request':
        return checkoutOperationResponse(type, requestId, directory, await bridge.pullCheckout(directory))
      default:
        // Git reports its state on every read, so a refresh is an acknowledgement
        // that tells the client to re-read status and diff.
        return checkoutOperationResponse(type, requestId, directory, { success: true })
    }
  }

  /** A directory to resolve a relative suggestion against: the newest workspace. */
  private async defaultDirectory(): Promise<string> {
    const workspaces = await this.options.bridge.listWorkspaces()
    this.cacheWorkspaces(workspaces)
    return workspaces[0]?.directory ?? process.cwd()
  }

  /** One workspace record by identity, or a refresh of the cache. */
  private async requireWorkspace(workspaceId: string): Promise<WorkspaceRecord> {
    const cached = await this.workspaceFor(workspaceId)
    if (cached !== undefined) return cached
    const listed = await this.options.bridge.listWorkspaces()
    this.cacheWorkspaces(listed)
    const found = this.workspaceCache.get(workspaceId)
    if (found === undefined) throw new Error(`unknown workspace ${workspaceId}`)
    return found
  }

  /** Workspace identity for one directory this daemon advertised. */
  private async workspaceIdForDirectory(directory: string | undefined): Promise<string | null> {
    if (directory === undefined) return null
    const known = await this.knownDirectory(directory)
    if (known === null) return null
    const workspace = [...this.workspaceCache.values()].find((candidate) => candidate.directory === known)
    return workspace?.id ?? null
  }

  /** Claim the lowest free stream slot for one terminal on this connection. */
  private allocateSlot(connection: Connection, terminalId: string, subscriptionId: string | undefined): number | null {
    for (const [slot, entry] of connection.slots) {
      if (entry.terminalId === terminalId) return slot
    }
    for (let slot = 0; slot <= TERMINAL_MAX_SLOT; slot += 1) {
      if (connection.slots.has(slot)) continue
      connection.slots.set(slot, { terminalId, ...(subscriptionId === undefined ? {} : { subscriptionId }) })
      return slot
    }
    return null
  }

  /** Current version of one file, as the watch frames report it. */
  private async fileVersion(
    directory: string,
    path: string,
  ): Promise<
    | { readonly status: 'ready'; readonly cwd: string; readonly path: string; readonly size: number; readonly modifiedAt: string }
    | { readonly status: 'missing'; readonly cwd: string; readonly path: string }
  > {
    const info = await this.options.bridge.statEntry(directory, path)
    return info === null
      ? { status: 'missing', cwd: directory, path }
      : { status: 'ready', cwd: directory, path, size: info.size, modifiedAt: info.modifiedAt }
  }

  /**
   * Watch one file by polling it.
   *
   * There is no portable file watch in the harness, so a subscription re-reads
   * the file's size and modification time and reports only a change.
   */
  private watchFile(connection: Connection, subscriptionId: string, directory: string, path: string): void {
    this.stopFileWatch(connection, subscriptionId)
    let previous: string | null = null
    const timer = setInterval(() => {
      if (connection.closed) {
        this.stopFileWatch(connection, subscriptionId)
        return
      }
      void this.fileVersion(directory, path).then((version) => {
        const key = JSON.stringify(version)
        if (previous === null) {
          previous = key
          return
        }
        if (connection.closed || key === previous) return
        previous = key
        connection.socket.send(envelope(fileUpdated(subscriptionId, version)))
      }).catch(() => {
        // A file that cannot be read right now is reported on the next tick.
      })
    }, FILE_POLL_INTERVAL_MS)
    timer.unref?.()
    connection.fileWatches.set(subscriptionId, timer)
  }

  /** Stop one file watch. */
  private stopFileWatch(connection: Connection, subscriptionId: string): void {
    const timer = connection.fileWatches.get(subscriptionId)
    if (timer === undefined) return
    clearInterval(timer)
    connection.fileWatches.delete(subscriptionId)
  }

  /** End one terminal's stream on this connection and release its slot. */
  private stopTerminalStream(connection: Connection, terminalId: string): void {
    const detach = connection.terminalStreams.get(terminalId)
    if (detach !== undefined) {
      detach()
      connection.terminalStreams.delete(terminalId)
    }
    for (const [slot, entry] of [...connection.slots]) {
      if (entry.terminalId === terminalId) connection.slots.delete(slot)
    }
  }

  /** Send one terminal frame, preferring the binary stream the client subscribed to. */
  private sendTerminalEvent(connection: Connection, slot: number, event: TerminalEvent): void {
    if (connection.closed) return
    // The client renders ANSI, so the attachment's recovery screen and later
    // output travel the same way: as output bytes for that slot.
    if (event.type === 'snapshot') {
      if (event.screen.length > 0) this.sendTerminalBytes(connection, encodeOutputFrame(slot, event.screen))
      return
    }
    if (event.type === 'output') {
      if (event.data.length > 0) this.sendTerminalBytes(connection, encodeOutputFrame(slot, event.data))
      return
    }
    void this.publishTerminalState(event.record)
  }

  private sendTerminalBytes(connection: Connection, frame: Uint8Array): void {
    if (connection.socket.sendBinary !== undefined) {
      connection.socket.sendBinary(frame)
      return
    }
    // A transport without binary frames (a test double) still receives the
    // frame, base64 encoded, rather than losing the terminal.
    connection.socket.send(envelope({ type: 'terminal_frame', payload: Buffer.from(frame).toString('base64') }))
  }

  private async publishTerminalState(record: TerminalRecord): Promise<void> {
    this.terminalCache.set(record.id, record)
    this.broadcast(terminalsChanged(await this.options.bridge.listTerminals()))
  }

  /** Apply one upload frame against the upload this client already began. */
  private async onTransferFrame(connection: Connection, bytes: Uint8Array): Promise<void> {
    const frame = decodeFileTransferFrame(bytes)
    if (frame === null) return
    const target = connection.uploads.get(frame.requestId)
    if (target === undefined) return
    try {
      if (frame.opcode === FILE_OPCODE.BEGIN) {
        await startUpload(target)
        return
      }
      if (frame.opcode === FILE_OPCODE.CHUNK) {
        const refused = await appendUpload(target, frame.payload)
        if (refused !== null) await this.failUpload(connection, target, refused)
        return
      }
      const failed = await finishUpload(target)
      connection.uploads.delete(frame.requestId)
      connection.socket.send(envelope(uploadResponse(frame.requestId, failed === null ? target : null, failed)))
    } catch (error) {
      await this.failUpload(connection, target, error instanceof Error ? error.message : String(error))
    }
  }

  /** Drop a failed upload and tell the client why. */
  private async failUpload(connection: Connection, target: UploadTarget, error: string): Promise<void> {
    connection.uploads.delete(target.id)
    await discardUpload(target).catch(() => undefined)
    connection.socket.send(envelope(uploadResponse(target.id, null, error)))
  }

  /** Apply one JSON terminal input, which is the client's non-stream input path. */
  private async applyTerminalInput(terminalId: string, input: Record<string, unknown>): Promise<void> {
    const kind = stringField(input, 'type')
    try {
      if (kind === 'input') {
        const data = stringField(input, 'data')
        if (data !== undefined) await this.options.bridge.writeTerminal(terminalId, data)
        return
      }
      if (kind === 'resize') {
        const rows = input.rows
        const cols = input.cols
        if (typeof rows === 'number' && typeof cols === 'number' && rows > 0 && cols > 0) {
          await this.options.bridge.resizeTerminal(terminalId, cols, rows)
        }
      }
    } catch (error) {
      this.options.logger.warn(`paseo: terminal ${terminalId} input failed: ${String(error)}`)
    }
  }

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
  /** Feed one inbound binary frame, which carries terminal stream frames. */
  receiveBinary(bytes: Uint8Array): void
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

/** Comparison a diff request asked for, defaulting to the working tree. */
function compareOf(message: Record<string, unknown>): DiffCompare {
  const compare = recordValue(message.compare)
  const mode = compare === undefined ? undefined : stringField(compare, 'mode')
  const baseRef = compare === undefined ? undefined : stringField(compare, 'baseRef')
  const ignoreWhitespace = compare?.['ignoreWhitespace'] === true
  return {
    mode: mode === 'base' ? 'base' : 'uncommitted',
    ...(baseRef === undefined ? {} : { baseRef }),
    ...(ignoreWhitespace ? { ignoreWhitespace: true } : {}),
  }
}

/** Operation result frames a checkout write answers with. */
function checkoutOperationResponse(
  type: string,
  requestId: string,
  directory: string,
  result: GitOperationResult,
): Record<string, unknown> {
  const responseType = type === 'checkout.refresh.request'
    ? 'checkout.refresh.response'
    : `${type.replace(/_request$/, '')}_response`
  return {
    type: responseType,
    payload: {
      cwd: directory,
      success: result.success,
      error: result.error === undefined ? null : { code: result.error.code, message: result.error.message },
      requestId,
    },
  }
}

/** Cadence a schedule request asked for, or null when it is malformed. */
function paseoCadence(value: unknown): PaseoCadence | null {
  const cadence = recordValue(value)
  if (cadence === undefined) return null
  const type = stringField(cadence, 'type')
  if (type === 'every') {
    const everyMs = cadence.everyMs
    return typeof everyMs === 'number' && Number.isFinite(everyMs) && everyMs > 0 ? { type: 'every', everyMs } : null
  }
  if (type === 'cron') {
    const expression = stringField(cadence, 'expression')
    if (expression === undefined || expression.trim().length === 0) return null
    const timezone = stringField(cadence, 'timezone')
    return { type: 'cron', expression, ...(timezone === undefined ? {} : { timezone }) }
  }
  return null
}

/** Merge strategy a client asked for, defaulting to a merge commit. */
function mergeMethodOf(value: unknown): 'merge' | 'squash' | 'rebase' {
  return value === 'squash' || value === 'rebase' ? value : 'merge'
}

/** Revision a project config write must match, or null when the client sent none. */
function revisionOf(value: unknown): { readonly mtimeMs: number; readonly size: number } | null {
  const record = recordValue(value)
  if (record === undefined) return null
  return typeof record.mtimeMs === 'number' && typeof record.size === 'number'
    ? { mtimeMs: record.mtimeMs, size: record.size }
    : null
}

/** Filter a directory request asked for, flattened from its wire shape. */
function directoryFilter(value: Record<string, unknown>): DirectoryFilter {
  const statuses = Array.isArray(value.statuses) ? value.statuses.filter((status): status is string => typeof status === 'string') : undefined
  const projectKeys = Array.isArray(value.projectKeys) ? value.projectKeys.filter((key): key is string => typeof key === 'string') : undefined
  return {
    ...(statuses === undefined ? {} : { statuses }),
    ...(projectKeys === undefined ? {} : { projectKeys }),
    ...(value.includeArchived === true ? { includeArchived: true } : {}),
    ...(value.requiresAttention === true ? { requiresAttention: true } : {}),
  }
}

/** Sort instructions a directory request asked for. */
function directorySort(value: readonly unknown[]): readonly DirectorySort[] {
  const sorts: DirectorySort[] = []
  for (const entry of value) {
    const record = recordValue(entry)
    if (record === undefined) continue
    const key = record.key
    if (key !== 'status_priority' && key !== 'created_at' && key !== 'updated_at' && key !== 'title') continue
    sorts.push({ key, direction: record.direction === 'asc' ? 'asc' : 'desc' })
  }
  return sorts
}

/** Page a directory request asked for. */
function directoryPage(value: Record<string, unknown>): DirectoryPage {
  const limit = typeof value.limit === 'number' && value.limit > 0 ? value.limit : 50
  const cursor = stringField(value, 'cursor')
  return { limit, ...(cursor === undefined ? {} : { cursor }) }
}

/** Media type of an uploaded icon, read from its own bytes. */
function iconMediaType(data: string): string {
  if (data.startsWith('iVBOR')) return 'image/png'
  if (data.startsWith('/9j/')) return 'image/jpeg'
  if (data.startsWith('R0lGOD')) return 'image/gif'
  if (data.startsWith('UklGR')) return 'image/webp'
  return 'image/png'
}
