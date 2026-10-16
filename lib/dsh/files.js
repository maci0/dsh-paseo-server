/**
 * The file surface a client browses: one directory listing and one file read.
 *
 * Every path is resolved against the workspace directory the daemon advertised
 * and refused when it escapes that directory, so a browse request cannot read
 * the rest of the machine.
 *
 * @module dsh-paseo-server/dsh/files
 */
import { appendFile, cp, link, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
/** Largest file this daemon reads for a client. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** Image extensions, with the media type a client renders them as. */
const IMAGE_TYPES = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
};
/**
 * Resolve one requested path inside a workspace directory.
 * @param base - advertised workspace directory.
 * @param requested - relative path the client asked for, or empty for the root.
 * @param followFinalSymlink - false for deleting the entry itself, never its target.
 * @returns the absolute path, or null when it escapes the workspace.
 */
export async function resolveInside(base, requested, followFinalSymlink = true) {
    const root = resolve(base);
    const wanted = requested === undefined || requested.length === 0 ? '.' : requested;
    if (isAbsolute(wanted))
        return null;
    const target = resolve(root, wanted);
    const inside = relative(root, target);
    if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside))
        return null;
    try {
        const realRoot = await realpath(root);
        let existing = !followFinalSymlink && target !== root ? dirname(target) : target;
        for (;;) {
            try {
                const resolved = await realpath(existing);
                const rel = relative(realRoot, resolved);
                return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) ? null : target;
            }
            catch (error) {
                if (error.code !== 'ENOENT' || existing === root)
                    return null;
                // A dangling link must not be treated as an absent path to create.
                if (await lstat(existing).then(() => true, () => false))
                    return null;
                existing = dirname(existing);
            }
        }
    }
    catch {
        return null;
    }
}
/**
 * List one directory.
 * @param base - workspace directory.
 * @param requested - path inside it.
 * @returns the entries sorted by name, or null when the path is not a readable directory.
 */
export async function listDirectory(base, requested) {
    const target = await resolveInside(base, requested);
    if (target === null)
        return null;
    try {
        const found = await readdir(target, { withFileTypes: true });
        const entries = [];
        for (const entry of found) {
            if (entry.name === '.git')
                continue;
            const full = join(target, entry.name);
            let size = 0;
            let modifiedAt = new Date(0).toISOString();
            try {
                const info = await lstat(full);
                size = info.size;
                modifiedAt = info.mtime.toISOString();
            }
            catch {
                // A file that vanished between the listing and the stat still lists.
            }
            entries.push({
                name: entry.name,
                path: relative(resolve(base), full),
                kind: entry.isDirectory() ? 'directory' : 'file',
                size,
                modifiedAt,
            });
        }
        return entries.sort((left, right) => left.name.localeCompare(right.name));
    }
    catch {
        return null;
    }
}
/**
 * Read one file.
 * @param base - workspace directory.
 * @param requested - path inside it.
 * @returns the content, or null when the path is unreadable or too large.
 */
export async function readWorkspaceFile(base, requested) {
    const target = await resolveInside(base, requested);
    if (target === null)
        return null;
    try {
        const info = await stat(target);
        if (!info.isFile() || info.size > MAX_FILE_BYTES)
            return null;
        const modifiedAt = info.mtime.toISOString();
        const relativePath = relative(resolve(base), target);
        const mediaType = IMAGE_TYPES[extname(target).toLowerCase()];
        if (mediaType !== undefined) {
            const bytes = await readFile(target);
            return { path: relativePath, kind: 'image', encoding: 'base64', content: bytes.toString('base64'), mimeType: mediaType, size: info.size, modifiedAt };
        }
        const bytes = await readFile(target);
        // A NUL byte in the first block is what makes a file binary here; a
        // stricter check would cost a dependency for no better answer.
        if (bytes.subarray(0, 8_000).includes(0)) {
            return { path: relativePath, kind: 'binary', encoding: 'none', size: info.size, modifiedAt };
        }
        return { path: relativePath, kind: 'text', encoding: 'utf-8', content: bytes.toString('utf8'), size: info.size, modifiedAt };
    }
    catch {
        return null;
    }
}
/**
 * Suggest paths under the directory a partially typed path names.
 *
 * This is the picker a client uses to add a project, so unlike the workspace
 * browser it deliberately reads outside the advertised workspaces: choosing a
 * directory to add is exactly the case where nothing is advertised yet. It
 * lists names only and never file contents, and only on the daemon side of an
 * authenticated session.
 * @param query - partial path, absolute or relative to `cwd`.
 * @param cwd - directory a relative query resolves against.
 * @param limit - most suggestions to return.
 * @returns matching entries, directories first.
 */
export async function suggestPaths(query, cwd, limit) {
    const expanded = query.startsWith('~') ? join(process.env.HOME ?? '/', query.slice(1)) : query;
    const base = isAbsolute(expanded) ? expanded : join(cwd, expanded);
    const endsWithSeparator = base.endsWith('/');
    const parent = endsWithSeparator ? base : join(base, '..');
    const prefix = endsWithSeparator ? '' : base.slice(parent.length + 1);
    try {
        const found = await readdir(parent, { withFileTypes: true });
        return found
            .filter((entry) => entry.name.startsWith(prefix) && entry.name !== '.git')
            .map((entry) => ({
            path: endsWithSeparator ? join(base, entry.name) : join(parent, entry.name),
            kind: entry.isDirectory() ? 'directory' : 'file',
        }))
            .sort((left, right) => {
            if (left.kind !== right.kind)
                return left.kind === 'directory' ? -1 : 1;
            return left.path.localeCompare(right.path);
        })
            .slice(0, limit);
    }
    catch {
        return [];
    }
}
/**
 * Read a project config file.
 * @param directory - project root.
 * @returns the parsed config and its revision, or null when there is no readable file.
 */
export async function readProjectConfig(directory) {
    const file = join(directory, 'paseo.json');
    try {
        const info = await stat(file);
        const parsed = JSON.parse(await readFile(file, 'utf8'));
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
            return null;
        return { config: parsed, revision: { mtimeMs: info.mtimeMs, size: info.size } };
    }
    catch {
        return null;
    }
}
/**
 * Write a project config file, refusing a write based on a stale revision.
 * @param directory - project root.
 * @param config - config document to store.
 * @param expected - revision the client read, or null to create or overwrite.
 * @returns the new revision, or the reason the write was refused.
 */
export async function writeProjectConfig(directory, config, expected) {
    if (config === null || typeof config !== 'object' || Array.isArray(config))
        return { error: 'invalid_project_config' };
    const file = join(directory, 'paseo.json');
    if (expected !== null) {
        const current = await readProjectConfig(directory);
        if (current === null)
            return { error: 'invalid_project_config' };
        if (current.revision.mtimeMs !== expected.mtimeMs || current.revision.size !== expected.size) {
            return { error: 'stale_project_config' };
        }
    }
    try {
        const body = `${JSON.stringify(config, null, 2)}\n`;
        await writeFile(file, body);
        const info = await stat(file);
        return { revision: { mtimeMs: info.mtimeMs, size: info.size } };
    }
    catch {
        return { error: 'write_failed' };
    }
}
/**
 * Write one file, refusing a write based on a stale modification time.
 *
 * The client sends the modification time it read; a file that changed since
 * then is reported as a conflict instead of being overwritten, which is what
 * keeps two writers from silently losing one of the changes.
 * @param base - workspace directory.
 * @param requested - path inside it.
 * @param content - text to store.
 * @param expectedModifiedAt - modification time the client read.
 * @returns the outcome.
 */
export async function writeWorkspaceFile(base, requested, content, expectedModifiedAt) {
    const target = await resolveInside(base, requested);
    if (target === null)
        return { status: 'error', error: 'the path escapes its workspace' };
    const current = await statOrNull(target);
    if (current !== null && current.mtime.toISOString() !== expectedModifiedAt) {
        return { status: 'conflict', modifiedAt: current.mtime.toISOString(), size: current.size };
    }
    try {
        await writeFile(target, content);
        const written = await stat(target);
        return { status: 'written', modifiedAt: written.mtime.toISOString(), size: written.size };
    }
    catch (error) {
        return { status: 'error', error: error instanceof Error ? error.message : String(error) };
    }
}
/** Create one file or directory inside a workspace. */
export async function createEntry(base, parentPath, name, kind) {
    if (name.length === 0 || name.includes('/'))
        return { error: 'a name must be one path segment' };
    const parent = await resolveInside(base, parentPath);
    if (parent === null)
        return { error: 'the parent escapes its workspace' };
    const target = join(parent, name);
    if (await resolveInside(base, relative(resolve(base), target)) === null)
        return { error: 'the target escapes its workspace' };
    try {
        if (kind === 'directory')
            await mkdir(target, { recursive: false });
        else
            await writeFile(target, '', { flag: 'wx' });
        return { path: relative(resolve(base), target) };
    }
    catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
    }
}
/** Whether one path inside a workspace exists. */
export async function entryExists(base, requested) {
    const target = await resolveInside(base, requested);
    return target !== null && await statOrNull(target) !== null;
}
/** Rename or move one entry inside a workspace. */
export async function renameEntry(base, requested, name) {
    if (name.length === 0 || name.includes('/'))
        return { error: 'a name must be one path segment' };
    const source = await resolveInside(base, requested);
    if (source === null)
        return { error: 'the path escapes its workspace' };
    const target = join(dirname(source), name);
    if (await resolveInside(base, relative(resolve(base), target)) === null)
        return { error: 'the target escapes its workspace' };
    if (source === target)
        return { path: relative(resolve(base), target) };
    try {
        if ((await lstat(source)).isDirectory()) {
            if (await lstat(target).then(() => true, () => false))
                return { error: 'the target already exists' };
            await rename(source, target);
        }
        else {
            // link refuses an existing destination atomically; rename overwrites it.
            await link(source, target);
            await unlink(source);
        }
        return { path: relative(resolve(base), target) };
    }
    catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
    }
}
/** Delete one entry inside a workspace, recursively for a directory. */
export async function deleteEntry(base, requested) {
    const target = await resolveInside(base, requested, false);
    if (target === null)
        return { error: 'the path escapes its workspace' };
    if (target === resolve(base))
        return { error: 'the workspace root cannot be deleted' };
    try {
        await rm(target, { recursive: true, force: false });
        return { ok: true };
    }
    catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
    }
}
/** Copy one entry next to itself under a fresh name, as a client duplicate does. */
export async function duplicateEntry(base, requested) {
    const source = await resolveInside(base, requested);
    if (source === null)
        return { error: 'the path escapes its workspace' };
    if (source === resolve(base))
        return { error: 'the workspace root cannot be duplicated' };
    const extension = extname(source);
    const stem = source.slice(0, source.length - extension.length);
    for (let copy = 1; copy < 100; copy += 1) {
        const target = `${stem} copy${copy === 1 ? '' : ` ${String(copy)}`}${extension}`;
        if (await statOrNull(target) !== null)
            continue;
        try {
            await cp(source, target, { recursive: true, errorOnExist: true, force: false });
            return { path: relative(resolve(base), target) };
        }
        catch (error) {
            return { error: error instanceof Error ? error.message : String(error) };
        }
    }
    return { error: 'no free copy name was available' };
}
/** One path's size and modification time. */
export async function statEntry(base, requested) {
    const target = await resolveInside(base, requested);
    if (target === null)
        return null;
    const info = await statOrNull(target);
    return info === null ? null : { size: info.size, modifiedAt: info.mtime.toISOString() };
}
/** Stat one path, resolving null when it does not exist. */
async function statOrNull(target) {
    try {
        const info = await stat(target);
        return { size: info.size, mtime: info.mtime };
    }
    catch {
        // A path that never existed and a path that cannot be read are the same
        // answer here: nothing to compare against.
        return null;
    }
}
/** Name one upload's directory and file. */
export function uploadPath(home, id, fileName) {
    return join(home, 'uploads', id, sanitizeFileName(fileName));
}
/** Strip anything from a client-supplied name that a path must not carry. */
export function sanitizeFileName(name) {
    const base = name.replace(/[\\/]/g, '_').replace(/^\.+/, '').trim();
    return base.length === 0 ? 'upload' : base;
}
/** Create the file a begin frame starts writing into. */
export async function startUpload(target) {
    await mkdir(dirname(target.path), { recursive: true });
    await writeFile(target.path, new Uint8Array());
    target.started = true;
}
/**
 * Append one chunk.
 * @param target - upload being written.
 * @param bytes - chunk bytes.
 * @returns null when accepted, or the reason the chunk was refused.
 */
export async function appendUpload(target, bytes) {
    if (!target.started)
        return 'upload chunks arrived before the file began';
    if (target.received + bytes.byteLength > target.expectedSize) {
        return `upload exceeded its declared size: expected ${String(target.expectedSize)}, received ${String(target.received + bytes.byteLength)}`;
    }
    await appendFile(target.path, bytes);
    target.received += bytes.byteLength;
    return null;
}
/** Finish one upload, removing it when the byte count does not match. */
export async function finishUpload(target) {
    if (target.received !== target.expectedSize) {
        await rm(dirname(target.path), { recursive: true, force: true });
        return `upload size mismatch: expected ${String(target.expectedSize)}, received ${String(target.received)}`;
    }
    return null;
}
/** Discard an upload that failed or was abandoned. */
export async function discardUpload(target) {
    await rm(dirname(target.path), { recursive: true, force: true });
}
/**
 * Mint one download grant.
 *
 * The token is what the client puts on the download URL, so it is random and
 * short lived rather than derived from the path.
 * @param path - absolute file the token unlocks.
 * @param fileName - name offered in the download.
 * @param mimeType - media type to serve.
 * @returns the grant.
 */
export function createDownloadGrant(path, fileName, mimeType) {
    return { token: randomUUID(), path, fileName, mimeType, expiresAt: Date.now() + DOWNLOAD_GRANT_TTL_MS };
}
/** How long a download token stays valid. */
export const DOWNLOAD_GRANT_TTL_MS = 60_000;
/** Guess a media type from a file name. */
export function mediaTypeOf(fileName) {
    const media = IMAGE_TYPES[extname(fileName).toLowerCase()];
    if (media !== undefined)
        return media;
    if (fileName.endsWith('.json'))
        return 'application/json';
    if (fileName.endsWith('.md'))
        return 'text/markdown';
    if (fileName.endsWith('.txt') || fileName.endsWith('.log'))
        return 'text/plain';
    return 'application/octet-stream';
}
/**
 * Create one directory under a parent path.
 *
 * This is the project picker's "new folder", so unlike the workspace browser it
 * writes outside the advertised directories on purpose: the folder being
 * created is the one about to be added.
 * @param parentPath - directory to create it in.
 * @param name - one path segment.
 * @returns the created path, or why it was refused.
 */
export async function createDirectory(parentPath, name) {
    if (name.length === 0 || name.includes('/') || name === '.' || name === '..') {
        return { error: 'invalid_name' };
    }
    const parentInfo = await statOrNull(parentPath);
    if (parentInfo === null)
        return { error: 'parent_directory_not_found' };
    const target = join(parentPath, name);
    try {
        await mkdir(target, { recursive: false });
        return { path: target };
    }
    catch (error) {
        const code = error.code;
        return { error: code === 'EEXIST' ? 'already_exists' : 'create_failed' };
    }
}
