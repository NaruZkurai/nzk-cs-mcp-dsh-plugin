#!/usr/bin/env node
// Unit tests for the multi-repo configuration expansion (spec D5).
//
// Proves:
//   - one repo by default  -> one server / one entry, byte-for-byte the
//     pre-multi-repo single-server shape;
//   - two repos (CSGRAPH_REPOS or explicit `repos`) -> two entries with
//     distinct ids and per-repo args/cwd;
//   - a repo path that does not exist fails validation;
//   - install.mjs renders every entry, is idempotent, and can uninstall them.
//
// Run: node --test test/config.test.mjs
// No network and no real csgraph binary are needed (fake repos + fake bins).

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  mcpClientEntries,
  mcpClientEntry,
  resolveCsgraphConfig,
  resolveRepos,
} from '../lib/csgraph-config.mjs'

const TEST_DIR = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = resolve(TEST_DIR, '..')
const INSTALL_MJS = join(PLUGIN_ROOT, 'lib', 'install.mjs')

// Ambient env must not leak into the assertions below.
const ENV_KEYS = ['CSGRAPH_REPOS', 'CSGRAPH_REPO', 'CSGRAPH_BIN', 'CSGRAPH_ROOT', 'CSGRAPH_THREADS']
const SAVED_ENV = new Map(ENV_KEYS.map((key) => [key, process.env[key]]))
for (const key of ENV_KEYS) delete process.env[key]

let scratch

before(() => {
  const base = join(PLUGIN_ROOT, '.test-tmp')
  mkdirSync(base, { recursive: true })
  scratch = mkdtempSync(join(base, 'config-'))
})

after(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true })
  for (const [key, value] of SAVED_ENV) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

function makeRepo(name) {
  const path = join(scratch, name)
  mkdirSync(path, { recursive: true })
  return path
}

function makeBin(name) {
  const path = join(scratch, name)
  writeFileSync(path, '#!/bin/sh\nexit 0\n')
  chmodSync(path, 0o755)
  return path
}

const entryIds = (entries) => entries.map((entry) => entry.id)
const serverArgs = (repo, root, threads) => ['--mcp', '--repo', resolve(repo), '--root', root, '--threads', String(threads)]

test('one repo by default -> one server and the unchanged single entry', () => {
  const repo = makeRepo('default-repo')
  const bin = makeBin('default-bin')

  const config = resolveCsgraphConfig({ bin, repo, root: '_sealed_src', threads: 4 })

  // resolveCsgraphConfig still returns the first server's fields on top level.
  assert.equal(config.serverName, 'csgraph')
  assert.equal(config.bin, resolve(bin))
  assert.equal(config.repo, resolve(repo))
  assert.equal(config.root, '_sealed_src')
  assert.equal(config.threads, 4)
  assert.deepEqual(config.args, serverArgs(repo, '_sealed_src', 4))

  assert.equal(config.servers.length, 1)
  assert.deepEqual(config.servers[0], {
    serverName: 'csgraph',
    bin: resolve(bin),
    repo: resolve(repo),
    root: '_sealed_src',
    threads: 4,
    args: serverArgs(repo, '_sealed_src', 4),
  })

  // Byte-for-byte the pre-multi-repo DSH entry (golden captured from the
  // single-server implementation before this change).
  const entry = mcpClientEntry(config)
  assert.deepEqual(entry, {
    id: 'csgraph-mcp',
    name: '@deepseek-ai/dsh-mcp-client',
    config: {
      serverName: 'csgraph',
      transport: 'stdio',
      command: resolve(bin),
      args: serverArgs(repo, '_sealed_src', 4),
      cwd: resolve(repo),
      failOnStartupError: true,
    },
  })
  assert.deepEqual(mcpClientEntries(config), [entry])
})

test('empty repos list falls back to the single-repo default', () => {
  const repo = makeRepo('empty-repos')
  const bin = makeBin('empty-repos-bin')
  const config = resolveCsgraphConfig({ repos: [], bin, repo })
  assert.equal(config.servers.length, 1)
  assert.equal(config.repo, resolve(repo))
})

test('CSGRAPH_REPOS comma list -> two servers with distinct ids and per-repo args/cwd', () => {
  const repoA = makeRepo('comma-a')
  const repoB = makeRepo('comma-b')
  const bin = makeBin('comma-bin')
  const previous = process.env.CSGRAPH_REPOS
  process.env.CSGRAPH_REPOS = `${repoA},${repoB}`
  process.env.CSGRAPH_BIN = bin
  try {
    const config = resolveCsgraphConfig({ root: '_sealed_src', threads: 4 })
    const entries = mcpClientEntries(config)

    assert.equal(config.servers.length, 2)
    assert.deepEqual(config.servers.map((s) => s.serverName), ['csgraph', 'csgraph2'])
    assert.deepEqual(entryIds(entries), ['csgraph-mcp', 'csgraph2-mcp'])
    assert.equal(new Set(entryIds(entries)).size, 2)

    for (const [index, repo] of [repoA, repoB].entries()) {
      const server = config.servers[index]
      assert.equal(server.repo, resolve(repo))
      assert.equal(server.bin, resolve(bin))
      assert.deepEqual(server.args, serverArgs(repo, '_sealed_src', 4))
      assert.equal(entries[index].config.cwd, resolve(repo))
      assert.equal(entries[index].config.command, resolve(bin))
      assert.equal(entries[index].config.serverName, server.serverName)
    }

    // Top level mirrors the first server, for existing callers.
    assert.equal(config.serverName, 'csgraph')
    assert.equal(config.repo, resolve(repoA))
  } finally {
    if (previous === undefined) delete process.env.CSGRAPH_REPOS
    else process.env.CSGRAPH_REPOS = previous
    delete process.env.CSGRAPH_BIN
  }
})

test('CSGRAPH_REPOS JSON array honours per-entry repo/root/threads/bin/serverName', () => {
  const repoA = makeRepo('json-a')
  const repoB = makeRepo('json-b')
  const binA = makeBin('json-bin-a')
  const binB = makeBin('json-bin-b')
  const previous = process.env.CSGRAPH_REPOS
  process.env.CSGRAPH_REPOS = JSON.stringify([
    repoA,
    { repo: repoB, bin: binB, root: 'src', threads: 2, serverName: 'other' },
  ])
  process.env.CSGRAPH_BIN = binA
  try {
    const config = resolveCsgraphConfig({ root: '_sealed_src', threads: 4 })
    assert.equal(config.servers.length, 2)
    assert.deepEqual(config.servers.map((s) => s.serverName), ['csgraph', 'other'])
    assert.deepEqual(entryIds(mcpClientEntries(config)), ['csgraph-mcp', 'other-mcp'])

    assert.equal(config.servers[0].bin, resolve(binA))
    assert.equal(config.servers[0].root, '_sealed_src')
    assert.equal(config.servers[0].threads, 4)
    assert.deepEqual(config.servers[0].args, serverArgs(repoA, '_sealed_src', 4))

    assert.equal(config.servers[1].bin, resolve(binB))
    assert.equal(config.servers[1].root, 'src')
    assert.equal(config.servers[1].threads, 2)
    assert.deepEqual(config.servers[1].args, serverArgs(repoB, 'src', 2))
    assert.equal(mcpClientEntries(config)[1].config.cwd, resolve(repoB))
  } finally {
    if (previous === undefined) delete process.env.CSGRAPH_REPOS
    else process.env.CSGRAPH_REPOS = previous
    delete process.env.CSGRAPH_BIN
  }
})

test('explicit repos:[...] option expands like CSGRAPH_REPOS', () => {
  const repoA = makeRepo('opt-a')
  const repoB = makeRepo('opt-b')
  const bin = makeBin('opt-bin')
  const config = resolveCsgraphConfig({ repos: [repoA, { repo: repoB, threads: 3 }], bin, root: 'r', threads: 8 })
  assert.deepEqual(config.servers.map((s) => s.serverName), ['csgraph', 'csgraph2'])
  assert.deepEqual(config.servers.map((s) => s.threads), [8, 3])
  assert.deepEqual(entryIds(mcpClientEntries(config)), ['csgraph-mcp', 'csgraph2-mcp'])
  assert.equal(config.servers[1].root, 'r')
  assert.equal(config.servers[1].repo, resolve(repoB))
})

test('resolveRepos parses strings, arrays, JSON, and rejects junk', () => {
  assert.deepEqual(resolveRepos(''), [])
  assert.deepEqual(resolveRepos(undefined), [])
  assert.deepEqual(resolveRepos('/a, /b'), [{ repo: '/a' }, { repo: '/b' }])
  assert.deepEqual(resolveRepos(['/a', '/b']), [{ repo: '/a' }, { repo: '/b' }])
  assert.deepEqual(resolveRepos('["/a",{"repo":"/b","threads":2}]'), [
    { repo: '/a' },
    { repo: '/b', root: undefined, threads: 2, bin: undefined, serverName: undefined },
  ])
  assert.throws(() => resolveRepos('[not json'), /invalid CSGRAPH_REPOS JSON/)
  assert.throws(() => resolveRepos([{ root: 'x' }]), /missing a "repo"/)
  assert.throws(() => resolveRepos([42]), /invalid repository entry/)
})

test('a bad repo fails validation and names the offending repository', () => {
  const repoA = makeRepo('bad-a')
  const bin = makeBin('bad-bin')
  const missing = join(repoA, 'does-not-exist')

  assert.throws(
    () => resolveCsgraphConfig({ repos: [repoA, missing], bin }),
    (error) => {
      assert.match(error.message, /repository path does not exist \(repository 2 of 2\)/)
      assert.ok(error.message.includes(missing))
      return true
    },
  )
  assert.throws(
    () => resolveCsgraphConfig({ repo: missing, bin }),
    /repository path does not exist/,
  )
})

test('duplicate serverNames are refused (ids must be distinct)', () => {
  const repoA = makeRepo('dup-a')
  const repoB = makeRepo('dup-b')
  const bin = makeBin('dup-bin')
  assert.throws(
    () => resolveCsgraphConfig({ repos: [{ repo: repoA, serverName: 'x' }, { repo: repoB, serverName: 'x' }], bin }),
    /duplicate MCP serverName/,
  )
})

test('install.mjs --mode print renders one entry per repo (--repos flag)', () => {
  const repoA = makeRepo('print-a')
  const repoB = makeRepo('print-b')
  const bin = makeBin('print-bin')
  const stdout = execFileSync(
    process.execPath,
    [INSTALL_MJS, '--mode', 'print', '--repos', `${repoA},${repoB}`, '--csgraph', bin, '--root', '_sealed_src', '--threads', '4'],
    { encoding: 'utf8', env: { ...process.env } },
  )
  assert.match(stdout, /id: csgraph-mcp/)
  assert.match(stdout, /id: csgraph2-mcp/)
  assert.match(stdout, /serverName: "csgraph2"/)
  assert.ok(stdout.includes(resolve(repoB)))
  assert.equal((stdout.match(/- insert:/g) ?? []).length, 2)
})

test('install.mjs --mode print fails clearly on a bad repo', () => {
  const repoA = makeRepo('print-bad-a')
  const bin = makeBin('print-bad-bin')
  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        [INSTALL_MJS, '--mode', 'print', '--repos', `${repoA},${join(repoA, 'missing')}`, '--csgraph', bin],
        { encoding: 'utf8', env: { ...process.env } },
      ),
    (error) => {
      assert.equal(error.status, 2)
      assert.match(String(error.stderr), /repository path does not exist/)
      return true
    },
  )
})

test('install.mjs patch mode writes every entry once, is idempotent, and uninstalls', () => {
  const repoA = makeRepo('patch-a')
  const repoB = makeRepo('patch-b')
  const bin = makeBin('patch-bin')
  const profileDir = join(scratch, 'profile')
  mkdirSync(profileDir, { recursive: true })
  const patchFile = join(profileDir, 'cordis.patch.yml')
  const env = { ...process.env, CSGRAPH_REPOS: `${repoA},${repoB}`, CSGRAPH_BIN: bin }
  const argv = [INSTALL_MJS, '--profile-dir', profileDir, '--csgraph', bin, '--repo', repoA]

  execFileSync(process.execPath, argv, { encoding: 'utf8', env })
  const first = readFileSync(patchFile, 'utf8')
  assert.match(first, /id: csgraph-mcp/)
  assert.match(first, /id: csgraph2-mcp/)
  assert.ok(first.includes(resolve(repoA)))
  assert.ok(first.includes(resolve(repoB)))
  assert.equal((first.match(/>>> dsh-plugin-vrcs:/g) ?? []).length, 1)

  const secondRun = execFileSync(process.execPath, argv, { encoding: 'utf8', env })
  assert.match(secondRun, /already up to date; nothing to change/)
  assert.equal(readFileSync(patchFile, 'utf8'), first)

  execFileSync(process.execPath, [...argv, '--uninstall'], { encoding: 'utf8', env })
  assert.equal(readFileSync(patchFile, 'utf8').trim(), '[]')
})
