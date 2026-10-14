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
export const TERMINAL_OPCODE = {
    OUTPUT: 0x01,
    INPUT: 0x02,
    RESIZE: 0x03,
    SNAPSHOT: 0x04,
    RESTORE: 0x05,
};
/** Highest slot a subscription may use. */
export const TERMINAL_MAX_SLOT = 255;
/**
 * Build one stream frame.
 * @param opcode - frame kind.
 * @param slot - subscription slot.
 * @param payload - frame bytes, empty when the frame carries none.
 * @returns the encoded frame.
 */
export function encodeTerminalFrame(opcode, slot, payload = new Uint8Array(0)) {
    const frame = new Uint8Array(2 + payload.byteLength);
    frame[0] = opcode;
    frame[1] = slot & 0xff;
    frame.set(payload, 2);
    return frame;
}
/** Encode one output frame carrying terminal bytes. */
export function encodeOutputFrame(slot, text) {
    return encodeTerminalFrame(TERMINAL_OPCODE.OUTPUT, slot, new TextEncoder().encode(text));
}
/**
 * Decode one stream frame.
 * @param bytes - frame bytes from the wire.
 * @returns the frame, or null when the opcode is not a stream opcode.
 */
export function decodeTerminalFrame(bytes) {
    if (bytes.byteLength < 2)
        return null;
    const opcode = bytes[0] ?? 0;
    if (!isStreamOpcode(opcode))
        return null;
    return { opcode, slot: bytes[1] ?? 0, payload: bytes.subarray(2) };
}
/** Decode a resize payload, which is JSON `{rows, cols}`. */
export function decodeResizePayload(payload) {
    try {
        const parsed = JSON.parse(new TextDecoder().decode(payload));
        if (typeof parsed.rows !== 'number' || typeof parsed.cols !== 'number')
            return null;
        if (parsed.rows <= 0 || parsed.cols <= 0)
            return null;
        return { rows: parsed.rows, cols: parsed.cols };
    }
    catch {
        return null;
    }
}
function isStreamOpcode(value) {
    return value === TERMINAL_OPCODE.OUTPUT
        || value === TERMINAL_OPCODE.INPUT
        || value === TERMINAL_OPCODE.RESIZE
        || value === TERMINAL_OPCODE.SNAPSHOT
        || value === TERMINAL_OPCODE.RESTORE;
}
