/**
 * File transfer frame tests.
 *
 * Uploads share the binary channel with terminals, so a wrong header here
 * corrupts a file instead of failing loudly.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  FILE_OPCODE,
  decodeFileTransferFrame,
  encodeFileTransferFrame,
  isTransferOpcode,
} from '../src/paseo/file-transfer.ts'

test('a begin frame round trips its metadata', () => {
  const frame = encodeFileTransferFrame({
    opcode: FILE_OPCODE.BEGIN,
    requestId: 'req_1',
    metadata: { mime: 'image/png', size: 12, encoding: 'binary', modifiedAt: '2026-01-01T00:00:00.000Z', fileName: 'a.png' },
  })
  assert.equal(frame[0], FILE_OPCODE.BEGIN)
  const decoded = decodeFileTransferFrame(frame)
  assert.equal(decoded?.opcode, FILE_OPCODE.BEGIN)
  assert.equal(decoded?.requestId, 'req_1')
  assert.equal(decoded?.opcode === FILE_OPCODE.BEGIN ? decoded.metadata.mime : null, 'image/png')
  assert.equal(decoded?.opcode === FILE_OPCODE.BEGIN ? decoded.metadata.size : null, 12)
})

test('a chunk frame carries its bytes unchanged', () => {
  const payload = new Uint8Array([0, 1, 2, 255])
  const decoded = decodeFileTransferFrame(encodeFileTransferFrame({ opcode: FILE_OPCODE.CHUNK, requestId: 'r', payload }))
  assert.deepEqual(decoded?.opcode === FILE_OPCODE.CHUNK ? [...decoded.payload] : [], [0, 1, 2, 255])
})

test('an end frame carries only its request id', () => {
  const decoded = decodeFileTransferFrame(encodeFileTransferFrame({ opcode: FILE_OPCODE.END, requestId: 'req_9' }))
  assert.deepEqual(decoded, { opcode: FILE_OPCODE.END, requestId: 'req_9' })
})

test('a truncated or foreign frame is refused', () => {
  assert.equal(decodeFileTransferFrame(new Uint8Array([FILE_OPCODE.BEGIN])), null)
  assert.equal(decodeFileTransferFrame(new Uint8Array([FILE_OPCODE.BEGIN, 0])), null)
  assert.equal(decodeFileTransferFrame(new Uint8Array([0x01, 3, 97, 98, 99])), null)
})

test('terminal opcodes are not transfer opcodes', () => {
  assert.equal(isTransferOpcode(0x01), false)
  assert.equal(isTransferOpcode(FILE_OPCODE.CHUNK), true)
})
