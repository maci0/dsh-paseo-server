/**
 * Script proxy path tests.
 *
 * The path decides which script's port a request reaches, so a wrong split
 * either 404s a live script or forwards to another workspace's port.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer, request } from 'node:http'
import { once } from 'node:events'
import { gunzipSync, gzipSync } from 'node:zlib'
import { PROXY_PREFIX, forwardScriptRequest, parseProxyPath } from '../src/paseo/script-proxy.ts'

test('a proxy path names its workspace, script, and upstream path', () => {
  assert.deepEqual(parseProxyPath(`${PROXY_PREFIX}/ws_1/dev`), {
    workspaceId: 'ws_1',
    scriptName: 'dev',
    rest: '/',
  })
  assert.deepEqual(parseProxyPath(`${PROXY_PREFIX}/ws_1/dev/assets/app.js`), {
    workspaceId: 'ws_1',
    scriptName: 'dev',
    rest: '/assets/app.js',
  })
})

test('a path outside the prefix is not a proxy request', () => {
  assert.equal(parseProxyPath('/paseo/pairing'), null)
  assert.equal(parseProxyPath('/ws_1/dev'), null)
})

test('a path without both names is refused', () => {
  assert.equal(parseProxyPath(PROXY_PREFIX), null)
  assert.equal(parseProxyPath(`${PROXY_PREFIX}/`), null)
  assert.equal(parseProxyPath(`${PROXY_PREFIX}/ws_1`), null)
  assert.equal(parseProxyPath(`${PROXY_PREFIX}/ws_1/`), null)
})

test('script names are decoded as the published proxy URL encodes them', () => {
  assert.equal(parseProxyPath(`${PROXY_PREFIX}/ws_1/dev%3Aweb`)?.scriptName, 'dev:web')
  assert.equal(parseProxyPath(`${PROXY_PREFIX}/ws_1/dev%ZZ`), null)
})

test('the proxy preserves compressed bytes, redirects, cookies, and request bodies', async (t) => {
  const upstream = createServer(async (req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { location: '/destination', 'set-cookie': ['first=1', 'second=2'] })
      res.end()
    } else if (req.method === 'POST') {
      const chunks = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      res.end(Buffer.concat(chunks))
    } else {
      res.writeHead(200, { 'content-encoding': 'gzip' })
      res.end(gzipSync('compressed script response'))
    }
  })
  upstream.listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  t.after(() => { upstream.closeAllConnections(); upstream.close() })
  const address = upstream.address()
  assert.ok(address !== null && typeof address === 'object')
  const proxy = createServer((req, res) => {
    void forwardScriptRequest(req, res, { workspaceId: 'test', scriptName: 'dev', port: address.port }, req.url ?? '/')
  })
  proxy.listen(0, '127.0.0.1')
  await once(proxy, 'listening')
  t.after(() => { proxy.closeAllConnections(); proxy.close() })
  const proxyAddress = proxy.address()
  assert.ok(proxyAddress !== null && typeof proxyAddress === 'object')
  const read = (path: string, body?: string) => new Promise<{ status: number | undefined; headers: import('node:http').IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: proxyAddress.port, path, method: body === undefined ? 'GET' : 'POST' }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      res.on('error', reject)
      res.on('end', () => { resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }) })
    })
    req.on('error', reject)
    req.end(body)
  })
  const compressed = await read('/compressed')
  assert.equal(compressed.headers['content-encoding'], 'gzip')
  assert.equal(gunzipSync(compressed.body).toString(), 'compressed script response')
  const redirected = await read('/redirect')
  assert.equal(redirected.status, 302)
  assert.equal(redirected.headers.location, '/destination')
  assert.deepEqual(redirected.headers['set-cookie'], ['first=1', 'second=2'])
  assert.equal((await read('/post', 'request body')).body.toString(), 'request body')
})
