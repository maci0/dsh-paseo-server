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

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { WebSocketServer } from 'ws'
import Schema from '@deepseek-ai/schemastery'
import { PaseoDaemon } from './paseo/daemon.ts'
import type { Logger } from './paseo/daemon.ts'
import { createDshBridge } from './dsh/bridge.ts'
import { loadOrCreateIdentity } from './paseo/identity.ts'
import { buildPairingInfo } from './paseo/pairing.ts'
import type { PairingInfo } from './paseo/pairing.ts'
import { DEFAULT_RELAY_ENDPOINT, startRelayTransport } from './paseo/relay.ts'
import type { RelayTransport } from './paseo/relay.ts'
import { upgradeWebSocket } from './paseo/websocket.ts'
import { DEFAULT_ALLOWED_ORIGINS, originAllowed, rejectUpgrade } from './paseo/origin.ts'
import type { HostContext, WebServerLike } from './host.ts'
import type { Volatile } from '@deepseek-ai/cordis'

/** Plugin name as it appears in the loader. */
export const name = 'paseo-server'

/** Services this plugin needs; the daemon is inert without them. */
export const inject = ['sessionController', 'workspaceRegistry', 'sessions']

/** Route reporting the pairing offer as JSON. */
export const ROUTE_PAIRING = '/paseo/pairing'

/** Route serving the pairing QR as an SVG document. */
export const ROUTE_PAIRING_QR = '/paseo/pairing.svg'

/** Route the Paseo CLI probes before it opens the socket. */
export const ROUTE_STATUS = '/api/status'

/** Route the Paseo CLI probes for liveness. */
export const ROUTE_HEALTH = '/api/health'

/** WebSocket path the Paseo client connects to. */
export const DEFAULT_WS_PATH = '/ws'

/** Plugin version reported to clients, read from the package this build shipped. */
export const VERSION = readPackageVersion()

/** Read this package's own version, which a hardcoded constant would let drift. */
function readPackageVersion(): string {
  try {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string }
    return manifest.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/** Row values, as a profile patch states them and as direct callers pass them. */
type Options = {
  enabled?: boolean
  wsPath?: string
  relayEnabled?: boolean
  relayEndpoint?: string
  relayUseTls?: boolean
  appBaseUrl?: string
  allowedOrigins?: string[]
  passwordEnv?: string
  dataDir?: string
  defaultProvider?: string
  defaultModel?: string
}

/** Configuration this plugin's row resolves to, as `apply` receives it. */
export interface Config {
  /** Mount the daemon at all. @default true */
  readonly enabled: Volatile<boolean>
  /** WebSocket path the Paseo client connects to. @default /ws */
  readonly wsPath: Volatile<string>
  /** Dial the Paseo relay so a phone reaches this daemon from anywhere. @default true */
  readonly relayEnabled: Volatile<boolean>
  /** Relay endpoint as `host:port`. @default relay.paseo.sh:443 */
  readonly relayEndpoint: Volatile<string>
  /** Use TLS for the relay connection. @default true */
  readonly relayUseTls: Volatile<boolean>
  /** Paseo app origin that renders a pairing link. @default https://app.paseo.sh */
  readonly appBaseUrl: Volatile<string>
  /** Browser origins allowed to open the Paseo socket. @default https://app.paseo.sh and paseo://app */
  readonly allowedOrigins: Volatile<string[]>
  /** Environment variable holding the daemon password. @default PASEO_PASSWORD */
  readonly passwordEnv: Volatile<string>
  /** Directory holding the server id and key pair. @default $DSH_HOME/paseo-server */
  readonly dataDir: Volatile<string>
  /** Provider reported for a session with no recorded request header. @default deepseek */
  readonly defaultProvider: Volatile<string>
  /** Model reported for a session with no recorded request header. @default deepseek-flash */
  readonly defaultModel: Volatile<string>
}

/** Plain row values with defaults filled by {@link ValueSchema}. */
const ValueSchema = Schema.object({
  enabled: Schema.boolean().default(true),
  wsPath: Schema.string().default(DEFAULT_WS_PATH),
  relayEnabled: Schema.boolean().default(true),
  relayEndpoint: Schema.string().default(DEFAULT_RELAY_ENDPOINT),
  allowedOrigins: Schema.array(Schema.string()).default([...DEFAULT_ALLOWED_ORIGINS]),
  relayUseTls: Schema.boolean().default(true),
  appBaseUrl: Schema.string().default('https://app.paseo.sh'),
  passwordEnv: Schema.string().default('PASEO_PASSWORD'),
  dataDir: Schema.string().default(''),
  defaultProvider: Schema.string().default('deepseek'),
  defaultModel: Schema.string().default('deepseek-flash'),
})

/** Row schema as Cordis resolves it: what this plugin's `config` is validated against. */
export const Config = Schema.object({
  enabled: Schema.boolean().default(true).volatile(),
  wsPath: Schema.string().default(DEFAULT_WS_PATH).volatile(),
  relayEnabled: Schema.boolean().default(true).volatile(),
  relayEndpoint: Schema.string().default(DEFAULT_RELAY_ENDPOINT).volatile(),
  allowedOrigins: Schema.array(Schema.string()).default([...DEFAULT_ALLOWED_ORIGINS]).volatile(),
  relayUseTls: Schema.boolean().default(true).volatile(),
  appBaseUrl: Schema.string().default('https://app.paseo.sh').volatile(),
  passwordEnv: Schema.string().default('PASEO_PASSWORD').volatile(),
  dataDir: Schema.string().default('').volatile(),
  defaultProvider: Schema.string().default('deepseek').volatile(),
  defaultModel: Schema.string().default('deepseek-flash').volatile(),
})

/** Read one configured field as a plain value, live or plain. */
function readLive<T>(value: T | Volatile<T> | undefined): T | undefined {
  if (value !== null && typeof value === 'object' && typeof (value as Volatile<T>).get === 'function') {
    return (value as Volatile<T>).get() as T | undefined
  }
  return value as T | undefined
}

/** Turn a row into validated plain options. */
export function resolveRow(row: Config | Options = {}): Required<Options> {
  return ValueSchema({
    enabled: readLive(row.enabled),
    wsPath: readLive(row.wsPath),
    relayEnabled: readLive(row.relayEnabled),
    relayEndpoint: readLive(row.relayEndpoint),
    relayUseTls: readLive(row.relayUseTls),
    appBaseUrl: readLive(row.appBaseUrl),
    allowedOrigins: readLive(row.allowedOrigins) ?? [...DEFAULT_ALLOWED_ORIGINS],
    passwordEnv: readLive(row.passwordEnv),
    dataDir: readLive(row.dataDir),
    defaultProvider: readLive(row.defaultProvider),
    defaultModel: readLive(row.defaultModel),
  }) as Required<Options>
}

/** Resolve the plugin data directory, defaulting under the harness home. */
export function resolveDataDir(configured: string): string {
  if (configured.trim().length > 0) return configured
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'paseo-server')
}

/**
 * Mount the Paseo daemon surface.
 * @param ctx - plugin context providing the web server and session services.
 * @param row - configured row.
 */
export function apply(ctx: HostContext, row: Config | Options = {}): void {
  const live = (): Required<Options> => resolveRow(row)
  if (!live().enabled) return

  const identity = loadOrCreateIdentity(resolveDataDir(live().dataDir))
  const logger = ctx.logger
  const password = (): string | undefined => {
    const value = process.env[live().passwordEnv]
    return value !== undefined && value.length > 0 ? value : undefined
  }

  let pairing: PairingInfo = pairingInfo(live(), identity)
  const daemonLogger: Logger = {
    debug: () => {},
    info: (message) => { logger.info(message) },
    warn: (message) => { logger.warn(message) },
  }
  const bridge = createDshBridge({
    ctx,
    defaultProvider: live().defaultProvider,
    defaultModel: live().defaultModel,
  })
  bridge.bindIdentity(identity.serverId, VERSION)

  const webServer = ctx.get('webServer') as WebServerLike | undefined
  const daemon = new PaseoDaemon({
    bridge,
    logger: daemonLogger,
    hostname: process.env.HOSTNAME ?? 'dsh',
    password: password(),
    ...(webServer?.host === undefined || webServer.port === undefined ? {} : { listen: `${webServer.host}:${webServer.port}` }),
    pairingOffer: () => ({ url: pairing.url, relayEnabled: live().relayEnabled }),
  })
  daemon.start()

  const sockets = new WebSocketServer({ noServer: true })
  let relay: RelayTransport | undefined

  if (webServer !== undefined) {
    const listenerOrigin = webServer.host === undefined || webServer.port === undefined
      ? undefined
      : `${webServer.protocol ?? 'http:'}//${webServer.host}:${webServer.port}`
    ctx.effect(() => webServer.registerUpgrade({
      path: live().wsPath,
      handler: (req, socket, head) => {
        const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined
        if (!originAllowed(origin, live().allowedOrigins, listenerOrigin)) {
          logger.warn(`paseo-server: refused an upgrade from origin ${String(origin)}`)
          rejectUpgrade(socket)
          return
        }
        upgradeWebSocket(daemon, sockets, req, socket, head)
      },
    }), 'paseo-server: /ws upgrade')

    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: ROUTE_HEALTH,
      handler: (_req, res) => { sendJson(res, 200, { status: 'ok', timestamp: new Date().toISOString() }) },
    }), 'paseo-server: health route')

    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: ROUTE_STATUS,
      handler: (_req, res) => {
        sendJson(res, 200, {
          status: 'server_info',
          serverId: identity.serverId,
          hostname: process.env.HOSTNAME ?? 'dsh',
          version: VERSION,
          protocolVersion: 1,
        })
      },
    }), 'paseo-server: status route')

    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: ROUTE_PAIRING,
      handler: (_req, res) => {
        sendJson(res, 200, {
          serverId: identity.serverId,
          url: pairing.url,
          uri: pairing.uri,
          relayEnabled: live().relayEnabled,
          relayConnected: relay !== undefined,
          wsPath: live().wsPath,
          appBaseUrl: live().appBaseUrl,
        })
      },
    }), 'paseo-server: pairing route')

    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: ROUTE_PAIRING_QR,
      handler: async (_req, res) => {
        const svg = await pairingQrSvg(pairing.url)
        if (svg === null) {
          sendJson(res, 503, { error: 'QR rendering unavailable' })
          return
        }
        res.statusCode = 200
        res.setHeader('content-type', 'image/svg+xml; charset=utf-8')
        res.setHeader('cache-control', 'no-store')
        res.end(svg)
      },
    }), 'paseo-server: pairing QR route')
  } else {
    logger.warn('paseo-server: the webServer service is not mounted; only the relay can reach this daemon')
  }

  if (live().relayEnabled) {
    relay = startRelayTransport({
      endpoint: live().relayEndpoint,
      useTls: live().relayUseTls,
      serverId: identity.serverId,
      keyPair: identity.keyPair,
      logger: daemonLogger,
      onConnection: (socket) => {
        const connection = daemon.attach(socket)
        logger.info(`paseo-server: relay client admitted (${daemon.size} connected)`)
        return { message: (text) => { connection.receive(text) }, close: () => { connection.dispose() } }
      },
    })

    logger.info(`paseo-server: paired as ${identity.serverId}; scan ${pairing.url}`)
  }

  ctx.effect(() => () => {
    daemon.stop()
    sockets.close()
    void relay?.stop()
  }, 'paseo-server: shutdown')
}

/** Current pairing information for one resolved row. */
function pairingInfo(row: Required<Options>, identity: { serverId: string; keyPair: { publicKeyB64: string } }): PairingInfo {
  return buildPairingInfo({
    serverId: identity.serverId,
    publicKeyB64: identity.keyPair.publicKeyB64,
    relayEndpoint: row.relayEndpoint,
    useTls: row.relayUseTls,
    appBaseUrl: row.appBaseUrl,
  })
}

/** Render the pairing URL as an SVG document, or null when encoding failed. */
async function pairingQrSvg(url: string): Promise<string | null> {
  try {
    const qrcode = await import('qrcode')
    return await qrcode.toString(url, { type: 'svg', margin: 2, width: 320 })
  } catch (error) {
    return null
  }
}

function sendJson(res: { statusCode: number; setHeader(name: string, value: string): void; end(body?: string): void }, status: number, payload: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}
