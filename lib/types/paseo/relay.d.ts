/**
 * Paseo relay transport, daemon side.
 *
 * The relay routes on the daemon's server id alone: this daemon opens one
 * control socket, and for every phone the relay reports it opens a data socket
 * that terminates end-to-end encryption. Nothing about the phone is trusted
 * before the key exchange completes.
 *
 * @module dsh-paseo-server/paseo/relay
 */
import type { KeyPair } from './identity.ts';
import type { Logger } from './daemon.ts';
import type { WireSocket, WireSocketEvents } from './transport.ts';
/** Relay endpoint used unless configuration names another one. */
export declare const DEFAULT_RELAY_ENDPOINT = "relay.paseo.sh:443";
/** Options for {@link startRelayTransport}. */
export interface RelayOptions {
    readonly endpoint: string;
    readonly useTls: boolean;
    readonly serverId: string;
    readonly keyPair: KeyPair;
    readonly logger: Logger;
    /** Called once a data socket completed the key exchange; returns the frame sink. */
    readonly onConnection: (socket: WireSocket) => WireSocketEvents;
}
/** Running relay transport. */
export interface RelayTransport {
    /** Stop reconnecting and close every socket. */
    stop(): Promise<void>;
    /** Number of live data sockets, for diagnostics. */
    readonly connections: number;
}
/** Build the relay WebSocket URL for one role. */
export declare function relayWebSocketUrl(input: {
    readonly endpoint: string;
    readonly useTls: boolean;
    readonly serverId: string;
    readonly role: 'server' | 'client';
    readonly connectionId?: string;
}): string;
/**
 * Open and supervise the relay control socket.
 * @param options - identity, endpoint, and per-connection callback.
 * @returns the running transport.
 */
export declare function startRelayTransport(options: RelayOptions): RelayTransport;
