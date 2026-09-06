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
