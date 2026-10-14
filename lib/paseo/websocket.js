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
export function serveWebSocket(daemon, socket) {
    const wire = {
        send: (text) => {
            if (socket.readyState === WsWebSocket.OPEN)
                socket.send(text);
        },
        close: (code, reason) => { socket.close(code, reason); },
        detach: () => { socket.removeAllListeners(); },
    };
    const connection = daemon.attach(wire);
    socket.on('message', (data, isBinary) => {
        if (isBinary)
            return;
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
    server.handleUpgrade(request, socket, head, (ws) => { serveWebSocket(daemon, ws); });
}
