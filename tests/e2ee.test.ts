/**
 * End-to-end encryption tests.
 *
 * These drive the real handshake a phone performs: plaintext `e2ee_hello`,
 * plaintext `e2ee_ready`, then XSalsa20-Poly1305 frames in both directions.
 * A regression here locks every relay client out, so both directions and the
 * rejection path are covered.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import nacl from 'tweetnacl'
import { DaemonChannel, ENCRYPTED_PAYLOAD_OVERHEAD_BYTES } from '../src/paseo/e2ee.ts'
import { generateKeyPair, decodeKeyPair } from '../src/paseo/identity.ts'

/** A socket that records everything sent to it. */
function recordingSocket() {
  const sent: Array<string | Uint8Array> = []
  return {
    sent,
    send(data: string | Uint8Array) { sent.push(data) },
    close() {},
  }
}

test('a relay client completes the handshake and exchanges frames both ways', () => {
  const daemonKeys = decodeKeyPair(generateKeyPair())
  const clientKeys = nacl.box.keyPair()
  const socket = recordingSocket()
  const received: string[] = []
  let closed = false

  const channel = new DaemonChannel(socket, daemonKeys, {
    message: (text) => { received.push(text) },
    close: () => { closed = true },
  })

  channel.receive(JSON.stringify({
    type: 'e2ee_hello',
    key: Buffer.from(clientKeys.publicKey).toString('base64'),
    capabilities: { binaryCiphertext: true },
  }))

  const ready = JSON.parse(socket.sent[0] as string) as Record<string, unknown>
  assert.equal(ready.type, 'e2ee_ready')
  assert.deepEqual(ready.capabilities, { binaryCiphertext: true })
  assert.equal(channel.ready, true)

  // Client to daemon.
  const shared = nacl.box.before(daemonKeys.publicKey, clientKeys.secretKey)
  const nonce = nacl.randomBytes(nacl.box.nonceLength)
  const plaintext = new TextEncoder().encode('{"type":"session","message":{"type":"ping"}}')
  const ciphertext = nacl.box.after(plaintext, nonce, shared)
  const bundle = new Uint8Array(nonce.length + ciphertext.length)
  bundle.set(nonce, 0)
  bundle.set(ciphertext, nonce.length)
  assert.equal(bundle.length, plaintext.length + ENCRYPTED_PAYLOAD_OVERHEAD_BYTES)
  channel.receive(bundle)
  assert.deepEqual(received, ['{"type":"session","message":{"type":"ping"}}'])

  // Daemon to client.
  channel.send('{"type":"session","message":{"type":"status"}}')
  const outbound = socket.sent[1] as Uint8Array
  const openNonce = outbound.subarray(0, nacl.box.nonceLength)
  const opened = nacl.box.open.after(outbound.subarray(nacl.box.nonceLength), openNonce, shared)
  assert.equal(new TextDecoder().decode(opened as Uint8Array), '{"type":"session","message":{"type":"status"}}')
  assert.equal(closed, false)
})

test('a tampered frame is dropped instead of delivered', () => {
  const daemonKeys = decodeKeyPair(generateKeyPair())
  const clientKeys = nacl.box.keyPair()
  const socket = recordingSocket()
  const received: string[] = []
  const channel = new DaemonChannel(socket, daemonKeys, { message: (text) => { received.push(text) }, close: () => {} })
  channel.receive(JSON.stringify({ type: 'e2ee_hello', key: Buffer.from(clientKeys.publicKey).toString('base64') }))

  const shared = nacl.box.before(daemonKeys.publicKey, clientKeys.secretKey)
  const nonce = nacl.randomBytes(nacl.box.nonceLength)
  const ciphertext = nacl.box.after(new TextEncoder().encode('secret'), nonce, shared)
  ciphertext[0] = (ciphertext[0] as number) ^ 0xff
  const bundle = new Uint8Array(nonce.length + ciphertext.length)
  bundle.set(nonce, 0)
  bundle.set(ciphertext, nonce.length)
  channel.receive(bundle)
  assert.deepEqual(received, [])
})

test('a handshake with a bad key closes the socket instead of trusting it', () => {
  const daemonKeys = decodeKeyPair(generateKeyPair())
  const closes: Array<{ code: number; reason: string }> = []
  const channel = new DaemonChannel(
    { send: () => {}, close: (code, reason) => { closes.push({ code, reason }) } },
    daemonKeys,
    { message: () => {}, close: () => {} },
  )
  channel.receive(JSON.stringify({ type: 'e2ee_hello', key: Buffer.from('short').toString('base64') }))
  assert.equal(closes.length, 1)
  assert.equal(closes[0]?.code, 1008)
})
