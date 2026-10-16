/**
 * Relay end-to-end encryption, daemon side.
 *
 * The Paseo relay only forwards bytes; the daemon and the phone share a
 * Curve25519 secret and encrypt every application frame with XSalsa20-
 * Poly1305. Frame layout is `[nonce 24][ciphertext]`, where the ciphertext
 * carries its own 16-byte authenticator, so each frame costs 40 bytes.
 *
 * @module dsh-paseo-server/paseo/e2ee
 */
import nacl from 'tweetnacl';
/** Bytes each encrypted frame adds over its plaintext. */
export declare const ENCRYPTED_PAYLOAD_OVERHEAD_BYTES = 40;
/** Minimal socket surface the channel needs. */
export interface ChannelSocket {
    send(data: string | Uint8Array): void;
    close(code: number, reason: string): void;
}
/** Callbacks the channel invokes. */
export interface ChannelEvents {
    /** One decrypted application frame. */
    message(text: string): void;
    /** One decrypted terminal or file-transfer frame. */
    binary?(bytes: Uint8Array): void;
    /** The peer closed, or the handshake failed. */
    close(): void;
}
/**
 * Terminate end-to-end encryption for one relay data socket.
 *
 * Construction performs no I/O: feed raw frames to {@link receive} and the
 * channel answers the handshake and then decodes application frames.
 */
export declare class DaemonChannel {
    private readonly socket;
    private readonly keyPair;
    private readonly events;
    private sharedKey;
    private negotiatedBinary;
    private closed;
    constructor(socket: ChannelSocket, keyPair: nacl.BoxKeyPair, events: ChannelEvents);
    /** Whether the handshake completed and frames are being decrypted. */
    get ready(): boolean;
    /**
     * Handle one raw relay frame.
     * @param data - text or binary frame from the relay.
     */
    receive(data: string | Uint8Array): void;
    /**
     * Send one application frame, encrypted once the handshake completed.
     * @param text - plaintext application frame.
     */
    send(text: string): void;
    /**
     * Send one raw application frame, which is how terminal stream frames travel.
     * @param bytes - plaintext frame bytes.
     */
    sendBytes(bytes: Uint8Array): void;
    /** Close the underlying socket. */
    close(code: number, reason: string): void;
    /** Mark the channel closed without touching the socket. */
    markClosed(): void;
    private handshake;
    private decrypt;
}
/** Exposed for the unit test: derive the shared key both sides use. */
export declare function sharedKeyFor(peerPublicKey: Uint8Array, secretKey: Uint8Array): Uint8Array;
