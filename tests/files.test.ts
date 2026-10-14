/**
 * File surface tests.
 *
 * Every path a client sends is untrusted, so the resolution check is the part
 * that matters: a miss here reads the rest of the machine.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  listDirectory,
  readProjectConfig,
  readWorkspaceFile,
  resolveInside,
  suggestPaths,
  writeProjectConfig,
} from '../src/dsh/files.ts'
import { scratchDir } from './scratch.ts'

test('a relative path resolves inside its workspace', () => {
  assert.equal(resolveInside('/repo', 'src/index.ts'), '/repo/src/index.ts')
  assert.equal(resolveInside('/repo', ''), '/repo')
  assert.equal(resolveInside('/repo', undefined), '/repo')
})

test('a path that escapes the workspace is refused', () => {
  assert.equal(resolveInside('/repo', '../secrets'), null)
  assert.equal(resolveInside('/repo', 'src/../../etc/passwd'), null)
  assert.equal(resolveInside('/repo', '/etc/passwd'), null)
})

test('a directory lists its entries and hides the git store', async () => {
  const root = scratchDir('files-list')
  await mkdir(join(root, 'src'), { recursive: true })
  await mkdir(join(root, '.git'), { recursive: true })
  await writeFile(join(root, 'readme.md'), 'hello\n')
  const entries = await listDirectory(root)
  assert.ok(entries !== null)
  // Entries come back sorted by name, not grouped by kind.
  assert.deepEqual(entries.map((entry) => `${entry.kind}:${entry.name}`), ['file:readme.md', 'directory:src'])
  assert.equal(entries[0]?.size, 6)
})

test('a text file reads back as utf-8', async () => {
  const root = scratchDir('files-text')
  await writeFile(join(root, 'note.txt'), 'hello\n')
  const file = await readWorkspaceFile(root, 'note.txt')
  assert.equal(file?.kind, 'text')
  assert.equal(file?.encoding, 'utf-8')
  assert.equal(file?.content, 'hello\n')
})

test('an image reads back as base64 with its media type', async () => {
  const root = scratchDir('files-image')
  await writeFile(join(root, 'pixel.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  const file = await readWorkspaceFile(root, 'pixel.png')
  assert.equal(file?.kind, 'image')
  assert.equal(file?.mimeType, 'image/png')
  assert.equal(file?.encoding, 'base64')
})

test('a file with a NUL byte reads back as binary without content', async () => {
  const root = scratchDir('files-binary')
  await writeFile(join(root, 'blob.bin'), Buffer.from([0x01, 0x00, 0x02]))
  const file = await readWorkspaceFile(root, 'blob.bin')
  assert.equal(file?.kind, 'binary')
  assert.equal(file?.encoding, 'none')
  assert.equal(file?.content, undefined)
})

test('an unreadable path reads as null rather than throwing', async () => {
  const root = scratchDir('files-missing')
  assert.equal(await readWorkspaceFile(root, 'nope.txt'), null)
  assert.equal(await readWorkspaceFile(root, '../escape.txt'), null)
  assert.equal(await listDirectory(root, '../escape'), null)
})

test('path suggestions complete a partially typed path', async () => {
  const root = scratchDir('suggest')
  await mkdir(join(root, 'project-one'), { recursive: true })
  await mkdir(join(root, 'project-two'), { recursive: true })
  await writeFile(join(root, 'project-notes.md'), 'x\n')
  const suggestions = await suggestPaths(`${root}/project-`, root, 20)
  assert.deepEqual(suggestions.map((entry) => `${entry.kind}:${entry.path.split('/').pop()}`), [
    'directory:project-one',
    'directory:project-two',
    'file:project-notes.md',
  ])
})

test('a suggestion query for a missing directory is empty, not an error', async () => {
  assert.deepEqual(await suggestPaths('/nope/nope-', '/', 10), [])
})

test('a project config writes and reads back against its revision', async () => {
  const root = scratchDir('project-config')
  const written = await writeProjectConfig(root, { scripts: { dev: { command: 'bun dev' } } }, null)
  assert.ok('revision' in written)
  const read = await readProjectConfig(root)
  assert.deepEqual(read?.config, { scripts: { dev: { command: 'bun dev' } } })
  const stale = await writeProjectConfig(root, { scripts: {} }, { mtimeMs: 1, size: 1 })
  assert.deepEqual(stale, { error: 'stale_project_config' })
})

test('a project config write refuses a non-object document', async () => {
  const root = scratchDir('project-config-invalid')
  assert.deepEqual(await writeProjectConfig(root, 'nope', null), { error: 'invalid_project_config' })
  assert.deepEqual(await writeProjectConfig(root, [1, 2], null), { error: 'invalid_project_config' })
})
