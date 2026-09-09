#!/usr/bin/env bash
# Move this box to a HomeBox release.
#
# Runs ON THE HOST — launched either by the CLI (`homebox self-update`) or by
# the dashboard, which reaches the host through a detached privileged container
# and nsenter. Two reasons it cannot run inside the dashboard container:
#
#   1. `git` is not installed there. Neither is curl or openssl. The host has
#      all three.
#   2. This script REBUILDS THE DASHBOARD. A process cannot recreate the
#      container it lives in; it gets killed halfway and leaves the box between
#      two versions.
#
# It therefore reports through state/platform-progress.json rather than through
# an exit code anybody is waiting on, because by the time it finishes, whoever
# asked for it has been restarted.
#
# EVERY STEP IS IDEMPOTENT AND THE ROLLBACK IS A GIT SHA. That is the whole
# reason releases are tags rather than tarballs: `git checkout <sha>` puts
# every tracked file back atomically, for free, and the untracked half — .env,
# state/, modules/*/config, data/ — is never touched by a checkout at all.
#
# Usage: self-update.sh <version>        e.g. self-update.sh 0.2.0
set -uo pipefail

HB_ROOT="${HB_ROOT:-/opt/homebox}"

# ---------------------------------------------------------------------------
# RUN FROM A COPY. This is not tidiness, it is correctness.
#
# bash reads a script LAZILY, by byte offset, as it executes. Step 4 below runs
# `git checkout`, which rewrites this very file. bash then resumes at the old
# offset inside the new bytes and executes whatever happens to be there — a
# fragment of a comment, half a function — in the middle of an update, on
# somebody else's box.
#
# It does not fail loudly. It fails as nonsense.
#
# So the first thing this script does is copy itself somewhere the checkout
# cannot reach and hand over. HB_SELF_COPIED marks that it has happened, so the
# copy does not do it again.
# ---------------------------------------------------------------------------
if [ -z "${HB_SELF_COPIED:-}" ]; then
  _copy="$(mktemp /tmp/homebox-self-update.XXXXXX.sh)" || exit 2
  cat "$0" > "$_copy" || exit 2
  chmod +x "$_copy"
  export HB_SELF_COPIED=1
  exec bash "$_copy" "$@"
fi
# From here on, $0 is the copy in /tmp and the checkout cannot pull it away.
STATE_DIR="$HB_ROOT/state"
PROGRESS="$STATE_DIR/platform-progress.json"
HISTORY="$STATE_DIR/platform-history.json"
LOCK="$STATE_DIR/platform-update.lock"
BACKUP_DIR="$STATE_DIR/platform-backups"
KEEP_BACKUPS=5
# /healthz, not /api/summary.
#
# Every route on the dashboard is behind a session by default; /healthz is on
# the short public list precisely because the container's own healthcheck runs
# before anybody has signed in. /api/summary answers 401 to an unauthenticated
# curl, `curl -fsS` calls that a failure, and the health gate could therefore
# never pass — every update on every box would have rolled itself back.
#
# server.js already carries a comment about making this exact mistake once.
HEALTH_URL="http://127.0.0.1:${HB_DASHBOARD_PORT:-8443}/healthz"
HEALTH_TIMEOUT=180

TARGET="${1:-}"
[ -n "$TARGET" ] || { echo "usage: $0 <version>" >&2; exit 2; }
case "$TARGET" in
  *[!0-9.]*) echo "refusing a version that is not N.N.N: $TARGET" >&2; exit 2 ;;
esac

mkdir -p "$STATE_DIR" "$BACKUP_DIR"
cd "$HB_ROOT" || { echo "no such root: $HB_ROOT" >&2; exit 2; }

FROM="$(cat "$HB_ROOT/VERSION" 2>/dev/null || echo 0.0.0)"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
ROLLBACK_TARBALL="$BACKUP_DIR/${FROM}-${STAMP}.tar.gz"
ROLLBACK_SHA=""

# ------------------------------------------------------------------ progress
#
# Written atomically after every step. The dashboard polls this file, and it is
# the only channel that survives the dashboard being rebuilt mid-update.

phase() {
  local ph="$1" msg="${2:-}"
  local tmp="$PROGRESS.tmp-$$"
  {
    printf '{\n'
    printf '  "phase": "%s",\n' "$ph"
    printf '  "message": "%s",\n' "$(printf '%s' "$msg" | sed 's/["\\]/\\&/g')"
    printf '  "from": "%s",\n' "$FROM"
    printf '  "to": "%s",\n' "$TARGET"
    printf '  "pid": %s,\n' "$$"
    printf '  "updatedAt": "%s"\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf '}\n'
  } > "$tmp" && mv "$tmp" "$PROGRESS"
  printf '[self-update] %-10s %s\n' "$ph" "$msg"
}

# One line appended to the history the Updates tab shows. Same shape as the
# image-update history, so the UI renders both without a second code path.
#
# node rather than shell string-building: this writes JSON containing an error
# message that came from git or install.sh, and quoting that by hand in bash is
# how a failed update also produces a corrupt history file.
record() {
  node -e '
    const fs = require("fs");
    const [file, from, to, ok, detail] = process.argv.slice(1);
    let rows = [];
    try { rows = JSON.parse(fs.readFileSync(file, "utf8")); } catch { rows = []; }
    if (!Array.isArray(rows)) rows = [];
    rows.unshift({ kind: "platform", from, to, ok: ok === "true", detail, at: new Date().toISOString() });
    const tmp = file + ".tmp-" + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(rows.slice(0, 20), null, 2) + "\n");
    fs.renameSync(tmp, file);
  ' "$HISTORY" "$FROM" "$TARGET" "$1" "$2" 2>/dev/null || true
}

# --------------------------------------------------------------------- lock
#
# A stale lock from a box that lost power is not a reason to refuse forever, so
# the pid is checked rather than the file's existence alone.

if [ -f "$LOCK" ]; then
  old="$(cat "$LOCK" 2>/dev/null || echo 0)"
  if [ -n "$old" ] && kill -0 "$old" 2>/dev/null; then
    echo "an update is already running (pid $old)" >&2
    exit 1
  fi
  echo "[self-update] clearing a lock left by pid $old, which is gone"
fi
echo $$ > "$LOCK"

# Clean up the container a previous run left behind. It is deliberately not
# --rm, so that a failure can still be read afterwards; this is where it goes.
docker rm -f homebox-self-update >/dev/null 2>&1 || true

finish_ok() {
  phase done "Now on $TARGET"
  record true "Updated from $FROM to $TARGET"
  rm -f "$LOCK"
  exit 0
}

fail() {
  local why="$1"
  phase failed "$why"
  record false "$why"
  rm -f "$LOCK"
  exit 1
}

# --------------------------------------------------------------- ownership
#
# This runs as root, so every object git writes into .git is root-owned. Leave
# it that way and the box's own user can no longer run `git status` on their
# own install — an update that quietly takes the repo away from its owner.
#
# modules/*/config is pruned for the reason install.sh already documents: those
# directories belong to the apps, several of which run as their own uid and
# will not start if their data is reassigned underneath them.
chown_back() {
  local owner
  owner="$(stat -c '%u:%g' "$HB_ROOT" 2>/dev/null)" || return 0
  find "$HB_ROOT" -path "$HB_ROOT/modules/*/config" -prune -o -exec chown "$owner" {} + 2>/dev/null || true
}

# ------------------------------------------------------------------ rollback

rollback() {
  local why="$1"
  phase rollback "$why — putting $FROM back"
  if [ -n "$ROLLBACK_SHA" ]; then
    git -C "$HB_ROOT" checkout --force "$ROLLBACK_SHA" >/dev/null 2>&1 \
      || echo "[self-update] WARNING: could not check $ROLLBACK_SHA back out" >&2
  fi
  if [ -f "$ROLLBACK_TARBALL" ]; then
    tar -xzf "$ROLLBACK_TARBALL" -C "$HB_ROOT" 2>/dev/null \
      || echo "[self-update] WARNING: could not restore $ROLLBACK_TARBALL" >&2
  fi
  chown_back
  bash "$HB_ROOT/install.sh" >/dev/null 2>&1 || true
  fail "$why (rolled back to $FROM)"
}

# ------------------------------------------------------------------- 1. sanity

phase checking "Looking at the working tree"

command -v git >/dev/null 2>&1 || fail "git is not installed on this host"
[ -d "$HB_ROOT/.git" ] || fail "$HB_ROOT is not a git checkout — this box was installed from a tarball and cannot self-update"

# A friend who hand-edited a module should be told, not silently overwritten.
# --force on checkout would discard their work without a word.
#
# core.fileMode=false, because a mode change is not somebody's edit. bootstrap.sh
# runs `chmod +x homebox install.sh scripts/*.sh` on every install, so any script
# whose recorded mode is 0644 shows up as modified on EVERY box — and the first
# update anyone tried was refused because of exactly that, on a file nobody had
# touched. The permission bit is the installer's business; the content is the
# user's, and only the content is worth stopping for.
dirty="$(git -C "$HB_ROOT" -c core.fileMode=false status --porcelain 2>/dev/null | head -20)"
if [ -n "$dirty" ]; then
  fail "the working tree has local changes, so an update would discard them: $(printf '%s' "$dirty" | awk '{print $2}' | tr '\n' ' ')"
fi

ROLLBACK_SHA="$(git -C "$HB_ROOT" rev-parse HEAD)"

# ------------------------------------------------------------------ 2. backup
#
# state/ and .env only — about 14MB. NOT a full config backup: a checkout
# cannot touch modules/*/config (gitignored), and on a real box that archive is
# the better part of a gigabyte of Jellyfin artwork and Immich's database. A
# migration that does touch a module's config takes its own, targeted.

phase backup "Saving state and .env"
tar -czf "$ROLLBACK_TARBALL" -C "$HB_ROOT" \
  --exclude='state/platform-backups' \
  --exclude='state/update-backups' \
  state .env 2>/dev/null \
  || fail "could not back up state before starting"

# Keep the last few, oldest first out.
ls -1t "$BACKUP_DIR"/*.tar.gz 2>/dev/null | tail -n +$((KEEP_BACKUPS + 1)) | while read -r old; do
  rm -f "$old"
done

# ------------------------------------------------------------------- 3. fetch

phase fetching "Fetching $TARGET"

# The clone is shallow (bootstrap.sh uses --depth 1), so a bare `fetch --tags`
# does not necessarily bring the tag's objects. Ask for the one ref by name.
git -C "$HB_ROOT" fetch --depth=1 origin "refs/tags/v${TARGET}:refs/tags/v${TARGET}" 2>/dev/null \
  || git -C "$HB_ROOT" fetch --tags origin 2>/dev/null \
  || fail "could not reach the release repository"

git -C "$HB_ROOT" rev-parse "v${TARGET}" >/dev/null 2>&1 \
  || fail "release v${TARGET} does not exist"

# Signature verification goes here once tags are signed. Absent a public key
# there is nothing to check, and pretending otherwise would be worse than the
# honest gap: git tag -v "v${TARGET}"

# --------------------------------------------------- the authoritative freeze
#
# The dashboard already checked the manifest over HTTPS before launching this.
# That read comes from raw.githubusercontent, which serves max-age=300 — so it
# can be up to five minutes behind, and five minutes behind is precisely the
# window a freeze exists to cover.
#
# Read it again here, from git. Ref advertisement on github.com is served by
# the git backend rather than a CDN, so this is the freshest answer available,
# and it happens one step before anything is written to disk.
#
# FAILS CLOSED. An update that proceeds because it could not read the freeze
# flag is not a freeze switch.

phase verifying "Re-checking the release is still good"
if git -C "$HB_ROOT" fetch --depth=1 origin main:refs/remotes/origin/hb-control 2>/dev/null; then
  manifest="$(git -C "$HB_ROOT" show refs/remotes/origin/hb-control:releases/manifest.json 2>/dev/null)"
  if [ -n "$manifest" ]; then
    frozen="$(printf '%s' "$manifest" | node -e '
      let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
        try { const m = JSON.parse(s);
          if (m.freeze === true) process.stdout.write(m.freeze_reason || "updates are paused by the maintainer");
        } catch { process.stdout.write("MANIFEST_UNREADABLE"); }
      });' 2>/dev/null)"
    if [ "$frozen" = "MANIFEST_UNREADABLE" ]; then
      fail "the release manifest could not be read, so this stopped rather than guessing"
    elif [ -n "$frozen" ]; then
      fail "the maintainer has paused updates: $frozen"
    fi
  fi
fi

# ---------------------------------------------------------------- 4. checkout

phase installing "Switching to $TARGET"
git -C "$HB_ROOT" checkout --quiet "v${TARGET}" 2>/dev/null \
  || fail "could not check out v${TARGET}"
chown_back

# ---------------------------------------------------------------- 5. migrate
#
# For what install.sh structurally cannot do: its set_env never overwrites an
# existing key, so a release that must CHANGE a value has no other route.

if [ -d "$HB_ROOT/migrations" ]; then
  phase migrating "Running migrations"
  for dir in $(ls -1 "$HB_ROOT/migrations" 2>/dev/null | sort -V); do
    script="$HB_ROOT/migrations/$dir/up.sh"
    [ -f "$script" ] || continue
    if grep -qs "\"$dir\"" "$STATE_DIR/migrations-done.json" 2>/dev/null; then continue; fi
    phase migrating "Migration $dir"
    if ! HB_ROOT="$HB_ROOT" bash "$script"; then
      rollback "migration $dir failed"
    fi
    node -e '
      const fs = require("fs");
      const [file, name] = process.argv.slice(1);
      let done = [];
      try { done = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
      if (!done.includes(name)) done.push(name);
      fs.writeFileSync(file, JSON.stringify(done, null, 2) + "\n");
    ' "$STATE_DIR/migrations-done.json" "$dir" 2>/dev/null || true
  done
fi

# ----------------------------------------------------------------- 6. install

phase installing "Rebuilding"
if ! bash "$HB_ROOT/install.sh" >/tmp/homebox-self-update.log 2>&1; then
  rollback "install.sh failed — see /tmp/homebox-self-update.log"
fi

# ------------------------------------------------------------------ 7. health

phase verifying "Waiting for the dashboard"
ok=0
for _ in $(seq 1 $((HEALTH_TIMEOUT / 3))); do
  if curl -fsS -m 5 -o /dev/null "$HEALTH_URL" 2>/dev/null; then ok=1; break; fi
  sleep 3
done
[ "$ok" -eq 1 ] || rollback "the dashboard did not answer within ${HEALTH_TIMEOUT}s"

finish_ok
