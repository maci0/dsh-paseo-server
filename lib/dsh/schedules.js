/**
 * Reminder cadence conversion between the two models.
 *
 * Paseo offers two cadences, a fixed interval and a cron expression. DSH
 * offers five, so the conversion is lossy in one direction on purpose: a
 * one-shot reminder has no Paseo cadence and is left out of the listing
 * rather than shown as a recurring one that would fire again.
 *
 * @module dsh-paseo-server/dsh/schedules
 */
/** Shortest interval DSH accepts, in seconds. */
export const MIN_EVERY_SECONDS = 60;
/**
 * Project a DSH reminder's recurrence onto a Paseo cadence.
 * @param source - the reminder's rule fields.
 * @returns the cadence, or null for a one-shot reminder.
 */
export function toPaseoCadence(source) {
    switch (source.kind) {
        case 'every': {
            if (source.everySeconds === undefined)
                return null;
            return { type: 'every', everyMs: source.everySeconds * 1_000 };
        }
        case 'cron': {
            if (source.expression === undefined)
                return null;
            return {
                type: 'cron',
                expression: source.expression,
                ...(source.timeZone === undefined ? {} : { timezone: source.timeZone }),
            };
        }
        case 'daily': {
            const at = clockParts(source.dailyTime);
            if (at === null)
                return null;
            return { type: 'cron', expression: `${String(at.minute)} ${String(at.hour)} * * *`, timezone: source.timeZone ?? 'UTC' };
        }
        case 'weekly': {
            const at = clockParts(source.dailyTime);
            if (at === null || source.weekdays === undefined || source.weekdays.length === 0)
                return null;
            // ISO weekdays are already cron's numbering for Sunday through Saturday
            // once Sunday is mapped back to 0.
            const days = source.weekdays.map((day) => day === 7 ? 0 : day).join(',');
            return {
                type: 'cron',
                expression: `${String(at.minute)} ${String(at.hour)} * * ${days}`,
                timezone: source.timeZone ?? 'UTC',
            };
        }
        default:
            return null;
    }
}
/**
 * Convert a Paseo cadence into the timing fields DSH accepts.
 * @param cadence - requested cadence.
 * @returns the timing, or the reason DSH cannot express it.
 */
export function fromPaseoCadence(cadence) {
    if (cadence.type === 'cron') {
        return { cron: { expression: cadence.expression, time_zone: cadence.timezone ?? 'UTC' } };
    }
    const seconds = Math.round(cadence.everyMs / 1_000);
    if (seconds < MIN_EVERY_SECONDS) {
        return { error: `DSH runs a recurring reminder no more often than every ${String(MIN_EVERY_SECONDS)} seconds` };
    }
    return { every_seconds: seconds };
}
/** Hour and minute of a `HH:MM:SS` clock time. */
function clockParts(time) {
    const match = time?.match(/^(\d{2}):(\d{2})/);
    if (match === null || match === undefined)
        return null;
    return { hour: Number(match[1]), minute: Number(match[2]) };
}
