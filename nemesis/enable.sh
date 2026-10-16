#!/usr/bin/env sh
# enable.sh - add/remove the csgraph-nemesis MCP server in a DSH profile patch.
#
#   ./enable.sh                 # add (idempotent) to $DSH_PROFILE_DIR/cordis.patch.yml
#   ./enable.sh --disable       # remove the managed block
#   ./enable.sh --profile DIR   # target another profile directory
#   ./enable.sh --dry-run       # print what would change
#
# The block is delimited by markers so enable/disable never touch your own
# entries. A profile reload is required afterwards (restart the dsh web host).
set -eu

DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
BEGIN="# >>> dsh-plugin-vrcs: csgraph-nemesis (managed) >>>"
END="# <<< dsh-plugin-vrcs: csgraph-nemesis (managed) <<<"

PROFILE="${DSH_PROFILE_DIR:-$HOME/.dsh/profiles/web}"
MODE=enable
DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --disable) MODE=disable ;;
    --dry-run) DRY=1 ;;
    --profile) shift; PROFILE="$1" ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "enable.sh: unknown option $1" >&2; exit 2 ;;
  esac
  shift
done

PATCH="$PROFILE/cordis.patch.yml"
[ -f "$PATCH" ] || { echo "enable.sh: no patch file at $PATCH" >&2; exit 1; }

if [ "$MODE" = disable ]; then
  if ! grep -qF "$BEGIN" "$PATCH"; then echo "csgraph-nemesis: not enabled"; exit 0; fi
  TMP="$PATCH.tmp.$$"
  awk -v b="$BEGIN" -v e="$END" '$0==b{skip=1} skip!=1{print} $0==e{skip=0}' "$PATCH" > "$TMP"
  if [ "$DRY" = 1 ]; then echo "would remove managed block from $PATCH"; rm -f "$TMP"; exit 0; fi
  mv "$TMP" "$PATCH"
  echo "csgraph-nemesis: disabled (reload the profile to apply)"
  exit 0
fi

if grep -qF "$BEGIN" "$PATCH"; then echo "csgraph-nemesis: already enabled"; exit 0; fi
if [ "$DRY" = 1 ]; then echo "would append managed block to $PATCH"; exit 0; fi
{
  printf '\n%s\n' "$BEGIN"
  cat "$DIR/cordis.patch.yml"
  printf '%s\n' "$END"
} >> "$PATCH"
echo "csgraph-nemesis: enabled in $PATCH (reload the profile to apply)"
