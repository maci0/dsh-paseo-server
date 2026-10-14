/**
 * Direct WebSocket binding: adapts a `ws` socket to the transport seam.
 *
 * @module dsh-paseo-server/paseo/websocket
 */
import type { WebSocket, WebSocketServer } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { PaseoDaemon } from './daemon.ts';
/**
 * Speak the Paseo protocol over one upgraded WebSocket.
 * @param daemon - protocol state machine.
 * @param socket - upgraded socket.
 */
export declare function serveWebSocket(daemon: PaseoDaemon, socket: WebSocket): void;
/**
 * Complete an HTTP upgrade as a Paseo client connection.
 * @param daemon - protocol state machine.
 * @param server - server used to complete the handshake.
 * @param request - upgrade request.
 * @param socket - raw duplex socket.
 * @param head - bytes already read from the socket.
 */
export declare function upgradeWebSocket(daemon: PaseoDaemon, server: WebSocketServer, request: IncomingMessage, socket: Duplex, head: Buffer): void;
