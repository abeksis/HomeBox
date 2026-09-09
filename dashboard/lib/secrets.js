'use strict';
/**
 * Generate the secrets a module declares, at the moment it is installed.
 *
 * install.sh already sweeps every module's `x-homebox.env_vars` for
 * `type: secret` and fills in what .env is missing. That runs ONCE, when the
 * box is built, and it covers every module present in the repo at that
 * moment.
 *
 * It does not cover a module added later. `git pull` brings new modules whose
 * keys were never swept, and compose then falls back to whatever default the
 * file names:
 *
 *   POSTGRES_PASSWORD=${JELLYSTAT_DB_PASSWORD:-jellystat}   -> "jellystat"
 *   JWT_SECRET=${JELLYSTAT_JWT_SECRET:-}                    -> ""
 *
 * The first is a real database password of "jellystat"; the second crashed
 * the container on a loop, because jsonwebtoken refuses to sign with an empty
 * secret. One of those tells you loudly and one does not, which is the worse
 * half.
 *
 * So generate at install time as well. Both install paths call this — the CLI
 * through `node -e`, the dashboard directly — because there are two of them
 * and a fix in one is a fix in neither.
 */

const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const state = require('./state-store');
const yaml = require('./yaml');

const ENV_FILE = path.join(state.ROOT, '.env');
const MODULES_DIR = path.join(state.ROOT, 'modules');

// Same shape install.sh produces: url-safe, no quoting surprises in a shell
// or in compose interpolation.
function rand(bytes = 24) {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** The `type: secret` keys a module declares, minus the ones it does not own. */
function declaredBy(id) {
  const file = path.join(MODULES_DIR, id, 'docker-compose.yml');
  if (!fs.existsSync(file)) return [];
  let meta;
  try {
    meta = yaml.extractTopLevel(fs.readFileSync(file, 'utf8'), 'x-homebox');
  } catch {
    return [];
  }
  const vars = (meta && meta.env_vars) || {};
  return Object.entries(vars)
    .filter(([key, spec]) => {
      if (!spec || spec.type !== 'secret') return false;
      // Issued elsewhere — a Cloudflare tunnel token, a third-party API key.
      // Filling those with random bytes produces a container that cannot
      // authenticate and a field where a placeholder is indistinguishable
      // from something the user set.
      if (spec.generated === false) return false;
      return /^[A-Z][A-Z0-9_]*$/.test(key);
    })
    .map(([key]) => key);
}

function valueFrom(lines, key) {
  const prefix = `${key}=`;
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith('#') || !t.startsWith(prefix)) continue;
    return t.slice(prefix.length).replace(/^["']|["']$/g, '');
  }
  return '';
}

/**
 * Fill in any declared secret this box has no value for. Never overwrites:
 * regenerating a secret an app has already used to encrypt something is how
 * you lose the thing it protects.
 *
 * Returns the key names that were created, for the install transcript.
 */
async function ensureFor(id) {
  const keys = declaredBy(id);
  if (!keys.length) return [];

  let lines;
  try {
    lines = (await fsp.readFile(ENV_FILE, 'utf8')).split(/\r?\n/);
  } catch {
    return [];
  }

  const added = [];
  for (const key of keys) {
    if (valueFrom(lines, key)) continue;
    const at = lines.findIndex((l) => l.trim().startsWith(`${key}=`) && !l.trim().startsWith('#'));
    if (at === -1) {
      // Before any trailing blank lines, so the file does not grow a gap per
      // install.
      let end = lines.length;
      while (end > 0 && lines[end - 1].trim() === '') end -= 1;
      lines.splice(end, 0, `${key}=${rand()}`);
    } else {
      lines[at] = `${key}=${rand()}`;
    }
    added.push(key);
  }
  if (!added.length) return [];

  const tmp = `${ENV_FILE}.tmp-${process.pid}`;
  await fsp.writeFile(tmp, `${lines.join('\n').replace(/\n+$/, '')}\n`, { mode: 0o600 });
  await fsp.rename(tmp, ENV_FILE);

  // Keep .env owned by whoever owned it: the dashboard runs as root and would
  // otherwise leave a file the login user can no longer read.
  try {
    const st = await fsp.stat(path.join(state.ROOT, 'modules'));
    await fsp.chown(ENV_FILE, st.uid, st.gid);
  } catch { /* best effort — mode 600 is the part that matters */ }
  await fsp.chmod(ENV_FILE, 0o600);

  return added;
}

/**
 * Drop a module's declared secrets from .env. For a purge only.
 *
 * A purge deletes the config directory; leaving the keys that protected it
 * behind is not a wipe, it is a wipe with the locks still hanging on the
 * wall. It also means a reinstall silently reuses a secret whose data is
 * gone, because ensureFor() will not overwrite an existing value.
 *
 * Every key here belongs to exactly one module — config.js enforces that when
 * it builds the Settings groups — so this cannot take a key another app is
 * still using. `generated: false` keys go too: on a purge, a token the user
 * pasted is config, and config is what a purge removes.
 */
async function forgetFor(id) {
  const file = path.join(MODULES_DIR, id, 'docker-compose.yml');
  if (!fs.existsSync(file)) return [];
  let meta;
  try {
    meta = yaml.extractTopLevel(fs.readFileSync(file, 'utf8'), 'x-homebox');
  } catch {
    return [];
  }
  const vars = (meta && meta.env_vars) || {};
  const keys = Object.entries(vars)
    .filter(([key, spec]) => spec && spec.type === 'secret' && /^[A-Z][A-Z0-9_]*$/.test(key))
    .map(([key]) => key);
  if (!keys.length) return [];

  let lines;
  try {
    lines = (await fsp.readFile(ENV_FILE, 'utf8')).split(/\r?\n/);
  } catch {
    return [];
  }

  const dropped = [];
  const kept = lines.filter((line) => {
    const t = line.trim();
    if (t.startsWith('#')) return true;
    const hit = keys.find((k) => t.startsWith(`${k}=`));
    if (!hit) return true;
    dropped.push(hit);
    return false;
  });
  if (!dropped.length) return [];

  const tmp = `${ENV_FILE}.tmp-${process.pid}`;
  await fsp.writeFile(tmp, `${kept.join('\n').replace(/\n+$/, '')}\n`, { mode: 0o600 });
  await fsp.rename(tmp, ENV_FILE);
  try {
    const st = await fsp.stat(MODULES_DIR);
    await fsp.chown(ENV_FILE, st.uid, st.gid);
  } catch { /* best effort */ }
  await fsp.chmod(ENV_FILE, 0o600);

  return dropped;
}

module.exports = { ensureFor, forgetFor, declaredBy };
