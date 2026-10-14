/**
 * Paseo relay transport, daemon side.
 *
 * The relay routes on the daemon's server id alone: this daemon opens one
 * control socket, and for every phone the relay reports it opens a data socket
 * that terminates end-to-end encryption. Nothing about the phone is trusted
 * before the key exchange completes.
 *
 * @module dsh-paseo-server/paseo/relay
 */

import { WebSocket } from 'ws'
import { DaemonChannel } from './e2ee.ts'
import type { KeyPair } from './identity.ts'
import type { Logger } from './daemon.ts'
import type { WireSocket, WireSocketEvents } from './transport.ts'

/** Relay endpoint used unless configuration names another one. */
export const DEFAULT_RELAY_ENDPOINT = 'relay.paseo.sh:443'

/** Milliseconds between control-socket keepalives, matching the Paseo daemon. */
const CONTROL_PING_INTERVAL_MS = 10_000

/** Milliseconds without a pong before the control socket is considered dead. */
const CONTROL_STALE_TIMEOUT_MS = 30_000

/** Longest reconnect delay. */
const MAX_RECONNECT_DELAY_MS = 30_000

/** How long a data socket may take to complete the key exchange. */
const DATA_HANDSHAKE_TIMEOUT_MS = 15_000

/** Options for {@link startRelayTransport}. */
export interface RelayOptions {
  readonly endpoint: string
  readonly useTls: boolean
  readonly serverId: string
  readonly keyPair: KeyPair
  readonly logger: Logger
  /** Called once a data socket completed the key exchange; returns the frame sink. */
  readonly onConnection: (socket: WireSocket) => WireSocketEvents
}

/** Running relay transport. */
export interface RelayTransport {
  /** Stop reconnecting and close every socket. */
  stop(): Promise<void>
  /** Number of live data sockets, for diagnostics. */
  readonly connections: number
}

/** Build the relay WebSocket URL for one role. */
export function relayWebSocketUrl(input: {
  readonly endpoint: string
  readonly useTls: boolean
  readonly serverId: string
  readonly role: 'server' | 'client'
  readonly connectionId?: string
}): string {
  const protocol = input.useTls ? 'wss' : 'ws'
  const { host, port } = splitEndpoint(input.endpoint)
  const url = new URL(`${protocol}://${host}:${port}/ws`)
  url.searchParams.set('serverId', input.serverId)
  url.searchParams.set('role', input.role)
  url.searchParams.set('v', '2')
  if (input.connectionId !== undefined) url.searchParams.set('connectionId', input.connectionId)
  return url.toString()
}

/**
 * Open and supervise the relay control socket.
 * @param options - identity, endpoint, and per-connection callback.
 * @returns the running transport.
 */
export function startRelayTransport(options: RelayOptions): RelayTransport {
  const sockets = new Map<string, WebSocket>()
  let control: WebSocket | null = null
  let stopped = false
  let attempt = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let pingTimer: ReturnType<typeof setInterval> | null = null
  let lastPongAt = 0

  const clearTimers = (): void => {
    if (reconnectTimer !== null) clearTimeout(reconnectTimer)
    if (pingTimer !== null) clearInterval(pingTimer)
    reconnectTimer = null
    pingTimer = null
  }

  const scheduleReconnect = (): void => {
    if (stopped || reconnectTimer !== null) return
    const delay = Math.min(MAX_RECONNECT_DELAY_MS, 1_000 * Math.max(1, attempt))
    attempt += 1
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      connectControl()
    }, delay)
  }

  const closeDataSocket = (connectionId: string): void => {
    const socket = sockets.get(connectionId)
    if (socket === undefined) return
    sockets.delete(connectionId)
    try {
      socket.close(1000, 'client disconnected')
    } catch {
      // Already gone.
    }
  }

  const openDataSocket = (connectionId: string): void => {
    if (stopped || sockets.has(connectionId)) return
    const url = relayWebSocketUrl({ endpoint: options.endpoint, useTls: options.useTls, serverId: options.serverId, role: 'server', connectionId })
    const socket = new WebSocket(url, { handshakeTimeout: 10_000, perMessageDeflate: false })
    sockets.set(connectionId, socket)

    let wired = false
    let deliver: ((text: string) => void) | undefined
    let onClose: (() => void) | undefined
    const buffered: string[] = []
    const handshakeTimer = setTimeout(() => {
      if (!wired) {
        socket.close(1011, 'E2EE handshake failed')
        closeDataSocket(connectionId)
      }
    }, DATA_HANDSHAKE_TIMEOUT_MS)

    const channel = new DaemonChannel(
      {
        send: (data) => {
          if (socket.readyState === WebSocket.OPEN) socket.send(data)
        },
        close: (code, reason) => { socket.close(code, reason) },
      },
      decodeKeyPair(options.keyPair),
      {
        message: (text) => {
          if (deliver !== undefined) deliver(text)
          else buffered.push(text)
        },
        close: () => { onClose?.() },
      },
    )

    socket.on('open', () => {
      options.logger.debug(`paseo: relay data socket ${connectionId} open`)
    })
    socket.on('message', (data, isBinary) => {
      channel.receive(isBinary ? toBytes(data) : data.toString())
      if (wired || !channel.ready) return
      wired = true
      clearTimeout(handshakeTimer)
      const events = options.onConnection({
        send: (text) => { channel.send(text) },
        close: (code, reason) => { channel.close(code, reason) },
        detach: () => { deliver = undefined },
      })
      deliver = (text) => { events.message(text) }
      onClose = () => { events.close() }
      for (const text of buffered.splice(0)) deliver(text)
    })
    socket.on('close', () => {
      clearTimeout(handshakeTimer)
      channel.markClosed()
      sockets.delete(connectionId)
      onClose?.()
    })
    socket.on('error', () => {
      clearTimeout(handshakeTimer)
      channel.markClosed()
      sockets.delete(connectionId)
    })
  }

  const handleControlFrame = (text: string): void => {
    let frame: unknown
    try {
      frame = JSON.parse(text)
    } catch {
      return
    }
    if (frame === null || typeof frame !== 'object') return
    const record = frame as Record<string, unknown>
    if (record.type === 'ping') {
      control?.send(JSON.stringify({ type: 'pong', ts: Date.now() }))
      return
    }
    if (record.type === 'connected' && typeof record.connectionId === 'string') {
      openDataSocket(record.connectionId)
      return
    }
    if (record.type === 'disconnected' && typeof record.connectionId === 'string') {
      closeDataSocket(record.connectionId)
      return
    }
    if (record.type === 'sync' && Array.isArray(record.connectionIds)) {
      const live = new Set(record.connectionIds.filter((id): id is string => typeof id === 'string'))
      for (const id of live) openDataSocket(id)
      for (const id of [...sockets.keys()]) if (!live.has(id)) closeDataSocket(id)
    }
  }

  function connectControl(): void {
    if (stopped) return
    const url = relayWebSocketUrl({ endpoint: options.endpoint, useTls: options.useTls, serverId: options.serverId, role: 'server' })
    const socket = new WebSocket(url, { handshakeTimeout: 10_000, perMessageDeflate: false })
    control = socket
    lastPongAt = Date.now()
    socket.on('open', () => {
      attempt = 0
      options.logger.info(`paseo: relay control connected for ${options.serverId}`)
      clearTimers()
      pingTimer = setInterval(() => {
        if (socket.readyState !== WebSocket.OPEN) return
        if (Date.now() - lastPongAt > CONTROL_STALE_TIMEOUT_MS) {
          socket.terminate()
          return
        }
        socket.ping()
      }, CONTROL_PING_INTERVAL_MS)
      pingTimer.unref()
    })
    socket.on('pong', () => { lastPongAt = Date.now() })
    socket.on('message', (data, isBinary) => {
      if (!isBinary) handleControlFrame(data.toString())
    })
    socket.on('close', () => {
      if (control === socket) control = null
      clearTimers()
      for (const id of [...sockets.keys()]) closeDataSocket(id)
      scheduleReconnect()
    })
    socket.on('error', (error: Error) => {
      options.logger.warn(`paseo: relay control error: ${error.message}`)
    })
  }

  connectControl()

  return {
    get connections(): number {
      return sockets.size
    },
    async stop(): Promise<void> {
      stopped = true
      clearTimers()
      for (const id of [...sockets.keys()]) closeDataSocket(id)
      control?.close(1000, 'daemon stopping')
      control = null
    },
  }
}

function toBytes(data: unknown): Uint8Array {
  if (Array.isArray(data)) return Uint8Array.from(Buffer.concat(data as Buffer[]))
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (Buffer.isBuffer(data)) return Uint8Array.from(data)
  return new Uint8Array(0)
}

function splitEndpoint(endpoint: string): { host: string; port: string } {
  const trimmed = endpoint.trim()
  if (trimmed.startsWith('[')) {
    const match = trimmed.match(/^\[([^\]]+)\]:(\d{1,5})$/)
    if (match === null) throw new Error(`invalid relay endpoint: ${endpoint}`)
    return { host: `[${match[1] as string}]`, port: match[2] as string }
  }
  const index = trimmed.lastIndexOf(':')
  if (index < 0) throw new Error(`relay endpoint must be host:port, got: ${endpoint}`)
  return { host: trimmed.slice(0, index), port: trimmed.slice(index + 1) }
}

function decodeKeyPair(keyPair: KeyPair): { publicKey: Uint8Array; secretKey: Uint8Array } {
  return {
    publicKey: Uint8Array.from(Buffer.from(keyPair.publicKeyB64, 'base64')),
    secretKey: Uint8Array.from(Buffer.from(keyPair.secretKeyB64, 'base64')),
  }
}
