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
import type { IncomingMessage, ServerResponse } from 'node:http';
/** Path prefix the proxy is registered under. */
export declare const PROXY_PREFIX = "/paseo/proxy";
/** One upstream target behind the proxy. */
export interface ProxyTarget {
    readonly workspaceId: string;
    readonly scriptName: string;
    readonly port: number;
}
/**
 * Split a proxy path into its target and the path the upstream sees.
 * @param pathname - request pathname under {@link PROXY_PREFIX}.
 * @returns the workspace, script, and remaining upstream path.
 */
export declare function parseProxyPath(pathname: string): {
    readonly workspaceId: string;
    readonly scriptName: string;
    readonly rest: string;
} | null;
/**
 * Forward one request to a script's port.
 * @param req - inbound request.
 * @param res - response to write.
 * @param target - upstream port and the path the script should see.
 */
export declare function forwardScriptRequest(req: IncomingMessage, res: ServerResponse, target: ProxyTarget, rest: string): Promise<void>;
