'use strict';
/**
 * Small JSON files under /opt/homebox/state, written atomically.
 *
 * Everything here is dashboard-owned state (UI preferences, activity log).
 * The enabled-module list lives in state/modules.conf as plain lines so the
 * `homebox` CLI and the dashboard can both read it without either owning a
 * format the other has to parse.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const ROOT = process.env.HOMEBOX_ROOT || '/opt/homebox';
const STATE_DIR = path.join(ROOT, 'state');

function ensureDir() {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
  } catch {
    /* read-only state dir: reads still work, writes will report their own error */
  }
}

async function readJson(name, fallback) {
  try {
    return JSON.parse(await fsp.readFile(path.join(STATE_DIR, name), 'utf8'));
  } catch {
    return fallback;
  }
}

/**
 * Write to a sibling temp file and rename over the target. A crash mid-write
 * then leaves the previous good file rather than a truncated one — the same
 * reason the rest of this box uses atomic writes for config.
 */
/**
 * State files that must not be world-readable.
 *
 * auth.json holds the password hash and every live session id — and a session
 * id IS the credential, so anyone able to read this file can paste one into a
 * cookie and be signed in. The rest of state/ (prefs, the activity log, the
 * catalog, bookmarks) is uninteresting and stays readable.
 */
const SECRET_FILES = new Set(['auth.json']);

async function writeJson(name, value) {
  ensureDir();
  const target = path.join(STATE_DIR, name);
  const tmp = `${target}.tmp-${process.pid}`;
  const mode = SECRET_FILES.has(name) ? 0o600 : 0o644;
  // The mode is set at creation and again explicitly, because `mode` in
  // writeFile is masked by the process umask. A file that is world-readable
  // for even a moment was world-readable.
  await fsp.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode });
  await fsp.chmod(tmp, mode);
  await fsp.rename(tmp, target);
  await matchDirOwner(target);
}

/**
 * The dashboard runs as root inside its container so it can open the Docker
 * socket, which means anything it writes into the bind-mounted state
 * directory lands root-owned — and the account that owns /opt/homebox can no
 * longer edit or delete its own files. Hand each file back to whoever owns
 * the directory.
 */
async function matchDirOwner(file) {
  try {
    const dir = await fsp.stat(STATE_DIR);
    const target = await fsp.stat(file);
    if (target.uid === dir.uid && target.gid === dir.gid) return;
    await fsp.chown(file, dir.uid, dir.gid);
  } catch {
    /* not root, or a filesystem that will not chown - the write still stands */
  }
}

/** Enabled module ids, one per line, blank lines and # comments ignored. */
function readEnabled() {
  try {
    return fs
      .readFileSync(path.join(STATE_DIR, 'modules.conf'), 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
  } catch {
    return null; // no file yet — caller decides what "enabled" means
  }
}

module.exports = { ROOT, STATE_DIR, readJson, writeJson, readEnabled };
