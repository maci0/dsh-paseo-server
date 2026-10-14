/**
 * dsh-paseo-server: DeepSeek Harness as a Paseo daemon.
 *
 * The plugin mounts the Paseo daemon session protocol on the harness's own
 * HTTP listener, at `/ws`, and optionally dials the Paseo relay so a phone
 * reaches this daemon from anywhere. Its routes serve the pairing offer and
 * the QR the Plugins card renders.
 *
 * @module dsh-paseo-server
 */
import Schema from '@deepseek-ai/schemastery';
import type { HostContext } from './host.ts';
import type { Volatile } from '@deepseek-ai/cordis';
/** Plugin name as it appears in the loader. */
export declare const name = "paseo-server";
/** Services this plugin needs; the daemon is inert without them. */
export declare const inject: string[];
/** Route reporting the pairing offer as JSON. */
export declare const ROUTE_PAIRING = "/paseo/pairing";
/** Route serving the pairing QR as an SVG document. */
export declare const ROUTE_PAIRING_QR = "/paseo/pairing.svg";
/** Route the Paseo CLI probes before it opens the socket. */
export declare const ROUTE_STATUS = "/api/status";
/** Route the Paseo CLI probes for liveness. */
export declare const ROUTE_HEALTH = "/api/health";
/** Request report, for tracing what a client asked for. */
export declare const ROUTE_DIAGNOSTICS = "/paseo/diagnostics";
/** Download endpoint the Paseo client builds from a token. */
export declare const ROUTE_DOWNLOAD = "/api/files/download";
/** WebSocket path the Paseo client connects to. */
export declare const DEFAULT_WS_PATH = "/ws";
/** Plugin version reported to clients, read from the package this build shipped. */
export declare const VERSION: string;
/** Row values, as a profile patch states them and as direct callers pass them. */
type Options = {
    enabled?: boolean;
    wsPath?: string;
    relayEnabled?: boolean;
    relayEndpoint?: string;
    relayUseTls?: boolean;
    appBaseUrl?: string;
    allowedOrigins?: string[];
    passwordEnv?: string;
    dataDir?: string;
    defaultProvider?: string;
    defaultModel?: string;
};
/** Configuration this plugin's row resolves to, as `apply` receives it. */
export interface Config {
    /** Mount the daemon at all. @default true */
    readonly enabled: Volatile<boolean>;
    /** WebSocket path the Paseo client connects to. @default /ws */
    readonly wsPath: Volatile<string>;
    /** Dial the Paseo relay so a phone reaches this daemon from anywhere. @default true */
    readonly relayEnabled: Volatile<boolean>;
    /** Relay endpoint as `host:port`. @default relay.paseo.sh:443 */
    readonly relayEndpoint: Volatile<string>;
    /** Use TLS for the relay connection. @default true */
    readonly relayUseTls: Volatile<boolean>;
    /** Paseo app origin that renders a pairing link. @default https://app.paseo.sh */
    readonly appBaseUrl: Volatile<string>;
    /** Browser origins allowed to open the Paseo socket. @default https://app.paseo.sh and paseo://app */
    readonly allowedOrigins: Volatile<string[]>;
    /** Environment variable holding the daemon password. @default PASEO_PASSWORD */
    readonly passwordEnv: Volatile<string>;
    /** Directory holding the server id and key pair. @default $DSH_HOME/paseo-server */
    readonly dataDir: Volatile<string>;
    /** Provider reported for a session with no recorded request header. @default deepseek */
    readonly defaultProvider: Volatile<string>;
    /** Model reported for a session with no recorded request header. @default deepseek-flash */
    readonly defaultModel: Volatile<string>;
}
/** Row schema as Cordis resolves it: what this plugin's `config` is validated against. */
export declare const Config: Schema<Schemastery.ObjectS<NoInfer<{
    enabled: Schema<boolean, boolean, "volatile-defined">;
    wsPath: Schema<string, string, "volatile-defined">;
    relayEnabled: Schema<boolean, boolean, "volatile-defined">;
    relayEndpoint: Schema<string, string, "volatile-defined">;
    allowedOrigins: Schema<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    relayUseTls: Schema<boolean, boolean, "volatile-defined">;
    appBaseUrl: Schema<string, string, "volatile-defined">;
    passwordEnv: Schema<string, string, "volatile-defined">;
    dataDir: Schema<string, string, "volatile-defined">;
    defaultProvider: Schema<string, string, "volatile-defined">;
    defaultModel: Schema<string, string, "volatile-defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    enabled: Schema<boolean, boolean, "volatile-defined">;
    wsPath: Schema<string, string, "volatile-defined">;
    relayEnabled: Schema<boolean, boolean, "volatile-defined">;
    relayEndpoint: Schema<string, string, "volatile-defined">;
    allowedOrigins: Schema<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    relayUseTls: Schema<boolean, boolean, "volatile-defined">;
    appBaseUrl: Schema<string, string, "volatile-defined">;
    passwordEnv: Schema<string, string, "volatile-defined">;
    dataDir: Schema<string, string, "volatile-defined">;
    defaultProvider: Schema<string, string, "volatile-defined">;
    defaultModel: Schema<string, string, "volatile-defined">;
}>>, "plain">;
/** Turn a row into validated plain options. */
export declare function resolveRow(row?: Config | Options): Required<Options>;
/** Resolve the plugin data directory, defaulting under the harness home. */
export declare function resolveDataDir(configured: string): string;
/**
 * Mount the Paseo daemon surface.
 * @param ctx - plugin context providing the web server and session services.
 * @param row - configured row.
 */
export declare function apply(ctx: HostContext, row?: Config | Options): void;
export {};
