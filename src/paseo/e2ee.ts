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

import nacl from 'tweetnacl'

/** Bytes each encrypted frame adds over its plaintext. */
export const ENCRYPTED_PAYLOAD_OVERHEAD_BYTES = 40

/** Nonce length in bytes. */
const NONCE_BYTES = nacl.box.nonceLength

/** Plaintext handshake frame the client sends first. */
interface E2eeHello {
  readonly type: 'e2ee_hello'
  readonly key: string
  readonly capabilities?: { readonly binaryCiphertext?: boolean }
}

/** Minimal socket surface the channel needs. */
export interface ChannelSocket {
  send(data: string | Uint8Array): void
  close(code: number, reason: string): void
}

/** Callbacks the channel invokes. */
export interface ChannelEvents {
  /** One decrypted application frame. */
  message(text: string): void
  /** The peer closed, or the handshake failed. */
  close(): void
}

/**
 * Terminate end-to-end encryption for one relay data socket.
 *
 * Construction performs no I/O: feed raw frames to {@link receive} and the
 * channel answers the handshake and then decodes application frames.
 */
export class DaemonChannel {
  private sharedKey: Uint8Array | undefined
  private negotiatedBinary = false
  private closed = false

  constructor(
    private readonly socket: ChannelSocket,
    private readonly keyPair: nacl.BoxKeyPair,
    private readonly events: ChannelEvents,
  ) {}

  /** Whether the handshake completed and frames are being decrypted. */
  get ready(): boolean {
    return this.sharedKey !== undefined
  }

  /**
   * Handle one raw relay frame.
   * @param data - text or binary frame from the relay.
   */
  receive(data: string | Uint8Array): void {
    if (this.closed) return
    if (this.sharedKey === undefined) {
      this.handshake(data)
      return
    }
    const plaintext = this.decrypt(data)
    if (plaintext !== undefined) this.events.message(plaintext)
  }

  /**
   * Send one application frame, encrypted once the handshake completed.
   * @param text - plaintext application frame.
   */
  send(text: string): void {
    this.sendBytes(new TextEncoder().encode(text))
  }

  /**
   * Send one raw application frame, which is how terminal stream frames travel.
   * @param bytes - plaintext frame bytes.
   */
  sendBytes(bytes: Uint8Array): void {
    if (this.closed) return
    const key = this.sharedKey
    if (key === undefined) return
    const nonce = nacl.randomBytes(NONCE_BYTES)
    const ciphertext = nacl.box.after(bytes, nonce, key)
    const bundle = new Uint8Array(NONCE_BYTES + ciphertext.length)
    bundle.set(nonce, 0)
    bundle.set(ciphertext, NONCE_BYTES)
    this.socket.send(this.negotiatedBinary ? bundle : Buffer.from(bundle).toString('base64'))
  }

  /** Close the underlying socket. */
  close(code: number, reason: string): void {
    if (this.closed) return
    this.closed = true
    this.socket.close(code, reason)
  }

  /** Mark the channel closed without touching the socket. */
  markClosed(): void {
    this.closed = true
  }

  private handshake(data: string | Uint8Array): void {
    const text = typeof data === 'string' ? data : Buffer.from(data).toString('utf8')
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return
    }
    if (parsed === null || typeof parsed !== 'object') return
    const hello = parsed as Partial<E2eeHello>
    if (hello.type !== 'e2ee_hello' || typeof hello.key !== 'string') return
    const peerPublicKey = Uint8Array.from(Buffer.from(hello.key, 'base64'))
    if (peerPublicKey.length !== nacl.box.publicKeyLength) {
      this.close(1008, 'E2EE handshake key mismatch')
      return
    }
    const sharedKey = nacl.box.before(peerPublicKey, this.keyPair.secretKey)
    this.negotiatedBinary = hello.capabilities?.binaryCiphertext === true
    this.sharedKey = sharedKey
    this.socket.send(JSON.stringify({
      type: 'e2ee_ready',
      ...(this.negotiatedBinary ? { capabilities: { binaryCiphertext: true } } : {}),
    }))
  }

  private decrypt(data: string | Uint8Array): string | undefined {
    const key = this.sharedKey
    if (key === undefined) return undefined
    const bundle = typeof data === 'string'
      ? Uint8Array.from(Buffer.from(data, 'base64'))
      : Uint8Array.from(data)
    if (bundle.length < ENCRYPTED_PAYLOAD_OVERHEAD_BYTES) return undefined
    const nonce = bundle.subarray(0, NONCE_BYTES)
    const ciphertext = bundle.subarray(NONCE_BYTES)
    const plaintext = nacl.box.open.after(ciphertext, nonce, key)
    if (plaintext === null) return undefined
    return new TextDecoder().decode(plaintext)
  }
}

/** Exposed for the unit test: derive the shared key both sides use. */
export function sharedKeyFor(peerPublicKey: Uint8Array, secretKey: Uint8Array): Uint8Array {
  return nacl.box.before(peerPublicKey, secretKey)
}
