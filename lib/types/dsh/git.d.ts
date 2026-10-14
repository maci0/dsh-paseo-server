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
