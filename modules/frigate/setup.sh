#!/usr/bin/env bash
# Give Frigate a config to start from.
#
# Frigate will not boot without /config/config.yml, and prints a schema
# validation dump rather than "there is no config file" — so a fresh install
# looks broken rather than unconfigured.
#
# What this CANNOT do is produce a fully valid config, and that is worth being
# straight about: `cameras` is a required field in 0.17, so a camera-less
# config fails validation no matter how it is written. Frigate then starts in
# SAFE MODE — it serves the UI, answers 200 and reports healthy, while running
# on defaults. Tested here: the settings below were silently ignored and the
# API reported Frigate's own.
#
# That is the right outcome anyway. Safe mode exists so you can reach the
# built-in config editor and add a camera, which is the one thing nothing on
# this box can do for you: only you know the RTSP URL. The file below is
# therefore a starting point to edit, not a working configuration.
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
  # 0.17 has no record.retain. Retention is per mode, and the schema the
  # running app publishes at /api/config/schema.json is the authority:
  #   continuous / motion -> { days }
  #   alerts / detections -> { pre_capture, post_capture, retain: { days } }
  # An unknown key here is rejected outright, not ignored.
  continuous:
    days: 0
  motion:
    days: 7
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

cat <<'MSG'
frigate: wrote a starting config.yml.
frigate: it declares no cameras, and `cameras` is a required field — so
frigate: Frigate starts in SAFE MODE and runs on its own defaults until you
frigate: add one. That is expected, not a failure: safe mode serves the UI so
frigate: you can use its config editor. Add a camera there and restart the app.
MSG
