#!/usr/bin/env bash
# Create the shared pool layout the media stack expects.
#
# All five containers mount the pool at ONE path (/data) so that a finished
# download can be HARDLINKED into the library instead of copied. That is not
# just about being on one filesystem: the kernel compares the MOUNT, so two
# separate binds fail with EXDEV even on the same disk. Hence a single root
# with the categories as folders inside it.
set -euo pipefail

HB_ROOT="${HB_ROOT:-/opt/homebox}"
DATA_DIR="${HB_DATA_DIR:-$HB_ROOT/data}"
MEDIA_ROOT="${HB_MEDIA_ROOT:-$DATA_DIR}"
PUID="${PUID:-1000}"
PGID="${PGID:-1000}"

# Folder names inside the root, matching the defaults in the compose file.
DOWNLOADS="${HB_DOWNLOADS:-downloads}"
MOVIES="${HB_MEDIA_MOVIES:-media/movies}"
TV="${HB_MEDIA_TV:-media/tv}"

for dir in \
  "$MEDIA_ROOT/$DOWNLOADS" \
  "$MEDIA_ROOT/$DOWNLOADS/incomplete" \
  "$MEDIA_ROOT/$MOVIES" \
  "$MEDIA_ROOT/$TV" \
  "$HB_ROOT/modules/media/config/qbittorrent" \
  "$HB_ROOT/modules/media/config/radarr" \
  "$HB_ROOT/modules/media/config/sonarr" \
  "$HB_ROOT/modules/media/config/prowlarr" \
  "$HB_ROOT/modules/media/config/bazarr"
do
  # A pre-existing library on a NAS is already laid out and may be read-only
  # to us in places; creating what is missing must not abort the install.
  mkdir -p "$dir" 2>/dev/null || echo "media: could not create $dir (already there, or not writable)"
done

# The linuxserver images drop privileges to PUID:PGID and cannot chown a
# directory root already owns, so ownership has to be right before first run.
# Only ever touch what we just made: chowning somebody's whole NAS library is
# not a side effect an installer gets to have.
for dir in "$MEDIA_ROOT/$DOWNLOADS" "$MEDIA_ROOT/$MOVIES" "$MEDIA_ROOT/$TV"; do
  [ -d "$dir" ] && chown "$PUID:$PGID" "$dir" 2>/dev/null || true
done
chown -R "$PUID:$PGID" "$HB_ROOT/modules/media/config" 2>/dev/null || true

echo "media: pool ready at $MEDIA_ROOT ($DOWNLOADS, $MOVIES, $TV) — all mounted as /data"

# ---------------------------------------------------------------------------
# Give qBittorrent a web UI account that survives a restart.
#
# Left alone, qBittorrent has NO stored account: it falls back to `admin` with
# a TEMPORARY password that it regenerates on every single start and prints to
# its log. So a fresh Media Stack install hands you an app you cannot sign in
# to without going to read a container log — and the moment the container
# restarts, whatever you found there stops working. Anyone who had not
# discovered that gets a flat "Unauthorized" and no idea why.
#
# Every other app in HomeBox is seeded with a generated password at install.
# This makes qBittorrent behave the same way: the password lives in .env, the
# dashboard's Live activity card reads it from there, and `homebox secrets
# media` prints it.
#
# Written ONLY when there is no account yet, so a password the user set
# themselves in the web UI is never overwritten by a re-run.
# ---------------------------------------------------------------------------
QBT_CONF="$HB_ROOT/modules/media/config/qbittorrent/qBittorrent/qBittorrent.conf"
QBIT_USER="${HB_QBIT_USER:-admin}"

seed_qbittorrent_login() {
  [ -n "${HB_QBIT_PASS:-}" ] || { echo "media: no HB_QBIT_PASS in .env — leaving qBittorrent on its temporary password"; return 0; }

  # qBittorrent rewrites this file from memory when it SHUTS DOWN, so anything
  # written here while it is running is erased the moment the container stops
  # — and the erase happens three seconds before the next start, which is why
  # it looks like the seeding never ran at all. Measured on this box.
  #
  # On a fresh install that is not a problem: setup.sh runs before `compose
  # up`. Re-running it against a live stack is the case that needs saying out
  # loud, because a silent no-op here reads as "HomeBox cannot do this".
  if command -v docker >/dev/null 2>&1 && [ -n "$(docker ps -q --filter name='^qbittorrent$' 2>/dev/null)" ]; then
    echo "media: qBittorrent is running — it would overwrite this file on shutdown, so the login was NOT seeded."
    echo "media: stop it first if you want the account written:  docker stop qbittorrent && bash $HB_ROOT/modules/media/setup.sh && docker start qbittorrent"
    return 0
  fi

  if [ -f "$QBT_CONF" ] && grep -q '^WebUI\\Password_PBKDF2=' "$QBT_CONF"; then
    echo "media: qBittorrent already has a saved web UI password — leaving it alone"
    return 0
  fi

  # qBittorrent stores PBKDF2-HMAC-SHA512, 100k iterations, 64-byte key, with
  # a 16-byte salt, as "@ByteArray(<base64 salt>:<base64 key>)".
  #
  # NODE, not python3, and the reason matters.
  #
  # This script runs in two very different places. From the CLI it runs on the
  # host, which has both. From the dashboard's "Install" button it runs INSIDE
  # the dashboard container — a node image with no python3 at all. Written
  # against python3 it therefore worked in every test I ran over SSH and did
  # nothing whatsoever for anyone installing the normal way: the seeding was
  # skipped, qBittorrent kept generating a temporary password each boot, and
  # the dialog confidently showed a password the app had never heard of.
  #
  # node is present in both: the dashboard image is built on it, and install.sh
  # already requires it on the host to read module metadata.
  #
  # Not pure shell: the hex->raw step loses bytes to command substitution
  # (a \x00 vanishes, so one salt in sixteen comes out short and the hash
  # silently does not match). Measured — the openssl variant produced a
  # 15-byte salt on the first try.
  local runner=''
  if command -v node >/dev/null 2>&1; then runner=node
  elif command -v python3 >/dev/null 2>&1; then runner=python3
  else
    echo "media: neither node nor python3 is available — cannot seed the qBittorrent password; it stays on the temporary one from its log"
    return 0
  fi

  # qBittorrent stores PBKDF2-HMAC-SHA512, 100k iterations, 64-byte key, with
  # a 16-byte salt, as "@ByteArray(<base64 salt>:<base64 key>)".
  local hashed
  if [ "$runner" = node ]; then
    hashed=$(QB_PASS="$HB_QBIT_PASS" node -e '
const crypto = require("crypto");
const salt = crypto.randomBytes(16);
const key = crypto.pbkdf2Sync(process.env.QB_PASS, salt, 100000, 64, "sha512");
process.stdout.write(`@ByteArray(${salt.toString("base64")}:${key.toString("base64")})`);
') || { echo "media: could not generate the qBittorrent password hash"; return 0; }
  else
    hashed=$(QB_PASS="$HB_QBIT_PASS" python3 - <<'PY'
import base64, hashlib, os
salt = os.urandom(16)
key = hashlib.pbkdf2_hmac("sha512", os.environ["QB_PASS"].encode(), salt, 100000, 64)
print(f"@ByteArray({base64.b64encode(salt).decode()}:{base64.b64encode(key).decode()})")
PY
    ) || { echo "media: could not generate the qBittorrent password hash"; return 0; }
  fi

  mkdir -p "$(dirname "$QBT_CONF")"
  [ -f "$QBT_CONF" ] || printf '[Preferences]\n' > "$QBT_CONF"
  # A [Preferences] section has to exist for the keys to mean anything; a
  # conf written by qBittorrent itself always has one.
  grep -q '^\[Preferences\]' "$QBT_CONF" || printf '\n[Preferences]\n' >> "$QBT_CONF"

  # Replace rather than append if a username line is already there, so a
  # re-run cannot leave two.
  sed -i '/^WebUI\\Username=/d; /^WebUI\\Password_PBKDF2=/d' "$QBT_CONF"
  sed -i "/^\[Preferences\]/a WebUI\\\\Username=$QBIT_USER\nWebUI\\\\Password_PBKDF2=\"$hashed\"" "$QBT_CONF"

  chown "$PUID:$PGID" "$QBT_CONF" 2>/dev/null || true
  echo "media: seeded the qBittorrent web UI account ($QBIT_USER) — \`homebox secrets media\` prints the password"
}

seed_qbittorrent_login
