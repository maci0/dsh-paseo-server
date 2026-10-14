/**
 * Script proxy path tests.
 *
 * The path decides which script's port a request reaches, so a wrong split
 * either 404s a live script or forwards to another workspace's port.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PROXY_PREFIX, parseProxyPath } from '../src/paseo/script-proxy.ts'

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
