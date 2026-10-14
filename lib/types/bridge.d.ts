/**
 * The surface the Paseo protocol layer needs from the agent runtime behind it.
 *
 * The Paseo wire layer never reaches into DeepSeek Harness directly: it calls
 * this interface, so the protocol can be tested against a static host and the
 * DSH binding stays one file that maps concepts.
 *
 * @module dsh-paseo-server/bridge
 */
import type { DirectoryEntry, FileContent, PathSuggestion, ProjectConfigFile, UploadTarget, WriteOutcome } from './dsh/files.ts';
import type { WorktreeEntry } from './dsh/git.ts';
import type { BranchEntry, CommitEntry, DiffCompare, DiffFile, GitOperationResult, GitStatus, StashEntry } from './dsh/git.ts';
import type { CheckDetails, ForgeHit, RepositoryHit, ForgeWriteResult, PullRequestLookup, PullRequestTimelineItem } from './dsh/forge.ts';
import type { PaseoCadence } from './dsh/schedules.ts';
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
    /** Parent session id for a session a parent spawned. */
    readonly parentAgentId?: string | null;
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
/** One reminder, as a Paseo client sees it. */
export interface ScheduleRecord {
    readonly id: string;
    /** Agent the prompt reaches; it is the owning Session here. */
    readonly agentId: string;
    readonly name: string | null;
    readonly prompt: string;
    readonly cadence: PaseoCadence;
    readonly status: 'active' | 'inactive';
    readonly createdAt: string;
    readonly nextRunAt: string | null;
    /** Instant the reminder was paused, for a reminder this daemon paused. */
    readonly pausedAt: string | null;
    /** Fixed end of a one-shot reminder, so the client can show it as a one-off. */
    readonly expiresAt: string | null;
    /** How many deliveries the reminder allows; one for a one-shot reminder. */
    readonly maxRuns: number | null;
}
/** One declared workspace script and what it is doing now. */
export interface WorkspaceScriptRecord {
    readonly name: string;
    /** Workspace the script belongs to, which its proxy URL names. */
    readonly workspaceId: string;
    readonly type: 'script' | 'service';
    readonly command: string;
    readonly port: number | null;
    readonly lifecycle: 'running' | 'stopped';
    /** Health is only known for a script the daemon can probe; null means unprobed. */
    readonly health: 'healthy' | 'unhealthy' | null;
    readonly exitCode: number | null;
}
/** One terminal a Paseo client can attach to. */
export interface TerminalRecord {
    readonly id: string;
    /** Session whose agent owns the PTY; Paseo has no equivalent and never sees it. */
    readonly sessionId: string;
    readonly workspaceId: string;
    readonly title: string;
    readonly cwd: string;
    readonly cols: number;
    readonly rows: number;
    readonly state: 'running' | 'exited' | 'failed';
    readonly exitCode: number | null;
}
/** One thing that happened to an attached terminal. */
export type TerminalEvent = {
    readonly type: 'snapshot';
    readonly screen: string;
} | {
    readonly type: 'output';
    readonly data: string;
} | {
    readonly type: 'state';
    readonly record: TerminalRecord;
};
/** One prompt a client submitted: text, images, or both. */
export interface PromptInput {
    readonly text: string;
    /** Client-minted identity of the submission, echoed back on its timeline row. */
    readonly clientMessageId?: string;
    /** Base64 encoded images, in the order the client attached them. */
    readonly images?: readonly {
        readonly data: string;
        readonly mimeType: string;
    }[];
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
    sendPrompt(agentId: string, prompt: PromptInput): Promise<void>;
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
        /** Images attached to that first prompt. */
        readonly images?: readonly {
            readonly data: string;
            readonly mimeType: string;
        }[];
    }): Promise<AgentRecord>;
    /** Checkout state of one workspace directory, for the client's git surface. */
    checkoutStatus(directory: string): Promise<GitStatus>;
    /** Parsed diff of one workspace directory against the requested comparison. */
    checkoutDiff(directory: string, compare: DiffCompare): Promise<readonly DiffFile[]>;
    /** Commit the working tree of one workspace directory. */
    commitCheckout(directory: string, message: string | undefined, addAll: boolean): Promise<GitOperationResult>;
    /** Push the current branch of one workspace directory. */
    pushCheckout(directory: string): Promise<GitOperationResult>;
    /** Fast-forward one workspace directory from its upstream. */
    pullCheckout(directory: string): Promise<GitOperationResult>;
    /** Branch refs a client may switch to. */
    listBranches(directory: string, query?: string, limit?: number): Promise<readonly BranchEntry[]>;
    /** Whether one branch name resolves. */
    resolveBranch(directory: string, branch: string): Promise<{
        readonly exists: boolean;
        readonly resolvedRef: string | null;
        readonly isRemote: boolean;
    }>;
    /** Switch one directory to another branch. */
    switchBranch(directory: string, branch: string): Promise<GitOperationResult>;
    /** Rename the directory's current branch. */
    renameBranch(directory: string, branch: string): Promise<GitOperationResult>;
    /** Discard working tree changes for the named paths. */
    discardChanges(directory: string, paths: readonly string[]): Promise<GitOperationResult>;
    /** Stash the directory's working tree. */
    stashSave(directory: string, branch?: string): Promise<GitOperationResult>;
    /** Stashes in the directory's repository. */
    stashList(directory: string, paseoOnly: boolean): Promise<readonly StashEntry[]>;
    /** Apply and drop the newest stash. */
    stashPop(directory: string): Promise<GitOperationResult>;
    /** Recent commits on the directory's current branch. */
    listCommits(directory: string): Promise<readonly CommitEntry[]>;
    /** One file's diff inside one commit. */
    commitFileDiff(directory: string, sha: string, path: string): Promise<readonly DiffFile[]>;
    /** Merge a ref into the directory's current branch. */
    mergeRef(directory: string, baseRef: string, strategy: 'merge' | 'squash'): Promise<GitOperationResult>;
    /** List one workspace directory. */
    listDirectory(directory: string, path?: string): Promise<readonly DirectoryEntry[] | null>;
    /** Read one file inside a workspace directory. */
    readWorkspaceFile(directory: string, path: string): Promise<FileContent | null>;
    /** Write one file inside a workspace directory, refusing a stale revision. */
    writeWorkspaceFile(directory: string, path: string, content: string, expectedModifiedAt: string): Promise<WriteOutcome>;
    /** Create one file or directory inside a workspace. */
    createEntry(directory: string, parentPath: string, name: string, kind: 'file' | 'directory'): Promise<{
        readonly path: string;
    } | {
        readonly error: string;
    }>;
    /** Rename one entry inside a workspace. */
    renameEntry(directory: string, path: string, name: string): Promise<{
        readonly path: string;
    } | {
        readonly error: string;
    }>;
    /** Duplicate one entry inside a workspace. */
    duplicateEntry(directory: string, path: string): Promise<{
        readonly path: string;
    } | {
        readonly error: string;
    }>;
    /** Delete one entry inside a workspace. */
    deleteEntry(directory: string, path: string): Promise<{
        readonly ok: true;
    } | {
        readonly error: string;
    }>;
    /** One path's size and modification time inside a workspace. */
    statEntry(directory: string, path: string): Promise<{
        readonly size: number;
        readonly modifiedAt: string;
    } | null>;
    /** Begin an upload and name the file it will land in. */
    beginUpload(input: {
        readonly fileName: string;
        readonly mimeType: string;
        readonly size: number;
    }): Promise<UploadTarget>;
    /** Remove one workspace record; its Sessions and their logs stay. */
    deleteWorkspace(workspaceId: string): Promise<boolean>;
    /** Worktrees of one repository. */
    listWorktrees(directory: string): Promise<readonly WorktreeEntry[]>;
    /**
     * Create a worktree beside its repository and register it as a workspace.
     * @param directory - repository directory.
     * @param input - branch to create or check out, and the ref to branch from.
     * @returns the new workspace, or why it was refused.
     */
    createWorktree(directory: string, input: {
        readonly branch: string;
        readonly from?: string;
    }): Promise<{
        readonly workspace: WorkspaceRecord;
    } | {
        readonly error: string;
    }>;
    /** Remove one worktree and the workspace that points at it. */
    removeWorktree(directory: string, path: string): Promise<GitOperationResult>;
    /**
     * Pin or unpin one workspace.
     *
     * DSH pins Sessions, not workspaces, so this applies to every Session the
     * workspace holds and reports the instant when they all became pinned.
     */
    setWorkspacePinned(workspaceId: string, pinned: boolean): Promise<string | null>;
    /** Suggest paths for a partially typed path, for the add-project picker. */
    suggestPaths(query: string, cwd: string, limit: number): Promise<readonly PathSuggestion[]>;
    /** Read one project's `paseo.json`, with the revision a write must match. */
    readProjectConfig(directory: string): Promise<ProjectConfigFile | null>;
    /** Write one project's `paseo.json` against an expected revision. */
    writeProjectConfig(directory: string, config: unknown, expected: {
        readonly mtimeMs: number;
        readonly size: number;
    } | null): Promise<{
        readonly revision: {
            readonly mtimeMs: number;
            readonly size: number;
        };
    } | {
        readonly error: string;
    }>;
    /** Workspace records whose project is one project identity. */
    workspacesOfProject(projectId: string): Promise<readonly WorkspaceRecord[]>;
    /** Install a model on one agent. */
    selectAgentModel(agentId: string, modelId: string | null): Promise<{
        readonly provider: string;
        readonly model: string;
    }>;
    /** Sessions a parent session spawned, which Paseo shows as provider subagents. */
    listSubagents(parentAgentId: string): Promise<readonly AgentRecord[]>;
    /**
     * Render one session's conversation up to a boundary as text.
     *
     * Paseo's fork-context flow hands the client a text attachment to attach to
     * a new agent; it does not create the session, so this returns the text and
     * the client decides what to do with it.
     */
    forkContext(agentId: string, boundaryMessageId?: string): Promise<{
        readonly text: string;
        readonly itemCount: number;
        readonly boundaryMessageId: string | null;
    }>;
    /** Pull request facts for the current branch of one workspace directory. */
    checkoutPrStatus(directory: string): Promise<PullRequestLookup>;
    /** Open a pull request for the directory's current branch. */
    createPullRequest(directory: string, input: {
        readonly title?: string;
        readonly body?: string;
        readonly baseRef?: string;
    }): Promise<ForgeWriteResult>;
    /** Merge the pull request whose head is the directory's current branch. */
    mergePullRequest(directory: string, method: 'merge' | 'squash' | 'rebase'): Promise<ForgeWriteResult>;
    /** Turn auto-merge on or off for that pull request. */
    setPullRequestAutoMerge(directory: string, enabled: boolean, method: 'merge' | 'squash' | 'rebase'): Promise<ForgeWriteResult>;
    /** Discussion of that pull request. */
    pullRequestTimeline(directory: string): Promise<{
        readonly items: readonly PullRequestTimelineItem[];
        readonly error: string | null;
        readonly number: number | null;
    }>;
    /** One check run's details. */
    checkDetails(directory: string, checkRunId: number): Promise<{
        readonly details: CheckDetails | null;
        readonly error: string | null;
    }>;
    /** Rename one agent. */
    renameAgent(agentId: string, title: string): Promise<void>;
    /** Install a reasoning effort on one agent's current model. */
    selectAgentThinking(agentId: string, thinkingOptionId: string | null): Promise<void>;
    /** Run a workspace's declared setup command as a background job. */
    runWorkspaceSetup(workspaceId: string): Promise<boolean>;
    /** Current setup state of one workspace, or null when none ran. */
    workspaceSetupStatus(workspaceId: string): Promise<Record<string, unknown> | null>;
    /** Slash commands one agent can run. */
    listCommands(agentId: string): Promise<readonly {
        readonly name: string;
        readonly description: string;
        readonly argumentHint: string;
    }[]>;
    /** Create one directory for the project picker. */
    createDirectory(parentPath: string, name: string): Promise<{
        readonly path: string;
    } | {
        readonly error: string;
    }>;
    /** Clone one GitHub repository and register it as a workspace. */
    cloneRepository(repo: string, target: string): Promise<{
        readonly workspace: WorkspaceRecord;
    } | {
        readonly error: string;
    }>;
    /** Search repositories the forge token can see. */
    searchRepositories(query: string, limit: number): Promise<{
        readonly repositories: readonly RepositoryHit[];
        readonly error: string | null;
        readonly authenticated: boolean;
    }>;
    /** Search issues and pull requests the forge token can see. */
    searchForge(query: string, limit: number): Promise<{
        readonly items: readonly ForgeHit[];
        readonly error: string | null;
        readonly authenticated: boolean;
    }>;
    /** Archive an agent, removing it from the active list. Resolves the archive instant. */
    archiveAgent(agentId: string): Promise<string>;
    /** Interrupt one agent's active turn, if any. */
    cancelAgent(agentId: string): Promise<void>;
    /** Create a workspace over a directory. */
    createWorkspace(input: {
        readonly directory: string;
        readonly name?: string;
    }): Promise<WorkspaceRecord>;
    /** Terminals this runtime currently retains. */
    listTerminals(): Promise<readonly TerminalRecord[]>;
    /** Allocate one terminal inside a workspace and return its descriptor. */
    /** Every recurring reminder this runtime holds, across Sessions. */
    listSchedules(): Promise<readonly ScheduleRecord[]>;
    /** Create one reminder for an agent. */
    createSchedule(input: {
        /** Paseo target: the agent the prompt reaches, which is a DSH Session here. */
        readonly agentId: string;
        readonly prompt: string;
        readonly name?: string;
        readonly cadence: PaseoCadence;
    }): Promise<ScheduleRecord>;
    /** Remove one reminder. */
    deleteSchedule(scheduleId: string): Promise<boolean>;
    /** Stop a reminder without losing it. */
    pauseSchedule(scheduleId: string): Promise<boolean>;
    /** Start a paused reminder again. */
    resumeSchedule(scheduleId: string): Promise<ScheduleRecord>;
    /** Deliver one reminder's prompt immediately. */
    runScheduleNow(scheduleId: string): Promise<void>;
    createTerminal(input: {
        /** Workspace to open the shell in; its directory becomes the shell's cwd. */
        readonly workspaceId: string;
        readonly name?: string;
        /** Initial size; a client that sends none gets the pocket default. */
        readonly cols?: number;
        readonly rows?: number;
    }): Promise<TerminalRecord>;
    /**
     * Attach to one terminal and stream what happens to it.
     * @param terminalId - terminal to attach.
     * @param listener - receives every frame until the returned disposer runs.
     * @returns a disposer that detaches the stream.
     */
    followTerminal(terminalId: string, listener: (event: TerminalEvent) => void): Promise<Disposable>;
    /** Deliver input bytes to one terminal. */
    writeTerminal(terminalId: string, data: string): Promise<void>;
    /** Resize one terminal's PTY. */
    resizeTerminal(terminalId: string, cols: number, rows: number): Promise<void>;
    /** Rename one terminal. */
    renameTerminal(terminalId: string, title: string): Promise<void>;
    /** Close one terminal and kill its process. */
    closeTerminal(terminalId: string): Promise<void>;
    /** Scripts one workspace declares, with their current lifecycle. */
    listWorkspaceScripts(workspaceId: string): Promise<readonly WorkspaceScriptRecord[]>;
    /** Start one declared script as a background job. */
    startWorkspaceScript(workspaceId: string, name: string): Promise<WorkspaceScriptRecord>;
    /** Stop one running script. */
    stopWorkspaceScript(workspaceId: string, name: string): Promise<WorkspaceScriptRecord>;
    /** Archive a workspace and its agents. */
    archiveWorkspace(workspaceId: string): Promise<void>;
    /** Subscribe to live agent, workspace, and timeline events. */
    subscribe(listener: (event: BridgeEvent) => void): Disposable;
}
