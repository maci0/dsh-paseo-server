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
} | {
    readonly type: 'image';
    readonly mediaType: ImageMediaType;
    readonly data: string;
    readonly name?: string;
};
/** Image encodings the attachment seam accepts; anything else is refused at admission. */
export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
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
    /** Partial projection hints a cold listing can carry, including the title. */
    readonly projections?: {
        readonly values?: Readonly<Record<string, unknown>>;
    };
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
/** One background job, as the job registry projects it. */
export interface JobViewLike {
    readonly id: string;
    readonly status: 'running' | 'stopping' | 'completed' | 'killed' | 'failed';
    /** Terminal reason, such as `exit code: 3`. */
    readonly detail?: string;
}
/** Background job registry surface a workspace script runs on. */
export interface JobsLike {
    start(spec: {
        readonly kind: string;
        readonly label: string;
        readonly run: (job: {
            append(text: string): void;
        }) => {
            cancel(reason?: string): void;
            done: Promise<unknown>;
        };
    }): string;
    get(id: string): JobViewLike;
    kill(id: string, caller?: string, reason?: string): 'requested' | 'already-finished';
    /** Claim that this composition runs the jobs it starts. */
    attachController(name: string): () => void;
}
/** Live agent surface. */
export interface AgentsLike {
    get(id: string): unknown;
    list(): readonly {
        readonly id: string;
    }[];
}
/** One retained terminal, as the terminal controller reports it. */
export interface TerminalInfoLike {
    readonly id: string;
    readonly title: string;
    readonly cwd: string;
    readonly cols: number;
    readonly rows: number;
    readonly state: 'running' | 'exited' | 'failed';
    readonly exitCode: number | null;
    readonly error?: string;
    /** Current writable attachment, when the terminal has one. */
    readonly controllerId?: string;
}
/** One frame of an attached terminal. */
export type TerminalFrameLike = {
    readonly type: 'snapshot';
    readonly sequence: number;
    readonly screen: string;
    readonly info: TerminalInfoLike;
} | {
    readonly type: 'output';
    readonly sequence: number;
    readonly data: string;
} | {
    readonly type: 'state';
    readonly info: TerminalInfoLike;
};
/** Browser-terminal surface: an owner-scoped PTY per Session. */
export interface TerminalControllerLike {
    list(sessionId: string): readonly TerminalInfoLike[];
    create(agent: unknown, request: {
        readonly id: string;
        readonly cols: number;
        readonly rows: number;
        readonly shellPath?: string;
    }, signal: AbortSignal): Promise<TerminalInfoLike>;
    follow(agent: unknown, id: string, attachmentId: string, signal: AbortSignal): AsyncIterable<TerminalFrameLike>;
    write(agent: unknown, id: string, attachmentId: string, data: string): Promise<void>;
    resize(agent: unknown, id: string, attachmentId: string, cols: number, rows: number): Promise<void>;
    rename(agent: unknown, id: string, title: string): void;
    close(agent: unknown, id: string): Promise<void>;
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
/** One durable reminder, with the rule fields the service stores. */
export interface ScheduleRecordLike {
    readonly id: string;
    readonly title: string;
    readonly prompt: string;
    /** Absent on a record read back from storage, where an active row is implied. */
    readonly status?: 'active' | 'inactive';
    readonly kind: 'after' | 'at' | 'every' | 'daily' | 'weekly' | 'cron';
    readonly scheduledAt?: string;
    readonly everySeconds?: number;
    readonly expression?: string;
    readonly timeZone?: string;
    /** Clock time of a daily or weekly reminder, as `HH:MM:SS`. */
    readonly time?: string;
    readonly weekdays?: readonly number[];
}
/** Durable reminder surface, scoped to the Session that owns each reminder. */
export interface ScheduleServiceLike {
    create(sessionId: string, request: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
    list(request: {
        readonly sessionId: string;
    }): Promise<readonly ScheduleRecordLike[]>;
    delete(request: {
        readonly sessionId: string;
        readonly id: string;
    }, signal?: AbortSignal): Promise<unknown>;
    history(request: {
        readonly sessionId: string;
        readonly id: string;
        readonly limit: number;
    }): Promise<unknown>;
}
/** Workspace registry surface. */
export interface WorkspaceRegistryLike {
    list(): readonly WorkspaceLike[];
    create(path: string, title?: string): Promise<WorkspaceLike>;
    /** Sessions the operator archived; an archived session is hidden from the active list. */
    readonly archivedSessionIds?: readonly string[];
    /** Archive one session, which bars it from running a model step until restored. */
    archiveSession?(sessionId: string, options?: Record<string, unknown>): Promise<void>;
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
    /** One message-aligned page of a Session log, readable while the Session is cold. */
    page?(request: {
        readonly address: {
            readonly kind: 'session';
            readonly sessionId: string;
        };
        /** Inclusive log cut; read one from {@link SessionControllerLike.projections} first. */
        readonly throughSeq: number;
        readonly beforeSeq?: number;
        readonly maxMessages?: number;
    }, signal: AbortSignal): Promise<{
        readonly records: readonly {
            readonly event: SessionEventLike;
        }[];
        readonly hasMore: boolean;
    }>;
    /** The projection watermark a cold Session's log reaches, which a page needs as its cut. */
    projections?(request: {
        readonly sessionId: string;
    }, signal: AbortSignal): Promise<{
        readonly kind?: string;
        readonly asOfSeq?: number;
    } | null>;
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
    /** Listener scheme, `http:` or `https:`, when it reports one. */
    readonly protocol?: string;
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
