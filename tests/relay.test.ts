import assert from 'node:assert/strict'
import { test } from 'node:test'
import { once } from 'node:events'
import nacl from 'tweetnacl'
import { WebSocketServer } from 'ws'
import { generateKeyPair } from '../src/paseo/identity.ts'
import { startRelayTransport } from '../src/paseo/relay.ts'
import { encodeTerminalFrame, TERMINAL_OPCODE } from '../src/paseo/terminal-frames.ts'

test('the relay delivers decrypted binary frames to the binary handler', { timeout: 3_000 }, async (t) => {
  const keys = generateKeyPair()
  const clientKeys = nacl.box.keyPair()
  const frame = encodeTerminalFrame(TERMINAL_OPCODE.INPUT, 255, new Uint8Array([0, 128, 255]))
  const relay = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  t.after(() => { for (const socket of relay.clients) socket.terminate(); relay.close() })
  await once(relay, 'listening')
  const address = relay.address()
  assert.ok(typeof address === 'object' && address !== null)
  relay.on('connection', (socket, req) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (!url.searchParams.has('connectionId')) {
      socket.send(JSON.stringify({ type: 'connected', connectionId: 'test' }))
      return
    }
    socket.send(JSON.stringify({ type: 'e2ee_hello', key: Buffer.from(clientKeys.publicKey).toString('base64'), capabilities: { binaryCiphertext: true } }))
    socket.once('message', () => {
      const shared = nacl.box.before(Uint8Array.from(Buffer.from(keys.publicKeyB64, 'base64')), clientKeys.secretKey)
      const nonce = nacl.randomBytes(nacl.box.nonceLength)
      const cipher = nacl.box.after(frame, nonce, shared)
      socket.send(Buffer.concat([nonce, cipher]))
    })
  })
  let receive!: (bytes: Uint8Array) => void
  const received = new Promise<Uint8Array>((resolve) => { receive = resolve })
  const transport = startRelayTransport({
    endpoint: `127.0.0.1:${address.port}`, useTls: false, serverId: 'test', keyPair: keys,
    logger: { debug() {}, info() {}, warn() {} },
    onConnection: () => ({ message: () => { assert.fail('binary traffic reached the text handler') }, binary: receive, close() {} }),
  })
  t.after(() => transport.stop())
  assert.deepEqual(await received, frame)
})
