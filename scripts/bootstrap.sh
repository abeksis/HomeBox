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

# The newest RELEASE, not the development branch.
#
# This used to default to `main`, which meant every new install got whatever
# had been pushed most recently — including the twenty minutes between
# committing something broken and noticing. That is an acceptable way to run
# your own box and not a way to give one to somebody else.
#
# `git ls-remote --sort=-v:refname` asks GitHub for the tags in version order
# and takes the first. If that fails — no tags yet, or no network — it falls
# back to main, because an install that refuses to start is worse than one
# that starts on the dev branch and says so.
default_ref() {
  local tag
  tag="$(git ls-remote --tags --refs --sort=-v:refname "https://github.com/${HB_REPO}.git" 2>/dev/null \
    | head -1 | sed 's|.*refs/tags/||')"
  if [ -n "$tag" ]; then printf '%s' "$tag"; else printf 'main'; fi
}
HB_REF="${HB_REF:-$(default_ref)}"
# refs/heads for a branch, refs/tags for a release. This used to be hardcoded
# to refs/heads, which was correct while HB_REF defaulted to `main` and became
# a 404 the moment it defaulted to a tag.
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
if [ -n "${HB_TARBALL_OVERRIDE:-}" ] || [ "${HB_TARBALL}" != "https://codeload.github.com/${HB_REPO}/tar.gz/refs/heads/${HB_REF}" ]; then
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
  warn "\`git pull\` will not work — update by re-running this into a clean directory."
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
