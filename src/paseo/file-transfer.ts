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
export const FILE_OPCODE = {
  BEGIN: 0x10,
  CHUNK: 0x11,
  END: 0x12,
} as const

/** Metadata a begin frame carries. */
export interface FileBeginMetadata {
  readonly mime: string
  readonly size: number
  readonly encoding: 'utf-8' | 'binary'
  readonly modifiedAt: string
  readonly fileName?: string
}

/** One decoded transfer frame. */
export type FileTransferFrame =
  | { readonly opcode: typeof FILE_OPCODE.BEGIN; readonly requestId: string; readonly metadata: FileBeginMetadata }
  | { readonly opcode: typeof FILE_OPCODE.CHUNK; readonly requestId: string; readonly payload: Uint8Array }
  | { readonly opcode: typeof FILE_OPCODE.END; readonly requestId: string }

/**
 * Decode one transfer frame.
 * @param bytes - frame bytes, which must already be known to be a transfer frame.
 * @returns the frame, or null when it is malformed.
 */
export function decodeFileTransferFrame(bytes: Uint8Array): FileTransferFrame | null {
  if (bytes.byteLength < 2) return null
  const opcode = bytes[0] ?? -1
  if (!isTransferOpcode(opcode)) return null
  const requestIdLength = bytes[1] ?? 0
  if (requestIdLength === 0 || requestIdLength > bytes.byteLength - 2) return null
  const requestId = new TextDecoder().decode(bytes.subarray(2, 2 + requestIdLength))
  const body = bytes.subarray(2 + requestIdLength)
  if (opcode === FILE_OPCODE.BEGIN) {
    if (body.byteLength < 2) return null
    const metadataLength = new DataView(body.buffer, body.byteOffset, body.byteLength).getUint16(0)
    if (metadataLength === 0 || 2 + metadataLength > body.byteLength) return null
    let parsed: unknown
    try {
      parsed = JSON.parse(new TextDecoder().decode(body.subarray(2, 2 + metadataLength)))
    } catch {
      return null
    }
    if (parsed === null || typeof parsed !== 'object') return null
    const record = parsed as Record<string, unknown>
    if (typeof record.mime !== 'string' || typeof record.size !== 'number') return null
    return {
      opcode: FILE_OPCODE.BEGIN,
      requestId,
      metadata: {
        mime: record.mime,
        size: record.size,
        encoding: record.encoding === 'utf-8' ? 'utf-8' : 'binary',
        modifiedAt: typeof record.modifiedAt === 'string' ? record.modifiedAt : new Date(0).toISOString(),
        ...(typeof record.fileName === 'string' ? { fileName: record.fileName } : {}),
      },
    }
  }
  if (opcode === FILE_OPCODE.CHUNK) return { opcode: FILE_OPCODE.CHUNK, requestId, payload: body }
  return { opcode: FILE_OPCODE.END, requestId }
}

/**
 * Encode one transfer frame.
 * @param frame - frame to encode.
 * @returns the encoded bytes.
 */
export function encodeFileTransferFrame(frame: FileTransferFrame): Uint8Array {
  const requestId = new TextEncoder().encode(frame.requestId)
  if (frame.opcode === FILE_OPCODE.BEGIN) {
    const metadata = new TextEncoder().encode(JSON.stringify(frame.metadata))
    const bytes = new Uint8Array(4 + requestId.byteLength + metadata.byteLength)
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    bytes[0] = frame.opcode
    bytes[1] = requestId.byteLength
    bytes.set(requestId, 2)
    view.setUint16(2 + requestId.byteLength, metadata.byteLength)
    bytes.set(metadata, 4 + requestId.byteLength)
    return bytes
  }
  const payload = frame.opcode === FILE_OPCODE.CHUNK ? frame.payload : new Uint8Array(0)
  const bytes = new Uint8Array(2 + requestId.byteLength + payload.byteLength)
  bytes[0] = frame.opcode
  bytes[1] = requestId.byteLength
  bytes.set(requestId, 2)
  bytes.set(payload, 2 + requestId.byteLength)
  return bytes
}

/** Whether one opcode belongs to the transfer family. */
export function isTransferOpcode(value: number): boolean {
  return value === FILE_OPCODE.BEGIN || value === FILE_OPCODE.CHUNK || value === FILE_OPCODE.END
}
