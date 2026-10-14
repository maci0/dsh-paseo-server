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
/** Paseo cadence, as the client sends and stores it. */
export type PaseoCadence = {
    readonly type: 'every';
    readonly everyMs: number;
} | {
    readonly type: 'cron';
    readonly expression: string;
    readonly timezone?: string;
};
/** Timing fields a DSH reminder can be created with. */
export type DshTiming = {
    readonly every_seconds: number;
} | {
    readonly cron: {
        readonly expression: string;
        readonly time_zone: string;
    };
};
/** Shortest interval DSH accepts, in seconds. */
export declare const MIN_EVERY_SECONDS = 60;
/** Cadence projection of one DSH reminder, or null when it has no Paseo shape. */
export interface CadenceSource {
    readonly kind: 'after' | 'at' | 'every' | 'daily' | 'weekly' | 'cron';
    /** Absolute instant of a one-shot reminder, as RFC 3339 UTC. */
    readonly scheduledAt?: string;
    readonly everySeconds?: number;
    readonly expression?: string;
    readonly timeZone?: string;
    readonly dailyTime?: string;
    readonly weekdays?: readonly number[];
}
/**
 * Project a DSH reminder's recurrence onto a Paseo cadence.
 *
 * A one-shot reminder has no recurring cadence, so it projects onto the cron
 * rule for its exact instant. The caller pairs that with `maxRuns: 1` and an
 * expiry at the same instant, which is what keeps the client from reading it
 * as a yearly recurrence.
 * @param source - the reminder's rule fields.
 * @returns the cadence, or null when the rule has no clock shape at all.
 */
export declare function toPaseoCadence(source: CadenceSource): PaseoCadence | null;
/**
 * Convert a Paseo cadence into the timing fields DSH accepts.
 * @param cadence - requested cadence.
 * @returns the timing, or the reason DSH cannot express it.
 */
export declare function fromPaseoCadence(cadence: PaseoCadence): DshTiming | {
    readonly error: string;
};
