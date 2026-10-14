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

/** Outcome of one forge write. */
export interface ForgeWriteResult {
  readonly success: boolean
  readonly url: string | null
  readonly number: number | null
  readonly error: string | null
}

/** One entry of a pull request's discussion. */
export interface PullRequestTimelineItem {
  readonly kind: 'comment' | 'review'
  readonly id: string
  readonly author: string
  readonly body: string
  readonly createdAt: number
  readonly url: string
  readonly reviewState?: 'approved' | 'changes_requested' | 'commented'
}

/** One check run, with the detail the client shows when a check is opened. */
export interface CheckDetails {
  readonly checkRunId: number
  readonly name: string
  readonly status: string | null
  readonly conclusion: string | null
  readonly url: string | null
  readonly detailsUrl: string | null
  readonly output: { readonly title: string | null; readonly summary: string | null; readonly text: string | null } | null
}

/**
 * Open a pull request for one branch.
 * @param remote - repository.
 * @param token - forge token; a write without one is refused.
 * @param input - head branch, base branch, title, and body.
 * @returns the created pull request's url and number.
 */
export async function createPullRequest(
  remote: GithubRemote,
  token: string | undefined,
  input: { readonly head: string; readonly base: string; readonly title: string; readonly body: string },
): Promise<ForgeWriteResult> {
  if (token === undefined) return refused('no forge token is configured')
  const response = await forgeSend(`${GITHUB_API}/repos/${remote.owner}/${remote.repo}/pulls`, token, 'POST', {
    title: input.title,
    body: input.body,
    head: input.head,
    base: input.base,
  })
  if (response === null) return refused('the forge did not answer')
  const body = await response.json() as Record<string, unknown>
  if (!response.ok) return refused(forgeMessage(body, `the forge answered ${String(response.status)}`))
  const number = typeof body.number === 'number' ? body.number : null
  return { success: true, url: typeof body.html_url === 'string' ? body.html_url : null, number, error: null }
}

/**
 * Merge one pull request.
 * @param remote - repository.
 * @param token - forge token.
 * @param number - pull request number.
 * @param method - merge strategy the client asked for.
 * @returns whether the merge landed.
 */
export async function mergePullRequest(
  remote: GithubRemote,
  token: string | undefined,
  number: number,
  method: 'merge' | 'squash' | 'rebase',
): Promise<ForgeWriteResult> {
  if (token === undefined) return refused('no forge token is configured')
  const response = await forgeSend(
    `${GITHUB_API}/repos/${remote.owner}/${remote.repo}/pulls/${String(number)}/merge`,
    token,
    'PUT',
    { merge_method: method },
  )
  if (response === null) return refused('the forge did not answer')
  const body = await response.json() as Record<string, unknown>
  if (!response.ok) return refused(forgeMessage(body, `the forge answered ${String(response.status)}`))
  return { success: body.merged === true, url: null, number, error: body.merged === true ? null : forgeMessage(body, 'the forge did not merge the pull request') }
}

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
export async function setAutoMerge(
  remote: GithubRemote,
  token: string | undefined,
  number: number,
  enabled: boolean,
  method: 'merge' | 'squash' | 'rebase',
): Promise<ForgeWriteResult> {
  if (token === undefined) return refused('no forge token is configured')
  const pr = await forgeFetch(`${GITHUB_API}/repos/${remote.owner}/${remote.repo}/pulls/${String(number)}`, token)
  if (pr === null) return refused('the forge did not answer')
  const body = await pr.json() as Record<string, unknown>
  const nodeId = typeof body.node_id === 'string' ? body.node_id : null
  if (nodeId === null) return refused('the forge returned no pull request identity')
  const mutation = enabled
    ? `mutation { enablePullRequestAutoMerge(input: {pullRequestId: "${nodeId}", mergeMethod: ${method.toUpperCase()}}) { clientMutationId } }`
    : `mutation { disablePullRequestAutoMerge(input: {pullRequestId: "${nodeId}"}) { clientMutationId } }`
  const response = await forgeSend(`${GITHUB_API}/graphql`, token, 'POST', { query: mutation })
  if (response === null) return refused('the forge did not answer')
  const result = await response.json() as { errors?: { message?: string }[] }
  const failure = result.errors?.[0]?.message
  return failure === undefined
    ? { success: true, url: null, number, error: null }
    : refused(failure)
}

/**
 * Read a pull request's discussion.
 * @param remote - repository.
 * @param token - forge token.
 * @param number - pull request number.
 * @returns the comments and reviews, oldest first.
 */
export async function readPullRequestTimeline(
  remote: GithubRemote,
  token: string | undefined,
  number: number,
): Promise<{ readonly items: readonly PullRequestTimelineItem[]; readonly error: string | null }> {
  if (token === undefined) return { items: [], error: null }
  const base = `${GITHUB_API}/repos/${remote.owner}/${remote.repo}`
  const [comments, reviews] = await Promise.all([
    forgeFetch(`${base}/issues/${String(number)}/comments?per_page=100`, token),
    forgeFetch(`${base}/pulls/${String(number)}/reviews?per_page=100`, token),
  ])
  if (comments === null || reviews === null) return { items: [], error: 'the forge did not answer' }
  const commentItems = await itemsOf(comments, 'comment')
  const reviewItems = await itemsOf(reviews, 'review')
  const items = [...commentItems, ...reviewItems].sort((left, right) => left.createdAt - right.createdAt)
  return { items, error: null }
}

/**
 * Read one check run.
 * @param remote - repository.
 * @param token - forge token.
 * @param checkRunId - check run to read.
 * @returns the details, or why they are unavailable.
 */
export async function readCheckDetails(
  remote: GithubRemote,
  token: string | undefined,
  checkRunId: number,
): Promise<{ readonly details: CheckDetails | null; readonly error: string | null }> {
  if (token === undefined) return { details: null, error: null }
  const response = await forgeFetch(
    `${GITHUB_API}/repos/${remote.owner}/${remote.repo}/check-runs/${String(checkRunId)}`,
    token,
  )
  if (response === null) return { details: null, error: 'the forge did not answer' }
  if (!response.ok) return { details: null, error: `the forge answered ${String(response.status)}` }
  const body = await response.json() as Record<string, unknown>
  const output = body.output === null || typeof body.output !== 'object' ? null : body.output as Record<string, unknown>
  return {
    details: {
      checkRunId,
      name: typeof body.name === 'string' ? body.name : '',
      status: typeof body.status === 'string' ? body.status : null,
      conclusion: typeof body.conclusion === 'string' ? body.conclusion : null,
      url: typeof body.html_url === 'string' ? body.html_url : null,
      detailsUrl: typeof body.details_url === 'string' ? body.details_url : null,
      output: output === null
        ? null
        : {
            title: textOf(output.title),
            summary: textOf(output.summary),
            text: textOf(output.text),
          },
    },
    error: null,
  }
}

/** One page of timeline entries, in the client's shape. */
async function itemsOf(response: Response, kind: 'comment' | 'review'): Promise<PullRequestTimelineItem[]> {
  if (!response.ok) return []
  const body = await response.json() as unknown
  if (!Array.isArray(body)) return []
  return body.flatMap((entry) => {
    if (entry === null || typeof entry !== 'object') return []
    const record = entry as Record<string, unknown>
    const user = record.user === null || typeof record.user !== 'object' ? undefined : record.user as Record<string, unknown>
    const created = typeof record.created_at === 'string' ? Date.parse(record.created_at) : 0
    const item: PullRequestTimelineItem = {
      kind,
      id: typeof record.id === 'number' ? String(record.id) : '',
      author: typeof user?.login === 'string' ? user.login : 'unknown',
      body: typeof record.body === 'string' ? record.body : '',
      createdAt: Number.isFinite(created) ? created : 0,
      url: typeof record.html_url === 'string' ? record.html_url : '',
      ...(kind === 'review' ? { reviewState: reviewStateOf(record.state) } : {}),
    }
    return [item]
  })
}

/** Review state GitHub reports, mapped onto the client's three. */
function reviewStateOf(state: unknown): 'approved' | 'changes_requested' | 'commented' {
  if (state === 'APPROVED') return 'approved'
  if (state === 'CHANGES_REQUESTED') return 'changes_requested'
  return 'commented'
}

/** A refused write, with the reason the client shows. */
function refused(message: string): ForgeWriteResult {
  return { success: false, url: null, number: null, error: message }
}

/** The forge's own error text, when it sent one. */
function forgeMessage(body: Record<string, unknown>, fallback: string): string {
  const message = body.message
  return typeof message === 'string' && message.length > 0 ? message : fallback
}

/** A string field of a JSON object, or null. */
function textOf(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/** One write to the forge API. */
async function forgeSend(
  url: string,
  token: string,
  method: 'POST' | 'PUT',
  body: Record<string, unknown>,
): Promise<Response | null> {
  try {
    return await fetch(url, {
      method,
      signal: AbortSignal.timeout(FORGE_TIMEOUT_MS),
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'user-agent': 'dsh-paseo-server',
        'x-github-api-version': '2022-11-28',
      },
      body: JSON.stringify(body),
    })
  } catch {
    return null
  }
}

/** One repository a search returned. */
export interface RepositoryHit {
  readonly id: string
  readonly name: string
  readonly nameWithOwner: string
  readonly description: string | null
  readonly visibility: 'public' | 'private' | 'internal'
  readonly updatedAt: string
  readonly cloneUrl: string
}

/** One issue or pull request a search returned. */
export interface ForgeHit {
  readonly kind: 'issue' | 'pr'
  readonly number: number
  readonly title: string
  readonly url: string
  readonly state: string
}

/**
 * Search repositories the token can see.
 * @param query - search text.
 * @param limit - most results to return.
 * @param token - forge token.
 * @returns the repositories, and why the search could not run.
 */
export async function searchRepositories(
  query: string,
  limit: number,
  token: string | undefined,
): Promise<{ readonly repositories: readonly RepositoryHit[]; readonly error: string | null; readonly authenticated: boolean }> {
  if (token === undefined) return { repositories: [], error: null, authenticated: false }
  const params = new URLSearchParams({ q: query, per_page: String(Math.min(limit, 50)) })
  const response = await forgeFetch(`${GITHUB_API}/search/repositories?${params.toString()}`, token)
  if (response === null) return { repositories: [], error: 'the forge did not answer', authenticated: true }
  if (!response.ok) return { repositories: [], error: `the forge answered ${String(response.status)}`, authenticated: true }
  const body = await response.json() as { items?: unknown }
  if (!Array.isArray(body.items)) return { repositories: [], error: null, authenticated: true }
  const repositories: RepositoryHit[] = []
  for (const entry of body.items) {
    if (entry === null || typeof entry !== 'object') continue
    const repo = entry as Record<string, unknown>
    const owner = repo.owner === null || typeof repo.owner !== 'object' ? '' : String((repo.owner as Record<string, unknown>).login ?? '')
    const name = typeof repo.name === 'string' ? repo.name : ''
    if (name.length === 0) continue
    repositories.push({
      id: String(repo.id ?? `${owner}/${name}`),
      name,
      nameWithOwner: typeof repo.full_name === 'string' ? repo.full_name : `${owner}/${name}`,
      description: typeof repo.description === 'string' ? repo.description : null,
      visibility: repo.private === true ? 'private' : 'public',
      updatedAt: typeof repo.updated_at === 'string' ? repo.updated_at : new Date(0).toISOString(),
      cloneUrl: typeof repo.clone_url === 'string' ? repo.clone_url : `https://github.com/${owner}/${name}.git`,
    })
  }
  return { repositories, error: null, authenticated: true }
}

/**
 * Search issues and pull requests across the repositories the token can see.
 * @param query - search text.
 * @param limit - most results to return.
 * @param token - forge token.
 * @returns the hits, and why the search could not run.
 */
export async function searchIssuesAndPulls(
  query: string,
  limit: number,
  token: string | undefined,
): Promise<{ readonly items: readonly ForgeHit[]; readonly error: string | null; readonly authenticated: boolean }> {
  if (token === undefined) return { items: [], error: null, authenticated: false }
  const params = new URLSearchParams({ q: query, per_page: String(Math.min(limit, 50)) })
  const response = await forgeFetch(`${GITHUB_API}/search/issues?${params.toString()}`, token)
  if (response === null) return { items: [], error: 'the forge did not answer', authenticated: true }
  if (!response.ok) return { items: [], error: `the forge answered ${String(response.status)}`, authenticated: true }
  const body = await response.json() as { items?: unknown }
  if (!Array.isArray(body.items)) return { items: [], error: null, authenticated: true }
  const items: ForgeHit[] = []
  for (const entry of body.items) {
    if (entry === null || typeof entry !== 'object') continue
    const hit = entry as Record<string, unknown>
    if (typeof hit.number !== 'number' || typeof hit.html_url !== 'string') continue
    items.push({
      kind: hit.pull_request === undefined ? 'issue' : 'pr',
      number: hit.number,
      title: typeof hit.title === 'string' ? hit.title : '',
      url: hit.html_url,
      state: typeof hit.state === 'string' ? hit.state : 'unknown',
    })
  }
  return { items, error: null, authenticated: true }
}
