/**
 * File surface tests.
 *
 * Every path a client sends is untrusted, so the resolution check is the part
 * that matters: a miss here reads the rest of the machine.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { lstat, mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  createEntry,
  deleteEntry,
  duplicateEntry,
  entryExists,
  listDirectory,
  readProjectConfig,
  readWorkspaceFile,
  renameEntry,
  resolveInside,
  statEntry,
  suggestPaths,
  writeProjectConfig,
  writeWorkspaceFile,
} from '../src/dsh/files.ts'
import { scratchDir } from './scratch.ts'

test('a relative path resolves inside its workspace', async () => {
  const root = scratchDir('resolve')
  assert.equal(await resolveInside(root, 'src/index.ts'), join(root, 'src/index.ts'))
  assert.equal(await resolveInside(root, ''), root)
  assert.equal(await resolveInside(root, undefined), root)
  assert.equal(await resolveInside(root, '..notes'), join(root, '..notes'))
})

test('a path that escapes the workspace is refused', async () => {
  assert.equal(await resolveInside('/repo', '../secrets'), null)
  assert.equal(await resolveInside('/repo', 'src/../../etc/passwd'), null)
  assert.equal(await resolveInside('/repo', '/etc/passwd'), null)
})

test('workspace operations refuse paths through an outside or dangling symlink', async () => {
  const parent = scratchDir('symlink')
  const root = join(parent, 'workspace')
  const outside = join(parent, 'outside')
  await mkdir(root)
  await mkdir(outside)
  await writeFile(join(outside, 'note.txt'), 'keep')
  await symlink(outside, join(root, 'link'))
  await symlink(join(outside, 'missing.txt'), join(root, 'dangling'))
  const modifiedAt = (await stat(join(outside, 'note.txt'))).mtime.toISOString()
  assert.equal(await readWorkspaceFile(root, 'link/note.txt'), null)
  assert.equal((await writeWorkspaceFile(root, 'link/note.txt', 'lost', modifiedAt)).status, 'error')
  assert.ok('error' in await deleteEntry(root, 'link/note.txt'))
  assert.ok('error' in await createEntry(root, 'link', 'new.txt', 'file'))
  assert.equal(await resolveInside(root, 'dangling'), null)
  assert.equal(await readFile(join(outside, 'note.txt'), 'utf8'), 'keep')
})

test('listing and deleting an outside symlink inspect only the workspace entry', async () => {
  const parent = scratchDir('symlink-entry')
  const root = join(parent, 'workspace')
  const outside = join(parent, 'outside.txt')
  await mkdir(root)
  await writeFile(outside, 'keep this outside content')
  const link = join(root, 'link')
  await symlink(outside, link)
  const info = await lstat(link)
  assert.deepEqual(await listDirectory(root), [{ name: 'link', path: 'link', kind: 'file', size: info.size, modifiedAt: info.mtime.toISOString() }])
  assert.equal(await readWorkspaceFile(root, 'link'), null)
  assert.deepEqual(await deleteEntry(root, 'link'), { ok: true })
  assert.equal(await readFile(outside, 'utf8'), 'keep this outside content')
  await assert.rejects(lstat(link), { code: 'ENOENT' })
  await symlink(join(parent, 'missing'), link)
  assert.deepEqual(await deleteEntry(root, 'link'), { ok: true }, 'dangling links can also be removed')
  assert.ok('error' in await deleteEntry(root, '../outside.txt'))
  assert.equal(await readFile(outside, 'utf8'), 'keep this outside content')
})

test('a symlink within the workspace remains usable', async () => {
  const root = scratchDir('inside-link')
  await mkdir(join(root, 'notes'))
  await writeFile(join(root, 'notes/a.txt'), 'hello')
  await symlink(join(root, 'notes'), join(root, 'link'))
  assert.equal((await readWorkspaceFile(root, 'link/a.txt'))?.content, 'hello')
})

test('renaming onto an existing file preserves both files, including concurrent renames', async () => {
  const root = scratchDir('rename-conflict')
  await writeFile(join(root, 'a.txt'), 'a')
  await writeFile(join(root, 'b.txt'), 'b')
  assert.ok('error' in await renameEntry(root, 'a.txt', 'b.txt'))
  assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'a')
  assert.equal(await readFile(join(root, 'b.txt'), 'utf8'), 'b')
  const results = await Promise.all([renameEntry(root, 'a.txt', 'c.txt'), renameEntry(root, 'b.txt', 'c.txt')])
  assert.equal(results.filter(result => 'path' in result).length, 1)
  const remaining = await listDirectory(root)
  assert.equal(remaining?.length, 2)
})

test('duplicating the workspace root is refused', async () => {
  assert.ok('error' in await duplicateEntry(scratchDir('duplicate-root'), ''))
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

test('a file write refuses a stale modification time', async () => {
  const root = scratchDir('files-write')
  await writeFile(join(root, 'a.txt'), 'first\n')
  const initial = await statEntry(root, 'a.txt')
  assert.ok(initial !== null)
  // A revision the client never read is a conflict, whatever the clock's
  // resolution did between the two writes.
  const stale = await writeWorkspaceFile(root, 'a.txt', 'third\n', new Date(0).toISOString())
  assert.equal(stale.status, 'conflict')
  const written = await writeWorkspaceFile(root, 'a.txt', 'second\n', initial.modifiedAt)
  assert.equal(written.status, 'written')
  assert.equal((await readWorkspaceFile(root, 'a.txt'))?.content, 'second\n')
})

test('a write outside the workspace is refused', async () => {
  const root = scratchDir('files-write-escape')
  const outcome = await writeWorkspaceFile(root, '../escape.txt', 'x', new Date(0).toISOString())
  assert.equal(outcome.status, 'error')
})

test('entries create, rename, duplicate, and delete', async () => {
  const root = scratchDir('files-entries')
  const created = await createEntry(root, '', 'notes', 'directory')
  assert.deepEqual(created, { path: 'notes' })
  await writeFile(join(root, 'notes', 'a.txt'), 'a\n')

  const renamed = await renameEntry(root, 'notes/a.txt', 'b.txt')
  assert.deepEqual(renamed, { path: 'notes/b.txt' })

  const duplicated = await duplicateEntry(root, 'notes/b.txt')
  assert.deepEqual(duplicated, { path: 'notes/b copy.txt' })

  assert.deepEqual(await deleteEntry(root, 'notes/b copy.txt'), { ok: true })
  assert.equal(await entryExists(root, 'notes/b copy.txt'), false)
  assert.equal(await entryExists(root, 'notes/b.txt'), true)
})

test('an entry name with a separator is refused', async () => {
  const root = scratchDir('files-entries-name')
  assert.deepEqual(await createEntry(root, '', 'a/b', 'file'), { error: 'a name must be one path segment' })
  assert.deepEqual(await renameEntry(root, '.', '../x'), { error: 'a name must be one path segment' })
})

test('the workspace root is not deletable', async () => {
  const root = scratchDir('files-root-delete')
  assert.deepEqual(await deleteEntry(root, ''), { error: 'the workspace root cannot be deleted' })
})
