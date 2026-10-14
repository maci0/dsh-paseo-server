/**
 * Origin-fence tests.
 *
 * A WebSocket handshake ignores the same-origin policy, so this fence is what
 * keeps a page on any site from driving the daemon through the local port.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_ALLOWED_ORIGINS, originAllowed, rejectUpgrade } from '../src/paseo/origin.ts'
import { renderPairingQr } from '../src/paseo/pairing.ts'

test('a native client sends no origin and is admitted', () => {
  assert.equal(originAllowed(undefined, DEFAULT_ALLOWED_ORIGINS), true)
  assert.equal(originAllowed('', DEFAULT_ALLOWED_ORIGINS), true)
})

test('the Paseo client origins are admitted', () => {
  assert.equal(originAllowed('https://app.paseo.sh', DEFAULT_ALLOWED_ORIGINS), true)
  assert.equal(originAllowed('https://app.paseo.sh/', DEFAULT_ALLOWED_ORIGINS), true)
  assert.equal(originAllowed('paseo://app', DEFAULT_ALLOWED_ORIGINS), true)
})

test('a foreign site is refused', () => {
  assert.equal(originAllowed('https://evil.example', DEFAULT_ALLOWED_ORIGINS), false)
  assert.equal(originAllowed('http://127.0.0.1:3080', DEFAULT_ALLOWED_ORIGINS), false)
  assert.equal(originAllowed('null', DEFAULT_ALLOWED_ORIGINS), false)
})

test('this daemon admits its own listener origin', () => {
  assert.equal(originAllowed('http://127.0.0.1:3080', DEFAULT_ALLOWED_ORIGINS, 'http://127.0.0.1:3080'), true)
  assert.equal(originAllowed('http://127.0.0.1:9999', DEFAULT_ALLOWED_ORIGINS, 'http://127.0.0.1:3080'), false)
})

test('a configured origin is honored regardless of case', () => {
  assert.equal(originAllowed('https://App.Paseo.Sh', ['https://app.paseo.sh']), true)
  assert.equal(originAllowed('https://other.example', ['https://other.example']), true)
})

test('a rejection answers with 403 and destroys the socket', () => {
  const calls: string[] = []
  rejectUpgrade({ write: (data) => { calls.push(data) }, destroy: () => { calls.push('destroy') } })
  assert.match(calls[0] ?? '', /^HTTP\/1\.1 403 Forbidden/)
  assert.equal(calls[1], 'destroy')
})

test('the pairing QR is terminal text wrapped for a dark background', async () => {
  const qr = await renderPairingQr('https://app.paseo.sh/#offer=abc')
  assert.ok(qr !== null)
  const lines = qr.split('\n')
  assert.ok(lines.length > 10)
  for (const line of lines) {
    assert.match(line, /^\u001b\[47m \u001b\[30m.*\u001b\[0m$/)
  }
})
