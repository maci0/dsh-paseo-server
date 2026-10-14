/**
 * The surface the Paseo protocol layer needs from the agent runtime behind it.
 *
 * The Paseo wire layer never reaches into DeepSeek Harness directly: it calls
 * this interface, so the protocol can be tested against a static host and the
 * DSH binding stays one file that maps concepts.
 *
 * @module dsh-paseo-server/bridge
 */
/** Disposer returned by every subscription. */
export type Disposable = () => void;
/** Paseo agent lifecycle statuses, as the protocol defines them. */
export type AgentStatus = 'initializing' | 'idle' | 'running' | 'error' | 'closed';
/** Workspace status bucket the Paseo sidebar renders. */
export type WorkspaceStatus = 'needs_input' | 'failed' | 'running' | 'attention' | 'done';
/** One directory checkout behind a workspace. */
export interface Checkout {
    /** Git repository root, or the workspace directory when the path is not a repository. */
    readonly repoRoot: string;
    /** True when the directory is inside a git work tree. */
    readonly isGit: boolean;
}
/** One Paseo workspace: a directory holding agents. */
export interface WorkspaceRecord {
    readonly id: string;
    readonly projectId: string;
    readonly projectKey: string;
    readonly projectName: string;
    readonly projectRootPath: string;
    readonly projectKind: 'git' | 'non_git' | 'directory';
    readonly name: string;
    readonly directory: string;
    readonly status: WorkspaceStatus;
    readonly statusEnteredAt: string | null;
    readonly activityAt: string | null;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly checkout: Checkout;
}
/** One Paseo agent: a controllable conversation in a workspace. */
export interface AgentRecord {
    readonly id: string;
    readonly shortId: string;
    readonly title: string | null;
    readonly provider: string;
    readonly model: string | null;
    readonly status: AgentStatus;
    readonly cwd: string;
    readonly workspaceId: string;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly lastUserMessageAt: string | null;
    readonly archivedAt?: string | null;
    readonly activeTurn?: {
        readonly turnId: string;
        readonly startedAt: string | null;
    } | null;
}
/** One rendered timeline row. */
export type TimelineItem = {
    readonly type: 'user_message';
    readonly text: string;
    /** Runtime identity of the message, carried so a client can reconcile rows. */
    readonly messageId?: string;
    /** Client-minted identity of the submission, echoed back from the send. */
    readonly clientMessageId?: string;
} | {
    readonly type: 'assistant_message';
    readonly text: string;
    readonly messageId?: string;
} | {
    readonly type: 'reasoning';
    readonly text: string;
} | {
    readonly type: 'tool_call';
    readonly callId: string;
    readonly name: string;
    readonly status: string;
    readonly input: unknown;
    readonly output?: unknown;
    readonly error?: string;
} | {
    readonly type: 'error';
    readonly message: string;
} | {
    readonly type: 'notification';
    readonly level: 'info' | 'warning' | 'error';
    readonly message: string;
};
/** One timeline row plus its position in the agent's log. */
export interface TimelineEntry {
    readonly item: TimelineItem;
    readonly timestamp: string;
    readonly seq: number;
    /** Turn the row belongs to, when the runtime reports one. */
    readonly turnId?: string;
}
/** Events the bridge pushes toward connected Paseo clients. */
export type BridgeEvent = {
    readonly kind: 'agent_upsert';
    readonly agent: AgentRecord;
} | {
    readonly kind: 'agent_remove';
    readonly agentId: string;
} | {
    readonly kind: 'workspace_upsert';
    readonly workspace: WorkspaceRecord;
} | {
    readonly kind: 'timeline';
    readonly agentId: string;
    readonly entry: TimelineEntry;
};
/** Everything the Paseo protocol layer needs from the runtime. */
export interface PaseoBridge {
    /** Stable daemon identity shown to clients. */
    readonly serverId: string;
    /** Daemon build/version string reported in `status`. */
    readonly version: string;
    /** Provider routes the runtime can serve, for the daemon status report. */
    listProviders(): Promise<readonly {
        readonly provider: string;
        readonly available: boolean;
    }[]>;
    /** Models one provider route can serve, for the client's model picker. */
    listProviderModels(provider: string): Promise<readonly {
        readonly id: string;
        readonly label: string;
        readonly description?: string;
    }[]>;
    /** Workspaces to advertise, in display order. */
    listWorkspaces(): Promise<readonly WorkspaceRecord[]>;
    /** Agents to advertise, in display order. */
    listAgents(): Promise<readonly AgentRecord[]>;
    /** One agent, or null when it is unknown. */
    getAgent(id: string): Promise<AgentRecord | null>;
    /** Timeline rows for one agent, oldest first. */
    getTimeline(agentId: string, options?: {
        readonly limit?: number;
    }): Promise<readonly TimelineEntry[]>;
    /** Deliver a user prompt to one agent, starting a turn when idle. */
    sendPrompt(agentId: string, text: string, clientMessageId?: string): Promise<void>;
    /** Create an agent in a workspace and return it. */
    createAgent(input: {
        /** Existing workspace to place the agent in; resolved to its directory. */
        readonly workspaceId?: string;
        /** Directory to place the agent in when no workspace is named. */
        readonly directory?: string;
        /** Provider route for the session's model selection. */
        readonly provider?: string;
        /** Model id for the session's model selection. */
        readonly model?: string;
        /** Explicit title; the runtime's own title is kept when absent. */
        readonly title?: string;
        /** Initial prompt, delivered as the agent's first turn. */
        readonly prompt?: string;
    }): Promise<AgentRecord>;
    /** Interrupt one agent's active turn, if any. */
    cancelAgent(agentId: string): Promise<void>;
    /** Create a workspace over a directory. */
    createWorkspace(input: {
        readonly directory: string;
        readonly name?: string;
    }): Promise<WorkspaceRecord>;
    /** Archive a workspace and its agents. */
    archiveWorkspace(workspaceId: string): Promise<void>;
    /** Subscribe to live agent, workspace, and timeline events. */
    subscribe(listener: (event: BridgeEvent) => void): Disposable;
}
