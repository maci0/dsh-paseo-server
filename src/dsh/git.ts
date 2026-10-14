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

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** How long one git read may take before it is abandoned. */
const GIT_TIMEOUT_MS = 5_000

/** Checkout state one Paseo client renders. */
export interface GitStatus {
  readonly isGit: boolean
  readonly repoRoot: string | null
  readonly currentBranch: string | null
  readonly isDirty: boolean
  readonly hasRemote: boolean
  readonly remoteUrl: string | null
  readonly upstreamRef: string | null
  readonly aheadOfOrigin: number | null
  readonly behindOfOrigin: number | null
}

/** The state of a directory that is not a repository. */
const NOT_A_REPOSITORY: GitStatus = {
  isGit: false,
  repoRoot: null,
  currentBranch: null,
  isDirty: false,
  hasRemote: false,
  remoteUrl: null,
  upstreamRef: null,
  aheadOfOrigin: null,
  behindOfOrigin: null,
}

/**
 * Read the checkout state of one directory.
 * @param directory - absolute directory to inspect.
 * @returns the state, or the not-a-repository state when git cannot answer.
 */
export async function readGitStatus(directory: string): Promise<GitStatus> {
  const repoRoot = await git(directory, ['rev-parse', '--show-toplevel'])
  if (repoRoot === null) return NOT_A_REPOSITORY
  const root = repoRoot.trim()
  const [branch, porcelain, remoteUrl, upstreamRef] = await Promise.all([
    git(root, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(root, ['status', '--porcelain']),
    git(root, ['remote', 'get-url', 'origin']),
    git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']),
  ])
  const upstream = upstreamRef?.trim()
  const aheadBehind = upstream === undefined || upstream.length === 0
    ? null
    : await git(root, ['rev-list', '--left-right', '--count', `${upstream}...HEAD`])
  const counts = parseAheadBehind(aheadBehind)
  return {
    isGit: true,
    repoRoot: root,
    currentBranch: branch?.trim() ?? null,
    isDirty: (porcelain ?? '').trim().length > 0,
    hasRemote: remoteUrl !== null && remoteUrl.trim().length > 0,
    remoteUrl: remoteUrl?.trim() ?? null,
    upstreamRef: upstream === undefined || upstream.length === 0 ? null : upstream,
    aheadOfOrigin: counts?.ahead ?? null,
    behindOfOrigin: counts?.behind ?? null,
  }
}

/** Parse `git rev-list --left-right --count <upstream>...HEAD` output. */
function parseAheadBehind(output: string | null): { ahead: number; behind: number } | null {
  if (output === null) return null
  const match = output.trim().match(/^(\d+)\s+(\d+)$/)
  if (match === null) return null
  return { behind: Number(match[1]), ahead: Number(match[2]) }
}

/** Run one git command, resolving null when git refuses or is missing. */
async function git(directory: string, args: readonly string[]): Promise<string | null> {
  try {
    const { stdout } = await run('git', ['-C', directory, ...args], {
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    })
    return stdout
  } catch {
    return null
  }
}
