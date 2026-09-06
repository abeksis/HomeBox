'use strict';
/**
 * Icons given as a URL are downloaded and kept here, not hot-linked.
 *
 * A remote icon is a permanent dependency on somebody else's server for a
 * 3KB file: it breaks when that host is down, when the repo is renamed, when
 * a pinned commit is garbage-collected, and on any box whose dashboard is
 * reachable but whose internet is not. It also costs a round trip to a third
 * party on every page view, which is the one thing a LAN dashboard should
 * never need.
 *
 * Files land in `<root>/state/icons`, NOT in `dashboard/public/icons`: public/
 * is copied into the image at build time, so anything written there is lost
 * on the next rebuild. state/ is on the bind mount and survives.
 *
 * Names are content-addressed — sha256 of the bytes — so the same icon given
 * twice is stored once, and a name can be cached forever because it can only
 * ever mean one file.
 */

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const state = require('./state-store');

const DIR = path.join(state.ROOT, 'state', 'icons');
const PREFIX = 'user-icons/';
const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 10000;
const MAX_REDIRECTS = 3;

// Only formats a browser will actually draw in an <img>.
const EXT_FOR = {
  'image/svg+xml': 'svg',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
};

const isRemote = (value) => /^https?:\/\//i.test(String(value || '').trim());
const isLocal = (value) => new RegExp(`^${PREFIX}[a-f0-9]{16}\\.[a-z]{3,4}$`).test(String(value || '').trim());

/** GET a URL, following a few redirects, with a hard cap on size and time. */
function get(url, redirectsLeft = MAX_REDIRECTS) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      reject(new Error(`that is not a URL: ${url}`));
      return;
    }
    // http/https only — a redirect chain must not land on file: or data:.
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      reject(new Error(`icons can only be fetched over http or https, not ${parsed.protocol}`));
      return;
    }

    const lib = require(parsed.protocol === 'https:' ? 'https' : 'http');
    const req = lib.get(parsed, { timeout: TIMEOUT_MS, headers: { accept: 'image/*' } }, (res) => {
      const { statusCode, headers } = res;

      if (statusCode >= 300 && statusCode < 400 && headers.location) {
        res.resume();
        if (!redirectsLeft) { reject(new Error('too many redirects fetching that icon')); return; }
        resolve(get(new URL(headers.location, parsed).toString(), redirectsLeft - 1));
        return;
      }
      if (statusCode !== 200) {
        res.resume();
        reject(new Error(`that URL answered ${statusCode}`));
        return;
      }

      const type = String(headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      const ext = EXT_FOR[type];
      if (!ext) {
        res.resume();
        reject(new Error(`that URL is ${type || 'not an image'} — an icon has to be a PNG, SVG, JPEG, WebP, GIF or ICO`));
        return;
      }

      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BYTES) {
          req.destroy();
          reject(new Error(`that icon is larger than ${MAX_BYTES / 1024 / 1024}MB`));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => resolve({ body: Buffer.concat(chunks), ext }));
    });

    req.on('timeout', () => { req.destroy(); reject(new Error('that URL did not answer in time')); });
    req.on('error', (err) => reject(new Error(`could not fetch that icon: ${err.message}`)));
  });
}

/**
 * Take whatever the icon field holds and return what should be stored.
 *
 * A URL is downloaded and replaced with its local path. Anything else — an
 * emoji, a shipped filename, an already-cached icon — is returned untouched.
 */
async function localise(value) {
  const icon = String(value || '').trim();
  if (!icon || !isRemote(icon) || isLocal(icon)) return icon;

  const { body, ext } = await get(icon);
  const name = `${crypto.createHash('sha256').update(body).digest('hex').slice(0, 16)}.${ext}`;

  const fresh = !fs.existsSync(DIR);
  await fsp.mkdir(DIR, { recursive: true });
  // The dashboard runs as root in its container, so a directory it creates on
  // the bind mount is root-owned and the login user cannot clean it up. Same
  // reason .env is chowned after a write.
  if (fresh) await matchOwner(DIR);
  const file = path.join(DIR, name);
  // Content-addressed: if it is already there it is byte-identical, so
  // rewriting it would only risk truncating a file something is serving.
  if (!fs.existsSync(file)) {
    const tmp = `${file}.tmp-${process.pid}`;
    await fsp.writeFile(tmp, body);
    await fsp.rename(tmp, file);
    await matchOwner(file);
  }
  return PREFIX + name;
}

async function matchOwner(file) {
  try {
    const root = await fsp.stat(state.ROOT);
    await fsp.chown(file, root.uid, root.gid);
  } catch { /* not root, or a filesystem that will not chown */ }
}

/** Resolve a stored `user-icons/<name>` to a path on disk, or null. */
function resolve(name) {
  if (!/^[a-f0-9]{16}\.[a-z]{3,4}$/.test(name || '')) return null;
  const file = path.join(DIR, name);
  return fs.existsSync(file) ? file : null;
}

/** Cached icons no module or override refers to any more. */
async function unused(referenced) {
  const keep = new Set([...referenced].filter(isLocal).map((v) => v.slice(PREFIX.length)));
  try {
    return (await fsp.readdir(DIR)).filter((f) => !keep.has(f) && !f.includes('.tmp-'));
  } catch {
    return [];
  }
}

module.exports = { localise, resolve, unused, isRemote, isLocal, DIR, PREFIX };
