#!/usr/bin/env bash
# 0.2.0 — put HB_VERSION in .env.
#
# modules/dashboard/docker-compose.yml has always read
# `image: homebox-dashboard:${HB_VERSION:-local}`, and nothing has ever set
# HB_VERSION. So every box built every dashboard as `:local`, and each build
# overwrote the last.
#
# That is fine until the first rollback, at which point it is the whole
# problem: the build for a new release DESTROYS the image the old release was
# running — the exact image a rollback needs. Rolling back then means
# rebuilding, on a box where a build has just failed, possibly with no network.
#
# With this set, 0.2.0 builds `:0.2.0`, the 0.1.0 image stays on disk, and
# going back is a retag and a restart.
#
# install.sh writes this too, on every run. This migration exists so a box that
# updates without a full install.sh pass still gets it, and because the first
# migration ought to be one whose effect is easy to see.
set -euo pipefail

HB_ROOT="${HB_ROOT:-/opt/homebox}"
ENV_FILE="$HB_ROOT/.env"
VERSION="$(cat "$HB_ROOT/VERSION" 2>/dev/null || echo 0.0.0)"

[ -f "$ENV_FILE" ] || { echo "0.2.0: no .env at $ENV_FILE" >&2; exit 1; }

# The end-state test. A resumed update re-runs whatever was in flight, so every
# migration has to be able to look at the box and decide it is already done.
current="$(grep -m1 '^HB_VERSION=' "$ENV_FILE" 2>/dev/null | cut -d= -f2- || true)"
if [ "$current" = "$VERSION" ]; then
  echo "0.2.0: HB_VERSION is already $VERSION"
  exit 0
fi

if grep -q '^HB_VERSION=' "$ENV_FILE" 2>/dev/null; then
  tmp="$ENV_FILE.tmp-$$"
  sed "s|^HB_VERSION=.*|HB_VERSION=${VERSION}|" "$ENV_FILE" > "$tmp"
  cat "$tmp" > "$ENV_FILE"
  rm -f "$tmp"
else
  printf 'HB_VERSION=%s\n' "$VERSION" >> "$ENV_FILE"
fi

# .env holds every secret on the box; a migration must not widen it.
chmod 600 "$ENV_FILE"

echo "0.2.0: HB_VERSION=$VERSION"
