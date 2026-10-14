/**
 * The one forge read this daemon makes: the pull request for a branch.
 *
 * The harness ships no forge client, so this asks GitHub's REST API directly
 * with a token from the environment and says so when there is none. Other
 * forges are not guessed at: a remote that is not GitHub reports no pull
 * request rather than a wrong one.
 *
 * @module dsh-paseo-server/dsh/forge
 */
/** Repository a remote URL names. */
export interface GithubRemote {
    readonly owner: string;
    readonly repo: string;
}
/** Facts about one pull request, as the client's panel shows them. */
export interface PullRequestStatus {
    readonly number: number;
    readonly url: string;
    readonly title: string;
    readonly state: string;
    readonly baseRefName: string;
    readonly headRefName: string;
    readonly isMerged: boolean;
    readonly isDraft: boolean;
    readonly mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
    readonly checks: readonly {
        readonly name: string;
        readonly status: string;
        readonly url: string | null;
    }[];
    readonly repoOwner: string;
    readonly repoName: string;
}
/** Outcome of one pull request lookup. */
export interface PullRequestLookup {
    readonly status: PullRequestStatus | null;
    readonly authenticated: boolean;
    readonly error: string | null;
}
/**
 * Parse the GitHub repository a remote URL names.
 * @param remoteUrl - `origin` URL, in either the https or the ssh form.
 * @returns the owner and repository, or null when the remote is not GitHub.
 */
export declare function parseGithubRemote(remoteUrl: string | null): GithubRemote | null;
/**
 * Look up the pull request whose head is one branch.
 * @param remote - repository the branch lives in.
 * @param branch - branch name.
 * @param token - GitHub token, or undefined when the environment has none.
 * @returns the pull request when one exists, and whether the lookup was authenticated.
 */
export declare function lookupPullRequest(remote: GithubRemote, branch: string, token: string | undefined): Promise<PullRequestLookup>;
/** Token the environment supplies, if any. */
export declare function forgeToken(env?: Record<string, string | undefined>): string | undefined;
/** Map one GitHub pull request onto the client's facts. */
export declare function mapPullRequest(value: unknown, remote: GithubRemote): PullRequestStatus | null;
