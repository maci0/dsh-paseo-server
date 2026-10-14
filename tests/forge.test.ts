/**
 * Forge read tests.
 *
 * The remote parser decides whether a pull request is looked up at all, so a
 * wrong answer here reports no pull request for a repository that has one, or
 * asks the wrong repository entirely.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { forgeToken, mapPullRequest, parseGithubRemote } from '../src/dsh/forge.ts'

test('an https remote names its owner and repository', () => {
  assert.deepEqual(parseGithubRemote('https://github.com/maci0/dsh-paseo-server.git'), {
    owner: 'maci0',
    repo: 'dsh-paseo-server',
  })
})

test('an ssh remote names the same repository', () => {
  assert.deepEqual(parseGithubRemote('git@github.com:maci0/dsh-paseo-server.git'), {
    owner: 'maci0',
    repo: 'dsh-paseo-server',
  })
})

test('a remote that is not GitHub is not guessed at', () => {
  assert.equal(parseGithubRemote('https://gitlab.com/maci0/dsh-paseo-server.git'), null)
  assert.equal(parseGithubRemote('git@bitbucket.org:maci0/dsh-paseo-server.git'), null)
  assert.equal(parseGithubRemote(null), null)
})

test('the token comes from the environment, preferring GH_TOKEN', () => {
  assert.equal(forgeToken({ GH_TOKEN: 'a', GITHUB_TOKEN: 'b' }), 'a')
  assert.equal(forgeToken({ GITHUB_TOKEN: 'b' }), 'b')
  assert.equal(forgeToken({ GH_TOKEN: '   ' }), undefined)
  assert.equal(forgeToken({}), undefined)
})

test('a pull request payload maps onto the panel facts', () => {
  const status = mapPullRequest({
    number: 42,
    html_url: 'https://github.com/maci0/dsh-paseo-server/pull/42',
    title: 'bridge terminals',
    state: 'open',
    merged_at: null,
    draft: false,
    mergeable: true,
    base: { ref: 'main' },
    head: { ref: 'feat/terminals' },
  }, { owner: 'maci0', repo: 'dsh-paseo-server' })
  assert.deepEqual(status, {
    number: 42,
    url: 'https://github.com/maci0/dsh-paseo-server/pull/42',
    title: 'bridge terminals',
    state: 'open',
    baseRefName: 'main',
    headRefName: 'feat/terminals',
    isMerged: false,
    isDraft: false,
    mergeable: 'MERGEABLE',
    checks: [],
    repoOwner: 'maci0',
    repoName: 'dsh-paseo-server',
  })
})

test('a merged conflicting draft says so', () => {
  const status = mapPullRequest({
    number: 7,
    html_url: 'https://github.com/maci0/dsh-paseo-server/pull/7',
    title: 'wip',
    state: 'closed',
    merged_at: '2026-01-01T00:00:00Z',
    draft: true,
    mergeable: false,
    base: { ref: 'main' },
    head: { ref: 'wip' },
  }, { owner: 'maci0', repo: 'dsh-paseo-server' })
  assert.equal(status?.isMerged, true)
  assert.equal(status?.isDraft, true)
  assert.equal(status?.mergeable, 'CONFLICTING')
})

test('a payload without a number is refused rather than half read', () => {
  assert.equal(mapPullRequest({ title: 'x' }, { owner: 'a', repo: 'b' }), null)
  assert.equal(mapPullRequest(null, { owner: 'a', repo: 'b' }), null)
})
