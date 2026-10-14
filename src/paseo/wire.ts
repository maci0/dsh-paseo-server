/**
 * Paseo wire format: the session messages this daemon emits and accepts.
 *
 * Field sets and required flags mirror the Paseo 0.11.2 protocol schemas. The
 * shapes are protocol facts; this module encodes only the subset a client
 * needs to list workspaces and agents, read a timeline, and drive a turn.
 *
 * @module dsh-paseo-server/paseo/wire
 */

import type { PullRequestLookup } from '../dsh/forge.ts'
import type { DiffFile, GitStatus } from '../dsh/git.ts'
import type {
  AgentRecord,
  AgentStatus,
  TerminalRecord,
  TimelineEntry,
  TimelineItem,
  WorkspaceRecord,
  ScheduleRecord,
  WorkspaceScriptRecord,
} from '../bridge.ts'

/** Protocol version the 0.11.2 client sends and expects. */
export const PASEO_PROTOCOL_VERSION = 1

/** Paseo daemon version this server reports. */
export const PASEO_DAEMON_VERSION = '0.11.2'

/** Session-capability names the connected client advertises. */
export interface ClientHello {
  readonly clientId: string
  readonly clientType: 'mobile' | 'browser' | 'cli' | 'mcp' | 'hub'
  readonly protocolVersion: number
  readonly auth?: { readonly kind: 'password'; readonly password: string } | { readonly kind: 'localCredential'; readonly token: string }
  readonly appVersion?: string
}

/** One inbound frame from a Paseo client. */
export type InboundFrame =
  | { readonly kind: 'hello'; readonly hello: ClientHello }
  | { readonly kind: 'ping' }
  | { readonly kind: 'recording_state' }
  | { readonly kind: 'request'; readonly message: Record<string, unknown> }

/** Message types this server answers. Anything else draws `rpc_error`. */
export const SUPPORTED_REQUESTS: readonly string[] = [
  'fetch_workspaces_request',
  'fetch_agents_request',
  'project.list.request',
  'fetch_agent_request',
  'fetch_agent_timeline_request',
  'send_agent_message_request',
  'send_agent_message',
  'cancel_agent_request',
  'daemon.get_status.request',
  'agent.create.request',
  'create_agent_request',
  'workspace.create.request',
  'wait_for_finish_request',
  'daemon.get_pairing_offer.request',
  'client_heartbeat',
  'subscription.release.request',
  'session.events.set_subscription.request',
  'clear_agent_attention',
  'list_terminals_request',
  'create_terminal_request',
  'subscribe_terminal_request',
  'unsubscribe_terminal_request',
  'kill_terminal_request',
  'terminal.rename.request',
  'terminal_input',
  'delete_agent_request',
  'workspace.script.list.request',
  'workspace.script.start.request',
  'workspace.script.stop.request',
  'schedule/list',
  'schedule/create',
  'schedule/delete',
  'schedule/run-once',
  'schedule/inspect',
  'schedule/pause',
  'schedule/resume',
  'schedule/update',
  'schedule/logs',
  'checkout_status_request',
  'checkout_pr_status_request',
  'checkout_commit_request',
  'checkout_push_request',
  'checkout_pull_request',
  'checkout.refresh.request',
  'checkout.diff.get.request',
  'subscribe_checkout_diff_request',
  'unsubscribe_checkout_diff_request',
  'archive_agent_request',
  'close_items_request',
  'workspace.mark_unread.request',
  'list_terminals_request',
  'subscribe_terminals_request',
  'unsubscribe_terminals_request',
]

/**
 * Parse one raw WebSocket text frame.
 * @param raw - frame text.
 * @returns the parsed frame, or null when it is not a known Paseo frame.
 */
export function parseInbound(raw: string): InboundFrame | null {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (value === null || typeof value !== 'object') return null
  const frame = value as Record<string, unknown>
  if (frame.type === 'ping') return { kind: 'ping' }
  if (frame.type === 'recording_state') return { kind: 'recording_state' }
  if (frame.type === 'hello') {
    if (typeof frame.clientId !== 'string' || typeof frame.protocolVersion !== 'number') return null
    const clientType = frame.clientType
    if (clientType !== 'mobile' && clientType !== 'browser' && clientType !== 'cli' && clientType !== 'mcp' && clientType !== 'hub') return null
    const auth = frame.auth
    let parsedAuth: ClientHello['auth']
    if (auth !== null && typeof auth === 'object') {
      const record = auth as Record<string, unknown>
      if (record.kind === 'password' && typeof record.password === 'string') parsedAuth = { kind: 'password', password: record.password }
      else if (record.kind === 'localCredential' && typeof record.token === 'string') parsedAuth = { kind: 'localCredential', token: record.token }
    }
    const hello: ClientHello = {
      clientId: frame.clientId,
      clientType,
      protocolVersion: frame.protocolVersion,
      ...(parsedAuth === undefined ? {} : { auth: parsedAuth }),
      ...(typeof frame.appVersion === 'string' ? { appVersion: frame.appVersion } : {}),
    }
    return { kind: 'hello', hello }
  }
  if (frame.type === 'session' && frame.message !== null && typeof frame.message === 'object') {
    return { kind: 'request', message: frame.message as Record<string, unknown> }
  }
  return null
}

/** Wrap one session message in the WebSocket envelope. */
export function envelope(message: Record<string, unknown>): string {
  return JSON.stringify({ type: 'session', message })
}

/** The `status` frame sent once per connection right after `hello`. */
export function serverInfo(bridge: { serverId: string; version: string }, hostname: string): Record<string, unknown> {
  return {
    type: 'status',
    payload: {
      status: 'server_info',
      protocolVersion: PASEO_PROTOCOL_VERSION,
      serverId: bridge.serverId,
      hostname,
      version: PASEO_DAEMON_VERSION,
      daemonVersion: bridge.version,
      permissions: ['daemon.read', 'workspace.read', 'workspace.write', 'workspace.manage'],
      capabilities: { voice: false, pushNotifications: false },
      // Every gate stays off except the status RPC: a client that believes the
      // daemon supports a feature asks for messages this server does not answer.
      features: { daemonStatusRpc: true },
    },
  }
}

/** `pong` for a `ping` frame. */
export function pong(): string {
  return JSON.stringify({ type: 'pong' })
}

/** A correlated failure for one request. */
export function rpcError(requestId: string, requestType: string, message: string, code = 'unsupported'): Record<string, unknown> {
  return { type: 'rpc_error', payload: { requestId, requestType, error: message, code } }
}

/** One workspace as the client's workspace descriptor. */
export function workspaceDescriptor(workspace: WorkspaceRecord): Record<string, unknown> {
  const checkout = workspace.checkout.isGit
    ? {
        cwd: workspace.directory,
        isGit: true,
        currentBranch: null,
        remoteUrl: null,
        worktreeRoot: workspace.directory,
        isPaseoOwnedWorktree: false,
        mainRepoRoot: workspace.projectRootPath,
      }
    : {
        cwd: workspace.directory,
        isGit: false,
        currentBranch: null,
        remoteUrl: null,
        worktreeRoot: null,
        isPaseoOwnedWorktree: false,
        mainRepoRoot: null,
      }
  return {
    id: workspace.id,
    projectId: workspace.projectId,
    projectDisplayName: workspace.projectName,
    projectRootPath: workspace.projectRootPath,
    workspaceDirectory: workspace.directory,
    projectKind: workspace.projectKind,
    workspaceKind: 'directory',
    name: workspace.name,
    title: workspace.name,
    pinnedAt: null,
    labels: [],
    archivingAt: null,
    status: workspace.status,
    statusEnteredAt: workspace.statusEnteredAt,
    activityAt: workspace.activityAt,
    scripts: [],
    gitRuntime: {
      currentBranch: null,
      remoteUrl: null,
      isPaseoOwnedWorktree: false,
      isDirty: null,
      aheadBehind: null,
      aheadOfOrigin: null,
      behindOfOrigin: null,
    },
    githubRuntime: { featuresEnabled: false, pullRequest: null, error: null, refreshedAt: null },
    project: {
      projectKey: workspace.projectKey,
      projectName: workspace.projectName,
      workspaceName: workspace.name,
      checkout,
    },
  }
}

/** One project descriptor. */
export function projectDescriptor(workspace: WorkspaceRecord): Record<string, unknown> {
  return {
    projectId: workspace.projectId,
    projectKey: workspace.projectKey,
    projectDisplayName: workspace.projectName,
    projectCustomName: null,
    projectRootPath: workspace.projectRootPath,
    projectKind: workspace.projectKind,
  }
}

/** One placement payload for an agent's project. */
export function placement(workspace: WorkspaceRecord): Record<string, unknown> {
  const descriptor = workspaceDescriptor(workspace)
  return descriptor.project as Record<string, unknown>
}

/** One agent snapshot. */
export function agentSnapshot(agent: AgentRecord): Record<string, unknown> {
  return {
    id: agent.id,
    provider: agent.provider,
    cwd: agent.cwd,
    workspaceId: agent.workspaceId,
    model: agent.model,
    features: [],
    thinkingOptionId: null,
    effectiveThinkingOptionId: null,
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
    lastUserMessageAt: agent.lastUserMessageAt,
    status: agent.status,
    activeTurn: agent.activeTurn ?? null,
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsSessionListing: true,
      supportsDynamicModes: false,
      supportsMcpServers: false,
      supportsReasoningStream: true,
      supportsToolInvocations: true,
    },
    currentModeId: null,
    availableModes: [{ id: 'default', label: 'Default' }],
    pendingPermissions: [],
    persistence: { provider: agent.provider, sessionId: agent.id },
    title: agent.title,
    labels: {},
    requiresAttention: false,
    attentionReason: null,
    attentionTimestamp: null,
    archivedAt: agent.archivedAt ?? null,
  }
}

/** One timeline item in wire form. */
export function timelineItem(item: TimelineItem): Record<string, unknown> {
  switch (item.type) {
    case 'user_message':
      return {
        type: 'user_message',
        text: item.text,
        ...(item.messageId === undefined ? {} : { messageId: item.messageId }),
        ...(item.clientMessageId === undefined ? {} : { clientMessageId: item.clientMessageId }),
      }
    case 'assistant_message':
      return {
        type: 'assistant_message',
        text: item.text,
        ...(item.messageId === undefined ? {} : { messageId: item.messageId }),
      }
    case 'reasoning':
      return { type: 'reasoning', text: item.text }
    case 'tool_call':
      return {
        type: 'tool_call',
        callId: item.callId,
        name: item.name,
        status: item.status,
        error: item.error ?? null,
        detail: { type: 'unknown', input: item.input ?? null, output: item.output ?? null },
      }
    case 'error':
      return { type: 'error', message: item.message }
    case 'notification':
      return { type: 'notification', level: item.level, message: item.message }
  }
}

/** One timeline entry in wire form. */
export function timelineEntry(provider: string, entry: TimelineEntry): Record<string, unknown> {
  return {
    provider,
    item: timelineItem(entry.item),
    ...(entry.turnId === undefined ? {} : { turnId: entry.turnId }),
    timestamp: entry.timestamp,
    seqStart: entry.seq,
    seqEnd: entry.seq,
    sourceSeqRanges: [{ startSeq: entry.seq, endSeq: entry.seq }],
    collapsed: [],
  }
}

/** `fetch_workspaces_response`. */
export function workspacesResponse(requestId: string, subscriptionId: string | null, workspaces: readonly WorkspaceRecord[]): Record<string, unknown> {
  return {
    type: 'fetch_workspaces_response',
    payload: {
      requestId,
      subscriptionId,
      entries: workspaces.map(workspaceDescriptor),
      emptyProjects: [],
      pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
    },
  }
}

/** `project.list.response`. */
export function projectsResponse(requestId: string, workspaces: readonly WorkspaceRecord[]): Record<string, unknown> {
  const seen = new Set<string>()
  const projects = []
  for (const workspace of workspaces) {
    if (seen.has(workspace.projectId)) continue
    seen.add(workspace.projectId)
    projects.push(projectDescriptor(workspace))
  }
  return { type: 'project.list.response', payload: { requestId, projects } }
}

/** `fetch_agents_response`. */
export function agentsResponse(
  requestId: string,
  subscriptionId: string | null,
  entries: readonly { agent: AgentRecord; workspace: WorkspaceRecord }[],
): Record<string, unknown> {
  return {
    type: 'fetch_agents_response',
    payload: {
      requestId,
      subscriptionId,
      entries: entries.map(({ agent, workspace }) => ({ agent: agentSnapshot(agent), project: placement(workspace) })),
      pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
    },
  }
}

/** `fetch_agent_response`. */
export function agentResponse(requestId: string, agent: AgentRecord | null, workspace: WorkspaceRecord | null, error: string | null): Record<string, unknown> {
  return {
    type: 'fetch_agent_response',
    payload: {
      requestId,
      agent: agent === null ? null : agentSnapshot(agent),
      project: workspace === null ? null : placement(workspace),
      error,
    },
  }
}

/** `fetch_agent_timeline_response`. */
export function timelineResponse(
  requestId: string,
  agent: AgentRecord,
  epoch: string,
  entries: readonly TimelineEntry[],
): Record<string, unknown> {
  const seqs = entries.map((entry) => entry.seq)
  const minSeq = seqs.length === 0 ? 0 : Math.min(...seqs)
  const maxSeq = seqs.length === 0 ? 0 : Math.max(...seqs)
  return {
    type: 'fetch_agent_timeline_response',
    payload: {
      requestId,
      agentId: agent.id,
      agent: agentSnapshot(agent),
      direction: 'tail',
      projection: 'projected',
      epoch,
      reset: true,
      staleCursor: false,
      gap: false,
      window: { minSeq, maxSeq, nextSeq: maxSeq + 1 },
      startCursor: null,
      endCursor: null,
      hasOlder: false,
      hasNewer: false,
      entries: entries.map((entry) => timelineEntry(agent.provider, entry)),
      error: null,
    },
  }
}

/** `send_agent_message_response`. */
export function sendMessageResponse(requestId: string, agent: AgentRecord): Record<string, unknown> {
  return {
    type: 'send_agent_message_response',
    payload: { requestId, agentId: agent.id, accepted: true, error: null },
  }
}

/** `send_agent_message_response` for a rejected prompt. */
export function sendMessageRejected(requestId: string, agentId: string, error: string): Record<string, unknown> {
  return { type: 'send_agent_message_response', payload: { requestId, agentId, accepted: false, error } }
}

/** `cancel_agent_response`. */
export function cancelResponse(requestId: string, agentId: string, agent: AgentRecord | null): Record<string, unknown> {
  return {
    type: 'cancel_agent_response',
    payload: { requestId, agentId, agent: agent === null ? null : agentSnapshot(agent), error: null },
  }
}

/** `wait_for_finish_response`. */
export function waitForFinishResponse(
  requestId: string,
  status: 'idle' | 'error' | 'permission' | 'timeout',
  agent: AgentRecord | null,
  lastMessage: string | null,
  error: string | null = null,
): Record<string, unknown> {
  return {
    type: 'wait_for_finish_response',
    payload: {
      requestId,
      status,
      final: agent === null ? null : agentSnapshot(agent),
      error,
      lastMessage,
    },
  }
}

/** Statuses an agent settles into, which end a `wait_for_finish_request`. */
export function isSettledStatus(status: AgentRecord['status']): boolean {
  return status === 'idle' || status === 'error' || status === 'closed'
}

/** Legacy creation success: a `status` frame, not a correlated response. */
export function agentCreatedStatus(requestId: string, agent: AgentRecord): Record<string, unknown> {
  return { type: 'status', payload: { status: 'agent_created', requestId, agentId: agent.id, agent: agentSnapshot(agent) } }
}

/** Legacy creation failure: a `status` frame, not a correlated response. */
export function agentCreateFailedStatus(requestId: string, error: string): Record<string, unknown> {
  return { type: 'status', payload: { status: 'agent_create_failed', requestId, error } }
}

/** `agent.create.response`. */
export function agentCreateResponse(requestId: string, agent: AgentRecord | null, error: string | null): Record<string, unknown> {
  return { type: 'agent.create.response', payload: { requestId, agent: agent === null ? null : agentSnapshot(agent), error } }
}

/** `workspace.create.response`. */
export function workspaceCreateResponse(
  requestId: string,
  workspace: WorkspaceRecord | null,
  agent: AgentRecord | null,
  error: string | null,
): Record<string, unknown> {
  return {
    type: 'workspace.create.response',
    payload: {
      requestId,
      workspace: workspace === null ? null : workspaceDescriptor(workspace),
      agent: agent === null ? undefined : agentSnapshot(agent),
      setupTerminalId: null,
      error,
    },
  }
}

/** One provider entry of the providers snapshot. */
export interface ProviderSnapshotInput {
  readonly provider: string
  readonly available: boolean
  readonly models: readonly { readonly id: string; readonly label: string; readonly description?: string }[]
}

/** `get_providers_snapshot_response`. */
export function providersSnapshotResponse(requestId: string, entries: readonly ProviderSnapshotInput[]): Record<string, unknown> {
  return {
    type: 'get_providers_snapshot_response',
    payload: {
      entries: entries.map((entry) => ({
        provider: entry.provider,
        status: entry.available ? 'ready' : 'unavailable',
        enabled: true,
        models: entry.models.map((model) => ({
          provider: entry.provider,
          id: model.id,
          label: model.label,
          isSelectable: true,
          ...(model.description === undefined ? {} : { description: model.description }),
        })),
        modes: [{ id: 'default', label: 'Default' }],
        defaultModeId: 'default',
        ...(entry.available ? {} : { error: 'no credential is configured for this provider' }),
      })),
      generatedAt: new Date().toISOString(),
      requestId,
    },
  }
}

/** `list_provider_models_response`. */
export function providerModelsResponse(
  requestId: string,
  provider: string,
  models: readonly { readonly id: string; readonly label: string; readonly description?: string }[],
): Record<string, unknown> {
  return {
    type: 'list_provider_models_response',
    payload: {
      provider,
      models: models.map((model) => ({
        provider,
        id: model.id,
        label: model.label,
        isSelectable: true,
        ...(model.description === undefined ? {} : { description: model.description }),
      })),
      error: null,
      fetchedAt: new Date().toISOString(),
      requestId,
    },
  }
}

/** `list_available_providers_response`. */
export function availableProvidersResponse(
  requestId: string,
  providers: readonly { readonly provider: string; readonly available: boolean }[],
): Record<string, unknown> {
  return {
    type: 'list_available_providers_response',
    payload: {
      providers: providers.map((entry) => ({ provider: entry.provider, available: entry.available, error: null })),
      error: null,
      fetchedAt: new Date().toISOString(),
      requestId,
    },
  }
}

/** `list_provider_modes_response`; DSH has no provider-owned modes. */
export function providerModesResponse(requestId: string, provider: string): Record<string, unknown> {
  return {
    type: 'list_provider_modes_response',
    payload: { provider, modes: [{ id: 'default', label: 'Default' }], error: null, fetchedAt: new Date().toISOString(), requestId },
  }
}

/** `checkout_status_response` for one directory. */
export function checkoutStatusResponse(requestId: string, directory: string, status: GitStatus): Record<string, unknown> {
  const common = { cwd: directory, error: null, requestId, isPaseoOwnedWorktree: false as const }
  if (!status.isGit) {
    return {
      type: 'checkout_status_response',
      payload: {
        ...common,
        isGit: false,
        repoRoot: null,
        currentBranch: null,
        isDirty: null,
        baseRef: null,
        aheadBehind: null,
        aheadOfOrigin: null,
        behindOfOrigin: null,
        hasRemote: false,
        remoteUrl: null,
      },
    }
  }
  const ahead = status.aheadOfOrigin
  const behind = status.behindOfOrigin
  return {
    type: 'checkout_status_response',
    payload: {
      ...common,
      isGit: true,
      repoRoot: status.repoRoot ?? directory,
      mainRepoRoot: null,
      currentBranch: status.currentBranch,
      isDirty: status.isDirty,
      baseRef: null,
      aheadBehind: ahead === null || behind === null ? null : { ahead, behind },
      aheadOfOrigin: ahead,
      behindOfOrigin: behind,
      hasRemote: status.hasRemote,
      remoteUrl: status.remoteUrl,
      upstreamRef: status.upstreamRef,
    },
  }
}

/** Shared body of every checkout-diff frame. */
function diffPayload(directory: string, files: readonly DiffFile[]): Record<string, unknown> {
  return {
    cwd: directory,
    files: files.map((file) => ({
      path: file.path,
      ...(file.oldPath === undefined ? {} : { oldPath: file.oldPath }),
      isNew: file.isNew,
      isDeleted: file.isDeleted,
      additions: file.additions,
      deletions: file.deletions,
      hunks: file.hunks.map((hunk) => ({
        oldStart: hunk.oldStart,
        oldCount: hunk.oldCount,
        newStart: hunk.newStart,
        newCount: hunk.newCount,
        lines: hunk.lines.map((line) => ({ type: line.type, content: line.content })),
      })),
      ...(file.status === undefined ? {} : { status: file.status }),
    })),
    error: null,
  }
}

/** `checkout.diff.get.response`, the one-shot read. */
export function checkoutDiffGetResponse(requestId: string, directory: string, files: readonly DiffFile[]): Record<string, unknown> {
  return { type: 'checkout.diff.get.response', payload: { ...diffPayload(directory, files), requestId } }
}

/** `subscribe_checkout_diff_response`, the opening frame of a live subscription. */
export function subscribeCheckoutDiffResponse(
  requestId: string,
  subscriptionId: string,
  directory: string,
  files: readonly DiffFile[],
): Record<string, unknown> {
  return {
    type: 'subscribe_checkout_diff_response',
    payload: { subscriptionId, ...diffPayload(directory, files), requestId },
  }
}

/** `checkout_diff_update`, sent when the working tree changed under a subscription. */
export function checkoutDiffUpdate(subscriptionId: string, directory: string, files: readonly DiffFile[]): Record<string, unknown> {
  return { type: 'checkout_diff_update', payload: { subscriptionId, ...diffPayload(directory, files) } }
}

/** `agent_update` upsert. */
export function agentUpdate(agent: AgentRecord, workspace: WorkspaceRecord | null): Record<string, unknown> {
  return {
    type: 'agent_update',
    payload: {
      kind: 'upsert',
      agent: agentSnapshot(agent),
      project: workspace === null ? null : placement(workspace),
    },
  }
}

/** `agent_update` remove. */
export function agentRemoved(agentId: string): Record<string, unknown> {
  return { type: 'agent_update', payload: { kind: 'remove', agentId } }
}

/** `agent_status`. */
export function agentStatus(agent: AgentRecord): Record<string, unknown> {
  return { type: 'agent_status', payload: { agentId: agent.id, status: agent.status, info: agentSnapshot(agent) } }
}

/** `agent_stream` carrying one timeline row. */
export function agentStream(agent: AgentRecord, entry: TimelineEntry, epoch: string): Record<string, unknown> {
  return {
    type: 'agent_stream',
    payload: {
      agentId: agent.id,
      event: { type: 'timeline', provider: agent.provider, item: timelineItem(entry.item), ...(entry.turnId === undefined ? {} : { turnId: entry.turnId }) },
      timestamp: entry.timestamp,
      seq: entry.seq,
      epoch,
    },
  }
}

/** `workspace_update` upsert. */
export function workspaceUpdate(workspace: WorkspaceRecord): Record<string, unknown> {
  return { type: 'workspace_update', payload: { kind: 'upsert', workspace: workspaceDescriptor(workspace) } }
}

/** `daemon.get_status.response`. */
export function daemonStatus(input: {
  readonly requestId: string
  readonly serverId: string
  readonly version: string
  readonly listen: string | null
  readonly providers: readonly { readonly provider: string; readonly available: boolean }[]
}): Record<string, unknown> {
  return {
    type: 'daemon.get_status.response',
    payload: {
      requestId: input.requestId,
      serverId: input.serverId,
      version: input.version,
      pid: process.pid,
      nodePath: process.execPath,
      startedAt: new Date(Date.now() - process.uptime() * 1_000).toISOString(),
      listen: input.listen,
      relay: null,
      providers: input.providers.map((entry) => ({ provider: entry.provider, available: entry.available, error: null })),
    },
  }
}

/** One terminal in the client's shape. */
export function terminalInfo(record: TerminalRecord): Record<string, unknown> {
  return {
    id: record.id,
    name: record.title.length > 0 ? record.title : 'Terminal',
    cwd: record.cwd,
    workspaceId: record.workspaceId,
    title: record.title,
    activity: null,
  }
}

/** `list_terminals_response`. */
export function terminalsResponse(requestId: string, terminals: readonly TerminalRecord[]): Record<string, unknown> {
  return { type: 'list_terminals_response', payload: { requestId, terminals: terminals.map(terminalInfo) } }
}

/** `create_terminal_response`. */
export function terminalCreated(requestId: string, terminal: TerminalRecord | null, error: string | null): Record<string, unknown> {
  return {
    type: 'create_terminal_response',
    payload: { requestId, terminal: terminal === null ? null : terminalInfo(terminal), error },
  }
}

/** `subscribe_terminal_response`, which hands the client its stream slot. */
export function terminalSubscribed(requestId: string, terminalId: string, slot: number, subscriptionId?: string): Record<string, unknown> {
  return {
    type: 'subscribe_terminal_response',
    payload: {
      requestId,
      terminalId,
      slot,
      error: null,
      ...(subscriptionId === undefined ? {} : { subscriptionId }),
    },
  }
}

/** `subscribe_terminal_response` for a terminal that cannot be attached. */
export function terminalSubscribeFailed(requestId: string, terminalId: string, error: string): Record<string, unknown> {
  return { type: 'subscribe_terminal_response', payload: { requestId, terminalId, error } }
}

/** `kill_terminal_response`. */
export function terminalKilled(requestId: string, terminalId: string, success: boolean): Record<string, unknown> {
  return { type: 'kill_terminal_response', payload: { requestId, terminalId, success } }
}

/** `terminal.rename.response`. */
export function terminalRenamed(requestId: string, terminalId: string, title: string): Record<string, unknown> {
  return { type: 'terminal.rename.response', payload: { requestId, terminalId, title, error: null } }
}

/** `terminals_changed`, which tells every client to re-list. */
export function terminalsChanged(terminals: readonly TerminalRecord[]): Record<string, unknown> {
  return { type: 'terminals_changed', payload: { terminals: terminals.map(terminalInfo) } }
}

/** `subscription.release.response`. */
export function subscriptionReleased(requestId: string): Record<string, unknown> {
  return { type: 'subscription.release.response', payload: { requestId } }
}

/** `session.events.set_subscription.response`. */
export function eventsSubscriptionSet(requestId: string): Record<string, unknown> {
  return { type: 'session.events.set_subscription.response', payload: { requestId } }
}

/** `clear_agent_attention_response`. */
export function attentionCleared(requestId: string): Record<string, unknown> {
  return { type: 'clear_agent_attention_response', payload: { requestId } }
}

/** Statuses whose agents the client shows as needing attention. */
export const ATTENTION_STATUSES: readonly AgentStatus[] = ['idle', 'error']

/** One workspace script in the client's shape. */
export function workspaceScript(record: WorkspaceScriptRecord): Record<string, unknown> {
  return {
    scriptName: record.name,
    type: record.type,
    // A script runs inside this machine's shell; the daemon itself is the host.
    hostname: 'localhost',
    port: record.port,
    localProxyUrl: null,
    publicProxyUrl: null,
    proxyUrl: null,
    lifecycle: record.lifecycle,
    health: record.health,
    exitCode: record.exitCode,
    terminalId: null,
  }
}

/** One `workspace.script.*` response, which all three requests share. */
export function workspaceScriptResponse(
  type: 'workspace.script.list.response' | 'workspace.script.start.response' | 'workspace.script.stop.response',
  requestId: string,
  workspaceId: string,
  scripts: readonly WorkspaceScriptRecord[],
  error: string | null = null,
  scriptName?: string,
): Record<string, unknown> {
  return {
    type,
    payload: {
      requestId,
      workspaceId,
      ...(scriptName === undefined ? {} : { scriptName }),
      scripts: scripts.map(workspaceScript),
      error,
    },
  }
}

/** `script_status_update`, which tells clients to re-list a workspace's scripts. */
export function scriptStatusUpdate(workspaceId: string, scripts: readonly WorkspaceScriptRecord[]): Record<string, unknown> {
  return { type: 'script_status_update', payload: { workspaceId, scripts: scripts.map(workspaceScript) } }
}

/** `agent_deleted`, the answer to a delete request this daemon archives instead. */
export function agentDeleted(agentId: string): Record<string, unknown> {
  return { type: 'agent_deleted', payload: { agentId } }
}

/** `schedule/list/response`. */
export function scheduleList(requestId: string, schedules: readonly ScheduleRecord[]): Record<string, unknown> {
  return { type: 'schedule/list/response', payload: { requestId, schedules: schedules.map(scheduleSummary), error: null } }
}

/** `schedule/create/response`. */
export function scheduleCreated(requestId: string, schedule: ScheduleRecord | null, error: string | null): Record<string, unknown> {
  return {
    type: 'schedule/create/response',
    payload: { requestId, schedule: schedule === null ? null : scheduleSummary(schedule), error },
  }
}

/** `schedule/delete/response`. */
export function scheduleDeleted(requestId: string, scheduleId: string, error: string | null = null): Record<string, unknown> {
  return { type: 'schedule/delete/response', payload: { requestId, scheduleId, error } }
}

/** `schedule/run-once/response`. */
export function scheduleRanOnce(requestId: string, scheduleId: string, error: string | null = null): Record<string, unknown> {
  return { type: 'schedule/run-once/response', payload: { requestId, scheduleId, error } }
}

/** One reminder in the client's shape. */
function scheduleSummary(record: ScheduleRecord): Record<string, unknown> {
  return {
    id: record.id,
    name: record.name,
    prompt: record.prompt,
    cadence: record.cadence,
    target: { type: 'agent', agentId: record.agentId },
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.createdAt,
    nextRunAt: record.nextRunAt,
    lastRunAt: null,
    pausedAt: null,
    expiresAt: null,
    maxRuns: null,
  }
}

/** `checkout_pr_status_response`. */
export function checkoutPrStatusResponse(
  requestId: string,
  directory: string,
  lookup: PullRequestLookup,
): Record<string, unknown> {
  const status = lookup.status
  return {
    type: 'checkout_pr_status_response',
    payload: {
      cwd: directory,
      status: status === null
        ? null
        : {
            forge: 'github',
            projectPath: directory,
            number: status.number,
            url: status.url,
            title: status.title,
            state: status.state,
            baseRefName: status.baseRefName,
            headRefName: status.headRefName,
            isMerged: status.isMerged,
            isDraft: status.isDraft,
            mergeable: status.mergeable,
            checks: status.checks.map((check) => ({ name: check.name, status: check.status, url: check.url })),
            checksStatus: null,
            reviewDecision: null,
            repoOwner: status.repoOwner,
            repoName: status.repoName,
          },
      // Features follow authentication, not whether this branch happens to have a pull request.
      githubFeaturesEnabled: lookup.authenticated,
      authState: lookup.authenticated ? 'authenticated' : 'unauthenticated',
      forge: 'github',
      error: lookup.error === null ? null : { code: 'UNKNOWN', message: lookup.error },
      requestId,
    },
  }
}
