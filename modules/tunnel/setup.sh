#!/usr/bin/env bash
# Refuse to start a tunnel that has nothing to connect with.
#
# cloudflared given an empty TUNNEL_TOKEN does not fail loudly — it exits,
# `restart: always` brings it back, and the module sits in a crash loop whose
# only trace is a line in a log nobody has opened yet. The user sees an app
# that "installed fine" and does not work. Same shape as the blank WG_HOST
# crash loop in the VPN module.
#
# So check first. An install that stops here with a sentence explaining what
# to paste and where is a better outcome than a container that keeps trying.
set -euo pipefail

if [ -z "${CLOUDFLARE_TUNNEL_TOKEN:-}" ]; then
  cat >&2 <<'MSG'
tunnel: no token yet, so there is nothing to connect to.

Cloudflare issues the token; HomeBox cannot generate it. To get one:

  1. one.dash.cloudflare.com -> Networks -> Tunnels -> Create a tunnel
  2. Pick "Cloudflared", name it, and copy the token out of the install
     command it shows you (the long string after --token)
  3. Paste it into HomeBox: Settings -> Configuration -> Cloudflare Tunnel
  4. Install this app again

Then add a Public Hostname in that same Cloudflare page pointing at the app
you want to reach, using its CONTAINER name and internal port -- for example
http://vaultwarden:80 -- not the LAN address.
MSG
  exit 1
fi

echo "tunnel: token present, cloudflared will dial out on start"
