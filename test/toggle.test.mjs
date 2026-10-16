// The settings toggle contract.
//
// `@deepseek-ai/dsh-plugin-manager` exposes the profile's plugin rows in the
// Web sidebar's Plugins page (and through the `plugin_manager` tool). Its
// `writePluginEnabled(filename, id, name, enabled)` finds the LAST top-level
// patch item whose `id` matches, skipping any item that carries `insert`, and
// then sets `disabled: !enabled` on it; with no match it appends its own
// `{ id, disabled }` entry.
//
// These tests pin the two things this plugin must guarantee:
//   1. install.sh registers a top-level `id: csgraph-mcp` row the manager can
//      address at all (an inserted entry alone is NOT addressable);
//   2. the default is ON, and re-running install.sh restores that default even
//      after the manager (or a hand edit) switched the row off.
//
// The manager's own write is simulated rather than imported: importing it would
// make this package's tests depend on a built DSH checkout.

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const INSTALL = resolve(HERE, '..', 'lib', 'install.mjs')
const ENTRY_ID = 'csgraph-mcp'

function run(args, options = {}) {
  return execFileSync(process.execPath, [INSTALL, ...args], {
    encoding: 'utf8',
    ...options,
  })
}

/** Exactly what plugin-manager's writePluginEnabled does to the row. */
function simulateManagerToggle(text, id, enabled) {
  const lines = text.split('\n')
  let lastMatch = -1
  for (let i = 0; i < lines.length; i += 1) {
    // A top-level sequence item, at column 0, whose id is the target.
    if (lines[i] === `- id: ${id}`) lastMatch = i
  }
  assert.notEqual(lastMatch, -1, `no top-level "- id: ${id}" row for the manager to address`)
  lines[lastMatch + 1] = `  disabled: ${enabled ? 'false' : 'true'}`
  return lines.join('\n')
}

test('print mode registers a top-level, addressable toggle row', () => {
  const out = run(['--mode', 'print'])
  // The row must sit at column 0, outside the `- insert:` list.
  assert.match(out, new RegExp(`^\\- id: ${ENTRY_ID}$`, 'm'))
  assert.match(out, new RegExp(`^\\- id: ${ENTRY_ID}\\n  disabled: false$`, 'm'))
  // ...and it must not be the inserted entry, which carries no `disabled`.
  assert.match(out, /- insert:\n {4}- id: csgraph-mcp\n {6}name: "@deepseek-ai\/dsh-mcp-client"/)
})

test('the default is ON, and --disabled registers it OFF', () => {
  assert.match(run(['--mode', 'print']), new RegExp(`- id: ${ENTRY_ID}\\n  disabled: false`))
  assert.match(run(['--mode', 'print', '--disabled']), new RegExp(`- id: ${ENTRY_ID}\\n  disabled: true`))
})

test('patch mode is idempotent and every re-run restores the default ON', () => {
  const profile = mkdtempSync(join(tmpdir(), 'dsh-plugin-vrcs-toggle-'))
  const patchFile = join(profile, 'cordis.patch.yml')
  writeFileSync(patchFile, '# user patch layer\n[]\n')
  try {
    const args = ['--profile-dir', profile]
    run(args)
    const first = readFileSync(patchFile, 'utf8')
    assert.match(first, new RegExp(`- id: ${ENTRY_ID}\\n  disabled: false`))

    // A second identical run must not change the file.
    run(args)
    assert.equal(readFileSync(patchFile, 'utf8'), first, 're-install must be idempotent')

    // The manager (or the user) switches the row off...
    writeFileSync(patchFile, simulateManagerToggle(first, ENTRY_ID, false))
    const off = readFileSync(patchFile, 'utf8')
    assert.match(off, new RegExp(`- id: ${ENTRY_ID}\\n  disabled: true`))

    // ...and install.sh puts the default back, proving "default on" holds.
    run(args)
    const back = readFileSync(patchFile, 'utf8')
    assert.match(back, new RegExp(`- id: ${ENTRY_ID}\\n  disabled: false`))
    assert.doesNotMatch(back, new RegExp(`- id: ${ENTRY_ID}\\n  disabled: true`))

    // Exactly one addressable row survives, so the manager never faces two.
    // (Count column-0 rows only: the inserted entry is indented and is skipped
    // by the manager's finder, so it must not be mistaken for a second row.)
    const addressable = back
      .split('\n')
      .filter((line) => line === `- id: ${ENTRY_ID}`).length
    assert.equal(addressable, 1)

    // And --disabled is honoured on a fresh profile.
    rmSync(patchFile)
    writeFileSync(patchFile, '# user patch layer\n[]\n')
    run([...args, '--disabled'])
    assert.match(readFileSync(patchFile, 'utf8'), new RegExp(`- id: ${ENTRY_ID}\\n  disabled: true`))
  } finally {
    rmSync(profile, { recursive: true, force: true })
  }
})

test('the toggle row is written for every server in split mode', () => {
  const repos = join(tmpdir(), 'dsh-plugin-vrcs-toggle-repos')
  const a = join(repos, 'a')
  const b = join(repos, 'b')
  execFileSync(process.execPath, ['-e', `require('fs').mkdirSync(${JSON.stringify(a)},{recursive:true});require('fs').mkdirSync(${JSON.stringify(b)},{recursive:true})`])
  try {
    const out = run(['--mode', 'print', '--repos', `${a},${b}`, '--split-servers'])
    assert.match(out, /- id: csgraph-mcp\n  disabled: false/)
    assert.match(out, /- id: csgraph2-mcp\n  disabled: false/)
  } finally {
    rmSync(repos, { recursive: true, force: true })
  }
})
