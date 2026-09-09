'use strict';
/**
 * "Is there a newer HomeBox, and may this box take it?"
 *
 * lib/updates.js answers that question for the CONTAINER IMAGES an app runs on.
 * This file answers it for HomeBox itself — the dashboard, the CLI, the module
 * definitions, everything tracked in git.
 *
 * WHY THIS EXISTS AT ALL
 *
 * A HomeBox given to someone else is a product with an install base. The update
 * path used to be `git pull && sudo bash install.sh` typed over SSH, which is
 * fine for whoever wrote it and unusable for anyone else. Worse, tracking `main`
 * means every push lands on their box, including the twenty minutes between
 * committing something broken and fixing it.
 *
 * So releases are annotated git tags, and a box moves between tags on purpose.
 *
 * WHAT THIS FILE DOES NOT DO
 *
 * It does not perform the update. `git` is not installed in the dashboard
 * container, and even if it were, the update REBUILDS THE DASHBOARD — a process
 * cannot recreate the container it is running in without being killed halfway.
 * `upgrade()` launches scripts/self-update.sh on the host through a detached
 * sibling container and returns immediately; the outcome arrives through a file
 * in state/, which is the only channel that survives the restart.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const https = require('https');
const path = require('path');

const storage = require('./storage');
const state = require('./state-store');
const versions = require('./versions');

const ROOT = state.ROOT;
const CACHE_FILE = path.join(state.STATE_DIR, 'platform-update.json');
const PROGRESS_FILE = path.join(state.STATE_DIR, 'platform-progress.json');
const HISTORY_FILE = path.join(state.STATE_DIR, 'platform-history.json');
const LOCK_FILE = path.join(state.STATE_DIR, 'platform-update.lock');

const REPO = process.env.HB_REPO || 'abeksis/HomeBox';
const MANIFEST_URL = process.env.HB_MANIFEST_URL
  || `https://raw.githubusercontent.com/${REPO}/main/releases/manifest.json`;

/** Same six hours the image check uses. A release is not an emergency. */
const STALE_AFTER_MS = 6 * 60 * 60 * 1000;
const HISTORY_LIMIT = 20;

/* ------------------------------------------------------------------ http */

/**
 * One small https GET. Node's own module, no curl — which is absent from this
 * image anyway, and a dependency would break the zero-dependency rule the rest
 * of the server keeps.
 */
function get(url, { headers = {}, timeout = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'user-agent': 'homebox-platform/1', accept: 'application/json', ...headers },
      timeout,
    }, (res) => {
      let body = '';
      // 304 has no body and is not a failure — it means the cached copy stands.
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; if (body.length > 512 * 1024) req.destroy(); });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('timeout', () => { req.destroy(); reject(new Error(`${url} timed out`)); });
    req.on('error', reject);
  });
}

/* --------------------------------------------------------------- versions */

// Plain N.N.N only, for now.
//
// versions.compareSameShape counts the digits in a string, which is right for
// image tags and wrong for a pre-release: "0.3.0-rc1" reads as [0,3,0,1] and
// therefore sorts ABOVE "0.3.0". Until the canary channel needs it, anything
// that is not three numbers is refused rather than mis-ordered.
const SEMVER = /^\d+\.\d+\.\d+$/;

function isVersion(v) {
  return typeof v === 'string' && SEMVER.test(v.trim());
}

/** > 0 when a is newer than b. Delegates the comparison itself. */
function compare(a, b) {
  return versions.compareSameShape(a, b);
}

function localVersion() {
  try {
    return fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim();
  } catch {
    return '0.0.0';
  }
}

/* ----------------------------------------------------------------- state */

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await fsp.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
  await fsp.rename(tmp, file);
}

const readHistory = () => readJson(HISTORY_FILE, []);

/** Written by self-update.sh as it goes. The only news that crosses a restart. */
const readProgress = () => readJson(PROGRESS_FILE, null);

/* ----------------------------------------------------------------- check */

/**
 * Fetch the manifest and decide what this box may do.
 *
 * Order matters: freeze is evaluated BEFORE the version comparison, so a
 * release discovered to be bad stops being offered even to a box that has
 * already seen it advertised.
 */
async function check({ force = false } = {}) {
  const cached = await readJson(CACHE_FILE, null);
  if (!force && cached && Date.now() - (cached.checkedAt || 0) < STALE_AFTER_MS) return cached;

  const current = localVersion();
  const result = {
    checkedAt: Date.now(),
    current,
    latest: null,
    updateAvailable: false,
    frozen: false,
    reason: null,
    notes: null,
    error: null,
  };

  let manifest;
  try {
    const res = await get(MANIFEST_URL, cached && cached.etag ? { headers: { 'if-none-match': cached.etag } } : {});
    if (res.status === 304 && cached) {
      return { ...cached, checkedAt: Date.now() };
    }
    if (res.status !== 200) throw new Error(`manifest answered ${res.status}`);
    manifest = JSON.parse(res.body);
    result.etag = res.headers.etag || null;
  } catch (err) {
    // Offline is not a failure worth shouting about — a box behind a dead
    // link is not broken, it is just not updating today.
    result.error = err.message;
    await writeJson(CACHE_FILE, result);
    return result;
  }

  if (manifest.freeze === true) {
    result.frozen = true;
    result.reason = manifest.freeze_reason || 'Updates are paused by the maintainer.';
    await writeJson(CACHE_FILE, result);
    return result;
  }

  const channel = manifest.channels && manifest.channels.stable;
  if (!isVersion(channel)) {
    result.error = `manifest names no usable stable version (${channel})`;
    await writeJson(CACHE_FILE, result);
    return result;
  }
  result.latest = channel;

  const floor = manifest.min_from_version;
  if (isVersion(floor) && isVersion(current) && compare(current, floor) < 0) {
    // Deliberately not offered as a button: the migrations that would carry
    // this box forward no longer ship, so the automated path cannot be honest
    // about what it would do.
    result.reason = `This box is on ${current}, and releases only carry forward from ${floor}. `
      + 'It needs a manual update — see docs/RELEASING.md.';
    await writeJson(CACHE_FILE, result);
    return result;
  }

  if (isVersion(current) && compare(channel, current) > 0) {
    result.updateAvailable = true;
    result.notes = await releaseNotes(channel);
  }

  await writeJson(CACHE_FILE, result);
  return result;
}

/**
 * Release notes from GitHub. Best effort, never fatal.
 *
 * Unauthenticated the API allows 60 requests an hour per IP; a six-hourly check
 * that only asks when there is something new spends four a day.
 */
async function releaseNotes(version) {
  const tag = `v${version}`;

  // A published GitHub Release, if there is one. Richer, and the place a
  // person would naturally write for an audience.
  try {
    const res = await get(`https://api.github.com/repos/${REPO}/releases/tags/${tag}`);
    if (res.status === 200) {
      const body = JSON.parse(res.body);
      if (body.body) {
        return { name: body.name || null, body: body.body, url: body.html_url || null };
      }
    }
  } catch { /* fall through to the tag */ }

  // Otherwise the ANNOTATED TAG'S OWN MESSAGE.
  //
  // Cutting a release already requires writing one — `git tag -a` will not let
  // you skip it — so the text exists before anyone thinks about release notes.
  // Publishing a Release object on top is a separate step through a web form,
  // and a separate step is a step that gets forgotten on the release where it
  // mattered. This makes the card say something useful by default, and a
  // proper Release still wins when there is one.
  //
  // Two calls: the ref names the tag object, the tag object carries the
  // message. A lightweight tag points straight at a commit and has no message
  // at all, which is one more reason releases here are annotated.
  try {
    const ref = await get(`https://api.github.com/repos/${REPO}/git/ref/tags/${tag}`);
    if (ref.status !== 200) return null;
    const obj = JSON.parse(ref.body).object || {};
    if (obj.type !== 'tag' || !obj.sha) return null;

    const res = await get(`https://api.github.com/repos/${REPO}/git/tags/${obj.sha}`);
    if (res.status !== 200) return null;
    const body = JSON.parse(res.body);
    const message = String(body.message || '').trim();
    if (!message) return null;

    // First line is the headline the way a commit subject is; the rest is the
    // detail. Strip the headline from the body so the card does not say it
    // twice.
    const [first, ...rest] = message.split('\n');
    return {
      name: first,
      body: rest.join('\n').trim() || null,
      url: `https://github.com/${REPO}/releases/tag/${tag}`,
    };
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------------- status */

async function status() {
  const [cached, progress, history] = await Promise.all([
    readJson(CACHE_FILE, null),
    readProgress(),
    readHistory(),
  ]);

  // Never checked, so there is nothing to report and nothing to report it.
  //
  // This is not theoretical: the check was not on any schedule before 0.2.7,
  // so a box could sit for weeks with an update waiting and a card that never
  // appeared, because the card renders the CACHED answer and the cache was
  // never written. Kick one off in the background — this call still returns
  // immediately with what it has, and the next one has something to say.
  if (!cached) {
    check().catch(() => {});
  }
  // What this box is on, read NOW rather than taken from the cache.
  //
  // The cached answer records the version at the time of the check, and an
  // update changes that version without invalidating the cache. So a box that
  // had just updated to 0.2.8 kept offering 0.2.8 and describing itself as
  // 0.2.4 — for up to six hours, until the next check happened to run. The
  // card was reporting a true fact about the past.
  //
  // latest still comes from the cache, because that genuinely is the last
  // thing the manifest said. Only "where am I" is re-read, and the
  // availability is recomputed from the two.
  const current = localVersion();
  const base = cached || { latest: null, frozen: false, reason: null, notes: null };
  const available = !base.frozen
    && !base.reason
    && isVersion(base.latest)
    && isVersion(current)
    && compare(base.latest, current) > 0;

  return {
    ...base,
    current,
    updateAvailable: available,
    running: !!(progress && progress.phase && !['done', 'failed'].includes(progress.phase)),
    progress,
    history: history.slice(0, HISTORY_LIMIT),
  };
}

/* --------------------------------------------------------------- upgrade */

/**
 * Start the update and get out of the way.
 *
 * This does NOT wait for the result. The script it launches rebuilds the
 * dashboard, so the process making this call is about to be terminated by its
 * own request — awaiting it would be waiting to be killed. The client polls
 * status() instead, and has to expect the connection to fail for a while.
 */
async function upgrade({ to = null } = {}) {
  const current = await check({ force: true });
  if (current.frozen) throw new Error(current.reason || 'updates are paused by the maintainer');
  const target = to || current.latest;
  if (!isVersion(target)) throw new Error('no release to move to');
  if (!current.updateAvailable && !to) throw new Error(`already on ${current.current}`);

  if (fs.existsSync(LOCK_FILE)) {
    const progress = await readProgress();
    if (progress && !['done', 'failed'].includes(progress.phase)) {
      throw new Error(`an update is already running (${progress.phase})`);
    }
  }

  await writeJson(PROGRESS_FILE, {
    phase: 'starting',
    from: current.current,
    to: target,
    startedAt: new Date().toISOString(),
    lines: [],
  });

  // On the HOST, not in here: git is not installed in this image, and the
  // script's whole job is to replace the code this process is running.
  // Detached, because that includes rebuilding this container.
  await storage.onHostDetached(['bash', `${ROOT}/scripts/self-update.sh`, target], {
    name: 'homebox-self-update',
  });

  return { ok: true, from: current.current, to: target };
}

module.exports = {
  check, status, upgrade, readHistory, readProgress,
  localVersion, isVersion, compare,
  STALE_AFTER_MS, PROGRESS_FILE, LOCK_FILE, HISTORY_FILE,
};
