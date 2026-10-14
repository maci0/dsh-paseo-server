/**
 * Terminal stream frame tests.
 *
 * Terminal traffic does not ride the JSON envelope, so a byte-level mistake
 * here makes every terminal silently empty.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  TERMINAL_OPCODE,
  decodeResizePayload,
  decodeTerminalFrame,
  encodeOutputFrame,
  encodeTerminalFrame,
} from '../src/paseo/terminal-frames.ts'

test('an output frame is opcode, slot, then bytes', () => {
  const frame = encodeOutputFrame(3, 'hi')
  assert.equal(frame[0], TERMINAL_OPCODE.OUTPUT)
  assert.equal(frame[1], 3)
  assert.equal(new TextDecoder().decode(frame.subarray(2)), 'hi')

  const decoded = decodeTerminalFrame(frame)
  assert.equal(decoded?.opcode, TERMINAL_OPCODE.OUTPUT)
  assert.equal(decoded?.slot, 3)
  assert.equal(new TextDecoder().decode(decoded?.payload), 'hi')
})

test('a slot above 255 wraps into one byte', () => {
  assert.equal(encodeTerminalFrame(TERMINAL_OPCODE.OUTPUT, 256)[1], 0)
})

test('a frame shorter than its header is refused', () => {
  assert.equal(decodeTerminalFrame(new Uint8Array([TERMINAL_OPCODE.OUTPUT])), null)
})

test('an unknown opcode is refused', () => {
  assert.equal(decodeTerminalFrame(new Uint8Array([0x7f, 0, 1])), null)
})

test('a resize payload is JSON rows and columns', () => {
  const payload = new TextEncoder().encode(JSON.stringify({ rows: 40, cols: 120 }))
  assert.deepEqual(decodeResizePayload(payload), { rows: 40, cols: 120 })
})

test('a malformed or empty resize payload is refused', () => {
  assert.equal(decodeResizePayload(new TextEncoder().encode('not json')), null)
  assert.equal(decodeResizePayload(new TextEncoder().encode('{}')), null)
  assert.equal(decodeResizePayload(new TextEncoder().encode('{"rows":0,"cols":80}')), null)
})
