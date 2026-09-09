#!/usr/bin/env bash
# Fetch service icons from homarr-labs/dashboard-icons into the dashboard.
#
# Companion to sync-icons.sh, which copies from a homepage install that
# happens to be on the network. This one goes to the upstream set, so a module
# added on any box can get its icon without another machine being up.
#
# Icons are committed and served locally on purpose — a remote icon is a
# permanent dependency on somebody else's server for a 3KB file.
#
# The -light preference is not cosmetic. dashboard-icons ships the plain name
# as black artwork meant for light UIs; HomeBox is dark, so tailscale.svg
# renders black on black while tailscale-light.svg is the readable one.
#
# Usage: scripts/fetch-icons.sh <name> [<name>...]
#        scripts/fetch-icons.sh --missing     (every icon a module names but this box lacks)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$REPO_ROOT/dashboard/public/icons"
BASE="https://raw.githubusercontent.com/homarr-labs/dashboard-icons/main"

mkdir -p "$DEST"

# Every icon: filename a module declares, minus the ones already here.
missing_icons() {
  grep -rhoE '^\s+icon: "[^"]+"' "$REPO_ROOT"/modules/*/docker-compose.yml \
    | sed -E 's/.*"([^"]+)".*/\1/' | sort -u \
    | while IFS= read -r f; do [ -f "$DEST/$f" ] || printf '%s\n' "${f%.*}"; done
}

fetch_one() {
  local name="$1" got=""
  for candidate in "svg/$name-light.svg" "svg/$name.svg" "png/$name.png" "webp/$name.webp"; do
    local ext="${candidate##*.}"
    if curl -fsSL --max-time 20 -o "$DEST/$name.$ext" "$BASE/$candidate" 2>/dev/null; then
      # A 3-byte answer is a redirect page, not artwork.
      if [ "$(wc -c < "$DEST/$name.$ext")" -gt 200 ]; then got="$name.$ext"; break; fi
      rm -f "$DEST/$name.$ext"
    fi
  done
  if [ -n "$got" ]; then printf '  ok      %s\n' "$got"; return 0; fi
  printf '  MISSING %s\n' "$name"; return 1
}

if [ "${1:-}" = "--missing" ]; then
  set -- $(missing_icons)
  [ $# -gt 0 ] || { echo "every icon a module names is already present"; exit 0; }
fi

[ $# -gt 0 ] || { echo "usage: $0 <name> [<name>...] | --missing" >&2; exit 1; }

ok=0 bad=0
for name in "$@"; do
  if fetch_one "$name"; then ok=$((ok + 1)); else bad=$((bad + 1)); fi
done
echo
echo "$ok fetched, $bad not in the upstream set"

# Then check what the modules actually ASK for.
#
# Fetching is by name; a module declares a full filename. Those came apart
# once: a module said ersatztv.svg, upstream had only a PNG, the fetch
# reported "ok ersatztv.png" and the card still showed a monogram. A success
# line about a file nobody references is worse than a failure, so verify the
# declared names resolve rather than trusting the download count.
echo
echo "icons declared by a module with no matching file:"
unresolved=0
while IFS= read -r f; do
  [ -f "$DEST/$f" ] && continue
  printf '  %s\n' "$f"
  unresolved=$((unresolved + 1))
done < <(grep -rhoE '^\s+icon: "[^"]+"' "$REPO_ROOT"/modules/*/docker-compose.yml | sed -E 's/.*"([^"]+)".*/\1/' | sort -u)
[ "$unresolved" -eq 0 ] && echo "  none — every declared icon resolves"

# A missing icon is cosmetic: the UI falls back to a coloured monogram. Drop
# the `icon:` line entirely when there is no artwork, rather than pointing at
# a file that will never exist.
exit 0
