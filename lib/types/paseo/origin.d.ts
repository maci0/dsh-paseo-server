/**
 * Browser-origin fence for the Paseo upgrade.
 *
 * A WebSocket handshake is not subject to the same-origin policy, so a page on
 * any site can open `ws://127.0.0.1:<port>/ws` and speak this protocol. The
 * browser always attaches `Origin` to that handshake, and a native client
 * never does, so refusing a foreign origin closes the hole without asking the
 * Paseo CLI or app for a credential it does not have.
 *
 * @module dsh-paseo-server/paseo/origin
 */
/** Origins a browser may use to reach this daemon. */
export declare const DEFAULT_ALLOWED_ORIGINS: readonly string[];
/**
 * Whether an upgrade may proceed.
 *
 * An absent origin is a native client: the HTTP layer cannot forge one, and
 * only a browser sets it for a cross-site handshake.
 * @param origin - raw `Origin` header, when present.
 * @param allowed - configured origins, compared case-insensitively.
 * @param listenerOrigin - this daemon's own HTTP origin, when known.
 * @returns true when the upgrade may proceed.
 */
export declare function originAllowed(origin: string | undefined, allowed: readonly string[], listenerOrigin?: string): boolean;
/** Reject one upgrade with a minimal HTTP response, then drop the socket. */
export declare function rejectUpgrade(socket: {
    write(data: string): unknown;
    destroy(): unknown;
}): void;
