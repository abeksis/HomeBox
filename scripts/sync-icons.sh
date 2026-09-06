#!/usr/bin/env bash
# Copy service icons from the existing homepage asset directory into the
# dashboard. Icons are served locally on purpose — no CDN, so the dashboard
# renders identically on a box with no internet.
#
# A module may name an icon this box does not have; the UI falls back to a
# coloured monogram rather than a broken image, so a missing file is a
# cosmetic issue, never an error.
set -euo pipefail

SRC="${1:-/srv/docker/appdata/homepage/assets/icons}"
DEST="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/dashboard/public/icons"

[ -d "$SRC" ] || { echo "no such icon source: $SRC" >&2; exit 1; }
mkdir -p "$DEST"

copied=0
while IFS= read -r file; do
  name="$(basename "$file")"
  # Never clobber homebox.svg — it is ours, not a copied service icon.
  [ "$name" = "homebox.svg" ] && continue
  cp -f "$file" "$DEST/$name"
  copied=$((copied + 1))
done < <(find "$SRC" -maxdepth 1 -type f \( -name '*.svg' -o -name '*.png' -o -name '*.webp' \) ! -name 'launcher-*')

echo "copied $copied icons into $DEST"
