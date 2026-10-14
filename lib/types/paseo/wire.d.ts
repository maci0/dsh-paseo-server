/**
 * Paseo wire format: the session messages this daemon emits and accepts.
 *
 * Field sets and required flags mirror the Paseo 0.11.2 protocol schemas. The
 * shapes are protocol facts; this module encodes only the subset a client
 * needs to list workspaces and agents, read a timeline, and drive a turn.
 *
 * @module dsh-paseo-server/paseo/wire
 */
import type { GitStatus } from '../dsh/git.ts';
import type { AgentRecord, AgentStatus, TimelineEntry, TimelineItem, WorkspaceRecord } from '../bridge.ts';
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
/** `list_terminals_response` with no terminals. */
export declare function noTerminals(requestId: string): Record<string, unknown>;
/** `subscription.release.response`. */
export declare function subscriptionReleased(requestId: string): Record<string, unknown>;
/** `session.events.set_subscription.response`. */
export declare function eventsSubscriptionSet(requestId: string): Record<string, unknown>;
/** `clear_agent_attention_response`. */
export declare function attentionCleared(requestId: string): Record<string, unknown>;
/** Statuses whose agents the client shows as needing attention. */
export declare const ATTENTION_STATUSES: readonly AgentStatus[];
