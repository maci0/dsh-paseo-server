/**
 * Paseo terminal stream frames.
 *
 * Terminal traffic does not ride the JSON envelope: each frame is
 * `[opcode][slot][payload]` and travels as a WebSocket binary frame, with the
 * slot identifying which subscription on the socket it belongs to. Output
 * payloads are raw terminal bytes; resize and snapshot payloads are JSON.
 *
 * @module dsh-paseo-server/paseo/terminal-frames
 */
/** Frame opcodes, as the Paseo protocol defines them. */
export declare const TERMINAL_OPCODE: {
    readonly OUTPUT: 1;
    readonly INPUT: 2;
    readonly RESIZE: 3;
    readonly SNAPSHOT: 4;
    readonly RESTORE: 5;
};
/** Highest slot a subscription may use. */
export declare const TERMINAL_MAX_SLOT = 255;
/** One decoded stream frame. */
export interface TerminalFrame {
    readonly opcode: number;
    readonly slot: number;
    readonly payload: Uint8Array;
}
/**
 * Build one stream frame.
 * @param opcode - frame kind.
 * @param slot - subscription slot.
 * @param payload - frame bytes, empty when the frame carries none.
 * @returns the encoded frame.
 */
export declare function encodeTerminalFrame(opcode: number, slot: number, payload?: Uint8Array): Uint8Array;
/** Encode one output frame carrying terminal bytes. */
export declare function encodeOutputFrame(slot: number, text: string): Uint8Array;
/**
 * Decode one stream frame.
 * @param bytes - frame bytes from the wire.
 * @returns the frame, or null when the opcode is not a stream opcode.
 */
export declare function decodeTerminalFrame(bytes: Uint8Array): TerminalFrame | null;
/** Decode a resize payload, which is JSON `{rows, cols}`. */
export declare function decodeResizePayload(payload: Uint8Array): {
    rows: number;
    cols: number;
} | null;
