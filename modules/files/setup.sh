#!/usr/bin/env bash
# Seed File Browser's config before its first start.
#
# The Quantum image reads config.yaml at boot and does not write one for you:
# without this file it starts with no source configured and shows an empty
# tree. Run by `homebox up files` before compose, and safe to re-run — it
# only writes the file when it is missing.
set -euo pipefail

HB_ROOT="${HB_ROOT:-/opt/homebox}"
CONFIG_DIR="$HB_ROOT/modules/files/config/filebrowser"
CONFIG="$CONFIG_DIR/config.yaml"

mkdir -p "$CONFIG_DIR/data"

if [ -f "$CONFIG" ]; then
  echo "files: config.yaml already present, leaving it alone"
  exit 0
fi

cat > "$CONFIG" <<'YAML'
server:
  port: 80
  baseURL: "/"
  # /folder is the whole HomeBox data pool, bind-mounted by the compose file.
  sources:
    - path: "/folder"
      name: "HomeBox"
      config:
        defaultEnabled: true
        createUserDir: false
auth:
  adminUsername: admin
  methods:
    password:
      enabled: true
      minLength: 8
userDefaults:
  darkMode: true
  disableSettings: false
  singleClick: false
  permissions:
    admin: false
    modify: true
    share: true
YAML

echo "files: wrote $CONFIG"
