#!/usr/bin/env bash
# Hand the agent the hub's public key, so nobody has to go and find it.
#
# Beszel's hub writes an ed25519 keypair to its data directory on first start
# and authenticates agents with it. The normal flow is: open the hub, start
# adding a system, copy the key it shows, paste it into the agent's config.
# But hub and agent are on the SAME box here, and the key is sitting in a file
# this script can read — so read it.
#
# The public half is derived in plain node rather than with ssh-keygen: this
# runs inside the dashboard container on a UI install, and that image has no
# ssh-keygen. A setup script that only works over SSH on the host is a script
# that silently does nothing for everyone who uses the interface.
set -euo pipefail

HB_ROOT="${HB_ROOT:-/opt/homebox}"
ENV_FILE="$HB_ROOT/.env"
HUB_DATA="$HB_ROOT/modules/metrics/config/beszel"
HUB_KEY="$HUB_DATA/id_ed25519"

mkdir -p "$HUB_DATA"

if [ -n "${BESZEL_AGENT_KEY:-}" ]; then
  echo "metrics: agent key already set, leaving it alone"
  exit 0
fi

if [ ! -f "$HUB_KEY" ]; then
  echo "metrics: the hub has not started yet, so its key does not exist."
  echo "metrics: the agent will wait. Once the hub is up, run 'homebox up metrics --yes'"
  echo "metrics: and this script will pick the key up on its own."
  exit 0
fi

pub="$(node -e '
  const fs = require("fs");
  const pem = fs.readFileSync(process.argv[1], "utf8");
  const buf = Buffer.from(pem.replace(/-----(BEGIN|END) OPENSSH PRIVATE KEY-----/g, "").replace(/\s+/g, ""), "base64");
  const magic = "openssh-key-v1\0";
  if (buf.subarray(0, magic.length).toString("binary") !== magic) throw new Error("not an OpenSSH key");
  let off = magic.length;
  const str = () => { const n = buf.readUInt32BE(off); off += 4; const b = buf.subarray(off, off + n); off += n; return b; };
  str(); str(); str();                       // ciphername, kdfname, kdfoptions
  if (buf.readUInt32BE(off) < 1) throw new Error("no public key");
  off += 4;
  const blob = str();
  const n = blob.readUInt32BE(0);
  process.stdout.write(`${blob.subarray(4, 4 + n)} ${blob.toString("base64")}`);
' "$HUB_KEY" 2>/dev/null)" || pub=""

if [ -z "$pub" ]; then
  echo "metrics: could not read the hub key — paste it into Settings instead" >&2
  exit 0
fi

# A key has no newline in it, but .env is line-oriented and a surprise here
# would forge a second setting.
case "$pub" in
  *$'\n'*|*$'\r'*) echo "metrics: derived key is not a single line, refusing to write it" >&2; exit 0 ;;
esac

if grep -q '^BESZEL_AGENT_KEY=' "$ENV_FILE" 2>/dev/null; then
  tmp="$(mktemp)"
  sed "s|^BESZEL_AGENT_KEY=.*|BESZEL_AGENT_KEY=$pub|" "$ENV_FILE" > "$tmp"
  cat "$tmp" > "$ENV_FILE"
  rm -f "$tmp"
else
  printf 'BESZEL_AGENT_KEY=%s\n' "$pub" >> "$ENV_FILE"
fi

echo "metrics: took the agent key from the hub — ${pub%% *} ...${pub##*[[:space:]]}" | cut -c1-90
