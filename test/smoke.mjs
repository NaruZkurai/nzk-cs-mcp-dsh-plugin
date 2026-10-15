#!/usr/bin/env node
// Smoke test: spawn the real csgraph stdio MCP server, complete the MCP
// handshake (initialize -> notifications/initialized -> tools/list) and assert
// the required baseline tool names. Exits 0 on success, non-zero on any failure.
//
// The assertion is a SUPERSET check: every baseline tool must be present, but
// additional tools are allowed and only reported, so the server gaining tools
// does not produce a false failure.
//
// Usage:
//   node test/smoke.mjs [--csgraph PATH] [--repo PATH] [--root REL]
//                       [--threads N] [--timeout-ms 10000] [--verbose]
//
// Environment fallbacks: CSGRAPH_BIN, CSGRAPH_REPO, CSGRAPH_ROOT, CSGRAPH_THREADS.

import { spawn } from 'node:child_process'
import process from 'node:process'
import { resolveCsgraphConfig } from '../lib/csgraph-config.mjs'

const PROTOCOL_VERSION = '2025-06-18'
const DEFAULT_TIMEOUT_MS = 10_000

// Required baseline: the tool names `csgraph --mcp` advertised when this test
// was written (csgraph 2.0.0). Every name below must be present. New/additional
// tools are allowed and logged, never a failure; drop or rename a baseline name
// only when the server genuinely removed that tool.
//
// The 22 routed tools plus the 19 MCP-only tools (14 edit + preview_change +
// 4 aux) are pinned here: 41 total. `preview_change` is the fifth-pass
// read-only signature/call-site change preview (M3 slice 2).
const BASELINE_TOOLS = [
  'api_call',
  'apply_edits',
  'browse',
  'chain',
  'code_block',
  'copy_path',
  'counts',
  'decls',
  'definitions',
  'doc',
  'expand_namespace',
  'export',
  'find',
  'find_duplicates',
  'functionize',
  'fuzzy_search',
  'grep',
  'index',
  'index_cancel',
  'kinds',
  'move_decls',
  'node',
  'parse_check',
  'preview_change',
  'projects',
  'qualify_symbols',
  'reformat',
  'refs',
  'relation',
  'rename_symbol',
  'reorg',
  'resolve_chain',
  'search',
  'select_decls',
  'settings',
  'source',
  'state',
  'subgraph',
  'viewer_state',
  'workspace',
  'write_file',
].sort()

function parseArgs(argv) {
  const options = { timeoutMs: DEFAULT_TIMEOUT_MS, verbose: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const take = () => {
      const value = argv[i + 1]
      if (value === undefined) throw new Error(`missing value for ${arg}`)
      i += 1
      return value
    }
    switch (arg) {
      case '--csgraph':
      case '--bin':
        options.bin = take()
        break
      case '--repo':
        options.repo = take()
        break
      case '--root':
        options.root = take()
        break
      case '--threads':
        options.threads = take()
        break
      case '--server-name':
        options.serverName = take()
        break
      case '--timeout-ms':
        options.timeoutMs = Number.parseInt(take(), 10)
        break
      case '--verbose':
      case '-v':
        options.verbose = true
        break
      case '--help':
      case '-h':
        options.help = true
        break
      default:
        throw new Error(`unknown argument: ${arg}`)
    }
  }
  return options
}

function fail(message) {
  process.stderr.write(`\nFAIL: ${message}\n`)
  process.exitCode = 1
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    process.stdout.write(
      'Usage: node test/smoke.mjs [--csgraph PATH] [--repo PATH] [--root REL] [--threads N] [--timeout-ms MS] [--verbose]\n',
    )
    return
  }

  const config = resolveCsgraphConfig(options)
  process.stdout.write(`csgraph smoke test\n  binary: ${config.bin}\n  repo:   ${config.repo}\n  root:   ${config.root}  threads: ${config.threads}\n`)

  const started = Date.now()
  const child = spawn(config.bin, config.args, {
    cwd: config.repo,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
  })

  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    stderr += chunk
    if (options.verbose) process.stderr.write(chunk)
  })

  // Hard wall-clock budget: the whole test must finish well under 10 seconds.
  const timer = setTimeout(() => {
    fail(`timed out after ${options.timeoutMs} ms waiting for tools/list`)
    child.kill('SIGKILL')
  }, options.timeoutMs)

  const tools = await new Promise((resolvePromise, rejectPromise) => {
    let buffer = ''
    let settled = false
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      fn(value)
    }

    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`)

    child.on('error', (error) => finish(rejectPromise, error))
    child.on('exit', (code, signal) => {
      if (!settled) {
        finish(rejectPromise, new Error(`server exited early (code=${code} signal=${signal})\n${stderr}`))
      }
    })

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      let newline
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (!line) continue
        let message
        try {
          message = JSON.parse(line)
        } catch {
          finish(rejectPromise, new Error(`non-JSON line on stdout: ${line.slice(0, 200)}`))
          return
        }
        if (message.id === 1) {
          if (message.error) {
            finish(rejectPromise, new Error(`initialize failed: ${JSON.stringify(message.error)}`))
            return
          }
          send({ jsonrpc: '2.0', method: 'notifications/initialized' })
          send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
        } else if (message.id === 2) {
          if (message.error) {
            finish(rejectPromise, new Error(`tools/list failed: ${JSON.stringify(message.error)}`))
            return
          }
          finish(resolvePromise, message.result?.tools ?? [])
        }
      }
    })

    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'dsh-plugin-vrcs-smoke', version: '1.0.0' },
      },
    })
  }).catch((error) => {
    fail(error.message)
    return null
  })

  clearTimeout(timer)
  try {
    child.stdin.end()
  } catch {
    /* already closed */
  }
  await new Promise((resolvePromise) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolvePromise()
    child.once('exit', resolvePromise)
    setTimeout(() => {
      child.kill('SIGKILL')
      resolvePromise()
    }, 2_000)
  })

  if (!tools) return

  const names = tools.map((tool) => tool.name).sort()
  const missing = BASELINE_TOOLS.filter((name) => !names.includes(name))
  const extra = names.filter((name) => !BASELINE_TOOLS.includes(name))
  const elapsedMs = Date.now() - started

  process.stdout.write(`  tools:  ${names.length} (${names.join(', ')})\n`)
  if (extra.length) process.stdout.write(`  new:    ${extra.join(', ')} (allowed, not in baseline)\n`)
  if (missing.length) fail(`missing baseline tools: ${missing.join(', ')}`)

  if (process.exitCode) {
    process.stderr.write(`  elapsed: ${elapsedMs} ms\n`)
    return
  }
  if (elapsedMs >= DEFAULT_TIMEOUT_MS) {
    fail(`took ${elapsedMs} ms, expected under ${DEFAULT_TIMEOUT_MS} ms`)
    return
  }
  process.stdout.write(`PASS: ${names.length} tools in ${elapsedMs} ms\n`)
}

main().catch((error) => {
  fail(error?.stack ?? String(error))
})
