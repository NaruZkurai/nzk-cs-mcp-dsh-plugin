# @nzk/dsh-plugin-vrcs

A [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) profile
bundle that bridges the **csgraph** stdio MCP server into the harness. Once
installed, the C# graph/refactor engine at
`cs viewer builder/target/debug/csgraph` is callable through the in-box
`@deepseek-ai/dsh-mcp-client` bridge, and its tools appear to the model as:

```
mcp__csgraph__api_call      mcp__csgraph__search     mcp__csgraph__node
mcp__csgraph__relation      mcp__csgraph__find       mcp__csgraph__refs
mcp__csgraph__source        mcp__csgraph__doc        mcp__csgraph__decls
mcp__csgraph__chain         mcp__csgraph__kinds      mcp__csgraph__definitions
mcp__csgraph__subgraph      mcp__csgraph__export     mcp__csgraph__projects
mcp__csgraph__state         mcp__csgraph__index      mcp__csgraph__index_cancel
mcp__csgraph__browse        mcp__csgraph__settings   mcp__csgraph__viewer_state
mcp__csgraph__reorg         mcp__csgraph__parse_check
mcp__csgraph__select_decls  mcp__csgraph__move_decls mcp__csgraph__grep
mcp__csgraph__fuzzy_search  mcp__csgraph__resolve_chain
mcp__csgraph__code_block    mcp__csgraph__rename_symbol
mcp__csgraph__qualify_symbols
mcp__csgraph__expand_namespace
mcp__csgraph__write_file    mcp__csgraph__apply_edits
mcp__csgraph__find_duplicates
```

This package ships **configuration + verification only**: no Host/Client entry
code. It follows DSH's config-only-bundle pattern (`dsh.bundle.patch`), the same
shape as the official MCP bundle template.

## What it does

- Declares a DSH profile bundle (`dsh.bundle.patch -> ./cordis.patch.yml`) that
  inserts one `@deepseek-ai/dsh-mcp-client` row named `csgraph`.
- Spawns `csgraph --mcp --repo <repo> --root <rel> --threads N` over stdio.
- Supports several repositories at once: one MCP server per repository
  (`csgraph`, `csgraph2`, ...), driven by `CSGRAPH_REPOS`. See
  [Several repositories](#several-repositories-one-mcp-server-per-repo).
- Exposes whichever tools `tools/list` advertises under the `mcp__csgraph__`
  namespace (currently 40).
- Provides an idempotent installer (`install.sh`) and a sub-10-second smoke test
  (`test/smoke.mjs`) that proves the real binary still speaks the protocol.

## Layout

| Path | Purpose |
|---|---|
| `package.json` | Bundle manifest (`dsh.bundle.patch`) |
| `cordis.patch.yml` | Bundle patch: mcp-client registration (env-driven) |
| `cordis.patch.example.yml` | Copy-paste registration example (resolved + env variants) |
| `install.sh` | Idempotent installer, `--dry-run`, `--uninstall` |
| `lib/install.mjs` | Installer implementation |
| `lib/csgraph-config.mjs` | Binary/repo/root/threads resolution (shared, multi-repo aware) |
| `test/smoke.mjs` | Spawns the real binary, initialize + `tools/list`, asserts tool names |
| `test/config.test.mjs` | `node:test` unit checks for multi-repo expansion + installer |

## Requirements

- DSH with the in-box `@deepseek-ai/dsh-mcp-client` package (shipped profiles
  already contain it).
- Node.js >= 20 (only for `install.sh` and the smoke test; DSH itself spawns the
  binary directly).
- A built `csgraph` binary (Rust, `target/debug/csgraph` or `target/release/csgraph`).

## Install

### 1. Recommended: `install.sh --mode patch`

Bakes the resolved absolute binary/repo paths into the profile's user patch
layer (`<profile>/cordis.patch.yml`) between managed markers. It preserves any
existing entries, backs the file up once, and is idempotent — re-run it any time
the binary moves.

```sh
# Preview first (writes nothing):
./install.sh --dry-run --profile-dir ~/.dsh/profiles/web

# Install:
./install.sh --profile-dir ~/.dsh/profiles/web \
  --csgraph "/2tb/@/nzk/git/vrcCS/cs viewer builder/target/debug/csgraph" \
  --repo /2tb/@/nzk/git/vrcCS --root _sealed_src --threads 4
```

The profile directory defaults to `$DSH_PROFILE_DIR`, else
`$DSH_HOME/profiles/web`, else `~/.dsh/profiles/web`. The binary defaults to
`--csgraph`, else `$CSGRAPH_BIN`, else an auto-probe of `<repo>/cs viewer
builder/target/debug/csgraph`, `<plugin>/../cs viewer builder/...`, then `csgraph`
on `PATH`. It never silently guesses: if nothing is executable it fails with the
list of paths it probed.

Then restart/reload the profile.

### 2. Alternative: install as a real bundle

Copies (or symlinks) the package into the profile's `node_modules` and adds
`@nzk/dsh-plugin-vrcs` to `dsh.profile.bundles` in the profile `package.json`.

```sh
./install.sh --mode bundle --profile-dir ~/.dsh/profiles/web            # copy
./install.sh --mode bundle --link --profile-dir ~/.dsh/profiles/web     # symlink
```

Copy mode bakes resolved paths into the installed copy. Link mode keeps the
env-driven patch, so export `CSGRAPH_BIN` and `CSGRAPH_REPO` in the environment
DSH starts from.

### 3. Manual / `dsh plugin`

Either paste the entry from `cordis.patch.example.yml` into
`<profile>/cordis.patch.yml`, or let DSH install it as a bundle:

```sh
dsh plugin --profile web add /2tb/@/nzk/git/vrcCS/dsh_plugin
```

`--mode print` renders the managed patch block to stdout without writing
anything.

### 4. Environment-driven bundle patch

The bundle's own `cordis.patch.yml` uses Loader `!!js` expressions, so the
harness process must see these when the bundle is activated directly:

| Variable | Default | Meaning |
|---|---|---|
| `CSGRAPH_BIN` | (required) | Absolute path to the `csgraph` binary |
| `CSGRAPH_REPO` | (required) | Repository the engine indexes |
| `CSGRAPH_REPOS` | (unset) | Multi-repo list (comma-separated or JSON array); one server per entry |
| `CSGRAPH_ROOT` | `_sealed_src` | Index root relative to the repo |
| `CSGRAPH_THREADS` | `4` | Worker threads |

### 5. Several repositories: one MCP server per repo

The bridge is **one MCP server per repository**. `CSGRAPH_REPOS` (or the
installer flag `--repos`) takes either a comma-separated list or a JSON array;
each entry becomes its own `@deepseek-ai/dsh-mcp-client` row with a distinct id
and tool namespace:

| Entry | serverName | row id | tools |
|---|---|---|---|
| 1st repo | `csgraph` | `csgraph-mcp` | `mcp__csgraph__*` |
| 2nd repo | `csgraph2` | `csgraph2-mcp` | `mcp__csgraph2__*` |
| 3rd repo | `csgraph3` | `csgraph3-mcp` | `mcp__csgraph3__*` |

Each server gets its own `--repo`/`cwd`, and therefore its own index; the model
picks the namespace it needs. JSON entries may be plain path strings, or objects
that override values per repo:

```sh
# Comma-separated:
./install.sh --profile-dir ~/.dsh/profiles/web \
  --repos /repo/one,/repo/two

# JSON array, per-entry overrides (root/threads/bin/serverName):
CSGRAPH_REPOS='[
  "/repo/one",
  {"repo": "/repo/two", "root": "src", "threads": 2, "serverName": "second"}
]' ./install.sh --profile-dir ~/.dsh/profiles/web

# Inspect the plan first; writes nothing:
./install.sh --mode print --repos /repo/one,/repo/two --csgraph /abs/csgraph
```

Rules and behavior:

- With no multi-repo input the result is exactly the single `csgraph` server
  described by `CSGRAPH_REPO` / `--repo` — nothing changes for existing profiles.
- `CSGRAPH_BIN` / `--csgraph`, `CSGRAPH_ROOT` / `--root` and
  `CSGRAPH_THREADS` / `--threads` still apply globally; a JSON entry may override
  them for its own repo.
- `--server-name` renames the **first** server; later ones append `2`, `3`, ...
  Ids are always `<serverName>-mcp` and must be distinct.
- Every repository path is validated: a missing path fails with exit code 2 and
  names the offending repo. Nothing is written when validation fails.
- All entries are written into the one managed patch block, so re-running
  `install.sh` refreshes them in place (idempotent) and `--uninstall` removes
  them together.
- **Adding or changing a server only takes effect after the profile is
  restarted/reloaded** — no MCP connection is established while the harness is
  running. `install.sh` prints this reminder after a real (non-dry-run) change.

## Verify

### Protocol smoke test (no DSH required)

```sh
node test/smoke.mjs
# or: CSGRAPH_BIN=... node test/smoke.mjs --repo <repo> --root _sealed_src
```

It spawns the real binary, performs `initialize` -> `notifications/initialized`
-> `tools/list`, asserts that every **baseline** tool name is present (a superset
check — additional/new server tools are allowed and only logged), enforces a 10 s
budget, and exits non-zero if any baseline tool is missing or the handshake
fails. Expected shape:

```
csgraph smoke test
  binary: /2tb/@/nzk/git/vrcCS/cs viewer builder/target/debug/csgraph
  repo:   /2tb/@/nzk/git/vrcCS
  root:   _sealed_src  threads: 4
  tools:  40 (api_call, apply_edits, browse, chain, code_block, copy_path, counts, decls, definitions, doc, expand_namespace, export, find, find_duplicates, functionize, fuzzy_search, grep, index, index_cancel, kinds, move_decls, node, parse_check, projects, qualify_symbols, reformat, refs, relation, rename_symbol, reorg, resolve_chain, search, select_decls, settings, source, state, subgraph, viewer_state, workspace, write_file)
PASS: 40 tools in ~3800 ms
```

### Under DSH

After the profile restarts, ask the model to call `mcp__csgraph__state` (cheap,
read-only). A successful call returns `{"status":200,...}`. If the tools do not
appear, check the harness log for the `csgraph` MCP connection error.

### Manual `tools/list` (raw JSON-RPC)

```sh
printf '%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"0.0.1"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
| "/2tb/@/nzk/git/vrcCS/cs viewer builder/target/debug/csgraph" \
    --mcp --repo /2tb/@/nzk/git/vrcCS --root _sealed_src --threads 4
```

## Uninstall

```sh
./install.sh --uninstall --profile-dir ~/.dsh/profiles/web            # patch mode
./install.sh --mode bundle --uninstall --profile-dir ~/.dsh/profiles/web
```

Uninstall removes only the managed patch block / the installed bundle entry; it
never deletes unrelated profile content. The first modification of a profile
file leaves a one-time `<file>.dsh-plugin-vrcs.bak` next to it.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `could not locate the csgraph binary` | Pass `--csgraph` or set `CSGRAPH_BIN`. The error lists every probed path. |
| `csgraph binary not found or not a file` | The path exists but is not a file, or is not executable. Build it: `cargo build` in `cs viewer builder`. |
| MCP connection fails at startup, harness still boots | `failOnStartupError: true` is set in the entry but DSH's startup policy keeps optional MCP entries from aborting the harness. Check the log line, then re-run `node test/smoke.mjs`. |
| Zero `mcp__csgraph__*` tools | The server connected but advertised no tools, or the entry is not active. Confirm the patch entry exists and the profile was restarted; then run the smoke test. |
| Tools take ~2–4 s to appear at startup | csgraph indexes the repo before answering `tools/list` (52 files ≈ 3 s, 4 workers). This is expected, not a hang. |
| Path with spaces fails in YAML | Installer output always quotes scalars (`"/…/cs viewer builder/…"`). Quote hand-written paths the same way. |
| Profile file refused/backup not written | Profile files may be root-owned. Re-run with sufficient privileges; `install.sh` never escalates on its own. |
| `--dry-run` prints but nothing changes | By design: dry-run performs no writes and no backups. |

## Security note

`csgraph --mcp` exposes the **entire `/api/*` surface of the engine**, including
`api_call`, `index`, `reorg`, `settings`, and `viewer_state`. It is exactly as
powerful as running the csgraph app itself: any tool the app can execute — reads
*and writes*, including reorganisation of a destination tree — is reachable from
the model. Treat this bridge with the same trust boundary as shell access to the
repository:

- Only install it into profiles/sessions where that level of control is intended.
- `--repo` and `--root` scope what is indexed; they do **not** restrict writes.
- DSH scrubs ambient `KEY|PASSWORD|SECRET|TOKEN` and `DSH_*` environment
  variables from stdio children; pass only what the server genuinely needs.
- Prefer `failOnStartupError: true` (as shipped) so a misconfigured bridge is
  loud rather than silently absent.

## Development

```sh
node test/smoke.mjs                    # protocol smoke test against the real binary
node --test test/config.test.mjs       # multi-repo config / installer unit tests
./install.sh --dry-run                 # inspect an install plan
```

`test/smoke.mjs` asserts a required **baseline** of tool names (`BASELINE_TOOLS`)
and tolerates new ones, so csgraph gaining tools never breaks it. Add a name to
the baseline only to lock in a new guarantee; remove one only when the server
genuinely drops or renames that tool.

## License

MIT — see [LICENSE](LICENSE).
