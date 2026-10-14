/**
 * The one git read this daemon needs: the state of a workspace directory.
 *
 * Git has no in-process API, so this shells out to the `git` binary with an
 * argument array and never a shell string, which keeps a path or ref from
 * being interpreted. Every call is bounded by a timeout, and a failure is
 * reported as "not a repository" rather than propagated: a client asking
 * about a plain directory is a normal case, not an error.
 *
 * @module dsh-paseo-server/dsh/git
 */
/** Checkout state one Paseo client renders. */
export interface GitStatus {
    readonly isGit: boolean;
    readonly repoRoot: string | null;
    readonly currentBranch: string | null;
    readonly isDirty: boolean;
    readonly hasRemote: boolean;
    readonly remoteUrl: string | null;
    readonly upstreamRef: string | null;
    readonly aheadOfOrigin: number | null;
    readonly behindOfOrigin: number | null;
}
/**
 * Read the checkout state of one directory.
 * @param directory - absolute directory to inspect.
 * @returns the state, or the not-a-repository state when git cannot answer.
 */
export declare function readGitStatus(directory: string): Promise<GitStatus>;
/** One line of a hunk, as the Paseo client renders it. */
export interface DiffLine {
    readonly type: 'add' | 'remove' | 'context' | 'header';
    readonly content: string;
}
/** One hunk of a file diff. */
export interface DiffHunk {
    readonly oldStart: number;
    readonly oldCount: number;
    readonly newStart: number;
    readonly newCount: number;
    readonly lines: readonly DiffLine[];
}
/** One changed file. */
export interface DiffFile {
    readonly path: string;
    readonly oldPath?: string;
    readonly isNew: boolean;
    readonly isDeleted: boolean;
    readonly additions: number;
    readonly deletions: number;
    readonly hunks: readonly DiffHunk[];
    readonly status?: 'ok' | 'too_large' | 'binary';
}
/** Which comparison a client asked for. */
export interface DiffCompare {
    readonly mode: 'uncommitted' | 'base';
    readonly baseRef?: string;
    readonly ignoreWhitespace?: boolean;
}
/**
 * Read a diff for one directory.
 * @param directory - absolute directory to inspect.
 * @param compare - which comparison to run.
 * @returns parsed changed files, empty when git cannot answer.
 */
export declare function readDiff(directory: string, compare: DiffCompare): Promise<readonly DiffFile[]>;
/**
 * Parse unified diff output into the client's file and hunk shape.
 * @param diff - `git diff` output.
 * @returns one entry per changed file.
 */
export declare function parseUnifiedDiff(diff: string): DiffFile[];
/** Failure codes the client understands. */
export type GitErrorCode = 'NOT_GIT_REPO' | 'NOT_ALLOWED' | 'MERGE_CONFLICT' | 'UNKNOWN';
/** Outcome of one write to the working tree. */
export interface GitOperationResult {
    readonly success: boolean;
    readonly error?: {
        readonly code: GitErrorCode;
        readonly message: string;
    };
}
/**
 * Commit the working tree.
 *
 * `addAll` stages tracked and untracked changes first, which is what the
 * client's "commit all" means. A missing message gets one derived from the
 * changed files rather than an empty commit message git would open an editor
 * for; the daemon never runs an interactive editor.
 * @param directory - repository directory.
 * @param message - client-supplied commit message.
 * @param addAll - whether to stage everything first.
 * @returns the outcome.
 */
export declare function commitCheckout(directory: string, message: string | undefined, addAll: boolean): Promise<GitOperationResult>;
/**
 * Push the current branch, setting its upstream on the first push.
 * @param directory - repository directory.
 * @returns the outcome. Force pushing is never attempted.
 */
export declare function pushCheckout(directory: string): Promise<GitOperationResult>;
/**
 * Fast-forward the current branch from its upstream.
 *
 * `--ff-only` is deliberate: a pull that would need a merge stops and reports
 * the conflict instead of creating a merge commit the operator never asked
 * for.
 * @param directory - repository directory.
 * @returns the outcome.
 */
export declare function pullCheckout(directory: string): Promise<GitOperationResult>;
/** One branch a client can switch to. */
export interface BranchEntry {
    readonly name: string;
    readonly committerDate: number;
    readonly hasLocal: boolean;
    readonly hasRemote: boolean;
}
/** One stash entry. */
export interface StashEntry {
    readonly index: number;
    readonly message: string;
    readonly branch: string | null;
    /** Whether this daemon created the stash, which its message marks. */
    readonly isPaseo: boolean;
}
/** One commit in the branch's history. */
export interface CommitEntry {
    readonly sha: string;
    readonly shortSha: string;
    readonly subject: string;
    readonly authorName: string;
    readonly authorDate: string;
    readonly isOnRemote: boolean;
}
/** Marker this daemon puts in a stash message, so it can list its own stashes. */
export declare const STASH_MARKER = "dsh-paseo";
/** Branch refs a client may switch to, local and remote, newest first. */
export declare function listBranches(directory: string, query?: string, limit?: number): Promise<readonly BranchEntry[]>;
/** Whether one branch name resolves, and whether it resolves to a remote ref. */
export declare function resolveBranch(directory: string, branch: string): Promise<{
    readonly exists: boolean;
    readonly resolvedRef: string | null;
    readonly isRemote: boolean;
}>;
/** Switch to one branch, tracking its remote counterpart when only that exists. */
export declare function switchBranch(directory: string, branch: string): Promise<GitOperationResult>;
/** Rename the current branch. */
export declare function renameBranch(directory: string, branch: string): Promise<GitOperationResult>;
/**
 * Discard working tree changes for the named paths.
 *
 * Tracked paths come back from HEAD; untracked paths under the same names are
 * removed, which is what discarding them means.
 */
export declare function discardChanges(directory: string, paths: readonly string[]): Promise<GitOperationResult>;
/** Stash the working tree, marking the entry as this daemon's own. */
export declare function stashSave(directory: string, branch?: string): Promise<GitOperationResult>;
/** Stashes in the repository, newest first. */
export declare function stashList(directory: string, paseoOnly: boolean): Promise<readonly StashEntry[]>;
/** Apply and drop the newest stash. */
export declare function stashPop(directory: string): Promise<GitOperationResult>;
/** Recent commits on the current branch, newest first. */
export declare function listCommits(directory: string, limit?: number): Promise<readonly CommitEntry[]>;
/** One file's diff inside one commit. */
export declare function commitFileDiff(directory: string, sha: string, path: string): Promise<readonly DiffFile[]>;
/** Merge a ref into the current branch. */
export declare function mergeRef(directory: string, baseRef: string, strategy: 'merge' | 'squash'): Promise<GitOperationResult>;
/** One git worktree. */
export interface WorktreeEntry {
    readonly path: string;
    readonly branch: string | null;
    readonly head: string | null;
}
/** List the worktrees of one repository. */
export declare function listWorktrees(directory: string): Promise<readonly WorktreeEntry[]>;
/**
 * Add one worktree beside its repository.
 *
 * The branch is created from the requested ref when it does not exist, which is
 * what a client asking for a new workspace on a new branch means.
 * @param directory - repository directory.
 * @param input - destination path, branch name, and the ref to branch from.
 * @returns the created worktree, or why it was refused.
 */
export declare function addWorktree(directory: string, input: {
    readonly path: string;
    readonly branch: string;
    readonly from?: string;
}): Promise<{
    readonly entry: WorktreeEntry;
} | {
    readonly error: string;
}>;
/** Remove one worktree, refusing while it still has changes. */
export declare function removeWorktree(directory: string, path: string, force: boolean): Promise<GitOperationResult>;
/**
 * Clone one repository into a target directory.
 *
 * The clone runs with the daemon's own git configuration, and a failure is
 * reported as git explained it rather than as a generic error.
 * @param repo - repository in `owner/name` form, cloned over https.
 * @param target - directory to clone into.
 * @returns the outcome.
 */
export declare function cloneRepository(repo: string, target: string): Promise<GitOperationResult>;
