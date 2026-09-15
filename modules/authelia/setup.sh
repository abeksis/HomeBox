#!/usr/bin/env bash
# Write Authelia's configuration and its first user.
#
# Two things need doing before Authelia can start, and neither is something
# the image does for you:
#
#   1. configuration.yml. Authelia refuses to boot without one, and the file
#      needs a cookie DOMAIN — which is why this stops when Domain is unset
#      rather than writing a config that cannot work. Session cookies are
#      scoped to a domain; on a bare IP the browser will not keep them, and
#      the result is a login page that accepts your password and then returns
#      you to the login page, forever.
#
#   2. users_database.yml, with an argon2id hash. Authelia's own binary is the
#      thing that knows how to produce one, so ask it — the same approach the
#      VPN module takes with wg-easy's `wgpw` rather than reimplementing
#      bcrypt. `docker run` works here because this script runs either on the
#      host or inside the dashboard container, and that container has the
#      docker CLI and the socket.
#
# Safe to re-run: an existing configuration.yml or users_database.yml is left
# exactly as it is, so edits you make by hand survive a reinstall.
set -euo pipefail

HB_ROOT="${HB_ROOT:-/opt/homebox}"
CONFIG_DIR="$HB_ROOT/modules/authelia/config/authelia"
CONFIG="$CONFIG_DIR/configuration.yml"
USERS="$CONFIG_DIR/users_database.yml"
IMAGE="authelia/authelia:4.39.20"

mkdir -p "$CONFIG_DIR"

if [ -z "${AUTHELIA_DOMAIN:-}" ]; then
  cat >&2 <<'MSG'
authelia: no cookie domain set, so there is nothing it could protect.

Authelia scopes its session cookie to a domain. On an IP address the
browser will not store that cookie, and every login bounces straight back
to the login page with no error to explain it.

  1. Settings -> Configuration -> Authelia -> Cookie domain
       the domain your apps live under, e.g. example.com
  2. Public URL
       where Authelia itself answers, e.g. https://auth.example.com
  3. Install this app again

Both of those need to resolve to this box before it will do anything
useful, through the proxy or a tunnel.
MSG
  exit 1
fi

if [ -f "$CONFIG" ]; then
  echo "authelia: configuration.yml already present, leaving it alone"
else
  cat > "$CONFIG" <<YAML
# Written by HomeBox at install. Edit freely — it is never rewritten.
#
# Secrets are NOT here. They come from the environment
# (AUTHELIA_SESSION_SECRET and friends) so this file stays readable.
theme: dark

server:
  address: 'tcp://0.0.0.0:9091'

log:
  level: info

totp:
  issuer: '${AUTHELIA_DOMAIN}'

authentication_backend:
  password_reset:
    disable: false
  file:
    path: /config/users_database.yml
    password:
      algorithm: argon2

access_control:
  # Everything behind this gateway asks for a password and a second factor.
  # Loosen it per-domain here once you know what you are protecting.
  default_policy: two_factor

session:
  name: authelia_session
  expiration: 12h
  inactivity: 45m
  cookies:
    - domain: '${AUTHELIA_DOMAIN}'
      authelia_url: '${AUTHELIA_URL:-https://auth.${AUTHELIA_DOMAIN}}'

regulation:
  # Three wrong passwords in two minutes locks that account out for five.
  max_retries: 3
  find_time: 2m
  ban_time: 5m

storage:
  local:
    path: /config/db.sqlite3

notifier:
  # No mail server configured, so password resets and 2FA enrolment links are
  # written to this file instead of being sent. Read it with:
  #   homebox logs authelia   (or open the file directly)
  filesystem:
    filename: /config/notification.txt
YAML
  echo "authelia: wrote configuration.yml for ${AUTHELIA_DOMAIN}"
fi

if [ -f "$USERS" ]; then
  echo "authelia: users_database.yml already present, leaving it alone"
  exit 0
fi

password="${AUTHELIA_ADMIN_PASSWORD:-}"
if [ -z "$password" ]; then
  echo "authelia: no admin password generated yet, skipping the user database" >&2
  exit 0
fi

# Authelia hashes its own passwords. Anything else here would be a guess at
# argon2id parameters that its verifier has to agree with exactly.
hash="$(docker run --rm "$IMAGE" \
  authelia crypto hash generate argon2 --password "$password" 2>/dev/null \
  | sed -n 's/^Digest: //p')"

if [ -z "$hash" ]; then
  echo "authelia: could not generate a password hash — is the docker socket reachable?" >&2
  exit 1
fi

cat > "$USERS" <<YAML
# Written by HomeBox at install. Add people by copying the block below.
# Generate a hash with:
#   docker run --rm ${IMAGE} authelia crypto hash generate argon2 --password 'theirs'
users:
  admin:
    disabled: false
    displayname: 'Administrator'
    password: '${hash}'
    email: 'admin@${AUTHELIA_DOMAIN}'
    groups:
      - 'admins'
YAML

chown -R "${PUID:-1000}:${PGID:-1000}" "$CONFIG_DIR" 2>/dev/null || true
chmod 600 "$USERS"

echo "authelia: created the admin user — 'homebox secrets authelia' prints the password"
