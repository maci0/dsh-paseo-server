/**
 * The socket-shaped seam between a transport (direct WebSocket or a relay
 * end-to-end channel) and the Paseo session logic.
 *
 * @module dsh-paseo-server/paseo/transport
 */
/** One connected Paseo client, however it reached this daemon. */
export interface WireSocket {
    /** Send one text frame. */
    send(text: string): void;
    /** Close with a WebSocket code and reason. */
    close(code: number, reason: string): void;
    /** Remove every listener; called once the session is disposed. */
    detach(): void;
}
/** Transport-level events a session reacts to. */
export interface WireSocketEvents {
    /** One text frame arrived. */
    message(text: string): void;
    /** The peer closed. */
    close(): void;
}
