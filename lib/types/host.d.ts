/**
 * The slice of the DeepSeek Harness host surface this plugin uses, declared
 * structurally.
 *
 * The plugin installs from outside the harness checkout and has no runtime
 * dependency on harness packages: the services it reaches are typed here, and
 * a composition that mounts none of them simply omits that capability. The
 * same shape lets the unit tests drive `apply` with a plain fake context.
 *
 * @module dsh-paseo-server/host
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
/** Disposer returned by every host registration. */
export type Disposable = () => void;
/** Logger surface the Cordis context provides. */
export interface HostLogger {
    /** Diagnostic detail. */
    debug(message: string): void;
    /** Ordinary progress. */
    info(message: string): void;
    /** Recoverable failure. */
    warn(message: string): void;
}
/** One prompt content part accepted by the session controller. */
export type PromptPart = {
    readonly type: 'text';
    readonly text: string;
};
/** One row of `sessionController.list()`. */
export interface SessionSummaryLike {
    readonly sessionId: string;
    readonly cwd?: string;
    readonly running: boolean;
    readonly agentAvailable: boolean;
    readonly blank: boolean;
    readonly parentSessionId?: string;
    readonly origin?: 'subagent';
    readonly updatedAt: number;
}
/** Durable session surface used for timeline reconstruction. */
export interface SessionLike {
    readonly id: string;
    readonly seq: number;
    readonly header: {
        readonly cwd?: string;
    };
    /** Durable events in `[from, to)`, oldest first. */
    snapshotEvents(from?: number, to?: number): readonly SessionEventLike[];
    /** Request header of the latest model call, when one was recorded. */
    requestHeader?(): {
        readonly config?: {
            readonly provider?: string;
            readonly model?: string;
        };
    } | undefined;
}
/** One durable session event. */
export interface SessionEventLike {
    readonly type: string;
    readonly seq: number;
    readonly time: number;
    readonly data: Record<string, unknown>;
}
/** Session store surface. */
export interface SessionsLike {
    get(id: string): SessionLike | undefined;
    list(): readonly SessionLike[];
}
/** Live agent surface. */
export interface AgentsLike {
    get(id: string): {
        readonly id: string;
    } | undefined;
    list(): readonly {
        readonly id: string;
    }[];
}
/** Workspace record surface. */
export interface WorkspaceLike {
    readonly id: string;
    readonly path: string;
    readonly title: string;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly sessionIds: readonly string[];
}
/** Workspace registry surface. */
export interface WorkspaceRegistryLike {
    list(): readonly WorkspaceLike[];
    create(path: string, title?: string): Promise<WorkspaceLike>;
}
/** High-level session API the client protocol is built on. */
export interface SessionControllerLike {
    list(request: Record<string, never>, signal: AbortSignal): Promise<{
        readonly items: readonly SessionSummaryLike[];
    }>;
    create(request: {
        readonly cwd?: string;
        readonly workspaceId?: string;
        readonly sessionId?: string;
    }): Promise<{
        readonly sessionId: string;
    }>;
    prompt(request: {
        readonly requestId: string;
        readonly sessionId: string;
        readonly mode: 'queue' | 'steer';
        readonly content: readonly PromptPart[];
    }, signal: AbortSignal): Promise<{
        readonly accepted: boolean;
    }>;
    cancel(request: {
        readonly sessionId: string;
    }): Promise<{
        readonly accepted: boolean;
    }>;
    /** Install a model selection on a session, when the composition supports it. */
    selectModel?(request: {
        readonly sessionId: string;
        readonly provider: string;
        readonly model: string;
        readonly reasoningEffort?: string;
    }): Promise<{
        readonly selected: {
            readonly provider: string;
            readonly model: string;
        };
    }>;
    /** Rename a session, when the composition supports it. */
    rename?(request: {
        readonly sessionId: string;
        readonly title: string;
    }): Promise<{
        readonly title: string;
    }>;
}
/** One HTTP route registration. */
export interface WebRouteLike {
    readonly kind: 'exact' | 'prefix';
    readonly path: string;
    readonly handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
}
/** One exact-path upgrade route registration. */
export interface WebUpgradeRouteLike {
    readonly path: string;
    readonly handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void>;
}
/** Shared HTTP listener surface. */
export interface WebServerLike {
    register(route: WebRouteLike): Disposable;
    registerUpgrade(route: WebUpgradeRouteLike): Disposable;
    /** Bound listen host, when the listener reports one. */
    readonly host?: string;
    /** Bound listen port, when the listener reports one. */
    readonly port?: number;
}
/** The context surface this plugin reaches. */
export interface HostContext {
    readonly logger: HostLogger;
    /** Resolve one named service, or undefined when the composition omits it. */
    get(name: string): unknown;
    /** Subscribe to a host event. */
    on(event: string, listener: (...args: never[]) => void): Disposable;
    /** Register a side effect and its disposer with the plugin's fiber. */
    effect(callback: () => Disposable | void, label?: string): void;
    /** The plugin's own loader row, when one exists. */
    readonly fiber?: {
        readonly entry?: {
            readonly options?: {
                readonly id?: string;
            };
        };
    };
}
