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
/** Outcome of one forge write. */
export interface ForgeWriteResult {
    readonly success: boolean;
    readonly url: string | null;
    readonly number: number | null;
    readonly error: string | null;
}
/** One entry of a pull request's discussion. */
export interface PullRequestTimelineItem {
    readonly kind: 'comment' | 'review';
    readonly id: string;
    readonly author: string;
    readonly body: string;
    readonly createdAt: number;
    readonly url: string;
    readonly reviewState?: 'approved' | 'changes_requested' | 'commented';
}
/** One check run, with the detail the client shows when a check is opened. */
export interface CheckDetails {
    readonly checkRunId: number;
    readonly name: string;
    readonly status: string | null;
    readonly conclusion: string | null;
    readonly url: string | null;
    readonly detailsUrl: string | null;
    readonly output: {
        readonly title: string | null;
        readonly summary: string | null;
        readonly text: string | null;
    } | null;
}
/**
 * Open a pull request for one branch.
 * @param remote - repository.
 * @param token - forge token; a write without one is refused.
 * @param input - head branch, base branch, title, and body.
 * @returns the created pull request's url and number.
 */
export declare function createPullRequest(remote: GithubRemote, token: string | undefined, input: {
    readonly head: string;
    readonly base: string;
    readonly title: string;
    readonly body: string;
}): Promise<ForgeWriteResult>;
/**
 * Merge one pull request.
 * @param remote - repository.
 * @param token - forge token.
 * @param number - pull request number.
 * @param method - merge strategy the client asked for.
 * @returns whether the merge landed.
 */
export declare function mergePullRequest(remote: GithubRemote, token: string | undefined, number: number, method: 'merge' | 'squash' | 'rebase'): Promise<ForgeWriteResult>;
/**
 * Turn auto-merge on or off for one pull request.
 *
 * GitHub exposes auto-merge only through GraphQL, so this asks for the pull
 * request's node id and runs the matching mutation.
 * @param remote - repository.
 * @param token - forge token.
 * @param number - pull request number.
 * @param enabled - whether auto-merge should be on.
 * @param method - merge strategy to use when it lands.
 * @returns whether the change was accepted.
 */
export declare function setAutoMerge(remote: GithubRemote, token: string | undefined, number: number, enabled: boolean, method: 'merge' | 'squash' | 'rebase'): Promise<ForgeWriteResult>;
/**
 * Read a pull request's discussion.
 * @param remote - repository.
 * @param token - forge token.
 * @param number - pull request number.
 * @returns the comments and reviews, oldest first.
 */
export declare function readPullRequestTimeline(remote: GithubRemote, token: string | undefined, number: number): Promise<{
    readonly items: readonly PullRequestTimelineItem[];
    readonly error: string | null;
}>;
/**
 * Read one check run.
 * @param remote - repository.
 * @param token - forge token.
 * @param checkRunId - check run to read.
 * @returns the details, or why they are unavailable.
 */
export declare function readCheckDetails(remote: GithubRemote, token: string | undefined, checkRunId: number): Promise<{
    readonly details: CheckDetails | null;
    readonly error: string | null;
}>;
