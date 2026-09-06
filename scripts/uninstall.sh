#!/usr/bin/env bash
# ==========================================================================
# Remove HomeBox from this machine.
#
#   sudo bash /opt/homebox/scripts/uninstall.sh              # asks first
#   sudo bash /opt/homebox/scripts/uninstall.sh --yes        # no questions
#   sudo bash /opt/homebox/scripts/uninstall.sh --keep-data  # keep data/ + backups/
#
# For starting over on a test box, and for getting a machine back to how it
# was. It removes the containers HomeBox created, its networks, and the tree
# at /opt/homebox. Docker itself stays — it was probably wanted anyway, and
# uninstalling it would take other people's containers with it.
#
# What it will NOT do, ever:
#
#   - touch anything outside $HB_ROOT and HomeBox's own Docker objects
#   - follow HB_DATA_DIR or HB_MEDIA_ROOT off this box. A media library on a
#     NAS is the one thing here that cannot be regenerated, and "uninstall the
#     dashboard" must never mean "delete the films".
# ==========================================================================
set -euo pipefail

HB_ROOT="${HB_ROOT:-/opt/homebox}"
ASSUME_YES=0
KEEP_DATA=0
KEEP_IMAGES=0

for arg in "$@"; do
  case "$arg" in
    --yes|-y) ASSUME_YES=1 ;;
    --keep-data) KEEP_DATA=1 ;;
    --keep-images) KEEP_IMAGES=1 ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) printf 'unknown option: %s\n' "$arg" >&2; exit 1 ;;
  esac
done

if [ -t 1 ]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GREEN=$'\033[32m'
  YELLOW=$'\033[33m'; RESET=$'\033[0m'
else
  BOLD=''; DIM=''; RED=''; GREEN=''; YELLOW=''; RESET=''
fi
step() { printf '\n%s==>%s %s%s%s\n' "$GREEN" "$RESET" "$BOLD" "$*" "$RESET"; }
warn() { printf '%s!! %s%s\n' "$YELLOW" "$*" "$RESET"; }
die()  { printf '%sxx %s%s\n' "$RED" "$*" "$RESET" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run this with sudo — it removes containers and $HB_ROOT"

# A typo in HB_ROOT must not turn this into `rm -rf /`.
case "$HB_ROOT" in
  /|/usr|/etc|/var|/home|/root|/opt|/mnt|/srv) die "refusing to remove $HB_ROOT" ;;
esac

DOCKER=(docker)
command -v docker >/dev/null 2>&1 || DOCKER=()

# ------------------------------------------------------------- 1. inventory

step "What will be removed"

CONTAINERS=""
NETWORKS=""
IMAGES=""
if [ "${#DOCKER[@]}" -gt 0 ] && docker info >/dev/null 2>&1; then
  # By compose project label, not by name: the label is what actually ties a
  # container to a HomeBox module, and names have no prefix by design.
  # No -q: docker refuses to honour --format when --quiet is also set
  # ("Ignoring custom format, because both --format and --quiet are set"), so
  # this listed bare IDs and the filter below matched nothing — the inventory
  # said "containers 0" on a box with three running.
  CONTAINERS="$(docker ps -a --filter 'label=com.docker.compose.project' \
    --format '{{.Label "com.docker.compose.project"}} {{.Names}}' 2>/dev/null \
    | awk '$1 ~ /^homebox-/ {print $2}' || true)"
  NETWORKS="$(docker network ls --format '{{.Name}}' 2>/dev/null | grep -E '^homebox_' || true)"
  IMAGES="$(docker image ls --format '{{.Repository}}:{{.Tag}}' 2>/dev/null | grep -E '^homebox-' || true)"
fi

count() { [ -z "$1" ] && echo 0 || printf '%s\n' "$1" | grep -c .; }
printf '  containers   %s%s\n' "$(count "$CONTAINERS")" \
  "$([ -n "$CONTAINERS" ] && printf ' %s(%s)%s' "$DIM" "$(printf '%s' "$CONTAINERS" | tr '\n' ' ')" "$RESET")"
printf '  networks     %s\n' "$(count "$NETWORKS")"
printf '  images       %s%s\n' "$(count "$IMAGES")" \
  "$([ "$KEEP_IMAGES" -eq 1 ] && echo "  ${DIM}kept (--keep-images)${RESET}")"

if [ -d "$HB_ROOT" ]; then
  printf '  %s        %s\n' "$HB_ROOT" "$(du -sh "$HB_ROOT" 2>/dev/null | cut -f1)"
  for sub in .env state backups data; do
    [ -e "$HB_ROOT/$sub" ] || continue
    printf '    %-10s %s\n' "$sub" "$(du -sh "$HB_ROOT/$sub" 2>/dev/null | cut -f1)"
  done
else
  printf '  %s        %snot present%s\n' "$HB_ROOT" "$DIM" "$RESET"
fi

# Data that lives somewhere else is data this script must not reach.
if [ -f "$HB_ROOT/.env" ]; then
  for key in HB_DATA_DIR HB_MEDIA_ROOT; do
    value="$(grep -E "^${key}=" "$HB_ROOT/.env" 2>/dev/null | cut -d= -f2- || true)"
    case "$value" in
      ''|"$HB_ROOT"|"$HB_ROOT"/*) ;;
      *) warn "$key is $value — OUTSIDE $HB_ROOT, so it is left completely alone" ;;
    esac
  done
fi

printf '\n%sThis cannot be undone.%s ' "$BOLD" "$RESET"
if [ "$KEEP_DATA" -eq 1 ]; then
  printf 'data/ and backups/ are kept.\n'
else
  printf '%sEvery generated password, all app config and every backup goes.%s\n' "$RED" "$RESET"
fi

# ---------------------------------------------------------------- 2. confirm

if [ "$ASSUME_YES" -ne 1 ]; then
  [ -t 0 ] || die "not a terminal, so nothing was removed. Re-run with --yes if you mean it."
  printf '\nType %sremove%s to continue: ' "$BOLD" "$RESET"
  read -r answer
  [ "$answer" = "remove" ] || die "nothing was removed"
fi

# ------------------------------------------------------------- 3. do it

if [ -n "$CONTAINERS" ]; then
  step "Removing containers"
  # shellcheck disable=SC2086
  docker rm -f $(printf '%s ' $CONTAINERS) >/dev/null 2>&1 || true
  printf '  %s removed\n' "$(count "$CONTAINERS")"
fi

if [ -n "$NETWORKS" ]; then
  step "Removing networks"
  for net in $NETWORKS; do
    docker network rm "$net" >/dev/null 2>&1 && printf '  %s\n' "$net" || warn "$net is still in use — left alone"
  done
fi

if [ -n "$IMAGES" ] && [ "$KEEP_IMAGES" -ne 1 ]; then
  step "Removing images built here"
  for img in $IMAGES; do
    docker image rm "$img" >/dev/null 2>&1 && printf '  %s\n' "$img" || true
  done
fi

if [ -d "$HB_ROOT" ]; then
  step "Removing $HB_ROOT"
  if [ "$KEEP_DATA" -eq 1 ]; then
    KEEP="$(mktemp -d)"
    for sub in data backups; do
      [ -e "$HB_ROOT/$sub" ] && mv "$HB_ROOT/$sub" "$KEEP/" || true
    done
    rm -rf "$HB_ROOT"
    mkdir -p "$HB_ROOT"
    for sub in data backups; do
      [ -e "$KEEP/$sub" ] && mv "$KEEP/$sub" "$HB_ROOT/" || true
    done
    rmdir "$KEEP" 2>/dev/null || true
    printf '  removed, data/ and backups/ put back\n'
  else
    rm -rf "$HB_ROOT"
    printf '  removed\n'
  fi
fi

# The systemd units scripts/mount-remote.sh writes are deliberately left in
# place: they mount a NAS, which has nothing to do with HomeBox being here,
# and removing them would unmount a share other things may be using.
if ls /etc/systemd/system/*.automount >/dev/null 2>&1; then
  if grep -lq 'HomeBox remote storage' /etc/systemd/system/*.mount 2>/dev/null; then
    warn "the NAS mount units from mount-remote.sh are still installed — remove them by hand if you want them gone:"
    grep -l 'HomeBox remote storage' /etc/systemd/system/*.mount 2>/dev/null | sed 's/^/     /'
  fi
fi

step "Done"
cat <<EOF
  HomeBox is gone. Docker was left installed.

  To install again:
    ${BOLD}curl -fsSL https://raw.githubusercontent.com/abeksis/HomeBox/main/scripts/bootstrap.sh | sudo bash${RESET}
EOF
