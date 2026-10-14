/**
 * Paseo file-transfer frames.
 *
 * One binary channel carries both terminal traffic and file uploads, and the
 * first byte decides which: terminal frames use `0x01` to `0x05`, transfer
 * frames `0x10` to `0x12`. A transfer frame is `[opcode][requestIdLength]
 * [requestId][body]`, where the begin body is a two-byte length plus JSON
 * metadata and the other bodies are raw bytes.
 *
 * @module dsh-paseo-server/paseo/file-transfer
 */
/** Frame opcodes, as the Paseo protocol defines them. */
export declare const FILE_OPCODE: {
    readonly BEGIN: 16;
    readonly CHUNK: 17;
    readonly END: 18;
};
/** Metadata a begin frame carries. */
export interface FileBeginMetadata {
    readonly mime: string;
    readonly size: number;
    readonly encoding: 'utf-8' | 'binary';
    readonly modifiedAt: string;
    readonly fileName?: string;
}
/** One decoded transfer frame. */
export type FileTransferFrame = {
    readonly opcode: typeof FILE_OPCODE.BEGIN;
    readonly requestId: string;
    readonly metadata: FileBeginMetadata;
} | {
    readonly opcode: typeof FILE_OPCODE.CHUNK;
    readonly requestId: string;
    readonly payload: Uint8Array;
} | {
    readonly opcode: typeof FILE_OPCODE.END;
    readonly requestId: string;
};
/**
 * Decode one transfer frame.
 * @param bytes - frame bytes, which must already be known to be a transfer frame.
 * @returns the frame, or null when it is malformed.
 */
export declare function decodeFileTransferFrame(bytes: Uint8Array): FileTransferFrame | null;
/**
 * Encode one transfer frame.
 * @param frame - frame to encode.
 * @returns the encoded bytes.
 */
export declare function encodeFileTransferFrame(frame: FileTransferFrame): Uint8Array;
/** Whether one opcode belongs to the transfer family. */
export declare function isTransferOpcode(value: number): boolean;
