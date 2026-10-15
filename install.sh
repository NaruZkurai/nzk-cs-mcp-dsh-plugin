#!/usr/bin/env sh
# install.sh — idempotent installer for the csgraph MCP bridge in a DSH profile.
#
# This wrapper only locates node and forwards every argument to
# lib/install.mjs, which implements the safe/idempotent install logic.
#
#   ./install.sh --dry-run --profile-dir ~/.dsh/profiles/web
#   ./install.sh --mode print
#   ./install.sh --uninstall --profile-dir ~/.dsh/profiles/web
#
# See ./install.sh --help for all options and env fallbacks
# (CSGRAPH_BIN, CSGRAPH_REPO, CSGRAPH_REPOS, CSGRAPH_ROOT, CSGRAPH_THREADS,
# DSH_PROFILE_DIR).
#
# CSGRAPH_REPOS (comma-separated or JSON array) registers one MCP server per
# repository: csgraph, csgraph2, ... Adding a server needs a profile reload.

set -eu

DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

if ! command -v node >/dev/null 2>&1; then
  echo "install.sh: node is required but was not found on PATH" >&2
  exit 127
fi

exec node "$DIR/lib/install.mjs" "$@"
