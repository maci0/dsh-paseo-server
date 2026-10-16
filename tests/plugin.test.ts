/**
 * Real-composition test: the plugin mounts into a real Cordis `Context`
 * alongside structural fakes of the host services it reaches.
 *
 * Cordis is the authority on injection, effects, and teardown here, so this
 * catches the failures a hand-rolled fake would not: a missing service
 * declaration, an effect that never releases its route, or a pairing route
 * that answers with the wrong identity.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { scratchDir } from './scratch.ts'
import * as PaseoServer from '../src/index.ts'
import type { WebRouteLike, WebUpgradeRouteLike } from '../src/host.ts'

/** Minimal shared listener the plugin can register routes on. */
function fakeWebServer() {
  const routes = new Map<string, WebRouteLike>()
  const upgrades = new Map<string, WebUpgradeRouteLike>()
  return {
    routes,
    upgrades,
    register(route: WebRouteLike) {
      routes.set(route.path, route)
      return () => { routes.delete(route.path) }
    },
    registerUpgrade(route: WebUpgradeRouteLike) {
      upgrades.set(route.path, route)
      return () => { upgrades.delete(route.path) }
    },
  }
}

/** Response recorder for one route call. */
function fakeResponse() {
  const state = { statusCode: 0, headers: new Map<string, string>(), body: '' }
  return {
    state,
    statusCode: 200,
    setHeader(name: string, value: string) { state.headers.set(name, value) },
    end(body?: string) { state.body = body ?? '' },
  }
}

test('the plugin mounts into a real Cordis composition and releases its routes', async () => {
  const dir = scratchDir('plugin')
  const ctx = new Context()
  const webServer = fakeWebServer()
  ctx.provide('connection', { requestRejection: () => undefined })
  ctx.provide('webServer', webServer)
  ctx.provide('sessionController', {
    list: async () => ({ items: [] }),
    create: async () => ({ sessionId: 'ses_1' }),
    prompt: async () => ({ accepted: true }),
    cancel: async () => ({ accepted: true }),
  })
  ctx.provide('workspaceRegistry', { list: () => [], create: async () => { throw new Error('unused') } })
  ctx.provide('sessions', { get: () => undefined, list: () => [] })

  const fiber = await ctx.plugin(PaseoServer as unknown as Parameters<typeof ctx.plugin>[0], {
    relayEnabled: false,
    dataDir: dir,
  })

  assert.deepEqual([...webServer.upgrades.keys()], ['/ws'])
  for (const path of ['/paseo/pairing', '/paseo/pairing.svg', '/api/health', '/api/status']) {
    assert.ok(webServer.routes.has(path), path)
  }

  const pairing = webServer.routes.get('/paseo/pairing')
  assert.ok(pairing !== undefined)
  const res = fakeResponse()
  await pairing.handler({} as never, res as never)
  const body = JSON.parse(res.state.body) as Record<string, unknown>
  const serverId = readFileSync(join(dir, 'server-id'), 'utf8').trim()
  assert.equal(body.serverId, serverId)
  assert.match(String(body.url), /^https:\/\/app\.paseo\.sh\/#offer=/)
  assert.match(String(body.uri), /^relay:\/\/relay\.paseo\.sh:443\//)

  // The offer the card shows decodes back to the same identity.
  const encoded = String(body.url).split('#offer=')[1] ?? ''
  const offer = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Record<string, unknown>
  assert.equal(offer.serverId, serverId)
  assert.equal(offer.v, 2)
  assert.equal(typeof offer.daemonPublicKeyB64, 'string')
  assert.deepEqual(offer.relay, { endpoint: 'relay.paseo.sh:443', useTls: true })

  await fiber.dispose()
  assert.equal(webServer.routes.size, 0)
  assert.equal(webServer.upgrades.size, 0)
})

test('a disabled row mounts nothing at all', async () => {
  const ctx = new Context()
  const webServer = fakeWebServer()
  ctx.provide('webServer', webServer)
  ctx.provide('sessionController', { list: async () => ({ items: [] }) })
  ctx.provide('workspaceRegistry', { list: () => [] })
  ctx.provide('sessions', { get: () => undefined, list: () => [] })
  const fiber = await ctx.plugin(PaseoServer as unknown as Parameters<typeof ctx.plugin>[0], {
    enabled: false,
    relayEnabled: false,
    dataDir: scratchDir('plugin-disabled'),
  })
  assert.equal(webServer.routes.size, 0)
  assert.equal(webServer.upgrades.size, 0)
  await fiber.dispose()
})

test('the identity is stable across mounts', async () => {
  const dir = scratchDir('plugin-identity')
  const mount = async (): Promise<string> => {
    const ctx = new Context()
    const webServer = fakeWebServer()
    ctx.provide('connection', { requestRejection: () => undefined })
    ctx.provide('webServer', webServer)
    ctx.provide('sessionController', { list: async () => ({ items: [] }) })
    ctx.provide('workspaceRegistry', { list: () => [] })
    ctx.provide('sessions', { get: () => undefined, list: () => [] })
    const fiber = await ctx.plugin(PaseoServer as unknown as Parameters<typeof ctx.plugin>[0], { relayEnabled: false, dataDir: dir })
    const res = fakeResponse()
    await webServer.routes.get('/paseo/pairing')?.handler({} as never, res as never)
    await fiber.dispose()
    return readFileSync(join(dir, 'server-id'), 'utf8').trim()
  }
  const first = await mount()
  const second = await mount()
  assert.equal(first, second)
  assert.match(first, /^srv_[A-Za-z0-9_-]{12}$/)
})

test('sensitive HTTP routes require harness authentication and remote control requires a password', async () => {
  for (const rejection of [401, 403, undefined]) {
    const ctx = new Context()
    const webServer = fakeWebServer()
    if (rejection !== undefined) ctx.provide('connection', { requestRejection: () => rejection })
    ctx.provide('webServer', webServer)
    ctx.provide('sessionController', { list: async () => ({ items: [] }) })
    ctx.provide('workspaceRegistry', { list: () => [] })
    ctx.provide('sessions', { get: () => undefined, list: () => [] })
    const fiber = await ctx.plugin(PaseoServer as unknown as Parameters<typeof ctx.plugin>[0], {
      passwordEnv: 'DSH_TEST_PASEO_MISSING_PASSWORD',
      dataDir: scratchDir('private-routes'),
    })
    try {
      for (const path of ['/api/status', '/paseo/pairing', '/paseo/pairing.svg', '/paseo/diagnostics', '/paseo/proxy']) {
        const res = fakeResponse()
        await webServer.routes.get(path)?.handler({} as never, res as never)
        assert.equal(res.statusCode, rejection ?? 503, path)
        assert.equal(res.state.body.includes('srv_'), false, path)
      }
      const sent: string[] = []
      let destroyed = false
      const upgrade = webServer.upgrades.get('/ws')
      assert.ok(upgrade !== undefined)
      await upgrade.handler({ socket: { remoteAddress: '192.168.1.10' }, headers: {} } as never, {
        write: (text: string) => { sent.push(text) }, destroy: () => { destroyed = true },
      } as never, Buffer.alloc(0))
      assert.match(sent[0] ?? '', /403 Forbidden/)
      assert.equal(destroyed, true)
    } finally {
      await fiber.dispose()
    }
  }
})

test('missing relay password is reported as disabled, rather than starting a public relay', async () => {
  const ctx = new Context()
  const webServer = fakeWebServer()
  ctx.provide('connection', { requestRejection: () => undefined })
  ctx.provide('webServer', webServer)
  ctx.provide('sessionController', { list: async () => ({ items: [] }) })
  ctx.provide('workspaceRegistry', { list: () => [] })
  ctx.provide('sessions', { get: () => undefined, list: () => [] })
  const fiber = await ctx.plugin(PaseoServer as unknown as Parameters<typeof ctx.plugin>[0], {
    passwordEnv: 'DSH_TEST_PASEO_MISSING_PASSWORD', dataDir: scratchDir('relay-password'),
  })
  try {
    const res = fakeResponse()
    await webServer.routes.get('/paseo/pairing')?.handler({} as never, res as never)
    const body = JSON.parse(res.state.body)
    assert.equal(body.relayEnabled, false)
    assert.equal(body.relayConnected, false)
  } finally {
    await fiber.dispose()
  }
})
