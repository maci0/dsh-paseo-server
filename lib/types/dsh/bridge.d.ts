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
import type { AgentStatus, PaseoBridge, TimelineEntry, WorkspaceStatus } from '../bridge.ts';
import type { HostContext, SessionEventLike } from '../host.ts';
/** Options for {@link createDshBridge}. */
export interface DshBridgeOptions {
    readonly ctx: HostContext;
    /** Fallback provider id when a session has no recorded request header. */
    readonly defaultProvider: string;
    /** Fallback model id when a session has no recorded request header. */
    readonly defaultModel: string;
}
/** A bridge whose daemon identity can be installed after construction. */
export interface DshBridgeHandle extends PaseoBridge {
    bindIdentity(serverId: string, version: string): void;
}
/** Binding that presents a DSH composition as a Paseo bridge. */
export declare function createDshBridge(options: DshBridgeOptions): DshBridgeHandle;
/** Fold a whole log into timeline rows. */
export declare function foldEvents(events: readonly SessionEventLike[]): TimelineEntry[];
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
export declare function foldEvent(event: SessionEventLike, clientMessageId?: string): TimelineEntry[];
/** Concatenate the text blocks of one message. */
export declare function messageText(message: Record<string, unknown>): string | undefined;
/** Concatenate the reasoning blocks of one assistant message. */
export declare function messageReasoning(message: Record<string, unknown>): string | undefined;
/** Workspace status bucket from the statuses of its agents, most severe first. */
export declare function workspaceStatus(statuses: readonly AgentStatus[]): WorkspaceStatus;
