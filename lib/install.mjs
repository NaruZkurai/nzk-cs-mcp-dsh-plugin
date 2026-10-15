#!/usr/bin/env node
// Implementation behind install.sh. Renders the DSH mcp-client registration for
// csgraph and installs it into a DSH profile. Every write is idempotent and
// guarded; --dry-run prints the plan and changes nothing.

import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'

import { PLUGIN_ROOT, mcpClientEntries, resolveCsgraphConfig } from './csgraph-config.mjs'

// Piping our output into `head` should not crash with an unhandled EPIPE.
process.stdout.on('error', (error) => {
  if (error?.code === 'EPIPE') process.exit(0)
  throw error
})

const PKG_NAME = '@nzk/dsh-plugin-vrcs'
const SERVER_NAME = 'csgraph'
const ENTRY_ID = `${SERVER_NAME}-mcp`
const BEGIN = `# >>> dsh-plugin-vrcs: ${ENTRY_ID} (managed by install.sh) >>>`
const END = `# <<< dsh-plugin-vrcs: ${ENTRY_ID} (managed) <<<`
const BACKUP_SUFFIX = '.dsh-plugin-vrcs.bak'
// Files/dirs published by bundle mode (explicit, so scratch and .git stay out).
const COPY_FILES = [
  'package.json',
  'README.md',
  'LICENSE',
  '.gitignore',
  'cordis.patch.yml',
  'cordis.patch.example.yml',
  'install.sh',
]
const COPY_DIRS = ['lib', 'test']

function usage() {
  return `Usage: install.sh [options]

Install the csgraph MCP bridge into a DSH profile.

Options:
  --profile-dir DIR     DSH profile directory (default: $DSH_PROFILE_DIR,
                        else $DSH_HOME/profiles/web, else ~/.dsh/profiles/web)
  --csgraph PATH        Absolute path to the csgraph binary (env: CSGRAPH_BIN).
                        Auto-probed when omitted.
  --repo PATH           Repository csgraph should index (env: CSGRAPH_REPO;
                        default: the parent directory of this plugin)
  --root REL            Index root relative to --repo (env: CSGRAPH_ROOT;
                        default: _sealed_src)
  --threads N           Worker threads passed to csgraph (env: CSGRAPH_THREADS;
                        default: 4)
  --repos LIST          Comma-separated or JSON-array list of repositories; one
                        MCP server is registered per repository (env:
                        CSGRAPH_REPOS). Entry N is named csgraph, csgraph2, ...
                        JSON entries may be strings or objects with
                        {repo, root, threads, bin, serverName}.
  --server-name NAME    MCP serverName of the FIRST server, also the tool
                        namespace prefix (default: csgraph -> tools
                        mcp__csgraph__<tool>; later servers append 2, 3, ...)
  --mode MODE           patch  (default) manage a block in <profile>/cordis.patch.yml
                        print  render the patch entry to stdout, write nothing
                        bundle copy/link the package into the profile and register
                               it in the profile package.json dsh.profile.bundles
  --link                bundle mode: symlink instead of copying
  --uninstall           remove the managed patch block (or the installed bundle)
  --dry-run             print every planned action; write nothing
  -h, --help            show this help

Examples:
  ./install.sh --dry-run --profile-dir ~/.dsh/profiles/web
  ./install.sh --profile-dir ~/.dsh/profiles/web --csgraph "/abs/csgraph"
  ./install.sh --mode print > /tmp/csgraph.patch.yml
  ./install.sh --mode bundle --profile-dir ~/.dsh/profiles/web
`
}

function parseArgs(argv) {
  const options = { mode: 'patch', dryRun: false, link: false, uninstall: false }
  const valueFlags = {
    '--profile-dir': 'profileDir',
    '--csgraph': 'bin',
    '--bin': 'bin',
    '--repo': 'repo',
    '--repos': 'repos',
    '--root': 'root',
    '--threads': 'threads',
    '--server-name': 'serverName',
    '--mode': 'mode',
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '-h' || arg === '--help') {
      options.help = true
      continue
    }
    if (arg === '--dry-run') {
      options.dryRun = true
      continue
    }
    if (arg === '--link') {
      options.link = true
      continue
    }
    if (arg === '--uninstall') {
      options.uninstall = true
      continue
    }
    const key = valueFlags[arg]
    if (key) {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('--')) throw new Error(`missing value for ${arg}`)
      options[key] = value
      i += 1
      continue
    }
    throw new Error(`unknown argument: ${arg}`)
  }
  return options
}

function defaultProfileDir() {
  const explicit = process.env.DSH_PROFILE_DIR
  if (explicit) return explicit
  const home = process.env.DSH_HOME
  if (home) return join(home, 'profiles', 'web')
  const userHome = process.env.HOME || ''
  return userHome ? join(userHome, '.dsh', 'profiles', 'web') : ''
}

function yamlStr(value) {
  return JSON.stringify(String(value))
}

/** Render one already-built mcp-client entry (id + config) as a YAML array item. */
function renderEntry(entry) {
  const cfg = entry.config
  return [
    `- insert:`,
    `    - id: ${entry.id}`,
    `      name: ${yamlStr(entry.name)}`,
    `      config:`,
    `        serverName: ${yamlStr(cfg.serverName)}`,
    `        transport: stdio`,
    `        command: ${yamlStr(cfg.command)}`,
    `        args:`,
    ...cfg.args.map((arg) => `          - ${yamlStr(arg)}`),
    `        cwd: ${yamlStr(cfg.cwd)}`,
    `        failOnStartupError: true`,
  ].join('\n')
}

/** Every server in the config, one resolved patch entry each (one server per repo). */
function renderEntries(config) {
  return mcpClientEntries(config)
    .map((entry) => renderEntry(entry))
    .join('\n')
}

/** Env-driven patch entry used by the shipped bundle template. */
function renderEnvEntry() {
  const cfg = {
    serverName: SERVER_NAME,
    bin: '<CSGRAPH_BIN>',
    repo: '<CSGRAPH_REPO>',
    root: '<CSGRAPH_ROOT|_sealed_src>',
    threads: '<CSGRAPH_THREADS|4>',
    args: [],
  }
  const entry = mcpClientEntry(cfg, { jsEnv: true })
  const c = entry.config
  return [
    `- insert:`,
    `    - id: ${ENTRY_ID}`,
    `      name: ${yamlStr(entry.name)}`,
    `      config:`,
    `        serverName: ${yamlStr(c.serverName)}`,
    `        transport: stdio`,
    `        command: ${c.command}`,
    `        args:`,
    `          - ${yamlStr('--mcp')}`,
    `          - ${yamlStr('--repo')}`,
    `          - ${c.args[2]}`,
    `          - ${yamlStr('--root')}`,
    `          - ${c.args[4]}`,
    `          - ${yamlStr('--threads')}`,
    `          - ${c.args[6]}`,
    `        cwd: ${c.cwd}`,
    `        failOnStartupError: true`,
  ].join('\n')
}

function renderManagedBlock(config, { uninstall = false, dryRun = false, target = '' } = {}) {
  const entry = config ? renderEntries(config) : renderEnvEntry()
  const banner = uninstall
    ? `# csgraph MCP bridge for DSH (${PKG_NAME}) — uninstall marker`
    : `# csgraph MCP bridge for DSH (${PKG_NAME})`
  const note = `# Managed by dsh_plugin/install.sh. Re-run to refresh; --uninstall to remove.`
  return `${BEGIN}\n${banner}\n${note}\n${entry}\n${END}`
}

function stripManagedBlock(text) {
  const start = text.indexOf(BEGIN)
  if (start === -1) return { text, removed: false }
  const end = text.indexOf(END, start)
  if (end === -1) return { text, removed: false }
  let before = text.slice(0, start)
  let after = text.slice(end + END.length)
  after = after.replace(/^\r?\n/, '')
  before = before.replace(/\s*$/, before.trim() ? '\n' : '')
  return { text: before + after, removed: true }
}

/** Whether a cordis.patch.yml body has no real loader entries. */
function isEmptyPatchDocument(text) {
  const effective = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .join('\n')
    .trim()
  return effective === '' || effective === '[]'
}

/** Build the new patch file content (idempotent). */
function planPatchFile(filePath, block, { uninstall }) {
  const original = existsSync(filePath) ? readFileSync(filePath, 'utf8') : '[]\n'
  const { text: stripped, removed } = stripManagedBlock(original)
  let body = stripped
  if (isEmptyPatchDocument(body)) {
    body = body
      .split('\n')
      .filter((line) => line.trim() !== '[]')
      .join('\n')
  }
  body = body.replace(/\s*$/, '')
  if (uninstall) {
    const next = body ? `${body}\n` : '[]\n'
    return { original, next, changed: removed || original !== next, removed }
  }
  const next = body ? `${body}\n${block}\n` : `${block}\n`
  return { original, next, changed: original !== next, removed }
}

function backupOnce(filePath, dryRun) {
  const backup = `${filePath}${BACKUP_SUFFIX}`
  if (existsSync(backup)) return
  if (dryRun) {
    log(`would back up ${filePath} -> ${backup}`)
    return
  }
  writeFileSync(backup, readFileSync(filePath))
  log(`backed up ${filePath} -> ${backup}`)
}

const actions = []
function log(message) {
  actions.push(message)
  process.stdout.write(`${message}\n`)
}

function planWrite(filePath, content, dryRun) {
  if (dryRun) {
    log(`[dry-run] would write ${filePath} (${content.length} bytes)`)
    return
  }
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, content)
  log(`wrote ${filePath}`)
}

function runPatchMode(options, config) {
  const profileDir = options.profileDir
  const patchFile = join(profileDir, 'cordis.patch.yml')
  log(`${options.dryRun ? '[dry-run] ' : ''}${options.uninstall ? 'uninstalling from' : 'installing into'} ${patchFile}`)

  let block = ''
  if (!options.uninstall) {
    block = renderManagedBlock(config, { target: patchFile })
  }
  const { next, changed } = planPatchFile(patchFile, block, { uninstall: options.uninstall })
  if (!changed) {
    log('already up to date; nothing to change')
    return
  }
  if (!options.uninstall && existsSync(patchFile)) backupOnce(patchFile, options.dryRun)
  planWrite(patchFile, next, options.dryRun)
  if (!options.dryRun && !options.uninstall) {
    log('Next: restart/reload the DSH profile so the mcp-client entry activates.')
    log(`Verify: node ${join(PLUGIN_ROOT, 'test', 'smoke.mjs')}`)
  }
}

function loadProfilePackage(profileDir) {
  const file = join(profileDir, 'package.json')
  if (!existsSync(file)) return { file, json: null }
  const json = JSON.parse(readFileSync(file, 'utf8'))
  return { file, json }
}

function bundleDestination(profileDir) {
  return join(profileDir, 'node_modules', ...PKG_NAME.split('/'))
}

function runBundleMode(options, config) {
  const profileDir = options.profileDir
  const dest = bundleDestination(profileDir)
  const { file: pkgFile, json: profile } = loadProfilePackage(profileDir)

  if (options.uninstall) {
    if (!existsSync(dest)) {
      log(`no installed bundle at ${dest}; nothing to remove`)
    } else {
      const stat = lstatSync(dest)
      const isLink = stat.isSymbolicLink()
      const linkTarget = isLink ? resolve(dirname(dest), readlinkSync(dest)) : null
      let ours = isLink && linkTarget === PLUGIN_ROOT
      if (!ours && !isLink) {
        try {
          ours = JSON.parse(readFileSync(join(dest, 'package.json'), 'utf8')).name === PKG_NAME
        } catch {
          ours = false
        }
      }
      if (!ours) throw new Error(`refusing to remove ${dest}: it is not an installed ${PKG_NAME}`)
      if (options.dryRun) log(`[dry-run] would remove ${dest}`)
      else {
        rmSync(dest, { recursive: true, force: true })
        log(`removed ${dest}`)
      }
    }
    if (profile?.dsh?.profile?.bundles?.includes(PKG_NAME)) {
      backupOnce(pkgFile, options.dryRun)
      removeBundleEntry(profile, pkgFile, options.dryRun)
    }
    return
  }

  // Install (copy or link).
  if (existsSync(dest)) {
    const stat = lstatSync(dest)
    const isLink = stat.isSymbolicLink()
    const linkTarget = isLink ? resolve(dirname(dest), readlinkSync(dest)) : null
    const ours = (isLink && linkTarget === PLUGIN_ROOT) || (!isLink && safePackageName(dest) === PKG_NAME)
    if (!ours) throw new Error(`refusing to overwrite ${dest}: it is not ${PKG_NAME}`)
    if (options.dryRun) log(`[dry-run] would replace existing ${dest}`)
    else {
      rmSync(dest, { recursive: true, force: true })
      log(`replaced existing ${dest}`)
    }
  }

  if (options.link) {
    log(`${options.dryRun ? '[dry-run] ' : ''}symlink ${PLUGIN_ROOT} -> ${dest}`)
    if (!options.dryRun) {
      mkdirSync(dirname(dest), { recursive: true })
      symlinkSync(PLUGIN_ROOT, dest, 'dir')
      log('NOTE: link mode keeps the env-driven patch; export CSGRAPH_BIN and CSGRAPH_REPO')
      log('      (or prefer --mode patch, which bakes resolved paths).')
    }
  } else {
    log(`${options.dryRun ? '[dry-run] ' : ''}copy ${PLUGIN_ROOT} -> ${dest}`)
    if (!options.dryRun) {
      mkdirSync(dest, { recursive: true })
      // Copy an explicit manifest rather than recursing: this keeps .git,
      // node_modules and test scratch out, and works even when the destination
      // happens to live under the source tree.
      for (const file of COPY_FILES) {
        const from = join(PLUGIN_ROOT, file)
        if (existsSync(from)) copyFileSync(from, join(dest, file))
      }
      for (const dir of COPY_DIRS) {
        const from = join(PLUGIN_ROOT, dir)
        if (existsSync(from)) cpSync(from, join(dest, dir), { recursive: true })
      }
      // Bake resolved paths into the installed copy so it works without env vars.
      writeFileSync(join(dest, 'cordis.patch.yml'), `${renderEntries(config)}\n`)
      log(`wrote ${join(dest, 'cordis.patch.yml')}`)
    }
  }

  if (!profile) {
    log(`no ${pkgFile}; skipping bundle registration`)
    return
  }
  const bundles = profile.dsh?.profile?.bundles
  if (!Array.isArray(bundles)) {
    log(`${pkgFile} has no dsh.profile.bundles array; skipping registration`)
    return
  }
  if (bundles.includes(PKG_NAME)) {
    log(`${pkgFile} already lists ${PKG_NAME}`)
  } else {
    backupOnce(pkgFile, options.dryRun)
    if (options.dryRun) {
      log(`[dry-run] would add ${PKG_NAME} to dsh.profile.bundles in ${pkgFile}`)
    } else {
      bundles.push(PKG_NAME)
      writeFileSync(pkgFile, `${JSON.stringify(profile, null, 2)}\n`)
      log(`added ${PKG_NAME} to dsh.profile.bundles in ${pkgFile}`)
    }
  }
  if (!options.dryRun) log('Next: run `dsh plugin --profile <name> list` (or restart) to activate.')
}

function safePackageName(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name
  } catch {
    return undefined
  }
}

function removeBundleEntry(profile, pkgFile, dryRun) {
  profile.dsh.profile.bundles = profile.dsh.profile.bundles.filter((name) => name !== PKG_NAME)
  if (dryRun) log(`[dry-run] would remove ${PKG_NAME} from dsh.profile.bundles in ${pkgFile}`)
  else {
    writeFileSync(pkgFile, `${JSON.stringify(profile, null, 2)}\n`)
    log(`removed ${PKG_NAME} from dsh.profile.bundles in ${pkgFile}`)
  }
}

function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${usage()}`)
    process.exit(2)
  }
  if (options.help) {
    process.stdout.write(usage())
    return
  }
  if (!['patch', 'print', 'bundle'].includes(options.mode)) {
    process.stderr.write(`unknown --mode ${options.mode} (expected patch|print|bundle)\n`)
    process.exit(2)
  }
  if (options.mode === 'print') {
    let config
    try {
      config = resolveConfigSafe(options)
    } catch (error) {
      process.stderr.write(`invalid repository configuration: ${error.message}\n`)
      process.exit(2)
    }
    process.stdout.write(`${renderManagedBlock(config, { target: 'stdout' })}\n`)
    return
  }
  options.serverName = options.serverName || SERVER_NAME
  const profileDir = resolve(options.profileDir || defaultProfileDir() || '')
  if (!profileDir) {
    process.stderr.write('no profile directory: pass --profile-dir or set DSH_PROFILE_DIR/DSH_HOME\n')
    process.exit(2)
  }
  options.profileDir = profileDir
  if (!existsSync(profileDir)) {
    process.stderr.write(`profile directory does not exist: ${profileDir}\n`)
    process.exit(2)
  }
  let config
  try {
    config = resolveCsgraphConfig(options)
  } catch (error) {
    process.stderr.write(`invalid repository configuration: ${error.message}\n`)
    process.exit(2)
  }
  if (options.mode === 'patch') runPatchMode(options, config)
  else runBundleMode(options, config)
  if (options.dryRun) process.stdout.write('dry-run complete; no changes were written.\n')
}

function resolveConfigSafe(options) {
  try {
    return resolveCsgraphConfig(options)
  } catch (error) {
    // A missing repository is a hard configuration error in every mode. Only
    // "binary not built yet" degrades to the env-driven placeholder template,
    // so `--mode print` still works before csgraph has been built.
    if (/^repository path does not exist/.test(error.message)) throw error
    return { serverName: options.serverName || SERVER_NAME, bin: '<CSGRAPH_BIN>', repo: '<CSGRAPH_REPO>', root: '<CSGRAPH_ROOT|_sealed_src>', threads: 4, args: [] }
  }
}

main()
