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
VOLUMES=""
DECLARED=""
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

  # Anonymous volumes, collected BEFORE the containers go.
  #
  # An image that declares VOLUME without a compose mapping gets an unnamed
  # volume with a 64-hex name, and `docker rm` leaves it behind — it needs
  # -v. Six of them survived a full uninstall on the test box, which is
  # exactly the kind of thing "it left residue" means. Read from the
  # containers themselves so only HomeBox's own are ever touched: a bare
  # `volume prune` would take somebody else's stopped container's data.
  for c in $CONTAINERS; do
    VOLUMES="$VOLUMES$(docker inspect "$c" \
      --format '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}}{{"\n"}}{{end}}{{end}}' 2>/dev/null || true)"
  done
  VOLUMES="$(printf '%s' "$VOLUMES" | grep -E '^[a-f0-9]{64}$' | sort -u || true)"

  # Images: what the modules actually declare, not just the ones built here.
  #
  # `homebox-*` only ever matched the dashboard's own build. Everything
  # pulled — Radarr, Sonarr, the proxy, FlareSolverr — stayed, which on the
  # test box was 5GB of "removed" HomeBox. The list comes from the module
  # files so it can never include an image HomeBox did not ask for.
  if [ -d "$HB_ROOT/modules" ]; then
    # A tag built from ${HB_VERSION:-local} leaves "homebox-dashboard:" once
    # the variable is stripped, so anything without a real tag is dropped —
    # the homebox-* match above already covers the images built here.
    DECLARED="$(grep -rhoE '^\s*image:\s*\S+' "$HB_ROOT"/modules/*/docker-compose.yml 2>/dev/null \
      | sed -E 's/^\s*image:\s*//; s/\$\{[^}]*\}//g' \
      | grep -E ':[A-Za-z0-9._-]+$' | sort -u || true)"
  fi
  IMAGES="$(docker image ls --format '{{.Repository}}:{{.Tag}}' 2>/dev/null | grep -E '^homebox-' || true)"
  for want in $DECLARED; do
    docker image inspect "$want" >/dev/null 2>&1 && IMAGES="$IMAGES
$want"
  done
  IMAGES="$(printf '%s' "$IMAGES" | grep -vE '^\s*$' | sort -u || true)"
fi

count() { [ -z "$1" ] && echo 0 || printf '%s\n' "$1" | grep -c .; }
printf '  containers   %s%s\n' "$(count "$CONTAINERS")" \
  "$([ -n "$CONTAINERS" ] && printf ' %s(%s)%s' "$DIM" "$(printf '%s' "$CONTAINERS" | tr '\n' ' ')" "$RESET")"
printf '  networks     %s\n' "$(count "$NETWORKS")"
printf '  volumes      %s %s(anonymous, created by these containers)%s\n' "$(count "$VOLUMES")" "$DIM" "$RESET"
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
  # -v so an anonymous volume goes with the container that made it. Named
  # volumes a compose file declares are not touched by this flag.
  # shellcheck disable=SC2086
  docker rm -f -v $(printf '%s ' $CONTAINERS) >/dev/null 2>&1 || true
  printf '  %s removed\n' "$(count "$CONTAINERS")"
fi

# Anything -v could not take, usually because it was still referenced when
# the container went. Only the ones this script inventoried from HomeBox's
# own containers, never a blanket prune.
if [ -n "$VOLUMES" ] && [ "$KEEP_DATA" -ne 1 ]; then
  step "Removing anonymous volumes"
  left=0
  for vol in $VOLUMES; do
    if docker volume inspect "$vol" >/dev/null 2>&1; then
      docker volume rm "$vol" >/dev/null 2>&1 && printf '  %s\n' "${vol:0:12}" || { warn "${vol:0:12} is still in use — left alone"; left=1; }
    fi
  done
  [ "$left" -eq 0 ] && printf '  %s accounted for\n' "$(count "$VOLUMES")"
fi

if [ -n "$NETWORKS" ]; then
  step "Removing networks"
  for net in $NETWORKS; do
    docker network rm "$net" >/dev/null 2>&1 && printf '  %s\n' "$net" || warn "$net is still in use — left alone"
  done
fi

if [ -n "$IMAGES" ] && [ "$KEEP_IMAGES" -ne 1 ]; then
  step "Removing images"
  for img in $IMAGES; do
    # `docker image rm` refuses while any container still uses it, which is
    # the safety we want: an image another stack on this box shares stays.
    docker image rm "$img" >/dev/null 2>&1 && printf '  %s\n' "$img" \
      || warn "$img is used by something else — left alone"
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

# ------------------------------------------------- 4. the last of the debris
#
# Removing HomeBox's own objects still leaves three kinds of rubbish that
# belong to nobody:
#
#   - anonymous volumes ORPHANED by an earlier uninstall. Once their
#     container is gone there is nothing left to attribute them to, so the
#     inventory above cannot see them. Five survived on the test box.
#   - dangling images: the untagged layers left behind every time the
#     dashboard was rebuilt. 322MB, invisible to `docker image ls`.
#   - the build cache from building the dashboard. 465MB.
#
# A blanket prune is only safe when nothing else on this machine uses Docker,
# so that is checked rather than assumed: if any container or tagged image
# survives, this is skipped entirely and says what it found instead. Someone
# running HomeBox next to their own stacks does not lose their leftovers to
# an uninstall of something else.
if [ "${#DOCKER[@]}" -gt 0 ] && docker info >/dev/null 2>&1 && [ "$KEEP_DATA" -ne 1 ] && [ "$KEEP_IMAGES" -ne 1 ]; then
  others_c="$(docker ps -aq 2>/dev/null | grep -c . || true)"
  others_i="$(docker image ls --format '{{.Repository}}' 2>/dev/null | grep -vc '^<none>$' || true)"
  if [ "${others_c:-0}" -eq 0 ] && [ "${others_i:-0}" -eq 0 ]; then
    step "Clearing what is left over"
    freed="$(docker system df --format '{{.Type}} {{.Size}}' 2>/dev/null | tr '\n' ' ')"
    docker volume prune -f >/dev/null 2>&1 || true
    docker image prune -af >/dev/null 2>&1 || true
    docker builder prune -af >/dev/null 2>&1 || true
    printf '  orphaned volumes, dangling images and the build cache\n'
    printf '  %swas: %s%s\n' "$DIM" "$freed" "$RESET"
    printf '  %snow: %s%s\n' "$DIM" "$(docker system df --format '{{.Type}} {{.Size}}' 2>/dev/null | tr '\n' ' ')" "$RESET"
  else
    warn "other containers or images are on this machine, so orphaned volumes, dangling images and the build cache were left alone."
    warn "nothing else uses Docker here? clear them with:  docker system prune -a --volumes"
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
    ${BOLD}curl -fsSL https://get.abeksis.net/install.sh | sudo bash${RESET}
EOF
