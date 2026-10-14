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

/** Token environment variables, in the order GitHub's own tooling reads them. */
const TOKEN_VARIABLES = ['GH_TOKEN', 'GITHUB_TOKEN'] as const

/** GitHub API host. */
const GITHUB_API = 'https://api.github.com'

/** How long one forge read may take. */
const FORGE_TIMEOUT_MS = 10_000

/** Repository a remote URL names. */
export interface GithubRemote {
  readonly owner: string
  readonly repo: string
}

/** Facts about one pull request, as the client's panel shows them. */
export interface PullRequestStatus {
  readonly number: number
  readonly url: string
  readonly title: string
  readonly state: string
  readonly baseRefName: string
  readonly headRefName: string
  readonly isMerged: boolean
  readonly isDraft: boolean
  readonly mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'
  readonly checks: readonly { readonly name: string; readonly status: string; readonly url: string | null }[]
  readonly repoOwner: string
  readonly repoName: string
}

/** Outcome of one pull request lookup. */
export interface PullRequestLookup {
  readonly status: PullRequestStatus | null
  readonly authenticated: boolean
  readonly error: string | null
}

/**
 * Parse the GitHub repository a remote URL names.
 * @param remoteUrl - `origin` URL, in either the https or the ssh form.
 * @returns the owner and repository, or null when the remote is not GitHub.
 */
export function parseGithubRemote(remoteUrl: string | null): GithubRemote | null {
  if (remoteUrl === null) return null
  const trimmed = remoteUrl.trim().replace(/\.git$/, '')
  const https = trimmed.match(/^https?:\/\/github\.com\/([^/]+)\/(.+)$/)
  if (https !== null) return { owner: https[1] ?? '', repo: https[2] ?? '' }
  const ssh = trimmed.match(/^(?:ssh:\/\/)?git@github\.com[:/]([^/]+)\/(.+)$/)
  if (ssh !== null) return { owner: ssh[1] ?? '', repo: ssh[2] ?? '' }
  return null
}

/**
 * Look up the pull request whose head is one branch.
 * @param remote - repository the branch lives in.
 * @param branch - branch name.
 * @param token - GitHub token, or undefined when the environment has none.
 * @returns the pull request when one exists, and whether the lookup was authenticated.
 */
export async function lookupPullRequest(
  remote: GithubRemote,
  branch: string,
  token: string | undefined,
): Promise<PullRequestLookup> {
  if (token === undefined) return { status: null, authenticated: false, error: null }
  const query = new URLSearchParams({ head: `${remote.owner}:${branch}`, state: 'all', per_page: '1' })
  const response = await forgeFetch(
    `${GITHUB_API}/repos/${remote.owner}/${remote.repo}/pulls?${query.toString()}`,
    token,
  )
  if (response === null) return { status: null, authenticated: true, error: 'the forge did not answer' }
  if (response.status === 403 || response.status === 404) {
    return { status: null, authenticated: true, error: `the forge refused the request (${String(response.status)})` }
  }
  if (!response.ok) return { status: null, authenticated: true, error: `the forge answered ${String(response.status)}` }
  const body = await response.json() as unknown
  if (!Array.isArray(body) || body.length === 0) return { status: null, authenticated: true, error: null }
  const status = mapPullRequest(body[0], remote)
  return status === null
    ? { status: null, authenticated: true, error: 'the forge returned a pull request this daemon cannot read' }
    : { status, authenticated: true, error: null }
}

/** Token the environment supplies, if any. */
export function forgeToken(env: Record<string, string | undefined> = process.env): string | undefined {
  for (const name of TOKEN_VARIABLES) {
    const value = env[name]
    if (value !== undefined && value.trim().length > 0) return value
  }
  return undefined
}

/** Map one GitHub pull request onto the client's facts. */
export function mapPullRequest(value: unknown, remote: GithubRemote): PullRequestStatus | null {
  if (value === null || typeof value !== 'object') return null
  const pr = value as Record<string, unknown>
  if (typeof pr.number !== 'number' || typeof pr.html_url !== 'string') return null
  return {
    number: pr.number,
    url: pr.html_url,
    title: typeof pr.title === 'string' ? pr.title : '',
    state: typeof pr.state === 'string' ? pr.state : 'unknown',
    baseRefName: refName(pr.base),
    headRefName: refName(pr.head),
    isMerged: typeof pr.merged_at === 'string',
    isDraft: pr.draft === true,
    mergeable: pr.mergeable === true ? 'MERGEABLE' : pr.mergeable === false ? 'CONFLICTING' : 'UNKNOWN',
    checks: [],
    repoOwner: remote.owner,
    repoName: remote.repo,
  }
}

/** Branch name of one side of a pull request. */
function refName(side: unknown): string {
  if (side === null || typeof side !== 'object') return ''
  const ref = (side as { ref?: unknown }).ref
  return typeof ref === 'string' ? ref : ''
}

/** One API read, resolving null when the network refuses. */
async function forgeFetch(url: string, token: string): Promise<Response | null> {
  try {
    return await fetch(url, {
      signal: AbortSignal.timeout(FORGE_TIMEOUT_MS),
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'user-agent': 'dsh-paseo-server',
        'x-github-api-version': '2022-11-28',
      },
    })
  } catch {
    return null
  }
}
