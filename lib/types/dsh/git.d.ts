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
