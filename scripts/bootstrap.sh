#!/usr/bin/env bash
# ==========================================================================
# HomeBox bootstrap — the one-liner.
#
#   curl -fsSL https://raw.githubusercontent.com/abeksis/HomeBox/main/scripts/bootstrap.sh | sudo bash
#
# This is the piece install.sh cannot be: install.sh configures a tree that is
# already on disk, and something has to put it there first. This downloads the
# repository, unpacks it to /opt/homebox, and hands over.
#
# GitHub is the single source. An earlier version had every running HomeBox
# serve its own copy over the LAN, which was removed on purpose: a box that had
# drifted would hand out a tree nobody could reproduce, and it meant an
# unauthenticated endpoint on every machine giving away the whole install.
#
# You are piping a script from the internet into a root shell. That is a real
# thing to be careful about, and the answer is not to trust the wording here:
#
#   curl -fsSL https://raw.githubusercontent.com/abeksis/HomeBox/main/scripts/bootstrap.sh -o hb.sh
#   less hb.sh && sudo bash hb.sh
# ==========================================================================
set -euo pipefail

# Override any of these to install from a fork, a branch, a tag, or — on a
# network with no route to GitHub — a tarball you host yourself:
#   HB_TARBALL=http://192.0.2.20/homebox.tar.gz sudo -E bash hb.sh
HB_REPO="${HB_REPO:-abeksis/HomeBox}"

# The release a NEW box starts on: whatever releases/manifest.json calls
# stable — the same file every installed box reads to decide what it may
# update to. A fresh install and an update offer therefore agree, a tag that
# has been cut but not yet announced is not handed out, and a paused release is
# said out loud instead of installed quietly.
#
# This used to ask `git ls-remote` for the newest tag, right here — sixty lines
# before step 1 installs git. A clean Debian has no git; the failure was
# swallowed by 2>/dev/null and the fallback was `main`, so a friend installing
# on a fresh machine got the development branch without a word. curl is safe
# to rely on at this point: it is what fetched this script.
#
# No pipes into grep -q or head here. Under `set -euo pipefail` a reader that
# exits early can SIGPIPE the writer and fail the whole pipeline, and a failed
# substitution in an assignment ends the script. Bash's own regex match reads
# the text in place.
if [ -n "${HB_REF:-}" ]; then HB_REF_ASKED=1; else HB_REF_ASKED=0; fi
HB_MANIFEST_URL="${HB_MANIFEST_URL:-https://raw.githubusercontent.com/${HB_REPO}/main/releases/manifest.json}"
HB_MANIFEST=""
HB_FROZEN=0
if [ "$HB_REF_ASKED" -eq 0 ]; then
  HB_MANIFEST="$(curl -fsSL --max-time 15 "$HB_MANIFEST_URL" 2>/dev/null)" || HB_MANIFEST=""
  if [[ $HB_MANIFEST =~ \"freeze\"[[:space:]]*:[[:space:]]*true ]]; then HB_FROZEN=1; fi
fi

default_ref() {
  local tag
  if [[ $HB_MANIFEST =~ \"stable\"[[:space:]]*:[[:space:]]*\"([0-9]+\.[0-9]+\.[0-9]+)\" ]]; then
    printf 'v%s' "${BASH_REMATCH[1]}"
    return 0
  fi
  # No manifest (a fork without one, no route to GitHub's raw host): the
  # newest stable-shaped tag, if git happens to be installed already.
  # Pre-release tags are not somebody's first install.
  if command -v git >/dev/null 2>&1; then
    tag="$(git ls-remote --tags --refs "https://github.com/${HB_REPO}.git" 2>/dev/null \
      | sed 's|.*refs/tags/||' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -n 1)" || tag=""
    if [ -n "$tag" ]; then printf '%s' "$tag"; return 0; fi
  fi
  printf 'main'
}
HB_REF="${HB_REF:-$(default_ref)}"
# Did the caller ASK for a tarball? Recorded as a flag, before the default is
# filled in.
#
# This used to be inferred further down by comparing HB_TARBALL against a
# hand-written copy of the default URL — and that broke the moment the default
# stopped being one fixed string. HB_REF now defaults to a tag, the URL is
# built with refs/tags, the comparison string still said refs/heads, so the
# two never matched and EVERY fresh install silently took the tarball path.
# The result was a box with no .git: working, and permanently unable to update
# itself. A flag cannot drift from the thing it describes.
if [ -n "${HB_TARBALL:-}" ]; then HB_TARBALL_ASKED=1; else HB_TARBALL_ASKED=0; fi

# refs/heads for a branch, refs/tags for a release.
case "$HB_REF" in
  v[0-9]*) HB_REF_NS="refs/tags" ;;
  *)       HB_REF_NS="refs/heads" ;;
esac
HB_TARBALL="${HB_TARBALL:-https://codeload.github.com/${HB_REPO}/tar.gz/${HB_REF_NS}/${HB_REF}}"
HB_ROOT="${HB_ROOT:-/opt/homebox}"
HB_USER="${HB_USER:-${SUDO_USER:-$(id -un)}}"

if [ -t 1 ]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GREEN=$'\033[32m'
  YELLOW=$'\033[33m'; RESET=$'\033[0m'
else
  BOLD=''; DIM=''; RED=''; GREEN=''; YELLOW=''; RESET=''
fi
step() { printf '\n%s[HomeBox]%s %s%s%s\n' "$GREEN" "$RESET" "$BOLD" "$*" "$RESET"; }
warn() { printf '%s[HomeBox]%s %s%s%s\n' "$YELLOW" "$RESET" "$YELLOW" "$*" "$RESET"; }
die()  { printf '%s[HomeBox]%s %s%s%s\n' "$RED" "$RESET" "$RED" "$*" "$RESET" >&2; exit 1; }

cat <<'BANNER'

  _   _                     ____
 | | | | ___  _ __ ___   ___| __ )  _____  __
 | |_| |/ _ \| '_ ` _ \ / _ \  _ \ / _ \ \/ /
 |  _  | (_) | | | | | |  __/ |_) | (_) >  <
 |_| |_|\___/|_| |_| |_|\___|____/ \___/_/\_\

 Your own apps, on your own box. Nothing phones home.
BANNER
printf ' %ssource:%s %s@%s\n' "$DIM" "$RESET" "$HB_REPO" "$HB_REF"
if [ "$HB_REF_ASKED" -eq 0 ] && [ "$HB_REF" = main ]; then
  warn "no release found (manifest unreachable, no tags) — installing the development branch"
fi
if [ "$HB_FROZEN" -eq 1 ]; then
  warn "the maintainer has paused updates in releases/manifest.json — installing ${HB_REF} anyway; check the project page first"
fi

# --------------------------------------------------------------- 1. checks

[ "$(id -u)" -eq 0 ] || die "run this with sudo — it writes to $HB_ROOT and installs packages"

. /etc/os-release 2>/dev/null || die "cannot read /etc/os-release — this expects Debian or Ubuntu"
case "${ID:-}${ID_LIKE:-}" in
  *debian*|*ubuntu*) ;;
  *) warn "${PRETTY_NAME:-this OS} is not Debian or Ubuntu — continuing, but the package steps may not fit" ;;
esac

case "$(uname -m)" in
  x86_64|aarch64|arm64) ;;
  *) die "unsupported architecture: $(uname -m)" ;;
esac

export DEBIAN_FRONTEND=noninteractive
for tool in curl tar git; do
  command -v "$tool" >/dev/null 2>&1 || { apt-get update -qq; apt-get install -y -qq "$tool"; }
done

# --------------------------------------------------- 2. refuse to clobber

# An existing install has .env in it — every generated password on that box.
# Unpacking over it would not delete the file, but this is not an upgrade path
# and pretending it is would be how someone loses a working box.
if [ -e "$HB_ROOT/.env" ]; then
  die "$HB_ROOT is already a HomeBox install.
To update it in place:      cd $HB_ROOT && git pull && sudo bash install.sh
To start over, move it out of the way first:
  sudo mv $HB_ROOT ${HB_ROOT}.old"
fi

# ------------------------------------------------------------ 3. download

# A clone, not a tarball download.
#
# The documented way to update a box is `cd /opt/homebox && git pull`, and a
# tarball makes that a lie — the first install left no .git, so the command in
# the README failed with "not a repository" on a box that was working fine.
# Cloning costs one apt package and makes updating, checking what version is
# running, and seeing local edits all work the obvious way.
#
# HB_TARBALL is still honoured for a network with no route to GitHub; that
# path has no .git, and says so at the end.
if [ "$HB_TARBALL_ASKED" -eq 1 ]; then
  step "Downloading HomeBox"
  printf '  %s\n' "$HB_TARBALL"
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  curl -fsSL --connect-timeout 15 --max-time 300 "$HB_TARBALL" -o "$TMP/homebox.tar.gz" \
    || die "could not download $HB_TARBALL"
  # A wrong URL usually returns an HTML error page, and `tar` then fails with
  # something unhelpful. Say what actually happened instead.
  tar -tzf "$TMP/homebox.tar.gz" >/dev/null 2>&1 \
    || die "what came back is not a tarball — check the address"
  mkdir -p "$HB_ROOT"
  tar -xzf "$TMP/homebox.tar.gz" -C "$HB_ROOT" --strip-components=1
  FROM_TARBALL=1
else
  step "Cloning $HB_REPO ($HB_REF)"
  # --depth 1: nobody needs the history of a box they are installing, and it
  # turns a clone into about a second. `git pull` still works on a shallow
  # clone, which is the whole point of doing it this way.
  if [ -d "$HB_ROOT" ] && [ -n "$(ls -A "$HB_ROOT" 2>/dev/null)" ]; then
    die "$HB_ROOT already has files in it. Move it aside first:  sudo mv $HB_ROOT ${HB_ROOT}.old"
  fi
  git clone --quiet --depth 1 --branch "$HB_REF" "https://github.com/${HB_REPO}.git" "$HB_ROOT" \
    || die "could not clone https://github.com/${HB_REPO}.git ($HB_REF)
Check the repository and branch exist and are reachable from here."
  FROM_TARBALL=0
  printf '  %s\n' "$(cd "$HB_ROOT" && git log -1 --format='%h %s' 2>/dev/null || echo cloned)"
fi

[ -f "$HB_ROOT/install.sh" ] || die "what arrived has no install.sh — nothing was installed"
chmod +x "$HB_ROOT/homebox" "$HB_ROOT/install.sh" "$HB_ROOT"/scripts/*.sh 2>/dev/null || true
chown -R "$HB_USER:$HB_USER" "$HB_ROOT"
printf '  %s v%s\n' "$HB_ROOT" "$(cat "$HB_ROOT/VERSION" 2>/dev/null || echo '?')"
if [ "${FROM_TARBALL:-0}" -eq 1 ]; then
  warn "installed from a tarball, so there is no git checkout here."
  warn "This box CANNOT update itself — no Updates button, no \`homebox self-update\`."
  warn "Update by re-running this into a clean directory."
elif [ ! -d "$HB_ROOT/.git" ]; then
  # Belt and braces. A clone that leaves no .git is not a working install, it
  # is a box that will look fine for weeks and then quietly never update — the
  # exact failure a wrong tarball/clone decision produced once already, on a
  # string comparison nobody thought of as load-bearing.
  die "the clone left no .git in $HB_ROOT.
This box would install correctly and then never be able to update itself,
so nothing is being installed. Please report this."
fi

# ------------------------------------------------------------- 4. install

# Stop here with HB_FETCH_ONLY=1 — for reading the tree before anything is
# installed, and for testing this script where installing Docker is not the
# part under test.
if [ -n "${HB_FETCH_ONLY:-}" ]; then
  step "Fetched only, as asked"
  printf '  %s is ready. Run the installer when you want it:\n    sudo bash %s/install.sh\n' "$HB_ROOT" "$HB_ROOT"
  exit 0
fi

step "Handing over to the installer"
HB_ROOT="$HB_ROOT" HB_USER="$HB_USER" bash "$HB_ROOT/install.sh"
