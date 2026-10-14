/**
 * Direct WebSocket binding: adapts a `ws` socket to the transport seam.
 *
 * @module dsh-paseo-server/paseo/websocket
 */
import { WebSocket as WsWebSocket } from 'ws';
/**
 * Speak the Paseo protocol over one upgraded WebSocket.
 * @param daemon - protocol state machine.
 * @param socket - upgraded socket.
 */
export function serveWebSocket(daemon, socket, host) {
    const wire = {
        send: (text) => {
            if (socket.readyState === WsWebSocket.OPEN)
                socket.send(text);
        },
        sendBinary: (bytes) => {
            if (socket.readyState === WsWebSocket.OPEN)
                socket.send(bytes, { binary: true });
        },
        close: (code, reason) => { socket.close(code, reason); },
        detach: () => { socket.removeAllListeners(); },
    };
    // The request's own Host is the base a client can reach this daemon on, which
    // is what a workspace script's local proxy URL has to be built from.
    const connection = daemon.attach(wire, host);
    socket.on('message', (data, isBinary) => {
        if (isBinary) {
            connection.receiveBinary(toBytes(data));
            return;
        }
        connection.receive(typeof data === 'string' ? data : data.toString('utf8'));
    });
    socket.on('close', () => {
        connection.dispose();
        socket.removeAllListeners();
    });
    socket.on('error', () => {
        connection.dispose();
    });
}
/**
 * Complete an HTTP upgrade as a Paseo client connection.
 * @param daemon - protocol state machine.
 * @param server - server used to complete the handshake.
 * @param request - upgrade request.
 * @param socket - raw duplex socket.
 * @param head - bytes already read from the socket.
 */
export function upgradeWebSocket(daemon, server, request, socket, head) {
    const host = request.headers.host;
    server.handleUpgrade(request, socket, head, (ws) => { serveWebSocket(daemon, ws, host); });
}
/** Narrow a `ws` message payload to bytes. */
function toBytes(data) {
    if (Array.isArray(data))
        return Uint8Array.from(Buffer.concat(data));
    if (data instanceof ArrayBuffer)
        return new Uint8Array(data);
    if (Buffer.isBuffer(data))
        return Uint8Array.from(data);
    return new Uint8Array(0);
}
