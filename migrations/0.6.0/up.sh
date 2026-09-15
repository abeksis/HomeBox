#!/usr/bin/env bash
# 0.6.0 — move the install from /opt/homebox to /opt/podhouse.
#
# The project was renamed in 0.5.0 and the folder kept its old name, because
# every container on the box is bind-mounted from it. This moves it:
#
#   1. mv /opt/homebox /opt/podhouse — a rename on the same filesystem, so no
#      file is copied and running containers keep their open files;
#   2. ln -s /opt/podhouse /opt/homebox — every container, script, systemd
#      unit and habit that still says /opt/homebox keeps working, and an app
#      moves to the new path the next time it is recreated;
#   3. every .env value under /opt/homebox now says /opt/podhouse, so compose
#      and install.sh use the new path from here on.
#
# Refuses — and the update rolls back untouched — when the tree cannot simply
# be renamed: /opt/podhouse already exists, /opt/homebox is its own mount, or
# the two are on different filesystems (a rename would become a copy of every
# photo and film on the box).
set -euo pipefail

OLD=/opt/homebox
NEW=/opt/podhouse
say() { printf '[migration 0.6.0] %s\n' "$*"; }

fix_env() {
  local env="$NEW/.env"
  [ -f "$env" ] || return 0
  if grep -qE '=/opt/homebox(/|$)' "$env"; then
    sed -i -E 's#=/opt/homebox(/|$)#=/opt/podhouse\1#g' "$env"
    say "updated paths in .env"
  fi
}

# Already done (a resumed update, or a second run): make sure .env agrees.
if [ -L "$OLD" ] && [ "$(readlink -f "$OLD")" = "$NEW" ] && [ -d "$NEW" ]; then
  fix_env
  say "already at $NEW"
  exit 0
fi

# Installed somewhere other than /opt/homebox: nothing of ours to move.
here="$(readlink -f "${HB_ROOT:-$OLD}")"
if [ "$here" != "$OLD" ]; then
  say "this box lives at $here, not $OLD — leaving it where it is"
  exit 0
fi

[ -d "$OLD" ] || { say "$OLD is missing"; exit 1; }
if [ -e "$NEW" ] || [ -L "$NEW" ]; then
  say "$NEW already exists — move or remove it, then update again"
  exit 1
fi
if mountpoint -q "$OLD" 2>/dev/null; then
  say "$OLD is a mount point of its own and cannot be renamed — not moving"
  exit 1
fi
if [ "$(stat -c %d "$OLD")" != "$(stat -c %d "$(dirname "$NEW")")" ]; then
  say "$OLD and $(dirname "$NEW") are on different filesystems — not moving"
  exit 1
fi

mv "$OLD" "$NEW"
ln -s "$NEW" "$OLD"
say "moved $OLD to $NEW, $OLD now points there"
fix_env
