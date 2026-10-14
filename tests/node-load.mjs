/**
 * Node smoke test for the built artifact.
 *
 * The harness loads plugins into Node, not Bun, so the shipped `lib/` entry
 * has to import and expose the loader contract there. Run after `bun run
 * build`:
 *
 *   node tests/node-load.mjs
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const testsDir = dirname(fileURLToPath(import.meta.url))
const packageRoot = join(testsDir, '..')
const entry = join(packageRoot, 'lib', 'index.js')

const module = await import(entry)

assert.equal(module.name, 'paseo-server', 'the loader needs the plugin name')
assert.equal(typeof module.apply, 'function', 'the loader calls apply(ctx, config)')
assert.ok(module.Config !== undefined, 'a row config schema must be exported')
assert.ok(Array.isArray(module.inject), 'the plugin declares the services it needs')
assert.equal(module.inject.includes('sessionController'), true)

// The browser half is a lazy CommonJS factory the client module system loads,
// so it must register itself without touching a DOM at import time.
const client = readFileSync(join(packageRoot, 'client.js'), 'utf8')
assert.match(client, /__ModuleLoader__\.load\(/)

console.log('node-load: ok')
