#!/usr/bin/env bash
# Put Headscale's three config files in place before the first start.
#
# All three are bind-mounted as FILES, not directories. Docker's rule for a
# bind mount whose host path does not exist is to create it — as a DIRECTORY.
# So a missing config.yaml does not fail with "no such file": it silently
# becomes a folder, and headscale then reports
#
#   Error initializing: read /etc/headscale/config.yaml: is a directory
#
# in a crash loop, with a mount that now has to be deleted by hand before any
# later fix can work. Writing them here is what prevents that.
#
# Every write is guarded: this runs on install AND on every update, and
# config.yaml in particular is a file somebody edits. Overwriting it would
# throw away a server_url, and changing server_url makes every enrolled
# device a stranger.
set -euo pipefail

HB_ROOT="${HB_ROOT:-/opt/homebox}"
CONF="$HB_ROOT/modules/headscale/config"

mkdir -p "$CONF/data"

if [ ! -f "$CONF/config.yaml" ]; then
  cat > "$CONF/config.yaml" <<'YAML'
# server_url is written into every client when it enrols, so it must be the
# address they can reach from OUTSIDE, over HTTPS with a real certificate.
# Change it before enrolling anything; changing it after means every device
# logs in again.
server_url: https://headscale.example.com
listen_addr: 0.0.0.0:8080
metrics_listen_addr: 127.0.0.1:9090
grpc_listen_addr: 127.0.0.1:50443
grpc_allow_insecure: false

noise:
  # This key is the server's identity. Lose it and every enrolled device is a
  # stranger, no matter what the database still says.
  private_key_path: /var/lib/headscale/noise_private.key

prefixes:
  v4: 100.64.0.0/10
  v6: fd7a:115c:a1e0::/48
  allocation: sequential

derp:
  server:
    enabled: false
  urls:
    - https://controlplane.tailscale.com/derpmap/default
  paths: []
  auto_update_enabled: true
  update_frequency: 24h

disable_check_updates: false
node:
  ephemeral:
    inactivity_timeout: 30m

database:
  type: sqlite
  debug: false
  gorm:
    prepare_stmt: true
    parameterized_queries: true
    skip_err_record_not_found: true
    slow_threshold: 1000
  sqlite:
    path: /var/lib/headscale/db.sqlite
    write_ahead_log: true
    wal_autocheckpoint: 1000

tls_letsencrypt_hostname: ""
tls_cert_path: ""
tls_key_path: ""

log:
  level: info
  format: text

policy:
  mode: database

dns:
  magic_dns: false
  base_domain: ""
  override_local_dns: true
  nameservers:
    global:
      - 1.1.1.1
      - 1.0.0.1
  search_domains: []
  extra_records: []
YAML
  echo "headscale: wrote a starting config.yaml — set server_url before enrolling devices"
fi

# The proxy config is HomeBox's, not the user's: it wires two containers
# together and there is nothing in it to tune. Rewritten every time so a
# module update can fix it.
cat > "$CONF/nginx.conf" <<'NGINX'
events {}

http {
  map $http_upgrade $connection_upgrade {
    default upgrade;
    '' close;
  }

  # The UI sends its API key as a bare `hskey-api-...`; headscale wants a
  # Bearer token. Rewriting it here is what lets the stock UI talk to the
  # stock server without patching either one.
  map $http_authorization $headscale_authorization {
    default "";
    "~*^Bearer\s+.+$" $http_authorization;
    "~*^hskey-api-.+$" "Bearer $http_authorization";
  }

  server {
    listen 8080;
    server_name _;
    absolute_redirect off;

    location = /web {
      return 302 /web/;
    }

    location /web/ {
      proxy_pass http://headscale-ui:8080;
      proxy_http_version 1.1;
      # The UI is served gzipped, and sub_filter cannot rewrite bytes it
      # cannot read. Asking for it uncompressed is what makes the injection
      # below actually happen.
      proxy_set_header Accept-Encoding "";
      proxy_set_header Host $host;
      proxy_set_header X-Real-IP $remote_addr;
      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
      proxy_set_header X-Forwarded-Proto $scheme;
      sub_filter_once off;
      sub_filter_types text/html;
      sub_filter '</head>' '<script src="/web/custom-patch.js"></script></head>';
    }

    location = /web/custom-patch.js {
      default_type application/javascript;
      alias /etc/nginx/custom-patch.js;
    }

    location / {
      proxy_pass http://headscale:8080;
      proxy_http_version 1.1;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection $connection_upgrade;
      proxy_set_header Authorization $headscale_authorization;
      proxy_set_header Host $host;
      proxy_set_header X-Real-IP $remote_addr;
      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
      proxy_set_header X-Forwarded-Proto $scheme;
      # Tailscale clients hold a long-poll open on /machine/map. Buffering it
      # means the box only hears about a device minutes after it changed.
      proxy_buffering off;
    }
  }
}
NGINX

# The UI shows a new pre-auth key once and then masks it forever. Anyone who
# looked away has to delete it and make another. This copies it to the
# clipboard and says it out loud instead.
cat > "$CONF/custom-patch.js" <<'JS'
(function () {
  const originalFetch = window.fetch.bind(window);

  window.fetch = async function patchedFetch(input, init) {
    const response = await originalFetch(input, init);

    try {
      const requestUrl = typeof input === 'string' ? input : input && input.url ? input.url : '';
      const method = (init && init.method ? init.method : 'GET').toUpperCase();

      if (method === 'POST' && requestUrl.includes('/api/v1/preauthkey') && response.ok) {
        const cloned = response.clone();
        const data = await cloned.json();
        const key = data && data.preAuthKey && data.preAuthKey.key;

        if (key && !key.includes('***')) {
          try {
            await navigator.clipboard.writeText(key);
          } catch (error) {
          }

          window.setTimeout(function () {
            window.alert('PreAuth Key created and copied to clipboard:\n\n' + key);
          }, 50);
        }
      }
    } catch (error) {
    }

    return response;
  };
})();
JS

chmod 600 "$CONF/config.yaml"
echo "headscale: config in place at $CONF"
