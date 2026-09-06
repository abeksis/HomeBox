#!/usr/bin/env bash
# Seed the Portainer admin password file before its first start.
#
# Portainer's `--admin-password-file` reads plaintext from this path and
# creates the admin account at boot. Without it Portainer opens an
# unauthenticated setup screen for whoever reaches port 9000 first, and locks
# itself a few minutes later — leaving an install nobody can log into.
set -euo pipefail

HB_ROOT="${HB_ROOT:-/opt/homebox}"
CONFIG_DIR="$HB_ROOT/modules/core/config"
PASSWORD_FILE="$CONFIG_DIR/portainer-admin-password"

mkdir -p "$CONFIG_DIR/npm/data" "$CONFIG_DIR/npm/letsencrypt" "$CONFIG_DIR/portainer"

if [ -f "$PASSWORD_FILE" ]; then
  echo "core: portainer password file already present, leaving it alone"
  exit 0
fi

# install.sh generated it; read it out of .env rather than minting a second
# one, so `homebox secrets core` and the actual login agree.
PASSWORD="$(grep -E '^PORTAINER_ADMIN_PASSWORD=' "$HB_ROOT/.env" 2>/dev/null | cut -d= -f2-)"
if [ -z "$PASSWORD" ]; then
  echo "core: PORTAINER_ADMIN_PASSWORD is not in .env — run install.sh first" >&2
  exit 1
fi

# Portainer rejects anything under 12 characters and would exit on boot.
if [ "${#PASSWORD}" -lt 12 ]; then
  echo "core: PORTAINER_ADMIN_PASSWORD is shorter than the 12 characters Portainer requires" >&2
  exit 1
fi

# No trailing newline: Portainer takes the file's bytes verbatim, and a
# newline becomes part of the password you then cannot type.
printf '%s' "$PASSWORD" > "$PASSWORD_FILE"
chmod 600 "$PASSWORD_FILE"

echo "core: wrote $PASSWORD_FILE"
