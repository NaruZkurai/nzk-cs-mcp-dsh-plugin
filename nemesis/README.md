# csgraph-nemesis — MCP bridge for the live Nemesis Main project

A second, optional csgraph MCP server bound to the **live Unity project**
instead of the vrcCS repo. Use it when a teammate (or the Lead) wants native
`mcp__csgraph_nemesis__*` tools against the SPS work under
`Assets/NZK toolkit v5`.

| | main bundle | this bundle |
|---|---|---|
| serverName | `csgraph` | `csgraph-nemesis` |
| repo | `/2tb/@/nzk/git/vrcCS` | `/run/media/naruzkurai/7239d970-fcaa-4df1-8bee-9d42d842204b/Nemesis Main` |
| root | `_sealed_src` | `Assets/NZK toolkit v5` |
| tool prefix | `mcp__csgraph__*` | `mcp__csgraph_nemesis__*` |

Both servers run the same binary and expose the same 41 tools; they differ only
in default repo/root. **A profile reload (restarting the dsh web host) is
required to pick either up.**

## Enable / disable

```sh
./nemesis/enable.sh              # add the managed block to $DSH_PROFILE_DIR/cordis.patch.yml
./nemesis/enable.sh --dry-run    # show what it would do
./nemesis/enable.sh --disable    # remove the managed block
./nemesis/enable.sh --profile /root/.dsh/profiles/web
```

The block is delimited by `# >>> dsh-plugin-vrcs: csgraph-nemesis (managed) >>>`
markers, so it never touches your own patch entries.

## Why it exists

Until it is enabled, every write and read against the live project goes through
the same server via the stdio driver:

```sh
python3 "/2tb/@/nzk/git/vrcCS/cs viewer builder/rust-only-csviewer/tools/mcp_drive.py" \
  --repo "/run/media/naruzkurai/7239d970-fcaa-4df1-8bee-9d42d842204b/Nemesis Main" \
  --root "Assets/NZK toolkit v5" --threads 2 call parse_check '{"files":["..."]}'
```

That is the same MCP surface (same `write_file`/`apply_edits`/`reformat`/
`parse_check` handlers), just driven without a host reload — so the SPS work can
finish with the constraint "everything through the MCP" either way.

## Verify after enabling

```sh
python3 tools/smoke.mjs   # from the main bundle: 41 tools
```

Then in the model's tool list, look for `mcp__csgraph_nemesis__state`; a
`state` call should report `root` = `.../Nemesis Main/Assets/NZK toolkit v5`.
