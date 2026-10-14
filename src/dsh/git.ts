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

/** One line of a hunk, as the Paseo client renders it. */
export interface DiffLine {
  readonly type: 'add' | 'remove' | 'context' | 'header'
  readonly content: string
}

/** One hunk of a file diff. */
export interface DiffHunk {
  readonly oldStart: number
  readonly oldCount: number
  readonly newStart: number
  readonly newCount: number
  readonly lines: readonly DiffLine[]
}

/** One changed file. */
export interface DiffFile {
  readonly path: string
  readonly oldPath?: string
  readonly isNew: boolean
  readonly isDeleted: boolean
  readonly additions: number
  readonly deletions: number
  readonly hunks: readonly DiffHunk[]
  readonly status?: 'ok' | 'too_large' | 'binary'
}

/** Which comparison a client asked for. */
export interface DiffCompare {
  readonly mode: 'uncommitted' | 'base'
  readonly baseRef?: string
  readonly ignoreWhitespace?: boolean
}

/** Diff output bound, so one huge change cannot exhaust memory. */
const DIFF_MAX_BYTES = 4 * 1024 * 1024

/**
 * Read a diff for one directory.
 * @param directory - absolute directory to inspect.
 * @param compare - which comparison to run.
 * @returns parsed changed files, empty when git cannot answer.
 */
export async function readDiff(directory: string, compare: DiffCompare): Promise<readonly DiffFile[]> {
  const args = ['diff', '--no-color', '--no-ext-diff', '--unified=3']
  if (compare.ignoreWhitespace === true) args.push('--ignore-all-space')
  if (compare.mode === 'base' && compare.baseRef !== undefined && compare.baseRef.length > 0) {
    args.push(compare.baseRef)
  } else {
    // Working tree against the last commit, so staged and unstaged changes
    // appear in one view the way Paseo shows them.
    args.push('HEAD')
  }
  const output = await git(directory, args)
  if (output === null) return []
  return parseUnifiedDiff(output)
}

/**
 * Parse unified diff output into the client's file and hunk shape.
 * @param diff - `git diff` output.
 * @returns one entry per changed file.
 */
export function parseUnifiedDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = []
  let current: {
    path: string
    oldPath?: string
    isNew: boolean
    isDeleted: boolean
    additions: number
    deletions: number
    hunks: DiffHunk[]
    status?: 'ok' | 'too_large' | 'binary'
    hunk?: { oldStart: number; oldCount: number; newStart: number; newCount: number; lines: DiffLine[] }
  } | undefined

  const closeHunk = (): void => {
    if (current === undefined || current.hunk === undefined) return
    current.hunks.push(current.hunk)
    current.hunk = undefined
  }
  const closeFile = (): void => {
    if (current === undefined) return
    closeHunk()
    files.push({
      path: current.path,
      ...(current.oldPath === undefined ? {} : { oldPath: current.oldPath }),
      isNew: current.isNew,
      isDeleted: current.isDeleted,
      additions: current.additions,
      deletions: current.deletions,
      hunks: current.hunks,
      ...(current.status === undefined ? {} : { status: current.status }),
    })
    current = undefined
  }

  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      closeFile()
      const paths = line.slice('diff --git '.length)
      current = {
        path: stripPrefix(paths.split(' b/').pop() ?? paths),
        isNew: false,
        isDeleted: false,
        additions: 0,
        deletions: 0,
        hunks: [],
      }
      continue
    }
    if (current === undefined) continue
    if (line.startsWith('new file mode')) { current.isNew = true; continue }
    if (line.startsWith('deleted file mode')) { current.isDeleted = true; continue }
    if (line.startsWith('Binary files') || line.startsWith('GIT binary patch')) {
      current.status = 'binary'
      continue
    }
    if (line.startsWith('rename from ')) { current.oldPath = stripPrefix(line.slice('rename from '.length)); continue }
    if (line.startsWith('--- ')) {
      const from = line.slice(4).split('\t')[0] ?? ''
      if (from !== '/dev/null') current.oldPath = stripPrefix(from)
      continue
    }
    if (line.startsWith('+++ ')) {
      const to = line.slice(4).split('\t')[0] ?? ''
      if (to !== '/dev/null') current.path = stripPrefix(to)
      continue
    }
    if (line.startsWith('@@')) {
      closeHunk()
      const header = parseHunkHeader(line)
      if (header === null) continue
      current.hunk = { ...header, lines: [] }
      continue
    }
    if (current.hunk === undefined) continue
    if (line.startsWith('\\')) continue
    const marker = line.slice(0, 1)
    if (marker === '+') { current.additions += 1; current.hunk.lines.push({ type: 'add', content: line.slice(1) }); continue }
    if (marker === '-') { current.deletions += 1; current.hunk.lines.push({ type: 'remove', content: line.slice(1) }); continue }
    if (marker === ' ') { current.hunk.lines.push({ type: 'context', content: line.slice(1) }); continue }
    if (line.length === 0) { current.hunk.lines.push({ type: 'context', content: '' }); continue }
  }
  closeFile()
  return files
}

/** Parse `@@ -a,b +c,d @@` into its four numbers. */
function parseHunkHeader(line: string): { oldStart: number; oldCount: number; newStart: number; newCount: number } | null {
  const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/)
  if (match === null) return null
  return {
    oldStart: Number(match[1]),
    oldCount: match[2] === undefined ? 1 : Number(match[2]),
    newStart: Number(match[3]),
    newCount: match[4] === undefined ? 1 : Number(match[4]),
  }
}

/** Drop git's `a/` or `b/` prefix from a diff path. */
function stripPrefix(path: string): string {
  return path.startsWith('a/') || path.startsWith('b/') ? path.slice(2) : path
}

/** Run one git command, resolving null when git refuses or is missing. */
async function git(directory: string, args: readonly string[]): Promise<string | null> {
  try {
    const { stdout } = await run('git', ['-C', directory, ...args], {
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: DIFF_MAX_BYTES,
    })
    return stdout
  } catch {
    return null
  }
}
