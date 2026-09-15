#!/usr/bin/env bash
# Generate Synapse's config, and Element's, before the first start.
#
# Synapse will not start without homeserver.yaml, and that file contains a
# SIGNING KEY that is the server's identity — every room it joins trusts that
# key. It has to be generated once and then never lost, which is why Synapse
# ships a `generate` mode rather than shipping a default config: a shared
# default key would mean every install on earth could impersonate every other.
#
# So ask Synapse to make its own, the same approach the Authelia module takes
# with its password hash. `docker run` works here because this script runs
# either on the host or inside the dashboard container, and that container has
# the docker CLI and the socket.
#
# The server name is refused when empty rather than defaulted. It is baked
# into every user ID (@you:example.com) and every room this server takes part
# in; a wrong one is not a setting you change later, it is a rebuild.
set -euo pipefail

HB_ROOT="${HB_ROOT:-/opt/homebox}"
CONFIG_DIR="$HB_ROOT/modules/matrix/config"
SYNAPSE_DIR="$CONFIG_DIR/synapse"
ELEMENT_CONFIG="$CONFIG_DIR/element/config.json"
IMAGE="matrixdotorg/synapse:v1.156.0"

mkdir -p "$SYNAPSE_DIR" "$CONFIG_DIR/element"

if [ -z "${MATRIX_SERVER_NAME:-}" ]; then
  cat >&2 <<'MSG'
matrix: no server name set, and this is the one thing that cannot be changed
later.

The server name becomes part of every user ID and every room this server
joins. Renaming it afterwards is not a setting — it is a new server and a
migration of everything on it.

  1. Settings -> Configuration -> Matrix -> Server name
       the domain your users will be @name:HERE, e.g. example.com
  2. Install this app again

It does not have to be reachable from outside to work on your own network.
It does have to be the name you intend to keep.
MSG
  exit 1
fi

if [ -f "$SYNAPSE_DIR/homeserver.yaml" ]; then
  echo "matrix: homeserver.yaml already present, leaving it and the signing key alone"
else
  docker run --rm \
    -e SYNAPSE_SERVER_NAME="$MATRIX_SERVER_NAME" \
    -e SYNAPSE_REPORT_STATS=no \
    -e UID="${PUID:-1000}" \
    -e GID="${PGID:-1000}" \
    -v "$SYNAPSE_DIR:/data" \
    "$IMAGE" generate >/dev/null 2>&1 \
    || { echo "matrix: synapse could not generate its config — is the docker socket reachable?" >&2; exit 1; }

  [ -f "$SYNAPSE_DIR/homeserver.yaml" ] \
    || { echo "matrix: generate ran but produced no homeserver.yaml" >&2; exit 1; }

  # Point it at the Postgres beside it.
  #
  # `generate` always writes a SQLite database block, which Synapse itself
  # documents as unsuitable for anything but a test server. Replacing it has
  # to work with tools that exist in EVERY environment this runs in, which
  # rules out python3: present on the host, absent from the dashboard
  # container, where most installs happen.
  #
  # A conf.d override was tried first and is a trap. The image runs synapse
  # with --config-path pointing at homeserver.yaml alone, so conf.d is never
  # read. Synapse came up on SQLite, answered 200, reported healthy, and left
  # the Postgres beside it holding zero tables. It was only caught by
  # installing it that way and counting the tables.
  #
  # So rewrite the block itself, with awk.
  awk -v pw="${MATRIX_DB_PASSWORD:-synapse}" '
    # Drop the generated database block: from a line starting `database:` at
    # column 0, until the next key at column 0.
    /^database:/ { skip = 1; next }
    skip && /^[^[:space:]#]/ { skip = 0 }
    skip { next }
    { print }
    END {
      print ""
      print "database:"
      print "  name: psycopg2"
      print "  args:"
      print "    user: synapse"
      print "    password: \"" pw "\""
      print "    dbname: synapse"
      print "    host: matrix-db"
      print "    port: 5432"
      print "    cp_min: 5"
      print "    cp_max: 10"
    }
  ' "$SYNAPSE_DIR/homeserver.yaml" > "$SYNAPSE_DIR/homeserver.yaml.new"

  if ! grep -q 'psycopg2' "$SYNAPSE_DIR/homeserver.yaml.new"; then
    rm -f "$SYNAPSE_DIR/homeserver.yaml.new"
    echo "matrix: could not rewrite the database block, refusing to start on SQLite" >&2
    exit 1
  fi
  mv "$SYNAPSE_DIR/homeserver.yaml.new" "$SYNAPSE_DIR/homeserver.yaml"

  echo "matrix: generated homeserver.yaml and a signing key for $MATRIX_SERVER_NAME"
  echo "matrix: back up ${SYNAPSE_DIR}/*.signing.key — without it this server cannot be restored"
fi

if [ -f "$ELEMENT_CONFIG" ]; then
  echo "matrix: element config.json already present, leaving it alone"
else
  cat > "$ELEMENT_CONFIG" <<JSON
{
  "default_server_config": {
    "m.homeserver": {
      "base_url": "${MATRIX_URL:-http://${HB_HOST_ADDRESS:-localhost}:8448}",
      "server_name": "${MATRIX_SERVER_NAME}"
    }
  },
  "brand": "Matrix",
  "disable_custom_urls": false,
  "disable_guests": true,
  "default_theme": "dark"
}
JSON
  echo "matrix: wrote element config.json"
fi

chown -R "${PUID:-1000}:${PGID:-1000}" "$CONFIG_DIR" 2>/dev/null || true
