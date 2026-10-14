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
import { dirname } from 'node:path';
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
/** Marker this daemon puts in a stash message, so it can list its own stashes. */
export const STASH_MARKER = 'dsh-paseo';
/** Branch refs a client may switch to, local and remote, newest first. */
export async function listBranches(directory, query, limit = 100) {
    const output = await git(directory, [
        'for-each-ref',
        '--sort=-committerdate',
        '--format=%(refname:short)\t%(committerdate:unix)\t%(refname)',
        'refs/heads',
        'refs/remotes',
    ]);
    if (output === null)
        return [];
    const byName = new Map();
    for (const line of output.split('\n')) {
        const [name, date, ref] = line.split('\t');
        // The full ref is what identifies a symbolic remote HEAD: its short name
        // is just the remote, with no `/HEAD` to look for.
        if (name === undefined || name.length === 0 || ref === undefined || ref.endsWith('/HEAD'))
            continue;
        const isRemote = ref.startsWith('refs/remotes/');
        const short = isRemote ? name.replace(/^[^/]+\//, '') : name;
        const existing = byName.get(short);
        byName.set(short, {
            name: short,
            committerDate: Number(date ?? '0') * 1_000,
            hasLocal: existing?.hasLocal === true || !isRemote,
            hasRemote: existing?.hasRemote === true || isRemote,
        });
    }
    const branches = [...byName.values()];
    const filtered = query === undefined || query.length === 0
        ? branches
        : branches.filter((branch) => branch.name.toLowerCase().includes(query.toLowerCase()));
    return filtered.slice(0, limit);
}
/** Whether one branch name resolves, and whether it resolves to a remote ref. */
export async function resolveBranch(directory, branch) {
    const local = await git(directory, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
    if (local !== null)
        return { exists: true, resolvedRef: `refs/heads/${branch}`, isRemote: false };
    const remote = await git(directory, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`]);
    if (remote !== null)
        return { exists: true, resolvedRef: `refs/remotes/origin/${branch}`, isRemote: true };
    return { exists: false, resolvedRef: null, isRemote: false };
}
/** Switch to one branch, tracking its remote counterpart when only that exists. */
export async function switchBranch(directory, branch) {
    const direct = await gitResult(directory, ['checkout', branch]);
    if (direct.ok)
        return { success: true };
    const tracked = await gitResult(directory, ['checkout', '--track', `origin/${branch}`]);
    return tracked.ok ? { success: true } : { success: false, error: describe(direct, 'switching branch failed') };
}
/** Rename the current branch. */
export async function renameBranch(directory, branch) {
    const renamed = await gitResult(directory, ['branch', '-m', branch]);
    return renamed.ok ? { success: true } : { success: false, error: describe(renamed, 'renaming the branch failed') };
}
/**
 * Discard working tree changes for the named paths.
 *
 * Tracked paths come back from HEAD; untracked paths under the same names are
 * removed, which is what discarding them means.
 */
export async function discardChanges(directory, paths) {
    if (paths.length === 0)
        return { success: false, error: { code: 'UNKNOWN', message: 'no paths were named' } };
    const restored = await gitResult(directory, ['checkout', '--', ...paths]);
    const cleaned = await gitResult(directory, ['clean', '-fd', '--', ...paths]);
    if (restored.ok || cleaned.ok)
        return { success: true };
    return { success: false, error: describe(restored, 'discarding changes failed') };
}
/** Stash the working tree, marking the entry as this daemon's own. */
export async function stashSave(directory, branch) {
    const label = branch === undefined || branch.length === 0 ? 'working tree' : branch;
    const saved = await gitResult(directory, ['stash', 'push', '--include-untracked', '-m', `${STASH_MARKER}: ${label}`]);
    if (saved.ok)
        return { success: true };
    // An empty stash is not a failure the client needs to see as an error.
    return /No local changes/i.test(`${saved.stdout}${saved.stderr}`)
        ? { success: true }
        : { success: false, error: describe(saved, 'stashing failed') };
}
/** Stashes in the repository, newest first. */
export async function stashList(directory, paseoOnly) {
    const output = await git(directory, ['stash', 'list', '--format=%gd\t%gs']);
    if (output === null)
        return [];
    const entries = [];
    for (const line of output.split('\n')) {
        const [ref, message] = line.split('\t');
        if (ref === undefined || ref.length === 0)
            continue;
        const index = Number(ref.replace(/[^0-9]/g, ''));
        const isPaseo = (message ?? '').startsWith(`${STASH_MARKER}: `);
        if (paseoOnly && !isPaseo)
            continue;
        const text = message ?? '';
        entries.push({
            index: Number.isFinite(index) ? index : 0,
            message: text,
            branch: isPaseo ? text.slice(STASH_MARKER.length + 2) : null,
            isPaseo,
        });
    }
    return entries;
}
/** Apply and drop the newest stash. */
export async function stashPop(directory) {
    const popped = await gitResult(directory, ['stash', 'pop']);
    return popped.ok ? { success: true } : { success: false, error: describe(popped, 'popping the stash failed') };
}
/** Recent commits on the current branch, newest first. */
export async function listCommits(directory, limit = 50) {
    const output = await git(directory, [
        'log',
        `--max-count=${String(limit)}`,
        '--format=%H\t%h\t%s\t%an\t%aI\t%d',
        'HEAD',
    ]);
    if (output === null)
        return [];
    const unpushed = await git(directory, ['rev-list', '@{upstream}..HEAD']);
    const localOnly = new Set((unpushed ?? '').split('\n').filter((sha) => sha.length > 0));
    const commits = [];
    for (const line of output.split('\n')) {
        const [sha, shortSha, subject, authorName, authorDate, refs] = line.split('\t');
        if (sha === undefined || sha.length === 0)
            continue;
        commits.push({
            sha,
            shortSha: shortSha ?? sha.slice(0, 7),
            subject: subject ?? '',
            authorName: authorName ?? '',
            authorDate: authorDate ?? '',
            isOnRemote: !localOnly.has(sha) && !(refs ?? '').includes('HEAD ->'),
        });
    }
    return commits;
}
/** One file's diff inside one commit. */
export async function commitFileDiff(directory, sha, path) {
    const output = await git(directory, ['show', '--no-color', '--no-ext-diff', '--format=', '--unified=3', sha, '--', path]);
    if (output === null)
        return [];
    return parseUnifiedDiff(output);
}
/** Merge a ref into the current branch. */
export async function mergeRef(directory, baseRef, strategy) {
    const args = strategy === 'squash' ? ['merge', '--squash', baseRef] : ['merge', '--no-edit', baseRef];
    const merged = await gitResult(directory, args);
    return merged.ok ? { success: true } : { success: false, error: describe(merged, 'merging failed') };
}
/** List the worktrees of one repository. */
export async function listWorktrees(directory) {
    const output = await git(directory, ['worktree', 'list', '--porcelain']);
    if (output === null)
        return [];
    const entries = [];
    let current = {};
    const flush = () => {
        if (current.path === undefined)
            return;
        entries.push({
            path: current.path,
            branch: current.branch?.replace('refs/heads/', '') ?? null,
            head: current.head ?? null,
        });
        current = {};
    };
    for (const line of output.split('\n')) {
        if (line.startsWith('worktree ')) {
            flush();
            current.path = line.slice('worktree '.length);
            continue;
        }
        if (line.startsWith('HEAD ')) {
            current.head = line.slice('HEAD '.length);
            continue;
        }
        if (line.startsWith('branch ')) {
            current.branch = line.slice('branch '.length);
            continue;
        }
    }
    flush();
    return entries;
}
/**
 * Add one worktree beside its repository.
 *
 * The branch is created from the requested ref when it does not exist, which is
 * what a client asking for a new workspace on a new branch means.
 * @param directory - repository directory.
 * @param input - destination path, branch name, and the ref to branch from.
 * @returns the created worktree, or why it was refused.
 */
export async function addWorktree(directory, input) {
    const existing = await git(directory, ['rev-parse', '--verify', '--quiet', `refs/heads/${input.branch}`]);
    const args = existing === null
        ? ['worktree', 'add', '-b', input.branch, input.path, input.from ?? 'HEAD']
        : ['worktree', 'add', input.path, input.branch];
    const added = await gitResult(directory, args);
    if (!added.ok)
        return { error: summarize(added.stderr || added.stdout, 'adding the worktree failed') };
    return { entry: { path: input.path, branch: input.branch, head: null } };
}
/** Remove one worktree, refusing while it still has changes. */
export async function removeWorktree(directory, path, force) {
    const args = force ? ['worktree', 'remove', '--force', path] : ['worktree', 'remove', path];
    const removed = await gitResult(directory, args);
    return removed.ok ? { success: true } : { success: false, error: describe(removed, 'removing the worktree failed') };
}
/**
 * Clone one repository into a target directory.
 *
 * The clone runs with the daemon's own git configuration, and a failure is
 * reported as git explained it rather than as a generic error.
 * @param repo - repository in `owner/name` form, cloned over https.
 * @param target - directory to clone into.
 * @returns the outcome.
 */
export async function cloneRepository(repo, target) {
    if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo)) {
        return { success: false, error: { code: 'UNKNOWN', message: 'a repository must be named owner/name' } };
    }
    const cloned = await gitResult(dirname(target), ['clone', `https://github.com/${repo}.git`, target]);
    return cloned.ok ? { success: true } : { success: false, error: describe(cloned, 'cloning failed') };
}
