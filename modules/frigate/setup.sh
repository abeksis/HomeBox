#!/usr/bin/env bash
# Give Frigate a config it can start with.
#
# Frigate refuses to boot without /config/config.yml, and the error it prints
# is a schema validation dump rather than "there is no config file" — so a
# fresh install looks broken rather than unconfigured. Write a valid minimal
# one instead, with the camera block commented out and ready to fill in.
#
# Never overwrites: once you have configured cameras, this file is yours.
set -euo pipefail

HB_ROOT="${HB_ROOT:-/opt/homebox}"
CONFIG_DIR="$HB_ROOT/modules/frigate/config/frigate"
CONFIG="$CONFIG_DIR/config.yml"

mkdir -p "$CONFIG_DIR"

# The recordings folder on the pool, so the first start does not fail on a
# missing path when the media root is a network mount.
MEDIA_ROOT="${HB_MEDIA_ROOT:-${HB_DATA_DIR:-$HB_ROOT/data}}"
mkdir -p "$MEDIA_ROOT/${HB_FRIGATE_DIR:-frigate}" 2>/dev/null || true

if [ -f "$CONFIG" ]; then
  echo "frigate: config.yml already present, leaving it alone"
  exit 0
fi

cat > "$CONFIG" <<'YAML'
# Written by HomeBox at install. Frigate will not start without this file.
#
# It is deliberately camera-less: Frigate runs, the UI opens, and you add
# cameras below. A camera block needs the RTSP URL your camera actually
# serves — check the manufacturer's documentation or the camera's own web
# page, they are all different.
mqtt:
  # Off unless you have a broker. Home Assistant integrates through MQTT,
  # so turn this on once one exists.
  enabled: false

detectors:
  cpu1:
    type: cpu
    # CPU detection costs roughly a core per camera. A Coral TPU replaces
    # this block with `type: edgetpu` and makes the cost disappear.
    num_threads: 3

record:
  enabled: true
  retain:
    days: 7
    mode: motion
  alerts:
    retain:
      days: 30
  detections:
    retain:
      days: 30

snapshots:
  enabled: true
  retain:
    default: 30

objects:
  # What is worth telling you about. Adding every COCO class here is how you
  # get an alert every time a bird crosses the garden.
  track:
    - person
    - car
    - dog
    - cat

# cameras:
#   front_door:
#     ffmpeg:
#       inputs:
#         # The SUB stream, for detection: low resolution is enough to decide
#         # something is a person, and cheap to decode.
#         - path: rtsp://user:password@192.168.1.50:554/stream2
#           roles:
#             - detect
#         # The MAIN stream, for what actually gets recorded.
#         - path: rtsp://user:password@192.168.1.50:554/stream1
#           roles:
#             - record
#     detect:
#       width: 640
#       height: 360
#       fps: 5

version: 0.17-0
YAML

chown -R "${PUID:-1000}:${PGID:-1000}" "$CONFIG_DIR" 2>/dev/null || true

echo "frigate: wrote a starting config.yml — add cameras to it, then restart"
