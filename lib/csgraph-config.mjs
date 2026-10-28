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
  repos: 'CSGRAPH_REPOS',
  splitServers: 'CSGRAPH_SPLIT_SERVERS',
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
  const names = [
    join('CsViewerGitRepo', 'BaseCode', 'target', 'release', 'csgraph'),
    join('CsViewerGitRepo', 'BaseCode', 'target', 'debug', 'csgraph'),
    join('CsViewerGitRepo', 'Builder', 'target', 'release', 'csgraph'),
    join('CsViewerGitRepo', 'Builder', 'target', 'debug', 'csgraph'),
    join('NZK-cs-mcp', 'target', 'release', 'csgraph'),
    join('NZK-cs-mcp', 'target', 'debug', 'csgraph'),
    // legacy v2/v3-in-monorepo layout
    join('cs viewer builder', 'target', 'debug', 'csgraph'),
  ]
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
 * Server name for the Nth repository in opt-in SPLIT mode: the base name, then
 * `<base>2`, `<base>3`, ... so every entry gets a distinct id
 * (`csgraph-mcp`, `csgraph2-mcp`, ...). The default merged mode always uses the
 * base name.
 */
export function serverNameForIndex(base, index) {
  return index === 0 ? base : `${base}${index + 1}`
}

function normalizeRepoEntry(value, index) {
  if (typeof value === 'string') {
    const repo = value.trim()
    if (!repo) throw new Error(`empty repository path at index ${index}`)
    return { repo }
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const { repo, root, threads, bin, serverName } = value
    if (repo === undefined || String(repo).trim() === '') {
      throw new Error(`repository entry at index ${index} is missing a "repo" path`)
    }
    return { repo: String(repo).trim(), root, threads, bin, serverName }
  }
  throw new Error(`invalid repository entry at index ${index}: expected a path string or an object`)
}

/**
 * Parse a multi-repo input into normalized entries.
 * Accepts an array (strings or `{repo, root, threads, bin, serverName}` objects),
 * a comma-separated string, or a JSON array string (the `CSGRAPH_REPOS` forms).
 * An empty/absent value means "no multi-repo input" (single-repo default).
 * @returns {Array<{repo: string, root?: string, threads?: string|number, bin?: string, serverName?: string}>}
 */
export function resolveRepos(value) {
  if (value === undefined || value === null) return []
  if (Array.isArray(value)) return value.map((entry, i) => normalizeRepoEntry(entry, i))
  const text = String(value).trim()
  if (!text) return []
  if (text.startsWith('[')) {
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      throw new Error(`invalid ${ENV.repos} JSON: ${error.message}`)
    }
    if (!Array.isArray(parsed)) throw new Error(`${ENV.repos} JSON must be an array`)
    return parsed.map((entry, i) => normalizeRepoEntry(entry, i))
  }
  return text
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((entry, i) => normalizeRepoEntry(entry, i))
}

/** True for the customary truthy environment spellings (`1`, `true`, `yes`, `on`). */
export function isTruthyEnv(value) {
  if (value === undefined || value === null) return false
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase())
}

/** Resolve one repository entry's csgraph binary (explicit, else probed). */
function resolveBin(entry, options, repo) {
  const env = process.env
  const explicitBin = entry.bin || options.bin || env[ENV.bin]
  if (explicitBin) {
    const bin = isAbsolute(explicitBin) ? explicitBin : resolve(process.cwd(), explicitBin)
    if (!isExecutableFile(bin)) {
      throw new Error(
        `csgraph binary not found or not a file: ${bin}\n` +
          `Set --csgraph/CSGRAPH_BIN to the real binary path.`,
      )
    }
    return resolve(bin)
  }
  const bin = firstExisting(csgraphCandidates(repo))
  if (!bin) {
    throw new Error(
      'could not locate the csgraph binary.\n' +
        'Pass --csgraph <path> or set CSGRAPH_BIN. Probed:\n' +
        csgraphCandidates(repo)
          .map((c) => `  - ${c}`)
          .join('\n'),
    )
  }
  return resolve(bin)
}

/** Resolve one repository entry into a complete per-server configuration. */
function resolveServer(entry, options, index, total) {
  const env = process.env
  const repo = resolve(entry.repo)
  const root = entry.root ?? options.root ?? env[ENV.root] ?? DEFAULTS.root
  const threads = resolveThreads(entry.threads ?? options.threads ?? env[ENV.threads])
  const baseName = options.serverName || DEFAULTS.serverName
  const serverName = entry.serverName || serverNameForIndex(baseName, index)
  const bin = resolveBin(entry, options, repo)

  if (!existsSync(repo)) {
    const where = total > 1 ? ` (repository ${index + 1} of ${total})` : ''
    throw new Error(`repository path does not exist${where}: ${repo}`)
  }

  return {
    serverName,
    bin,
    repo,
    root,
    threads,
    args: ['--mcp', '--repo', repo, '--root', root, '--threads', String(threads)],
  }
}

/**
 * The DEFAULT multi-repo shape: ONE csgraph server bound to every repository,
 * via a repeated `--repo` in the argv. `--root`/`--exclude`/`--threads` are
 * global in the server, so the first entry's (or the top-level) values win.
 * The server's `cwd` is the first repo (and index 0 is the primary/default).
 */
function mergedServer(entries, options) {
  const env = process.env
  const repos = entries.map((entry) => resolve(entry.repo))
  const root = entries[0].root ?? options.root ?? env[ENV.root] ?? DEFAULTS.root
  const threads = resolveThreads(entries[0].threads ?? options.threads ?? env[ENV.threads])
  const serverName = options.serverName || entries[0].serverName || DEFAULTS.serverName
  const bin = resolveBin(entries[0], options, repos[0])

  repos.forEach((repo, index) => {
    if (!existsSync(repo)) {
      const where = repos.length > 1 ? ` (repository ${index + 1} of ${repos.length})` : ''
      throw new Error(`repository path does not exist${where}: ${repo}`)
    }
  })

  const args = ['--mcp']
  for (const repo of repos) args.push('--repo', repo)
  args.push('--root', root, '--threads', String(threads))
  return { serverName, bin, repo: repos[0], root, threads, args }
}

/**
 * Resolve the effective csgraph MCP configuration.
 *
 * With no multi-repo input the result is the single server described by
 * `options.repo` / `CSGRAPH_REPO` (unchanged). `options.repos` or
 * `CSGRAPH_REPOS` binds every repository to ONE server by default: the argv is
 * `--mcp --repo A --repo B ... --root R --threads T`, its `cwd` is the first
 * repo, and a per-call `repo` argument selects among them. Set
 * `options.splitServers: true` (or `CSGRAPH_SPLIT_SERVERS=1`) for the old
 * opt-in split: one server entry per repository (`csgraph`, `csgraph2`, ...).
 *
 * The returned object always describes the FIRST server (so existing callers
 * keep working) and additionally carries every server in `servers`.
 * @param {{bin?: string, repo?: string, repos?: string|Array, root?: string, threads?: string|number, serverName?: string, splitServers?: boolean}} [options]
 */
export function resolveCsgraphConfig(options = {}) {
  const env = process.env
  const multi = options.repos !== undefined ? options.repos : env[ENV.repos]
  const entries = resolveRepos(multi)
  if (entries.length === 0) {
    entries.push({ repo: options.repo || env[ENV.repo] || resolve(PLUGIN_ROOT, '..') })
  }
  const split = options.splitServers !== undefined
    ? Boolean(options.splitServers)
    : isTruthyEnv(env[ENV.splitServers])
  const servers = split
    ? entries.map((entry, index) => resolveServer(entry, options, index, entries.length))
    : [mergedServer(entries, options)]

  const names = new Set()
  for (const server of servers) {
    if (names.has(server.serverName)) {
      throw new Error(
        `duplicate MCP serverName ${JSON.stringify(server.serverName)}; ` +
          'each repository needs a distinct serverName (ids are <serverName>-mcp)',
      )
    }
    names.add(server.serverName)
  }

  return { ...servers[0], servers }
}

/**
 * One canonical DSH mcp-client entry per configured server.
 * @param {ReturnType<typeof resolveCsgraphConfig>} config
 */
export function mcpClientEntries(config, opts = {}) {
  const servers = Array.isArray(config?.servers) && config.servers.length ? config.servers : [config]
  return servers.map((server) => mcpClientEntry(server, opts))
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
