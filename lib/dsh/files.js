/**
 * The file surface a client browses: one directory listing and one file read.
 *
 * Every path is resolved against the workspace directory the daemon advertised
 * and refused when it escapes that directory, so a browse request cannot read
 * the rest of the machine.
 *
 * @module dsh-paseo-server/dsh/files
 */
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
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
 * @returns the absolute path, or null when it escapes the workspace.
 */
export function resolveInside(base, requested) {
    const root = resolve(base);
    const wanted = requested === undefined || requested.length === 0 ? '.' : requested;
    if (isAbsolute(wanted))
        return null;
    const target = resolve(root, wanted);
    const inside = relative(root, target);
    if (inside.startsWith('..') || isAbsolute(inside))
        return null;
    return target;
}
/**
 * List one directory.
 * @param base - workspace directory.
 * @param requested - path inside it.
 * @returns the entries sorted by name, or null when the path is not a readable directory.
 */
export async function listDirectory(base, requested) {
    const target = resolveInside(base, requested);
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
                const info = await stat(full);
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
    const target = resolveInside(base, requested);
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
