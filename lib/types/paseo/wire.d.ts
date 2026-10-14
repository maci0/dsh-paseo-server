/**
 * Paseo wire format: the session messages this daemon emits and accepts.
 *
 * Field sets and required flags mirror the Paseo 0.11.2 protocol schemas. The
 * shapes are protocol facts; this module encodes only the subset a client
 * needs to list workspaces and agents, read a timeline, and drive a turn.
 *
 * @module dsh-paseo-server/paseo/wire
 */
import type { DirectoryEntry, FileContent } from '../dsh/files.ts';
import type { CheckDetails, ForgeWriteResult, PullRequestLookup, PullRequestTimelineItem } from '../dsh/forge.ts';
import type { BranchEntry, CommitEntry, DiffFile, GitStatus, StashEntry } from '../dsh/git.ts';
import type { AgentRecord, AgentStatus, TerminalRecord, TimelineEntry, TimelineItem, WorkspaceRecord, ScheduleRecord, WorkspaceScriptRecord } from '../bridge.ts';
/** Protocol version the 0.11.2 client sends and expects. */
export declare const PASEO_PROTOCOL_VERSION = 1;
/** Paseo daemon version this server reports. */
export declare const PASEO_DAEMON_VERSION = "0.11.2";
/** Session-capability names the connected client advertises. */
export interface ClientHello {
    readonly clientId: string;
    readonly clientType: 'mobile' | 'browser' | 'cli' | 'mcp' | 'hub';
    readonly protocolVersion: number;
    readonly auth?: {
        readonly kind: 'password';
        readonly password: string;
    } | {
        readonly kind: 'localCredential';
        readonly token: string;
    };
    readonly appVersion?: string;
}
/** One inbound frame from a Paseo client. */
export type InboundFrame = {
    readonly kind: 'hello';
    readonly hello: ClientHello;
} | {
    readonly kind: 'ping';
} | {
    readonly kind: 'recording_state';
} | {
    readonly kind: 'request';
    readonly message: Record<string, unknown>;
};
/** Message types this server answers. Anything else draws `rpc_error`. */
export declare const SUPPORTED_REQUESTS: readonly string[];
/**
 * Parse one raw WebSocket text frame.
 * @param raw - frame text.
 * @returns the parsed frame, or null when it is not a known Paseo frame.
 */
export declare function parseInbound(raw: string): InboundFrame | null;
/** Wrap one session message in the WebSocket envelope. */
export declare function envelope(message: Record<string, unknown>): string;
/** The `status` frame sent once per connection right after `hello`. */
export declare function serverInfo(bridge: {
    serverId: string;
    version: string;
}, hostname: string): Record<string, unknown>;
/** `pong` for a `ping` frame. */
export declare function pong(): string;
/** A correlated failure for one request. */
export declare function rpcError(requestId: string, requestType: string, message: string, code?: string): Record<string, unknown>;
/** One workspace as the client's workspace descriptor. */
export declare function workspaceDescriptor(workspace: WorkspaceRecord): Record<string, unknown>;
/** One project descriptor. */
export declare function projectDescriptor(workspace: WorkspaceRecord): Record<string, unknown>;
/** One placement payload for an agent's project. */
export declare function placement(workspace: WorkspaceRecord): Record<string, unknown>;
/** One agent snapshot. */
export declare function agentSnapshot(agent: AgentRecord): Record<string, unknown>;
/** One timeline item in wire form. */
export declare function timelineItem(item: TimelineItem): Record<string, unknown>;
/** One timeline entry in wire form. */
export declare function timelineEntry(provider: string, entry: TimelineEntry): Record<string, unknown>;
/** `fetch_workspaces_response`. */
export declare function workspacesResponse(requestId: string, subscriptionId: string | null, workspaces: readonly WorkspaceRecord[]): Record<string, unknown>;
/** `project.list.response`. */
export declare function projectsResponse(requestId: string, workspaces: readonly WorkspaceRecord[]): Record<string, unknown>;
/** `fetch_agents_response`. */
export declare function agentsResponse(requestId: string, subscriptionId: string | null, entries: readonly {
    agent: AgentRecord;
    workspace: WorkspaceRecord;
}[]): Record<string, unknown>;
/** `fetch_agent_response`. */
export declare function agentResponse(requestId: string, agent: AgentRecord | null, workspace: WorkspaceRecord | null, error: string | null): Record<string, unknown>;
/** `fetch_agent_timeline_response`. */
export declare function timelineResponse(requestId: string, agent: AgentRecord, epoch: string, entries: readonly TimelineEntry[]): Record<string, unknown>;
/** `send_agent_message_response`. */
export declare function sendMessageResponse(requestId: string, agent: AgentRecord): Record<string, unknown>;
/** `send_agent_message_response` for a rejected prompt. */
export declare function sendMessageRejected(requestId: string, agentId: string, error: string): Record<string, unknown>;
/** `cancel_agent_response`. */
export declare function cancelResponse(requestId: string, agentId: string, agent: AgentRecord | null): Record<string, unknown>;
/** `wait_for_finish_response`. */
export declare function waitForFinishResponse(requestId: string, status: 'idle' | 'error' | 'permission' | 'timeout', agent: AgentRecord | null, lastMessage: string | null, error?: string | null): Record<string, unknown>;
/** Statuses an agent settles into, which end a `wait_for_finish_request`. */
export declare function isSettledStatus(status: AgentRecord['status']): boolean;
/** Legacy creation success: a `status` frame, not a correlated response. */
export declare function agentCreatedStatus(requestId: string, agent: AgentRecord): Record<string, unknown>;
/** Legacy creation failure: a `status` frame, not a correlated response. */
export declare function agentCreateFailedStatus(requestId: string, error: string): Record<string, unknown>;
/** `agent.create.response`. */
export declare function agentCreateResponse(requestId: string, agent: AgentRecord | null, error: string | null): Record<string, unknown>;
/** `workspace.create.response`. */
export declare function workspaceCreateResponse(requestId: string, workspace: WorkspaceRecord | null, agent: AgentRecord | null, error: string | null): Record<string, unknown>;
/** One provider entry of the providers snapshot. */
export interface ProviderSnapshotInput {
    readonly provider: string;
    readonly available: boolean;
    readonly models: readonly {
        readonly id: string;
        readonly label: string;
        readonly description?: string;
    }[];
}
/** `get_providers_snapshot_response`. */
export declare function providersSnapshotResponse(requestId: string, entries: readonly ProviderSnapshotInput[]): Record<string, unknown>;
/** `list_provider_models_response`. */
export declare function providerModelsResponse(requestId: string, provider: string, models: readonly {
    readonly id: string;
    readonly label: string;
    readonly description?: string;
}[]): Record<string, unknown>;
/** `list_available_providers_response`. */
export declare function availableProvidersResponse(requestId: string, providers: readonly {
    readonly provider: string;
    readonly available: boolean;
}[]): Record<string, unknown>;
/** `list_provider_modes_response`; DSH has no provider-owned modes. */
export declare function providerModesResponse(requestId: string, provider: string): Record<string, unknown>;
/** `checkout_status_response` for one directory. */
export declare function checkoutStatusResponse(requestId: string, directory: string, status: GitStatus): Record<string, unknown>;
/** `checkout.diff.get.response`, the one-shot read. */
export declare function checkoutDiffGetResponse(requestId: string, directory: string, files: readonly DiffFile[]): Record<string, unknown>;
/** `subscribe_checkout_diff_response`, the opening frame of a live subscription. */
export declare function subscribeCheckoutDiffResponse(requestId: string, subscriptionId: string, directory: string, files: readonly DiffFile[]): Record<string, unknown>;
/** `checkout_diff_update`, sent when the working tree changed under a subscription. */
export declare function checkoutDiffUpdate(subscriptionId: string, directory: string, files: readonly DiffFile[]): Record<string, unknown>;
/** `agent_update` upsert. */
export declare function agentUpdate(agent: AgentRecord, workspace: WorkspaceRecord | null): Record<string, unknown>;
/** `agent_update` remove. */
export declare function agentRemoved(agentId: string): Record<string, unknown>;
/** `agent_status`. */
export declare function agentStatus(agent: AgentRecord): Record<string, unknown>;
/** `agent_stream` carrying one timeline row. */
export declare function agentStream(agent: AgentRecord, entry: TimelineEntry, epoch: string): Record<string, unknown>;
/** `workspace_update` upsert. */
export declare function workspaceUpdate(workspace: WorkspaceRecord): Record<string, unknown>;
/** `daemon.get_status.response`. */
export declare function daemonStatus(input: {
    readonly requestId: string;
    readonly serverId: string;
    readonly version: string;
    readonly listen: string | null;
    readonly providers: readonly {
        readonly provider: string;
        readonly available: boolean;
    }[];
}): Record<string, unknown>;
/** One terminal in the client's shape. */
export declare function terminalInfo(record: TerminalRecord): Record<string, unknown>;
/** `list_terminals_response`. */
export declare function terminalsResponse(requestId: string, terminals: readonly TerminalRecord[]): Record<string, unknown>;
/** `create_terminal_response`. */
export declare function terminalCreated(requestId: string, terminal: TerminalRecord | null, error: string | null): Record<string, unknown>;
/** `subscribe_terminal_response`, which hands the client its stream slot. */
export declare function terminalSubscribed(requestId: string, terminalId: string, slot: number, subscriptionId?: string): Record<string, unknown>;
/** `subscribe_terminal_response` for a terminal that cannot be attached. */
export declare function terminalSubscribeFailed(requestId: string, terminalId: string, error: string): Record<string, unknown>;
/** `kill_terminal_response`. */
export declare function terminalKilled(requestId: string, terminalId: string, success: boolean): Record<string, unknown>;
/** `terminal.rename.response`. */
export declare function terminalRenamed(requestId: string, terminalId: string, title: string): Record<string, unknown>;
/** `terminals_changed`, which tells every client to re-list. */
export declare function terminalsChanged(terminals: readonly TerminalRecord[]): Record<string, unknown>;
/** `subscription.release.response`. */
export declare function subscriptionReleased(requestId: string): Record<string, unknown>;
/** `session.events.set_subscription.response`. */
export declare function eventsSubscriptionSet(requestId: string): Record<string, unknown>;
/** `clear_agent_attention_response`. */
export declare function attentionCleared(requestId: string): Record<string, unknown>;
/** Statuses whose agents the client shows as needing attention. */
export declare const ATTENTION_STATUSES: readonly AgentStatus[];
/**
 * One workspace script in the client's shape.
 * @param record - the script and its lifecycle.
 * @param proxyBase - base a client can reach this daemon on, for the local proxy URL.
 */
export declare function workspaceScript(record: WorkspaceScriptRecord, proxyBase?: string): Record<string, unknown>;
/** One `workspace.script.*` response, which all three requests share. */
export declare function workspaceScriptResponse(type: 'workspace.script.list.response' | 'workspace.script.start.response' | 'workspace.script.stop.response', requestId: string, workspaceId: string, scripts: readonly WorkspaceScriptRecord[], error?: string | null, scriptName?: string, proxyBase?: string): Record<string, unknown>;
/** `script_status_update`, which tells clients to re-list a workspace's scripts. */
export declare function scriptStatusUpdate(workspaceId: string, scripts: readonly WorkspaceScriptRecord[], proxyBase?: string): Record<string, unknown>;
/** `agent_deleted`, the answer to a delete request this daemon archives instead. */
export declare function agentDeleted(agentId: string): Record<string, unknown>;
/** `schedule/list/response`. */
export declare function scheduleList(requestId: string, schedules: readonly ScheduleRecord[]): Record<string, unknown>;
/** `schedule/create/response`. */
export declare function scheduleCreated(requestId: string, schedule: ScheduleRecord | null, error: string | null): Record<string, unknown>;
/** `schedule/delete/response`. */
export declare function scheduleDeleted(requestId: string, scheduleId: string, error?: string | null): Record<string, unknown>;
/** `schedule/run-once/response`. */
export declare function scheduleRanOnce(requestId: string, scheduleId: string, error?: string | null): Record<string, unknown>;
/** `schedule/pause/response`. */
export declare function schedulePaused(requestId: string, scheduleId: string, error: string | null): Record<string, unknown>;
/** `schedule/resume/response`. */
export declare function scheduleResumed(requestId: string, scheduleId: string, schedule: ScheduleRecord | null, error: string | null): Record<string, unknown>;
/** `checkout_pr_status_response`. */
export declare function checkoutPrStatusResponse(requestId: string, directory: string, lookup: PullRequestLookup): Record<string, unknown>;
/** `checkout_pr_create_response`. */
export declare function pullRequestCreated(requestId: string, directory: string, result: ForgeWriteResult): Record<string, unknown>;
/** `checkout_pr_merge_response` and its auto-merge sibling. */
export declare function pullRequestWriteResponse(type: 'checkout_pr_merge_response' | 'checkout.forge.set_auto_merge.response' | 'checkout.github.set_auto_merge.response', requestId: string, directory: string, result: ForgeWriteResult, enabled?: boolean): Record<string, unknown>;
/** `pull_request_timeline_response`. */
export declare function pullRequestTimelineResponse(requestId: string, directory: string, number: number | null, items: readonly PullRequestTimelineItem[], error: string | null): Record<string, unknown>;
/** `checkout.forge.get_check_details.response` and its GitHub sibling. */
export declare function checkDetailsResponse(type: 'checkout.forge.get_check_details.response' | 'checkout.github.get_check_details.response', requestId: string, directory: string, details: CheckDetails | null, error: string | null): Record<string, unknown>;
/** `branch_suggestions_response`. */
export declare function branchSuggestions(requestId: string, branches: readonly BranchEntry[], error?: string | null): Record<string, unknown>;
/** `validate_branch_response`. */
export declare function branchValidated(requestId: string, result: {
    readonly exists: boolean;
    readonly resolvedRef: string | null;
    readonly isRemote: boolean;
}): Record<string, unknown>;
/** `stash_list_response`. */
export declare function stashEntries(requestId: string, directory: string, entries: readonly StashEntry[]): Record<string, unknown>;
/** `checkout.commits.list.response`. */
export declare function commitList(requestId: string, directory: string, commits: readonly CommitEntry[], baseRef?: string | null): Record<string, unknown>;
/** `checkout.commits.file_diff.response`, carrying the same parsed files as a working diff. */
export declare function commitDiff(requestId: string, directory: string, sha: string, path: string, files: readonly DiffFile[]): Record<string, unknown>;
/** `file_explorer_response` for a directory listing. */
export declare function directoryListing(requestId: string, directory: string, path: string, entries: readonly DirectoryEntry[]): Record<string, unknown>;
/** `file_explorer_response` for one file. */
export declare function fileContents(requestId: string, directory: string, path: string, file: FileContent | null, error: string | null): Record<string, unknown>;
/** `list_available_editors_response`, which names the editors a client may open in. */
export declare function availableEditors(requestId: string, editors: readonly {
    id: string;
    label: string;
}[]): Record<string, unknown>;
/** `open_in_editor_response`. */
export declare function openedInEditor(requestId: string, error: string | null): Record<string, unknown>;
/** `archive_workspace_response`. */
export declare function workspaceArchived(requestId: string, workspaceId: string, success: boolean): Record<string, unknown>;
/** `workspace.pin.set.response`. */
export declare function workspacePinned(requestId: string, workspaceId: string, accepted: boolean, pinnedAt: string | null, error: string | null): Record<string, unknown>;
/** `workspace.title.set.response`, which reports that this daemon cannot retitle. */
export declare function workspaceTitleSet(requestId: string, workspaceId: string, accepted: boolean, title: string | null, error: string | null): Record<string, unknown>;
/** `workspace.clear_attention.response`. */
export declare function attentionClearedFor(requestId: string, workspaceIds: readonly string[], clearedAgentIds: readonly string[]): Record<string, unknown>;
/** `workspace.mark_unread.response`. */
export declare function workspaceMarkedUnread(requestId: string, workspaceId: string, markedAgentId: string | null, success: boolean, error: string | null): Record<string, unknown>;
/** `project.add.response`. */
export declare function projectAdded(requestId: string, workspace: WorkspaceRecord | null, error: string | null): Record<string, unknown>;
/** `project.remove.response`. */
export declare function projectRemoved(requestId: string, projectId: string, workspaceIds: readonly string[], error: string | null): Record<string, unknown>;
/** `directory_suggestions_response`. */
export declare function directorySuggestions(requestId: string, entries: readonly {
    readonly path: string;
    readonly kind: 'file' | 'directory';
}[], includeFiles: boolean): Record<string, unknown>;
/** `read_project_config_response`. */
export declare function projectConfigRead(requestId: string, repoRoot: string, config: unknown, revision: {
    readonly mtimeMs: number;
    readonly size: number;
} | null): Record<string, unknown>;
/** `read_project_config_response` for a directory this daemon does not serve. */
export declare function projectConfigMissing(requestId: string, repoRoot: string, code: 'project_not_found' | 'invalid_project_config' | 'write_failed'): Record<string, unknown>;
/** `write_project_config_response`. */
export declare function projectConfigWritten(requestId: string, repoRoot: string, config: unknown, revision: {
    readonly mtimeMs: number;
    readonly size: number;
}): Record<string, unknown>;
/** `write_project_config_response` failure. */
export declare function projectConfigWriteFailed(requestId: string, repoRoot: string, code: 'project_not_found' | 'invalid_project_config' | 'stale_project_config' | 'write_failed'): Record<string, unknown>;
