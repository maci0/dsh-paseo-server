/**
 * Reminders this daemon paused.
 *
 * DSH has no paused state: a reminder is active or deleted. Pausing therefore
 * removes the reminder from the runtime and keeps its definition here, and
 * resuming recreates it. The file is the reason a paused reminder survives a
 * restart, and it is also the mapping between the identity a client was given
 * and the identity the runtime currently holds.
 *
 * @module dsh-paseo-server/dsh/paused-reminders
 */
import { readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { mkdir } from 'node:fs/promises';
/** Directory under the harness home that holds this plugin's own state. */
const STATE_DIRECTORY = 'paseo';
/** File name of the paused reminder record. */
const STATE_FILE = 'paused-reminders.json';
/**
 * Read the paused reminder file.
 * @param homePath - harness home path builder.
 * @returns the paused reminders, empty when nothing was ever paused.
 */
export async function loadPausedReminders(homePath) {
    const file = statePath(homePath);
    try {
        const parsed = JSON.parse(await readFile(file, 'utf8'));
        if (!Array.isArray(parsed.paused))
            return [];
        return parsed.paused.filter((entry) => typeof entry?.id === 'string' && typeof entry.sessionId === 'string');
    }
    catch {
        // An absent file is the normal first run; an unreadable one leaves the
        // daemon with no paused reminders rather than refusing to start.
        return [];
    }
}
/**
 * Write the paused reminder file, replacing it whole.
 * @param homePath - harness home path builder.
 * @param paused - reminders to store.
 */
export async function savePausedReminders(homePath, paused) {
    const file = statePath(homePath);
    await mkdir(dirname(file), { recursive: true });
    const temporary = `${file}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ paused }, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, file);
}
/** Absolute path of the state file. */
function statePath(homePath) {
    return join(homePath(STATE_DIRECTORY, STATE_FILE));
}
