/**
 * Daemon identity: the server id the relay routes on and the Curve25519 key
 * pair that terminates relay end-to-end encryption.
 *
 * Both are generated once and reused, so a phone that paired yesterday still
 * reaches this daemon today. Files are written owner-only, matching the
 * credential-handling rule for local secrets.
 *
 * @module dsh-paseo-server/paseo/identity
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import nacl from 'tweetnacl'

/** Base64 alphabet including both URL-safe and standard variants. */
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** Characters in the random tail of a server id. */
const SERVER_ID_TAIL_CHARS = 12

/** One Curve25519 key pair, base64 encoded as Paseo stores it. */
export interface KeyPair {
  readonly publicKeyB64: string
  readonly secretKeyB64: string
}

/** Persisted daemon identity. */
export interface DaemonIdentity {
  readonly serverId: string
  readonly keyPair: KeyPair
}

/**
 * Read the identity in `directory`, generating and persisting it when absent.
 * @param directory - plugin data directory.
 * @returns the stable identity.
 */
export function loadOrCreateIdentity(directory: string): DaemonIdentity {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const serverIdPath = join(directory, 'server-id')
  const keyPairPath = join(directory, 'daemon-keypair.json')

  const serverId = existsSync(serverIdPath) ? readFileSync(serverIdPath, 'utf8').trim() : newServerId()
  if (!existsSync(serverIdPath)) writePrivate(serverIdPath, serverId)

  let keyPair: KeyPair
  if (existsSync(keyPairPath)) {
    keyPair = parseKeyPair(JSON.parse(readFileSync(keyPairPath, 'utf8')))
  } else {
    keyPair = generateKeyPair()
    writePrivate(keyPairPath, `${JSON.stringify({ v: 2, ...keyPair }, null, 2)}\n`)
  }
  return { serverId, keyPair }
}

/** Decode a stored key pair back to raw bytes. */
export function decodeKeyPair(keyPair: KeyPair): nacl.BoxKeyPair {
  return {
    publicKey: Uint8Array.from(Buffer.from(keyPair.publicKeyB64, 'base64')),
    secretKey: Uint8Array.from(Buffer.from(keyPair.secretKeyB64, 'base64')),
  }
}

/** Generate a fresh daemon key pair. */
export function generateKeyPair(): KeyPair {
  const pair = nacl.box.keyPair()
  return {
    publicKeyB64: Buffer.from(pair.publicKey).toString('base64'),
    secretKeyB64: Buffer.from(pair.secretKey).toString('base64'),
  }
}

/** Paseo server ids are `srv_` plus twelve base64url characters. */
function newServerId(): string {
  const bytes = nacl.randomBytes(SERVER_ID_TAIL_CHARS)
  let tail = ''
  for (const byte of bytes) tail += BASE64_ALPHABET[byte % 64]
  return `srv_${tail.replace(/\+/g, '-').replace(/\//g, '_')}`
}

function parseKeyPair(value: unknown): KeyPair {
  if (value === null || typeof value !== 'object') throw new Error('daemon-keypair.json is not an object')
  const record = value as Record<string, unknown>
  const publicKeyB64 = record.publicKeyB64
  const secretKeyB64 = record.secretKeyB64
  if (typeof publicKeyB64 !== 'string' || typeof secretKeyB64 !== 'string') {
    throw new Error('daemon-keypair.json is missing publicKeyB64 or secretKeyB64')
  }
  return { publicKeyB64, secretKeyB64 }
}

function writePrivate(path: string, contents: string): void {
  writeFileSync(path, contents, { mode: 0o600 })
  chmodSync(path, 0o600)
}
