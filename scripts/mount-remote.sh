#!/usr/bin/env bash
# ==========================================================================
# Mount a NAS share on this box so HomeBox can point its media paths at it.
#
#   sudo scripts/mount-remote.sh nfs  192.0.2.10:/mnt/media/media_disk /mnt/media_disk
#   sudo scripts/mount-remote.sh cifs //192.0.2.10/media /mnt/media_disk user
#
# A Docker bind mount can only reference a path on the Docker host, so the
# share has to be mounted here first. This writes a systemd .mount unit
# rather than an fstab line, for one reason that matters:
#
#   An *arr app started against an EMPTY mountpoint concludes its library
#   vanished and starts "fixing" the difference. A systemd automount with
#   the containers ordered after it means they never see the empty directory
#   in the first place — the mount is established on first access, and a
#   failure is a failure rather than an empty folder.
# ==========================================================================
set -euo pipefail

if [ -t 1 ]; then
  BOLD=$'\033[1m'; RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RESET=$'\033[0m'
else
  BOLD=''; RED=''; GREEN=''; YELLOW=''; RESET=''
fi
die() { printf '%s%s%s\n' "$RED" "$*" "$RESET" >&2; exit 1; }
step() { printf '%s==>%s %s\n' "$GREEN" "$RESET" "$*"; }
warn() { printf '%s!! %s%s\n' "$YELLOW" "$*" "$RESET"; }

KIND="${1:-}"
REMOTE="${2:-}"
MOUNTPOINT="${3:-}"
SMB_USER="${4:-}"

case "$KIND" in
  nfs|cifs) ;;
  *) die "usage: $0 <nfs|cifs> <remote> <mountpoint> [smb-user]" ;;
esac
[ -n "$REMOTE" ] && [ -n "$MOUNTPOINT" ] || die "usage: $0 <nfs|cifs> <remote> <mountpoint> [smb-user]"
[ "$(id -u)" -eq 0 ] || die "run this with sudo — it writes a systemd unit"

# systemd derives the unit name from the path: /mnt/media_disk -> mnt-media_disk.mount
UNIT="$(systemd-escape -p --suffix=mount "$MOUNTPOINT")"
AUTOMOUNT="${UNIT%.mount}.automount"

step "Checking the client tools"
if [ "$KIND" = nfs ]; then
  command -v mount.nfs >/dev/null 2>&1 || { step "Installing nfs-common"; apt-get install -y -qq nfs-common >/dev/null; }
else
  command -v mount.cifs >/dev/null 2>&1 || { step "Installing cifs-utils"; apt-get install -y -qq cifs-utils >/dev/null; }
fi

# For NFS, ask the server what it exports before writing anything. A mount
# that fails because this host is not in the export ACL is the single most
# common reason this does not work, and the error it gives is unhelpful.
if [ "$KIND" = nfs ]; then
  server="${REMOTE%%:*}"
  export_path="${REMOTE#*:}"
  step "Asking $server what it exports"
  if command -v showmount >/dev/null 2>&1; then
    if ! showmount -e "$server" 2>/dev/null | grep -q -- "$export_path"; then
      warn "$server does not list $export_path as exported to anyone."
    else
      allowed="$(showmount -e "$server" 2>/dev/null | awk -v p="$export_path" '$1==p {print $2}')"
      here="$(hostname -I | awk '{print $1}')"
      printf '  exported to: %s\n' "$allowed"
      case ",$allowed," in
        *"$here"*|*"*"*) : ;;
        *) die "this box ($here) is not in that export list — add it on the NAS first, or the mount will hang and then fail" ;;
      esac
    fi
  fi
fi

CREDS="/etc/homebox-smb-credentials"
if [ "$KIND" = cifs ]; then
  [ -n "$SMB_USER" ] || die "cifs needs a username as the fourth argument"
  if [ ! -f "$CREDS" ]; then
    # The password never goes in the unit file: /etc/systemd/system is
    # world-readable. It lands in $CREDS at 0600 instead.
    #
    # HB_SMB_PASS_FILE lets the dashboard drive this without a terminal. A
    # FILE and not a variable: an env var is visible in `docker inspect` and
    # an argument is visible in `ps`, and neither is an acceptable place for
    # somebody's NAS password. The file is read once and deleted here.
    if [ -n "${HB_SMB_PASS_FILE:-}" ] && [ -f "$HB_SMB_PASS_FILE" ]; then
      smb_pass="$(cat "$HB_SMB_PASS_FILE")"
      rm -f "$HB_SMB_PASS_FILE"
    elif [ -t 0 ]; then
      step "SMB password for $SMB_USER"
      read -r -s -p "  password: " smb_pass; echo
    else
      die "no terminal and no HB_SMB_PASS_FILE — cannot ask for the SMB password"
    fi
    printf 'username=%s\npassword=%s\n' "$SMB_USER" "$smb_pass" > "$CREDS"
    chmod 600 "$CREDS"
    unset smb_pass
  fi
fi

# ------------------------------------------------------- the directory below
# Everything here happens to the directory UNDERNEATH the share, so the share
# must not be mounted while we do it.
if mountpoint -q "$MOUNTPOINT"; then
  step "Unmounting $MOUNTPOINT to prepare the directory beneath it"
  systemctl stop "$AUTOMOUNT" "$UNIT" >/dev/null 2>&1 || true
  if mountpoint -q "$MOUNTPOINT"; then umount "$MOUNTPOINT" || true; fi
  if mountpoint -q "$MOUNTPOINT"; then
    die "$MOUNTPOINT is still mounted — something is holding it, most likely a container with a bind mount. Stop it and run this again."
  fi
fi

chattr -i "$MOUNTPOINT" 2>/dev/null || true
mkdir -p "$MOUNTPOINT"

# A Docker bind mount is resolved when the container is CREATED, and Docker
# CREATES a missing source directory instead of refusing. A container that
# starts three seconds before this automount comes up therefore binds a fresh
# empty folder on the root disk — which then hides under the share, so the app
# holds an empty library while `ls` on the host shows everything present.
#
# Clear any such leftovers, then set the immutable bit. It is the one thing
# root honours, so the next time that race happens Docker fails loudly instead
# of quietly inventing an empty library.
if [ -n "$(ls -A "$MOUNTPOINT" 2>/dev/null)" ]; then
  warn "$MOUNTPOINT is not mounted yet already has entries — these would hide under the share:"
  ls -A "$MOUNTPOINT" | sed 's/^/     /'
  find "$MOUNTPOINT" -mindepth 1 -maxdepth 1 -type d -empty -delete 2>/dev/null || true
  if [ -n "$(ls -A "$MOUNTPOINT" 2>/dev/null)" ]; then
    die "what is left is not empty, so it is real data rather than a bind stub — move it aside yourself, then run this again"
  fi
  step "Removed the empty bind stubs"
fi

if chattr +i "$MOUNTPOINT" 2>/dev/null; then
  step "Froze $MOUNTPOINT so nothing can create a stub underneath the share"
else
  warn "could not set the immutable bit on $MOUNTPOINT — a container starting before the mount could still bind an empty directory"
fi

PUID="$(grep -E '^PUID=' /opt/homebox/.env 2>/dev/null | cut -d= -f2)"; PUID="${PUID:-1000}"
PGID="$(grep -E '^PGID=' /opt/homebox/.env 2>/dev/null | cut -d= -f2)"; PGID="${PGID:-1000}"

if [ "$KIND" = nfs ]; then
  WHAT="$REMOTE"
  TYPE="nfs"
  # hard,nointr: an interrupted write to a NAS is a corrupted file. Slow is
  # better than half-written when the thing on the other end is a library.
  OPTIONS="rw,hard,noatime,rsize=1048576,wsize=1048576,timeo=600,retrans=2,_netdev"
else
  WHAT="$REMOTE"
  TYPE="cifs"
  # SMB has no real hardlink support: the *arr apps will COPY on import.
  OPTIONS="credentials=$CREDS,uid=$PUID,gid=$PGID,file_mode=0664,dir_mode=0775,noatime,_netdev"
  warn "SMB does not support hardlinks — every import will be a full copy."
  warn "If the NAS can do NFS, use it instead for a media library."
fi

step "Writing /etc/systemd/system/$UNIT"
cat > "/etc/systemd/system/$UNIT" <<EOF
[Unit]
Description=HomeBox remote storage at $MOUNTPOINT
After=network-online.target
Wants=network-online.target

[Mount]
What=$WHAT
Where=$MOUNTPOINT
Type=$TYPE
Options=$OPTIONS

[Install]
WantedBy=multi-user.target
EOF

step "Writing /etc/systemd/system/$AUTOMOUNT"
cat > "/etc/systemd/system/$AUTOMOUNT" <<EOF
[Unit]
Description=Automount for $MOUNTPOINT

[Automount]
Where=$MOUNTPOINT
TimeoutIdleSec=0

[Install]
WantedBy=multi-user.target
EOF

# Docker must not reach container creation before the automount exists, for
# the reason spelled out above. Ordering only — never Requires=: a NAS that is
# switched off must not take dockerd, and with it the dashboard, down too.
if systemctl cat docker.service >/dev/null 2>&1; then
  DROPIN="/etc/systemd/system/docker.service.d/10-homebox-${AUTOMOUNT%.automount}.conf"
  step "Ordering docker.service after $AUTOMOUNT"
  mkdir -p "$(dirname "$DROPIN")"
  cat > "$DROPIN" <<EOF
# Written by HomeBox scripts/mount-remote.sh.
# A bind mount is resolved when the container is CREATED; if dockerd gets there
# first, the source is an empty directory on the root disk and the app starts
# against an empty library. Ordering only, so an unreachable NAS cannot stop
# Docker from starting.
[Unit]
Wants=$AUTOMOUNT
After=$AUTOMOUNT
EOF
fi

systemctl daemon-reload
systemctl enable --now "$AUTOMOUNT" >/dev/null
step "Mounting"
systemctl start "$UNIT"

if mountpoint -q "$MOUNTPOINT"; then
  printf '\n%smounted%s  %s\n' "$GREEN" "$RESET" "$(findmnt -no SOURCE,SIZE,USED "$MOUNTPOINT")"
  printf '\nNow point HomeBox at it — Settings > Server Config > Advanced, or:\n'
  printf '  %sHB_DATA_DIR=%s%s   (one mount for everything, hardlinks intact)\n' "$BOLD" "$MOUNTPOINT" "$RESET"
  printf '\nA container keeps the bind it was CREATED with, so restarting is not\n'
  printf 'enough — the containers have to be replaced:\n'
  printf '  %shomebox update <module>%s\n' "$BOLD" "$RESET"
else
  die "the unit was written but $MOUNTPOINT is not mounted — check: systemctl status $UNIT"
fi
