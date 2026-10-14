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
/** One reminder the daemon removed and remembers. */
export interface PausedReminder {
    /** Identity the client was given, which survives pause and resume. */
    readonly id: string;
    readonly sessionId: string;
    readonly title: string;
    readonly prompt: string;
    readonly cadence: unknown;
    /** Instant the reminder was paused. */
    readonly pausedAt: string;
    /** Runtime identity while the reminder is live again after a resume. */
    readonly dshId?: string;
}
/** Paused reminders plus the identity map, as stored. */
export interface PausedState {
    readonly paused: readonly PausedReminder[];
}
/**
 * Read the paused reminder file.
 * @param homePath - harness home path builder.
 * @returns the paused reminders, empty when nothing was ever paused.
 */
export declare function loadPausedReminders(homePath: (...segments: string[]) => string): Promise<PausedReminder[]>;
/**
 * Write the paused reminder file, replacing it whole.
 * @param homePath - harness home path builder.
 * @param paused - reminders to store.
 */
export declare function savePausedReminders(homePath: (...segments: string[]) => string, paused: readonly PausedReminder[]): Promise<void>;
