#!/usr/bin/env bash
# ==========================================================================
# HomeBox installer — turns a clean Debian box into a HomeBox host.
#
#   curl -fsSL .../install.sh | bash      (or just: sudo bash install.sh)
#
# It installs Docker, lays out /opt/homebox, generates the secrets every
# module needs, creates the networks, and brings up core + dashboard. It is
# idempotent: run it again after an upgrade and it repairs what is missing
# without touching what already works.
# ==========================================================================
set -euo pipefail

# This script is meant to be piped from curl into a root shell, so there is no
# controlling terminal. Without this, debconf tries Dialog, then Readline, then
# Teletype, printing a paragraph of failure for each before it settles on
# Noninteractive — which looks like something went wrong on a first install.
export DEBIAN_FRONTEND=noninteractive

HB_ROOT="${HB_ROOT:-/opt/homebox}"
HB_USER="${HB_USER:-${SUDO_USER:-$(id -un)}}"
ENV_FILE="$HB_ROOT/.env"

if [ -t 1 ]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GREEN=$'\033[32m'
  YELLOW=$'\033[33m'; RESET=$'\033[0m'
else
  BOLD=''; DIM=''; RED=''; GREEN=''; YELLOW=''; RESET=''
fi

# One prefix on every line this script writes, so its own words stay
# distinguishable from the output of apt, docker and compose running underneath.
say()  { printf '%s[HomeBox]%s %s\n' "$GREEN" "$RESET" "$*"; }
step() { printf '\n%s[HomeBox]%s %s%s%s\n' "$GREEN" "$RESET" "$BOLD" "$*" "$RESET"; }
warn() { printf '%s[HomeBox]%s %s%s%s\n' "$YELLOW" "$RESET" "$YELLOW" "$*" "$RESET"; }
die()  { printf '%s[HomeBox]%s %s%s%s\n' "$RED" "$RESET" "$RED" "$*" "$RESET" >&2; exit 1; }
rule() { printf '%s============================================================%s\n' "$DIM" "$RESET"; }

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  command -v sudo >/dev/null 2>&1 || die "run as root, or install sudo"
  SUDO="sudo"
fi

# --------------------------------------------------------------- 1. checks

. /etc/os-release 2>/dev/null || die "cannot read /etc/os-release"

# Everything worth knowing before anything is changed, in one block. Read it
# and you know what this machine is and what is about to happen to it, which
# is the moment to stop if the answer is not what you expected.
hardware() {
  local virt; virt="$(systemd-detect-virt 2>/dev/null || echo none)"
  case "$virt" in
    none) printf 'bare metal' ;;
    kvm|qemu) printf 'virtual machine (%s)' "$virt" ;;
    docker|lxc|podman) printf 'container (%s), unusual for this' "$virt" ;;
    *) printf '%s' "$virt" ;;
  esac
}
clock() {
  case "$(timedatectl show -p NTPSynchronized --value 2>/dev/null)" in
    yes) printf 'in sync' ;;
    no)  printf 'NOT synchronised: certificates and 2FA will misbehave' ;;
    *)   printf 'unknown (no timedatectl)' ;;
  esac
}

# Every value is computed here rather than inside the heredoc below.
# A command substitution in an unquoted heredoc needs its `$` escaped for
# the shell but not for awk, and getting that backwards sends a literal
# backslash to awk — which blanked the memory and disk rows while printing
# an error nobody would connect to a layout string.
PF_SYS="${PRETTY_NAME:-unknown} ($(uname -m))"
PF_HW="$(hardware)"
PF_CPU="$(nproc) cores"
PF_MEM="$(free -h | awk "/^Mem:/{print \$2}")"
PF_PARENT="$(dirname "$HB_ROOT")"
PF_DISK="$(df -h "$PF_PARENT" | awk "NR==2{print \$4}")"
PF_TZ="$(timedatectl show -p Timezone --value 2>/dev/null || echo unknown)"
PF_CLOCK="$(clock)"
if [ -f "$ENV_FILE" ]; then
  PF_MODE='repair — existing install, secrets are kept'
else
  PF_MODE='fresh install'
fi

echo
rule
printf '  %sPREFLIGHT%s  what I found on this machine\n' "$BOLD" "$RESET"
rule
printf '  %-13s %s\n' "System:"     "$PF_SYS"
printf '  %-13s %s\n' "Hardware:"   "$PF_HW"
printf '  %-13s %s, %s\n' "Resources:" "$PF_CPU" "$PF_MEM"
printf '  %-13s %s free at %s\n' "Disk:" "$PF_DISK" "$PF_PARENT"
printf '  %-13s %s\n' "Install to:" "$HB_ROOT"
printf '  %-13s %s\n' "Runs as:"    "$HB_USER"
printf '  %-13s %s\n' "Timezone:"   "$PF_TZ"
printf '  %-13s %s\n' "Clock:"      "$PF_CLOCK"
printf '  %-13s %s\n' "Mode:"       "$PF_MODE"
rule

case "${ID:-}" in
  debian|ubuntu) ;;
  *) warn "only Debian and Ubuntu are tested, continuing anyway" ;;
esac

# 4GB is where the default module set stops being comfortable. Not a refusal:
# a box running only the dashboard and a DNS blocker is fine on less.
MEM_MB="$(awk '/^MemTotal:/{printf "%d", $2/1024}' /proc/meminfo 2>/dev/null || echo 0)"
if [ "$MEM_MB" -gt 0 ] && [ "$MEM_MB" -lt 3500 ]; then
  warn "${MEM_MB}MB of RAM: 4GB+ is recommended once you install more than a couple of modules"
fi

# --------------------------------------------------------------- 2. docker

install_docker() {
  step "Installing Docker"
  $SUDO apt-get update -qq
  $SUDO apt-get install -y -qq ca-certificates curl gnupg >/dev/null

  $SUDO install -m 0755 -d /etc/apt/keyrings
  if [ ! -f /etc/apt/keyrings/docker.asc ]; then
    $SUDO curl -fsSL "https://download.docker.com/linux/${ID}/gpg" -o /etc/apt/keyrings/docker.asc
    $SUDO chmod a+r /etc/apt/keyrings/docker.asc
  fi

  local codename="${VERSION_CODENAME:-}"
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/${ID} ${codename} stable" \
    | $SUDO tee /etc/apt/sources.list.d/docker.list >/dev/null

  if ! $SUDO apt-get update -qq 2>/dev/null; then
    # Docker had not published for this release yet — Debian's own packages
    # are a working engine plus the v2 compose plugin, just older.
    warn "Docker has no repository for ${ID} ${codename}; falling back to the distribution packages"
    $SUDO rm -f /etc/apt/sources.list.d/docker.list
    $SUDO apt-get update -qq
    $SUDO apt-get install -y -qq docker.io docker-compose-v2 >/dev/null
    return
  fi

  $SUDO apt-get install -y -qq docker-ce docker-ce-cli containerd.io \
    docker-buildx-plugin docker-compose-plugin >/dev/null
}

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  step "Docker already present"
  printf '  %s\n' "$(docker --version)"
  printf '  %s\n' "$(docker compose version)"
else
  install_docker
fi

$SUDO systemctl enable --now docker >/dev/null 2>&1 || true
docker info >/dev/null 2>&1 || $SUDO docker info >/dev/null 2>&1 || die "docker installed but the daemon is not running"

# Running docker without sudo is the difference between the CLI being
# pleasant and every command needing a password.
# No pipe here on purpose: `grep -q` closes the pipe on its first match, which
# SIGPIPEs `tr`, and under the `pipefail` at the top of this file the condition
# then reports 141 whether or not the user is already in the group — so this
# would announce and re-run usermod on every install. Harmless in itself, but
# it is the same trap that made rand() abort the script outright.
case " $(id -nG "$HB_USER") " in
  *" docker "*) ;;
  *)
    step "Adding $HB_USER to the docker group"
    $SUDO usermod -aG docker "$HB_USER"
    warn "log out and back in (or run: newgrp docker) before docker works without sudo"
    ;;
esac

# ----------------------------------------------------------------- 3. node

# The CLI reads module metadata through the same parser the dashboard uses,
# which is JavaScript. Node on the host keeps the two from ever disagreeing.
if ! command -v node >/dev/null 2>&1; then
  step "Installing Node.js (for the homebox CLI)"
  $SUDO apt-get install -y -qq nodejs >/dev/null
fi
printf '  node      %s\n' "$(node --version 2>/dev/null || echo MISSING)"

# ----------------------------------------------------------------- 4. tree

step "Laying out $HB_ROOT"
$SUDO mkdir -p \
  "$HB_ROOT"/{modules,dashboard,scripts,state,docs,backups} \
  "$HB_ROOT"/data/{media/movies,media/tv,music,books,photos,downloads} \
  "$HB_ROOT"/modules/core/config/{npm/data,npm/letsencrypt,portainer}

$SUDO chown -R "$HB_USER:$HB_USER" "$HB_ROOT"
printf '  %s\n' "$HB_ROOT"

# ------------------------------------------------------------------ 5. env

# openssl is not guaranteed present; /dev/urandom always is.
#
# Read a BOUNDED chunk and trim in the shell, rather than the usual
# `tr -dc ... </dev/urandom | head -c N`. That idiom has `head` close the pipe
# the moment it has enough, which kills `tr` with SIGPIPE — and under the
# `set -o pipefail` at the top of this file the pipeline then reports 141 and
# `set -e` aborts the install at the first secret it generates. Here `head`
# reads a fixed amount and exits, `tr` reaches EOF normally, and nothing is
# killed. 16 bytes per character wanted leaves ~3.9x more than needed after
# filtering to [A-Za-z0-9]; the loop covers the rest.
rand() {
  local want="${1:-32}" pool=''
  while [ "${#pool}" -lt "$want" ]; do
    pool="$pool$(head -c "$((want * 16))" /dev/urandom | LC_ALL=C tr -dc 'A-Za-z0-9')"
  done
  printf '%s' "${pool:0:want}"
}

set_env() {
  local key="$1" value="$2"
  if grep -q "^${key}=" "$ENV_FILE" 2>/dev/null; then
    # Already set — never regenerate a secret an app has already used to
    # encrypt something, or that data becomes unreadable.
    return
  fi
  printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
}

step "Generating $ENV_FILE"
if [ ! -f "$ENV_FILE" ]; then
  : > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
fi

set_env HB_ROOT "$HB_ROOT"
set_env HB_DATA_DIR "$HB_ROOT/data"
set_env HB_HOST_ADDRESS "$(hostname -I 2>/dev/null | awk '{print $1}')"
# /etc/timezone does not exist on a systemd box (the timezone is the target
# of the /etc/localtime symlink), so reading it silently yields UTC and every
# container inherits a clock three hours off. Ask systemd first.
detect_tz() {
  local tz=""
  command -v timedatectl >/dev/null 2>&1 && tz="$(timedatectl show -p Timezone --value 2>/dev/null)"
  [ -z "$tz" ] && [ -f /etc/timezone ] && tz="$(cat /etc/timezone)"
  [ -z "$tz" ] && [ -L /etc/localtime ] && tz="$(readlink -f /etc/localtime | sed "s#.*/zoneinfo/##")"
  echo "${tz:-UTC}"
}
HB_TZ="$(detect_tz)"
set_env TZ "$HB_TZ"
case "$HB_TZ" in
  UTC|Etc/UTC)
    warn "timezone is $HB_TZ - container logs will be in UTC."
    warn "Set it with: sudo timedatectl set-timezone Area/City, then re-run this script."
    ;;
esac
set_env PUID "$(id -u "$HB_USER")"
set_env PGID "$(id -g "$HB_USER")"

# Media paths, blank by default so each falls back under the pool. Settings
# -> Server Config -> Advanced points them at real storage. Keep them on one
# filesystem: a hardlink cannot cross a mount point, so split them across
# disks and every finished download is copied instead of linked.
set_env HB_MEDIA_MOVIES ""
set_env HB_MEDIA_TV ""
set_env HB_MEDIA_MUSIC ""
set_env HB_MEDIA_BOOKS ""
set_env HB_MEDIA_PHOTOS ""
set_env HB_DOWNLOADS ""
# core: Nginx Proxy Manager seeds its admin account from these at first
# boot, and Portainer reads its own from a file setup.sh writes out of here.
# Portainer refuses anything under 12 characters.
# The backup archive contains .env itself, so it is always encrypted and the
# key must exist before the first backup rather than at restore time.
set_env HB_BACKUP_KEY "$(rand 48)"
set_env NPM_ADMIN_EMAIL "admin@homebox.local"
set_env NPM_ADMIN_PASSWORD "$(rand 20)"
set_env PORTAINER_ADMIN_PASSWORD "$(rand 20)"
set_env FILEBROWSER_ADMIN_PASSWORD "$(rand 20)"
set_env FILEBROWSER_JWT_SECRET "$(rand 48)"
set_env IMMICH_DB_PASSWORD "$(rand 32)"
set_env VAULTWARDEN_ADMIN_TOKEN "$(rand 48)"
set_env LINKDING_ADMIN_PASSWORD "$(rand 20)"
set_env N8N_ENCRYPTION_KEY "$(rand 48)"
set_env NEXTCLOUD_DB_PASSWORD "$(rand 32)"
set_env WG_ADMIN_PASSWORD "$(rand 20)"
# Blank on purpose: only you know the address clients reach this box at
# from outside, and a guess here hands out VPN configs that point nowhere.
set_env WG_HOST ""

# ---------------------------------------------------------------------------
# Anything else a module declares.
#
# The list above is explicit because those secrets have deliberate lengths and
# reasons. But a hand-kept list drifts the moment a module is added, and it
# already had: `pi-hole` declares PIHOLE_PASSWORD in its own `x-homebox.env_vars`
# and no line here generated one, so a fresh box installed Pi-hole with a blank
# admin password.
#
# So sweep the modules for everything declared `type: secret` and fill in what
# is missing. `set_env` never overwrites, so the explicit lines above still win
# and an existing secret is never regenerated. A new module now brings its own
# password into being with no edit here — the same rule the CLI and dashboard
# already follow by reading metadata rather than keeping a catalog.
# ---------------------------------------------------------------------------
declared_secrets() {
  [ -f "$HB_ROOT/dashboard/lib/yaml.js" ] || return 0
  command -v node >/dev/null 2>&1 || return 0
  node -e '
    const fs = require("fs"), path = require("path");
    const root = process.argv[1];
    const yaml = require(path.join(root, "dashboard/lib/yaml.js"));
    const dir = path.join(root, "modules");
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name, "docker-compose.yml");
      if (!fs.existsSync(file)) continue;
      let meta;
      try { meta = yaml.extractTopLevel(fs.readFileSync(file, "utf8"), "x-homebox"); } catch { continue; }
      const vars = (meta && meta.env_vars) || {};
      for (const [key, spec] of Object.entries(vars)) {
        if (spec && spec.type === "secret" && /^[A-Z][A-Z0-9_]*$/.test(key)) console.log(key);
      }
    }
  ' "$HB_ROOT" 2>/dev/null || true
}

added=0
while IFS= read -r secret; do
  [ -n "$secret" ] || continue
  if ! grep -q "^${secret}=" "$ENV_FILE" 2>/dev/null; then
    set_env "$secret" "$(rand 24)"
    printf '  %s %sgenerated for a module that declares it%s\n' "$secret" "$DIM" "$RESET"
    added=$((added + 1))
  fi
done <<EOF
$(declared_secrets | sort -u)
EOF
# `[ ... ] && printf` would return 1 whenever the test is false, and under
# `set -e` at the top of this file that aborts the install. Same trap as rand().
if [ "$added" -eq 0 ]; then
  printf '  %severy module secret already present%s\n' "$DIM" "$RESET"
fi
# Created after the chown -R above, so it needs its own: without this the
# HomeBox user cannot read the secrets the installer just generated.
$SUDO chown "$HB_USER:$HB_USER" "$ENV_FILE"
chmod 600 "$ENV_FILE"
printf '  %s secrets, mode 600\n' "$(grep -c '=' "$ENV_FILE")"

# -------------------------------------------------------------- 6. networks

# usermod only affects NEW logins, so within this same run docker may still
# need sudo even though the group membership was just granted.
dk() { if docker version >/dev/null 2>&1; then docker "$@"; else $SUDO docker "$@"; fi; }

step "Creating networks"
for net in homebox_proxy homebox_internal; do
  if dk network inspect "$net" >/dev/null 2>&1; then
    printf '  %s %sexists%s\n' "$net" "$DIM" "$RESET"
  else
    dk network create "$net" >/dev/null
    printf '  %s created\n' "$net"
  fi
done

# ------------------------------------------------------------ 7. first boot

# `install`, not `up`: only install runs a module's setup.sh, and core's
# writes the Portainer admin password file. Skipping it leaves Docker to
# create a DIRECTORY at that bind-mount path, and Portainer restart-loops on
# "failed getting admin password file" forever.
step "Starting core and dashboard"
"$HB_ROOT/homebox" install core
"$HB_ROOT/homebox" install dashboard

# The dashboard has a login now, and this is the only place the token to
# claim it appears. Printed last so it is the thing still on screen.
# HOMEBOX_ROOT, not just argv: auth.js finds state/ through state-store, which
# reads that variable. Passing the path only as an argument meant a non-default
# HB_ROOT wrote the token into /opt/homebox instead of the install being made.
BOOTSTRAP="$(HOMEBOX_ROOT="$HB_ROOT" node -e '
  require(process.argv[1] + "/dashboard/lib/auth.js").bootstrapToken()
    .then((t) => process.stdout.write(t || ""))
    .catch(() => process.stdout.write(""));
' "$HB_ROOT" 2>/dev/null || true)"

# This runs as root and AFTER the chown -R above, so the file it just created
# belongs to root and `homebox bootstrap-token` as the login user could not
# read it back.
if [ -f "$HB_ROOT/state/auth.json" ]; then
  $SUDO chown "$HB_USER:$HB_USER" "$HB_ROOT/state/auth.json"
  $SUDO chmod 600 "$HB_ROOT/state/auth.json"
fi

ADDRESS="$(hostname -I 2>/dev/null | awk '{print $1}')"
cat <<EOF

${GREEN}${BOLD}HomeBox is up.${RESET}

  Dashboard   http://${ADDRESS:-localhost}:8443
  Modules     $HB_ROOT/modules
  Secrets     $ENV_FILE  ${DIM}(mode 600 — homebox secrets <module> prints one)${RESET}

  ${BOLD}homebox list${RESET}              what is available
  ${BOLD}homebox install monitoring${RESET}  install an app
  ${BOLD}homebox status${RESET}            what is running

EOF

if [ -n "$BOOTSTRAP" ]; then
  rule
  printf '  %sCLAIM THIS BOX%s
' "$BOLD" "$RESET"
  rule
  printf '  The dashboard asks for this once, to prove the person opening it
'
  printf '  is the person who installed it:

'
  printf '      %s%s%s

' "$GREEN$BOLD" "$BOOTSTRAP" "$RESET"
  printf '  Then you pick a password. Lost it? %shomebox bootstrap-token%s
' "$BOLD" "$RESET"
  rule
  printf '
'
fi
