// Shared configuration resolution for the csgraph stdio MCP server.
//
// Everything is configurable; nothing is blindly hardcoded. Resolution order
// for every value is: explicit option -> environment variable -> derived
// default. The only "known" path is a *candidate* that is probed and must
// exist, never trusted unless it is actually there.

import { existsSync, statSync } from 'node:fs'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const DEFAULTS = {
  root: '_sealed_src',
  threads: 4,
  serverName: 'csgraph',
}

export const ENV = {
  bin: 'CSGRAPH_BIN',
  repo: 'CSGRAPH_REPO',
  root: 'CSGRAPH_ROOT',
  threads: 'CSGRAPH_THREADS',
  profileDir: 'DSH_PROFILE_DIR',
}

/** Absolute path of this package (the git repo root of dsh_plugin). */
export const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function isExecutableFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function firstExisting(candidates) {
  for (const candidate of candidates) {
    if (candidate && isExecutableFile(candidate)) return candidate
  }
  return undefined
}

/** Walk PATH looking for `name`, mirroring how a shell would resolve it. */
export function findOnPath(name) {
  if (name.includes('/') || name.includes('\\')) {
    return isExecutableFile(name) ? name : undefined
  }
  const pathEnv = process.env.PATH ?? ''
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, name)
    if (isExecutableFile(candidate)) return candidate
  }
  return undefined
}

/** Candidate locations probed (in order) when no --csgraph/CSGRAPH_BIN is given. */
export function csgraphCandidates(repo) {
  const names = [join('cs viewer builder', 'target', 'debug', 'csgraph')]
  const list = []
  if (repo) {
    for (const name of names) list.push(join(repo, name))
  }
  // The plugin may live next to the app tree; probe one level up as well.
  for (const name of names) list.push(join(PLUGIN_ROOT, '..', name))
  list.push(findOnPath('csgraph'))
  return list.filter(Boolean)
}

export function resolveThreads(value) {
  const n = Number.parseInt(String(value ?? DEFAULTS.threads), 10)
  if (!Number.isFinite(n) || n < 1) {
    throw new Error(`invalid threads value: ${JSON.stringify(value)} (expected a positive integer)`)
  }
  return n
}

/**
 * Resolve the effective csgraph MCP configuration.
 * @param {{bin?: string, repo?: string, root?: string, threads?: string|number, serverName?: string}} [options]
 */
export function resolveCsgraphConfig(options = {}) {
  const env = process.env
  const repo = resolve(options.repo || env[ENV.repo] || resolve(PLUGIN_ROOT, '..'))
  const root = options.root || env[ENV.root] || DEFAULTS.root
  const threads = resolveThreads(options.threads ?? env[ENV.threads])

  const explicitBin = options.bin || env[ENV.bin]
  let bin = explicitBin
  if (bin) {
    bin = isAbsolute(bin) ? bin : resolve(process.cwd(), bin)
    if (!isExecutableFile(bin)) {
      throw new Error(
        `csgraph binary not found or not a file: ${bin}\n` +
          `Set --csgraph/CSGRAPH_BIN to the real binary path.`,
      )
    }
  } else {
    bin = firstExisting(csgraphCandidates(repo))
    if (!bin) {
      throw new Error(
        'could not locate the csgraph binary.\n' +
          'Pass --csgraph <path> or set CSGRAPH_BIN. Probed:\n' +
          csgraphCandidates(repo)
            .map((c) => `  - ${c}`)
            .join('\n'),
      )
    }
  }

  if (!existsSync(repo)) {
    throw new Error(`repository path does not exist: ${repo}`)
  }

  return {
    serverName: options.serverName || DEFAULTS.serverName,
    bin: resolve(bin),
    repo: resolve(repo),
    root,
    threads,
    args: ['--mcp', '--repo', resolve(repo), '--root', root, '--threads', String(threads)],
  }
}

/**
 * The canonical DSH mcp-client loader entry for this server.
 * `!!js` expressions are emitted instead of absolute paths when `jsEnv` is set,
 * so a patch can stay machine independent.
 */
export function mcpClientEntry(config, { jsEnv = false } = {}) {
  const configBlock = jsEnv
    ? {
        serverName: config.serverName,
        transport: 'stdio',
        command: '!!js process.env.CSGRAPH_BIN',
        args: [
          '--mcp',
          '--repo',
          '!!js process.env.CSGRAPH_REPO',
          '--root',
          "!!js process.env.CSGRAPH_ROOT || '_sealed_src'",
          '--threads',
          "!!js String(process.env.CSGRAPH_THREADS || '4')",
        ],
        cwd: '!!js process.env.CSGRAPH_REPO',
        failOnStartupError: true,
      }
    : {
        serverName: config.serverName,
        transport: 'stdio',
        command: config.bin,
        args: config.args,
        cwd: config.repo,
        failOnStartupError: true,
      }
  return { id: `${config.serverName}-mcp`, name: '@deepseek-ai/dsh-mcp-client', config: configBlock }
}
