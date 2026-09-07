#!/usr/bin/env bash
# Turn the generated wg-easy password into the bcrypt hash v14 demands.
#
# wg-easy v14 REFUSES to start when PASSWORD is set — it exits with
# "DO NOT USE PASSWORD ENVIRONMENT VARIABLE. USE PASSWORD_HASH INSTEAD."
# So the plain password stays in .env for the user to sign in with, and this
# writes the hash beside it for the container to check against.
#
# bcrypt is not in node's crypto, and it is not worth a dependency or a
# hand-rolled implementation. The wg-easy image ships the exact tool for it
# (`wgpw`), and by the time this runs that image is already being pulled for
# the module itself — so the thing that defines the format generates it.
set -euo pipefail

HB_ROOT="${HB_ROOT:-/opt/homebox}"
ENV_FILE="$HB_ROOT/.env"
IMAGE="$(grep -oE 'ghcr\.io/wg-easy/wg-easy:[A-Za-z0-9._-]+' "$HB_ROOT/modules/vpn/docker-compose.yml" | head -1)"
IMAGE="${IMAGE:-ghcr.io/wg-easy/wg-easy:14}"

if grep -q '^WG_ADMIN_PASSWORD_HASH=' "$ENV_FILE" 2>/dev/null; then
  echo "vpn: the web UI password hash is already set — leaving it alone"
  exit 0
fi

if [ -z "${WG_ADMIN_PASSWORD:-}" ]; then
  echo "vpn: no WG_ADMIN_PASSWORD in .env — cannot build the hash wg-easy needs"
  exit 0
fi

command -v docker >/dev/null 2>&1 || { echo "vpn: docker not available here — skipping the hash"; exit 0; }

echo "vpn: generating the bcrypt hash wg-easy v14 requires"
# wgpw prints:  PASSWORD_HASH='$2a$12$...'
raw="$(docker run --rm "$IMAGE" wgpw "$WG_ADMIN_PASSWORD" 2>/dev/null | sed -n "s/^PASSWORD_HASH='\(.*\)'$/\1/p" | head -1)"
[ -n "$raw" ] || { echo "vpn: wgpw produced nothing — leaving the hash unset"; exit 0; }

# EVERY $ doubled, and this is the whole reason this file is careful.
#
# Compose re-interpolates a value it reads from --env-file, so a bcrypt hash
# stored raw arrives at the container mutilated: $2a$12$Pl2zg... has $12 and
# $Pl2zgLXMBaMvxdHqFsg read as variables and replaced with nothing. Measured,
# with compose warning "The \"Pl2zgLXMBaMvxdHqFsg\" variable is not set".
# Doubling them round-trips exactly.
#
# Both sides escaped: unescaped, `$$` in the REPLACEMENT is bash's own PID,
# so the hash came out as "4452a44512445Pl2zg..." — a perfectly plausible
# looking string that is not the hash. Checked against the expected value
# rather than eyeballed.
escaped=${raw//\$/\$\$}

umask 077
printf 'WG_ADMIN_PASSWORD_HASH=%s\n' "$escaped" >> "$ENV_FILE"
echo "vpn: hash written — sign in with the password from \`homebox secrets vpn\`"
