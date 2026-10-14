/**
 * Workspace scripts, as `paseo.json` declares them.
 *
 * Paseo keeps its per-workspace script declarations in `paseo.json` at the
 * workspace root, so this daemon reads the same file. Nothing else about the
 * format is invented: a script is a name, an optional lifecycle type, a
 * command, and an optional port.
 *
 * @module dsh-paseo-server/dsh/scripts
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
/** Declaration file Paseo reads from a workspace root. */
const SCRIPT_FILE = 'paseo.json';
/** Longest command this daemon will run, as a guard against a pathological file. */
const MAX_COMMAND_CHARS = 4_000;
/**
 * Read one workspace's script declarations.
 * @param directory - workspace directory.
 * @returns the declarations, empty when the file is absent or unreadable.
 */
export async function readWorkspaceScripts(directory) {
    let raw;
    try {
        raw = await readFile(join(directory, SCRIPT_FILE), 'utf8');
    }
    catch {
        return [];
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return [];
    }
    if (parsed === null || typeof parsed !== 'object')
        return [];
    const scripts = parsed.scripts;
    if (scripts === null || typeof scripts !== 'object' || Array.isArray(scripts))
        return [];
    const definitions = [];
    for (const [name, entry] of Object.entries(scripts)) {
        if (entry === null || typeof entry !== 'object')
            continue;
        const record = entry;
        const command = typeof record.command === 'string' ? record.command.trim() : '';
        if (command.length === 0 || command.length > MAX_COMMAND_CHARS)
            continue;
        definitions.push({
            name,
            type: record.type === 'script' ? 'script' : 'service',
            command,
            port: typeof record.port === 'number' && Number.isInteger(record.port) ? record.port : null,
        });
    }
    return definitions;
}
