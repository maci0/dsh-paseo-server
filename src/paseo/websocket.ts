/**
 * Direct WebSocket binding: adapts a `ws` socket to the transport seam.
 *
 * @module dsh-paseo-server/paseo/websocket
 */

import { WebSocket as WsWebSocket } from 'ws'
import type { WebSocket, WebSocketServer } from 'ws'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import type { PaseoDaemon } from './daemon.ts'
import type { WireSocket } from './transport.ts'

/**
 * Speak the Paseo protocol over one upgraded WebSocket.
 * @param daemon - protocol state machine.
 * @param socket - upgraded socket.
 */
export function serveWebSocket(daemon: PaseoDaemon, socket: WebSocket): void {
  const wire: WireSocket = {
    send: (text) => {
      if (socket.readyState === WsWebSocket.OPEN) socket.send(text)
    },
    sendBinary: (bytes) => {
      if (socket.readyState === WsWebSocket.OPEN) socket.send(bytes, { binary: true })
    },
    close: (code, reason) => { socket.close(code, reason) },
    detach: () => { socket.removeAllListeners() },
  }
  const connection = daemon.attach(wire)
  socket.on('message', (data, isBinary) => {
    if (isBinary) {
      connection.receiveBinary(toBytes(data))
      return
    }
    connection.receive(typeof data === 'string' ? data : data.toString('utf8'))
  })
  socket.on('close', () => {
    connection.dispose()
    socket.removeAllListeners()
  })
  socket.on('error', () => {
    connection.dispose()
  })
}

/**
 * Complete an HTTP upgrade as a Paseo client connection.
 * @param daemon - protocol state machine.
 * @param server - server used to complete the handshake.
 * @param request - upgrade request.
 * @param socket - raw duplex socket.
 * @param head - bytes already read from the socket.
 */
export function upgradeWebSocket(
  daemon: PaseoDaemon,
  server: WebSocketServer,
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): void {
  server.handleUpgrade(request, socket, head, (ws) => { serveWebSocket(daemon, ws) })
}

/** Narrow a `ws` message payload to bytes. */
function toBytes(data: unknown): Uint8Array {
  if (Array.isArray(data)) return Uint8Array.from(Buffer.concat(data as Buffer[]))
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (Buffer.isBuffer(data)) return Uint8Array.from(data)
  return new Uint8Array(0)
}
