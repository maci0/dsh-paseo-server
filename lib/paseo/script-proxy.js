/**
 * Local proxy for one workspace script's port.
 *
 * Paseo publishes a proxy URL for a service script so a client can open the
 * running app. This daemon has no tunnel, so it forwards on its own HTTP
 * listener instead: the phone reaches the daemon, and the daemon reaches the
 * script's loopback port.
 *
 * ponytail: the response is forwarded verbatim, so an upstream that links its
 * assets by absolute path (`/assets/app.js`) resolves them against the daemon
 * instead of the script. Rewriting HTML or mapping the prefix is the upgrade
 * path if a proxy target needs it.
 *
 * @module dsh-paseo-server/paseo/script-proxy
 */
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
/** Path prefix the proxy is registered under. */
export const PROXY_PREFIX = '/paseo/proxy';
/** Headers that describe one hop and must not be forwarded. */
const HOP_BY_HOP = new Set([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
    'host',
    'content-length',
]);
/**
 * Split a proxy path into its target and the path the upstream sees.
 * @param pathname - request pathname under {@link PROXY_PREFIX}.
 * @returns the workspace, script, and remaining upstream path.
 */
export function parseProxyPath(pathname) {
    if (!pathname.startsWith(`${PROXY_PREFIX}/`))
        return null;
    const [workspaceId, scriptName, ...rest] = pathname.slice(PROXY_PREFIX.length + 1).split('/');
    if (workspaceId === undefined || workspaceId.length === 0)
        return null;
    if (scriptName === undefined || scriptName.length === 0)
        return null;
    return { workspaceId, scriptName, rest: rest.length === 0 ? '/' : `/${rest.join('/')}` };
}
/**
 * Forward one request to a script's port.
 * @param req - inbound request.
 * @param res - response to write.
 * @param target - upstream port and the path the script should see.
 */
export async function forwardScriptRequest(req, res, target, rest) {
    const search = req.url === undefined ? '' : new URL(req.url, 'http://localhost').search;
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
        if (typeof value !== 'string' || HOP_BY_HOP.has(name))
            continue;
        headers.set(name, value);
    }
    try {
        const upstream = await fetch(`http://127.0.0.1:${String(target.port)}${rest}${search}`, {
            method: req.method,
            headers,
            body: req.method === 'GET' || req.method === 'HEAD' ? undefined : req,
            ...{ duplex: 'half' },
        });
        const responseHeaders = {};
        upstream.headers.forEach((value, name) => {
            if (!HOP_BY_HOP.has(name))
                responseHeaders[name] = value;
        });
        res.writeHead(upstream.status, responseHeaders);
        if (upstream.body === null) {
            res.end();
            return;
        }
        await pipeline(Readable.fromWeb(upstream.body), res);
    }
    catch (error) {
        // A script that is not listening is the normal failure here, not a bug.
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(`script ${target.scriptName} is not answering on port ${String(target.port)}: ${error instanceof Error ? error.message : String(error)}\n`);
    }
}
