#!/usr/bin/env bash
# Make the data directory writable by the user Navidrome runs as.
#
# Docker creates a bind mount's host directory as root when it does not
# already exist. Navidrome runs under `user: PUID:PGID` and, unlike the
# linuxserver images, has no s6 init that chowns its own directories — so it
# starts, cannot create its database inside a root-owned folder, and exits:
#
#   level=fatal msg="Database could not be opened!"
#   error="unable to open database file: no such file or directory"
#
# which reads like a missing path rather than a permissions problem. With
# restart: always that becomes a crash loop whose cause is one line above the
# part anyone reads.
#
# Create the directory here instead, owned by the right user, before the first
# start. Safe to re-run: chown on an already-correct directory is a no-op.
set -euo pipefail

HB_ROOT="${HB_ROOT:-/opt/homebox}"
DATA_DIR="$HB_ROOT/modules/navidrome/config/navidrome"

mkdir -p "$DATA_DIR"
chown -R "${PUID:-1000}:${PGID:-1000}" "$DATA_DIR"

echo "navidrome: data directory owned by ${PUID:-1000}:${PGID:-1000}"
