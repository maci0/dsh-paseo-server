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
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);
/** How long one git read may take before it is abandoned. */
const GIT_TIMEOUT_MS = 5_000;
/** How long one git write may take; a push over a slow link needs longer. */
const GIT_WRITE_TIMEOUT_MS = 120_000;
/** The state of a directory that is not a repository. */
const NOT_A_REPOSITORY = {
    isGit: false,
    repoRoot: null,
    currentBranch: null,
    isDirty: false,
    hasRemote: false,
    remoteUrl: null,
    upstreamRef: null,
    aheadOfOrigin: null,
    behindOfOrigin: null,
};
/**
 * Read the checkout state of one directory.
 * @param directory - absolute directory to inspect.
 * @returns the state, or the not-a-repository state when git cannot answer.
 */
export async function readGitStatus(directory) {
    const repoRoot = await git(directory, ['rev-parse', '--show-toplevel']);
    if (repoRoot === null)
        return NOT_A_REPOSITORY;
    const root = repoRoot.trim();
    const [branch, porcelain, remoteUrl, upstreamRef] = await Promise.all([
        git(root, ['rev-parse', '--abbrev-ref', 'HEAD']),
        git(root, ['status', '--porcelain']),
        git(root, ['remote', 'get-url', 'origin']),
        git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']),
    ]);
    const upstream = upstreamRef?.trim();
    const aheadBehind = upstream === undefined || upstream.length === 0
        ? null
        : await git(root, ['rev-list', '--left-right', '--count', `${upstream}...HEAD`]);
    const counts = parseAheadBehind(aheadBehind);
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
    };
}
/** Parse `git rev-list --left-right --count <upstream>...HEAD` output. */
function parseAheadBehind(output) {
    if (output === null)
        return null;
    const match = output.trim().match(/^(\d+)\s+(\d+)$/);
    if (match === null)
        return null;
    return { behind: Number(match[1]), ahead: Number(match[2]) };
}
/** Diff output bound, so one huge change cannot exhaust memory. */
const DIFF_MAX_BYTES = 4 * 1024 * 1024;
/**
 * Read a diff for one directory.
 * @param directory - absolute directory to inspect.
 * @param compare - which comparison to run.
 * @returns parsed changed files, empty when git cannot answer.
 */
export async function readDiff(directory, compare) {
    const args = ['diff', '--no-color', '--no-ext-diff', '--unified=3'];
    if (compare.ignoreWhitespace === true)
        args.push('--ignore-all-space');
    if (compare.mode === 'base' && compare.baseRef !== undefined && compare.baseRef.length > 0) {
        args.push(compare.baseRef);
    }
    else {
        // Working tree against the last commit, so staged and unstaged changes
        // appear in one view the way Paseo shows them.
        args.push('HEAD');
    }
    const output = await git(directory, args);
    if (output === null)
        return [];
    return parseUnifiedDiff(output);
}
/**
 * Parse unified diff output into the client's file and hunk shape.
 * @param diff - `git diff` output.
 * @returns one entry per changed file.
 */
export function parseUnifiedDiff(diff) {
    const files = [];
    let current;
    const closeHunk = () => {
        if (current === undefined || current.hunk === undefined)
            return;
        current.hunks.push(current.hunk);
        current.hunk = undefined;
    };
    const closeFile = () => {
        if (current === undefined)
            return;
        closeHunk();
        files.push({
            path: current.path,
            ...(current.oldPath === undefined ? {} : { oldPath: current.oldPath }),
            isNew: current.isNew,
            isDeleted: current.isDeleted,
            additions: current.additions,
            deletions: current.deletions,
            hunks: current.hunks,
            ...(current.status === undefined ? {} : { status: current.status }),
        });
        current = undefined;
    };
    for (const line of diff.split('\n')) {
        if (line.startsWith('diff --git ')) {
            closeFile();
            const paths = line.slice('diff --git '.length);
            current = {
                path: stripPrefix(paths.split(' b/').pop() ?? paths),
                isNew: false,
                isDeleted: false,
                additions: 0,
                deletions: 0,
                hunks: [],
            };
            continue;
        }
        if (current === undefined)
            continue;
        if (line.startsWith('new file mode')) {
            current.isNew = true;
            continue;
        }
        if (line.startsWith('deleted file mode')) {
            current.isDeleted = true;
            continue;
        }
        if (line.startsWith('Binary files') || line.startsWith('GIT binary patch')) {
            current.status = 'binary';
            continue;
        }
        if (line.startsWith('rename from ')) {
            current.oldPath = stripPrefix(line.slice('rename from '.length));
            continue;
        }
        if (line.startsWith('--- ')) {
            const from = line.slice(4).split('\t')[0] ?? '';
            if (from !== '/dev/null')
                current.oldPath = stripPrefix(from);
            continue;
        }
        if (line.startsWith('+++ ')) {
            const to = line.slice(4).split('\t')[0] ?? '';
            if (to !== '/dev/null')
                current.path = stripPrefix(to);
            continue;
        }
        if (line.startsWith('@@')) {
            closeHunk();
            const header = parseHunkHeader(line);
            if (header === null)
                continue;
            current.hunk = { ...header, lines: [] };
            continue;
        }
        if (current.hunk === undefined)
            continue;
        if (line.startsWith('\\'))
            continue;
        const marker = line.slice(0, 1);
        if (marker === '+') {
            current.additions += 1;
            current.hunk.lines.push({ type: 'add', content: line.slice(1) });
            continue;
        }
        if (marker === '-') {
            current.deletions += 1;
            current.hunk.lines.push({ type: 'remove', content: line.slice(1) });
            continue;
        }
        if (marker === ' ') {
            current.hunk.lines.push({ type: 'context', content: line.slice(1) });
            continue;
        }
        if (line.length === 0) {
            current.hunk.lines.push({ type: 'context', content: '' });
            continue;
        }
    }
    closeFile();
    return files;
}
/** Parse `@@ -a,b +c,d @@` into its four numbers. */
function parseHunkHeader(line) {
    const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (match === null)
        return null;
    return {
        oldStart: Number(match[1]),
        oldCount: match[2] === undefined ? 1 : Number(match[2]),
        newStart: Number(match[3]),
        newCount: match[4] === undefined ? 1 : Number(match[4]),
    };
}
/** Drop git's `a/` or `b/` prefix from a diff path. */
function stripPrefix(path) {
    return path.startsWith('a/') || path.startsWith('b/') ? path.slice(2) : path;
}
/** Files a commit message names when the client supplied none. */
const COMMIT_MESSAGE_FILE_LIMIT = 3;
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
export async function commitCheckout(directory, message, addAll) {
    if (!(await isRepository(directory)))
        return { success: false, error: { code: 'NOT_GIT_REPO', message: `${directory} is not a git repository` } };
    if (addAll) {
        const staged = await gitResult(directory, ['add', '--all']);
        if (!staged.ok)
            return { success: false, error: describe(staged, 'staging failed') };
    }
    const resolved = message !== undefined && message.trim().length > 0 ? message.trim() : await describeChanges(directory);
    const committed = await gitResult(directory, ['commit', '-m', resolved]);
    if (!committed.ok)
        return { success: false, error: describe(committed, 'commit failed') };
    return { success: true };
}
/**
 * Push the current branch, setting its upstream on the first push.
 * @param directory - repository directory.
 * @returns the outcome. Force pushing is never attempted.
 */
export async function pushCheckout(directory) {
    if (!(await isRepository(directory)))
        return { success: false, error: { code: 'NOT_GIT_REPO', message: `${directory} is not a git repository` } };
    const pushed = await gitResult(directory, ['push']);
    if (pushed.ok)
        return { success: true };
    const upstream = await gitResult(directory, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
    if (upstream.ok && upstream.stdout.trim().length > 0)
        return { success: false, error: describe(pushed, 'push failed') };
    const first = await gitResult(directory, ['push', '--set-upstream', 'origin', 'HEAD']);
    return first.ok ? { success: true } : { success: false, error: describe(first, 'push failed') };
}
/**
 * Fast-forward the current branch from its upstream.
 *
 * `--ff-only` is deliberate: a pull that would need a merge stops and reports
 * the conflict instead of creating a merge commit the operator never asked
 * for.
 * @param directory - repository directory.
 * @returns the outcome.
 */
export async function pullCheckout(directory) {
    if (!(await isRepository(directory)))
        return { success: false, error: { code: 'NOT_GIT_REPO', message: `${directory} is not a git repository` } };
    const pulled = await gitResult(directory, ['pull', '--ff-only']);
    if (pulled.ok)
        return { success: true };
    const merged = /CONFLICT|diverged|Not possible to fast-forward/i.test(`${pulled.stdout}${pulled.stderr}`);
    return { success: false, error: { code: merged ? 'MERGE_CONFLICT' : 'UNKNOWN', message: summarize(pulled.stderr || pulled.stdout, 'pull failed') } };
}
/** Whether git answers for this directory at all. */
async function isRepository(directory) {
    const result = await gitResult(directory, ['rev-parse', '--git-dir']);
    return result.ok;
}
/** One-sentence commit message naming the changed paths. */
async function describeChanges(directory) {
    const status = await gitResult(directory, ['status', '--porcelain']);
    if (!status.ok)
        return 'update working tree';
    const paths = status.stdout
        .split('\n')
        .map((line) => line.slice(3).trim())
        .filter((path) => path.length > 0);
    if (paths.length === 0)
        return 'update working tree';
    const shown = paths.slice(0, COMMIT_MESSAGE_FILE_LIMIT).join(', ');
    return paths.length <= COMMIT_MESSAGE_FILE_LIMIT
        ? `update ${shown}`
        : `update ${shown} and ${String(paths.length - COMMIT_MESSAGE_FILE_LIMIT)} more`;
}
/** Map a failed git run onto a protocol error. */
function describe(result, fallback) {
    const text = `${result.stdout}${result.stderr}`;
    if (/CONFLICT/i.test(text))
        return { code: 'MERGE_CONFLICT', message: summarize(result.stderr, fallback) };
    if (/permission denied|not allowed|could not read Username|Authentication failed|403/i.test(text)) {
        return { code: 'NOT_ALLOWED', message: summarize(result.stderr, fallback) };
    }
    return { code: 'UNKNOWN', message: summarize(result.stderr || result.stdout, fallback) };
}
/** One bounded line of git's own explanation. */
function summarize(text, fallback) {
    const line = text
        .split('\n')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
        .pop();
    return (line ?? fallback).slice(0, 300);
}
/** Run one git command and keep its output, for both success and failure. */
async function gitResult(directory, args) {
    try {
        const { stdout, stderr } = await run('git', ['-C', directory, ...args], {
            timeout: GIT_WRITE_TIMEOUT_MS,
            windowsHide: true,
            maxBuffer: 1024 * 1024,
            env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', GIT_PAGER: 'cat' },
        });
        return { ok: true, stdout, stderr };
    }
    catch (error) {
        const failure = error;
        return { ok: false, stdout: failure.stdout ?? '', stderr: failure.stderr ?? failure.message ?? 'git failed' };
    }
}
/** Run one git command, resolving null when git refuses or is missing. */
async function git(directory, args) {
    try {
        const { stdout } = await run('git', ['-C', directory, ...args], {
            timeout: GIT_TIMEOUT_MS,
            windowsHide: true,
            maxBuffer: DIFF_MAX_BYTES,
        });
        return stdout;
    }
    catch {
        return null;
    }
}
