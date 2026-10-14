/**
 * Paseo daemon: one WebSocket session per connected Paseo client, plus the
 * fan-out of live agent, workspace, and timeline events from the bridge.
 *
 * @module dsh-paseo-server/paseo/daemon
 */
import type { AgentRecord, PaseoBridge } from '../bridge.ts';
import type { DownloadGrant } from '../dsh/files.ts';
import type { WireSocket } from './transport.ts';
/** Minimal logger surface; matches Cordis `ctx.logger`. */
export interface Logger {
    debug(message: string): void;
    info(message: string): void;
    warn(message: string): void;
}
/** What the daemon needs to publish a pairing offer. */
export interface PairingOffer {
    readonly url: string;
    /** Terminal-renderable QR of that URL, or null when rendering failed. */
    readonly qr: string | null;
    readonly relayEnabled: boolean;
}
/** Daemon construction options. */
export interface DaemonOptions {
    readonly bridge: PaseoBridge;
    readonly logger: Logger;
    readonly hostname: string;
    /** Relay endpoint host:port, when relay transport is enabled. */
    readonly relayEndpoint?: string;
    /** Shared secret a client must present in `hello`; empty accepts anyone. */
    readonly password?: string;
    /** Address the daemon listens on, for the status report; null when unknown. */
    readonly listen?: string;
    /** Supplies the current pairing offer, evaluated per request. */
    readonly pairingOffer: () => PairingOffer;
}
/** Live event fan-out plus request dispatch for every connected client. */
export declare class PaseoDaemon {
    private readonly options;
    private readonly connections;
    private unsubscribe;
    private closed;
    constructor(options: DaemonOptions);
    /** Start listening to bridge events. */
    start(): void;
    /** Stop the fan-out; transport sockets are owned by the caller. */
    stop(): void;
    /** Number of admitted clients, for diagnostics. */
    get size(): number;
    /**
     * Redeem one download token.
     *
     * The token is single use, so a second request for the same one is refused
     * even while the first is still streaming.
     * @param token - token from the download URL.
     * @returns the grant, or null when it is unknown or expired.
     */
    takeDownload(token: string): DownloadGrant | null;
    /**
     * Admit one transport socket as a Paseo client.
     *
     * The transport owns its own listeners and drives this handle: it calls
     * {@link PaseoConnection.receive} per text frame and
     * {@link PaseoConnection.dispose} when the peer goes away.
     * @param socket - transport to speak the protocol over.
     * @returns the connection handle for that socket.
     */
    attach(socket: WireSocket, host?: string): PaseoConnection;
    /**
     * Route one inbound binary frame.
     *
     * Terminals and uploads share this channel, so the opcode decides which
     * handler sees the frame.
     */
    private onBinaryFrame;
    /** Route one inbound text frame. */
    private onFrame;
    /** Answer one request message. */
    private dispatch;
    private readonly workspaceCache;
    /** Last known descriptor of every terminal, for change notifications. */
    private readonly terminalCache;
    /** Configuration facts the harness knows about this daemon. */
    private daemonConfig;
    /** Instant this daemon started, for the diagnostics snapshot. */
    private readonly startedAt;
    /** Outstanding download tokens, redeemed by the HTTP route. */
    private readonly downloads;
    /** Pending `wait_for_finish_request` waiters, keyed by agent id. */
    private readonly waiters;
    /** Resolve when an agent settles, or after the client's timeout. */
    private waitForSettle;
    private dropWaiter;
    /** Settle every waiter watching an agent that just finished. */
    private settleWaiters;
    private cacheWorkspaces;
    private workspaceFor;
    /**
     * Resolve a requested directory to one this daemon advertised.
     * @param directory - directory the client asked about.
     * @returns the canonical known directory, or null when nothing matches.
     */
    /**
     * Poll one directory's diff and tell the client when it changed.
     *
     * Git has no watch API, so a subscription is a bounded poll. Only a changed
     * serialization is sent, which keeps an idle working tree silent.
     */
    private watchDiff;
    /** Drop one live diff subscription. */
    private stopDiffWatch;
    /**
     * Run one checkout write and build its response frame.
     *
     * The directory is already resolved to one this daemon advertised, and the
     * commit message travels as its own argument, never through a shell.
     */
    private runCheckoutOperation;
    /** A directory to resolve a relative suggestion against: the newest workspace. */
    private defaultDirectory;
    /** One workspace record by identity, or a refresh of the cache. */
    private requireWorkspace;
    /** Workspace identity for one directory this daemon advertised. */
    private workspaceIdForDirectory;
    /** Claim the lowest free stream slot for one terminal on this connection. */
    private allocateSlot;
    /** Current version of one file, as the watch frames report it. */
    private fileVersion;
    /**
     * Watch one file by polling it.
     *
     * There is no portable file watch in the harness, so a subscription re-reads
     * the file's size and modification time and reports only a change.
     */
    private watchFile;
    /** Stop one file watch. */
    private stopFileWatch;
    /** End one terminal's stream on this connection and release its slot. */
    private stopTerminalStream;
    /** Send one terminal frame, preferring the binary stream the client subscribed to. */
    private sendTerminalEvent;
    private sendTerminalBytes;
    private publishTerminalState;
    /** Apply one upload frame against the upload this client already began. */
    private onTransferFrame;
    /** Drop a failed upload and tell the client why. */
    private failUpload;
    /** Apply one JSON terminal input, which is the client's non-stream input path. */
    private applyTerminalInput;
    private knownDirectory;
    /** Push one bridge event to every admitted client. */
    private onBridgeEvent;
    private publishAgentEvent;
    private publishTimeline;
    private broadcast;
}
/** Stable per-agent epoch the client uses to reject cross-epoch cursors. */
export declare function epochFor(agentId: string): string;
/** Handle for one admitted transport socket. */
export interface PaseoConnection {
    /** Feed one inbound text frame. */
    receive(text: string): void;
    /** Feed one inbound binary frame, which carries terminal stream frames. */
    receiveBinary(bytes: Uint8Array): void;
    /** Drop the connection without touching the socket. */
    dispose(): void;
}
/** Narrow a value to an agent record, for embedders. */
export declare function isAgentRecord(value: unknown): value is AgentRecord;
