'use strict';
/**
 * The Updates page: find containers running an image the registry has since
 * rebuilt, and — only when you say so — update them one at a time.
 *
 * WHAT THIS FINDS, AND WHAT IT DOES NOT
 *
 * Every module in this repo pins an exact tag. That was a deliberate choice
 * and it stays: a box that silently jumps a major version overnight is a box
 * that breaks overnight. So this never changes the tag in a compose file.
 *
 * What it does find is the case a pinned tag does NOT protect you from: the
 * publisher re-pushing the SAME tag with a patched base layer. `pihole:2026.07.2`
 * today and `pihole:2026.07.2` six weeks from now can be different bytes, and
 * the second one is where the CVE fixes went. Only the digest shows it, which
 * is why lib/registry.js asks the registry for the digest instead of trusting
 * `docker compose pull` to notice.
 *
 * Moving to a genuinely newer version is a HomeBox release — `git pull` and
 * `homebox update`, with the compose file, the config migration and the
 * release note all arriving together.
 *
 * HOW AN UPDATE IS APPLIED
 *
 * One service at a time, in this order, stopping at the first thing that goes
 * wrong: back up the module's config, record the image currently running,
 * pull, recreate only that service, then watch it until it is healthy. If it
 * does not come back healthy, the recorded image is re-tagged and the service
 * recreated from it — the box ends up where it started rather than half
 * updated. Nothing is touched until the confirmation comes back from the UI.
 */

const fsp = require('fs/promises');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const docker = require('./docker');
const composeLib = require('./compose');
const registry = require('./registry');
const modulesLib = require('./modules');

const state = require('./state-store');
const activity = require('./activity');

const CACHE_FILE = 'updates.json';
const HISTORY_FILE = 'update-history.json';
const BACKUP_DIR = path.join(state.ROOT, 'state', 'update-backups');

// How long a check stays worth showing before the page quietly refreshes it.
// An hour is the source's window too: long enough not to hammer Docker Hub's
// rate limit on every tab switch, short enough that what you are looking at
// is not yesterday's answer.
const STALE_AFTER_MS = 60 * 60 * 1000;

// How long a recreated container gets to report itself healthy before the
// update is called a failure and rolled back.
const HEALTH_TIMEOUT_MS = 120000;

const HISTORY_MAX = 50;

// Checking every image at once means a dozen simultaneous TLS handshakes and,
// on Docker Hub, a much better chance of a 429 for the whole batch.
const CONCURRENCY = 4;

let checking = false;
let applying = false;

/* ------------------------------------------------------------------ state */

const readCache = () => state.readJson(CACHE_FILE, {
  lastCheck: null, available: [], skipped: [], checked: 0, containers: 0,
});

const readHistory = async () => {
  const raw = await state.readJson(HISTORY_FILE, []);
  return Array.isArray(raw) ? raw : [];
};

async function note(entry) {
  const history = await readHistory();
  history.unshift({ timestamp: new Date().toISOString(), ...entry });
  await state.writeJson(HISTORY_FILE, history.slice(0, HISTORY_MAX));
}

/* ------------------------------------------------------------- the check */

/**
 * Services their module builds on this box rather than pulling.
 *
 * The dashboard is the obvious one, and it is a trap: buildkit records a
 * RepoDigest for a locally built image too, so "does it have a digest?" is
 * not the question — asked that way we cheerfully went off to Docker Hub
 * looking for `library/homebox-dashboard` and reported a 401 as if the
 * registry were down. The compose file already says which services are
 * built; that is the answer, and it costs one read.
 *
 * Scanned rather than parsed: lib/yaml.js exists to lift the x-homebox block
 * out of a compose file, not to parse the whole of one — a real compose file
 * has flow collections and anchors it refuses, by design. All that is needed
 * here is "which service keys have a `build:` under them", and indentation
 * answers that without pretending to be a YAML implementation.
 */
function builtServices(moduleId) {
  const built = new Set();
  let text;
  try {
    text = fs.readFileSync(path.join(state.ROOT, 'modules', moduleId, 'docker-compose.yml'), 'utf8');
  } catch {
    return built;   // unreadable: let the digest comparison speak for itself
  }

  let inServices = false;
  let serviceIndent = null;
  let current = null;

  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || /^\s*#/.test(raw)) continue;
    const indent = raw.length - raw.trimStart().length;

    if (indent === 0) {
      inServices = /^services\s*:/.test(raw);
      serviceIndent = null;
      current = null;
      continue;
    }
    if (!inServices) continue;

    if (serviceIndent === null) serviceIndent = indent;
    if (indent === serviceIndent) {
      const name = /^([A-Za-z0-9_.-]+)\s*:/.exec(raw.trim());
      current = name ? name[1] : null;
    } else if (current && indent > serviceIndent && /^build\s*:/.test(raw.trim())) {
      built.add(current);
    }
  }
  return built;
}

/**
 * Every service this box runs that HomeBox owns, paired with the image its
 * container is actually running.
 *
 * Scoped to `homebox-*` compose projects: containers someone started by hand
 * are not ours to recreate, and offering an Update button for them would be
 * offering to restart something we know nothing about.
 */
async function targets() {
  const containers = await docker.listContainers();
  const { modules } = await modulesLib.loadAll();
  const titles = new Map(modules.map((m) => [m.id, m.title]));
  const builds = new Map();

  const out = [];
  for (const c of containers) {
    if (!c.project || !c.project.startsWith('homebox-')) continue;
    if (c.state === 'stopped') continue;      // nothing to update on a stopped app
    const moduleId = c.project.slice('homebox-'.length);
    if (!c.service || !titles.has(moduleId)) continue;
    if (!builds.has(moduleId)) builds.set(moduleId, builtServices(moduleId));
    if (builds.get(moduleId).has(c.service)) continue;
    out.push({
      module: moduleId,
      title: titles.get(moduleId),
      service: c.service,
      container: c.name,
      image: c.image,
      imageId: c.imageId,
    });
  }
  return out;
}

/** The digest this container's image was pulled under, or null if built here. */
async function localDigest(target, ref) {
  const digests = await docker.imageDigests(target.imageId || target.image);
  for (const entry of digests) {
    const at = entry.lastIndexOf('@');
    if (at < 0) continue;
    // Match the repository, so a multi-registry image cannot answer with the
    // wrong one. Compare loosely: a Docker Hub image is tagged `redis` locally
    // but its digest reads `docker.io/library/redis@sha256:...`.
    const repo = entry.slice(0, at);
    if (repo.endsWith(ref.repo) || ref.repo.endsWith(repo.replace(/^docker\.io\//, ''))) {
      return entry.slice(at + 1);
    }
  }
  return digests.length === 1 ? digests[0].slice(digests[0].lastIndexOf('@') + 1) : null;
}

async function checkOne(target) {
  const ref = registry.parseRef(target.image);
  if (!ref) {
    return { ...target, skipped: 'pinned-digest' };
  }

  const current = await localDigest(target, ref);
  if (!current) {
    // No RepoDigests at all: this image was built on the box rather than
    // pulled — the dashboard's own is the obvious one. There is no registry
    // copy to compare against, and saying so is better than saying "current".
    return { ...target, skipped: 'built-locally' };
  }

  let latest;
  try {
    latest = await registry.remoteDigest(ref);
  } catch (err) {
    return { ...target, skipped: 'registry-unavailable', reason: err.message };
  }
  if (!latest) return { ...target, skipped: 'registry-unavailable', reason: 'no digest returned' };

  return {
    ...target,
    tag: ref.tag,
    currentDigest: current,
    latestDigest: latest,
    updateAvailable: current !== latest,
  };
}

/** Run the checks a few at a time rather than all at once. */
async function inBatches(items, worker, size = CONCURRENCY) {
  const results = [];
  for (let i = 0; i < items.length; i += size) {
    results.push(...await Promise.all(items.slice(i, i + size).map(worker)));
  }
  return results;
}

async function check() {
  if (checking) throw Object.assign(new Error('a check is already running'), { status: 409 });
  checking = true;
  try {
    const list = await targets();
    const results = await inBatches(list, async (t) => {
      try {
        return await checkOne(t);
      } catch (err) {
        return { ...t, skipped: 'error', reason: err.message };
      }
    });

    const available = results
      .filter((r) => r.updateAvailable)
      .map((r) => ({
        module: r.module,
        title: r.title,
        service: r.service,
        container: r.container,
        image: r.image,
        tag: r.tag,
        currentDigest: r.currentDigest,
        latestDigest: r.latestDigest,
      }))
      .sort((a, b) => a.container.localeCompare(b.container));

    // "Skipped" is shown, not swallowed. A box where half the images could not
    // be reached and a box where everything is current look identical on a
    // page that only counts updates, and only one of them is fine.
    const skipped = results
      .filter((r) => r.skipped && r.skipped !== 'built-locally' && r.skipped !== 'pinned-digest')
      .map((r) => ({ container: r.container, image: r.image, reason: r.reason || r.skipped }));

    const cache = {
      lastCheck: new Date().toISOString(),
      containers: list.length,
      checked: results.filter((r) => !r.skipped).length,
      available,
      skipped,
    };
    await state.writeJson(CACHE_FILE, cache);
    return cache;
  } finally {
    checking = false;
  }
}

/** The cached answer, plus whether it is old enough that the page should recheck. */
async function status() {
  const cache = await readCache();
  const age = cache.lastCheck ? Date.now() - new Date(cache.lastCheck).getTime() : null;
  return {
    ...cache,
    checking,
    applying,
    stale: age === null || age > STALE_AFTER_MS,
    history: (await readHistory()).slice(0, 20),
  };
}

/* ------------------------------------------------------------ the update */

function stamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
}

/**
 * Archive the module's config directory before anything is pulled.
 *
 * This is where an app's database and settings live, so it is the only part
 * an update can damage in a way that reinstalling does not fix. A module with
 * no config directory yet (nothing has run) archives nothing and says so.
 */
const BACKUPS_KEPT = 10;

/**
 * Hand a file back to whoever owns the state directory.
 *
 * This process runs as root inside its container so it can open the Docker
 * socket, so everything it writes into the bind-mounted state directory lands
 * root-owned — and the account that owns /opt/homebox can then neither read
 * nor delete its own pre-update backups. lib/state-store.js does the same for
 * the JSON it writes, for the same reason.
 */
async function matchStateOwner(file) {
  try {
    const dir = await fsp.stat(path.join(state.ROOT, 'state'));
    await fsp.chown(file, dir.uid, dir.gid);
  } catch {
    /* not root, or a filesystem that will not chown — the file still stands */
  }
}

/**
 * Keep the last few archives per module and delete the rest.
 *
 * Left alone this directory grows by the size of an app's database on every
 * update, forever, on the box's system disk. Ten is enough to go back through
 * a bad run and few enough that nobody discovers it when the disk fills.
 */
async function pruneBackups(id) {
  try {
    const names = (await fsp.readdir(BACKUP_DIR))
      .filter((n) => n.startsWith(`${id}-`) && n.endsWith('.tar.gz'))
      .sort()                       // the stamp sorts chronologically
      .slice(0, -BACKUPS_KEPT);
    for (const name of names) await fsp.rm(path.join(BACKUP_DIR, name), { force: true });
  } catch {
    /* a failed prune is not a reason to fail an update */
  }
}

async function backupModule(id, onLine) {
  const dir = path.join(state.ROOT, 'modules', id, 'config');
  if (!fs.existsSync(dir)) {
    if (onLine) onLine(`==> ${id} has no config directory yet — nothing to back up`, false);
    return null;
  }
  await fsp.mkdir(BACKUP_DIR, { recursive: true });
  await matchStateOwner(BACKUP_DIR);
  const file = path.join(BACKUP_DIR, `${id}-${stamp()}.tar.gz`);
  if (onLine) onLine(`==> Backing up modules/${id}/config`, false);

  await new Promise((resolve, reject) => {
    const child = spawn('tar', ['-czf', file, '-C', path.join(state.ROOT, 'modules', id), 'config']);
    let stderr = '';
    child.stderr.on('data', (c) => { stderr += c.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      // tar exits 1 for "file changed as we read it", which is normal for a
      // running app's database and is not a reason to refuse to update.
      if (code === 0 || code === 1) resolve();
      else reject(new Error(`backup failed: tar exited ${code} ${stderr.trim().slice(0, 200)}`));
    });
  });

  const { size } = await fsp.stat(file);
  if (!size) throw new Error('backup failed: the archive came out empty');
  await fsp.chmod(file, 0o600).catch(() => {});
  await matchStateOwner(file);
  await pruneBackups(id);
  if (onLine) onLine(`==> Backup saved: ${path.basename(file)} (${Math.round(size / 1024)} KB)`, false);
  return file;
}

/** Poll a container until it is healthy, or until we give up on it. */
async function waitHealthy(name, onLine) {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let last = 'unknown';
  while (Date.now() < deadline) {
    const containers = await docker.listContainers();
    const found = containers.find((c) => c.name === name);
    last = found ? found.state : 'gone';
    // `running` is the state of a container whose image declares no
    // healthcheck — there is nothing further to wait for, so it counts.
    if (last === 'healthy' || last === 'running') return { ok: true, state: last };
    if (last === 'unhealthy') return { ok: false, state: last };
    if (onLine) onLine(`    ${name}: ${last}…`, false);
    await new Promise((r) => setTimeout(r, 3000));
  }
  return { ok: false, state: last };
}

/**
 * Update one service. Every step reports itself, because the whole point of
 * the progress log is that an update that stalls looks different from an
 * update that is still pulling a 900MB image.
 */
async function applyOne(item, onLine) {
  const say = (line, err = false) => { if (onLine) onLine(line, err); };
  say(`==> ${item.container} (${item.module}/${item.service})`);
  say(`    ${item.image}`);
  say(`    ${String(item.currentDigest).slice(0, 19)}… → ${String(item.latestDigest).slice(0, 19)}…`);

  const backup = await backupModule(item.module, onLine);

  // Recorded BEFORE the pull, because the pull is what makes it unreachable
  // by name. This id is the entire rollback plan.
  const before = (await docker.listContainers()).find((c) => c.name === item.container);
  const previousImageId = before ? before.imageId : null;

  say('==> Pulling the new image');
  await composeLib.pullService(item.module, item.service, { onLine });

  say('==> Recreating the service');
  await composeLib.upService(item.module, item.service, { onLine });

  say('==> Waiting for it to come back healthy');
  const health = await waitHealthy(item.container, onLine);

  if (health.ok) {
    say(`==> ${item.container} is ${health.state}`);
    await note({
      module: item.module, service: item.service, container: item.container,
      image: item.image, success: true, backup: backup ? path.basename(backup) : null,
    });
    activity.note({ name: item.container, action: 'update', level: 'info' });
    return { container: item.container, success: true, state: health.state, backup };
  }

  // --- rollback ---
  say(`==> ${item.container} did not come back healthy (${health.state}) — rolling back`, true);
  let rolledBack = false;
  if (previousImageId) {
    try {
      await composeLib.retag(previousImageId, item.image);
      await composeLib.upService(item.module, item.service, { onLine });
      const back = await waitHealthy(item.container, onLine);
      rolledBack = back.ok;
      say(rolledBack
        ? '==> Rolled back to the previous image; the service is running again'
        : '==> Rollback recreated the service but it is still not healthy — check its logs', !rolledBack);
    } catch (err) {
      say(`==> Rollback failed: ${err.message}`, true);
    }
  } else {
    say('==> No previous image was recorded, so there is nothing to roll back to', true);
  }

  await note({
    module: item.module, service: item.service, container: item.container,
    image: item.image, success: false, rolledBack,
    reason: `did not become healthy after update (${health.state})`,
    backup: backup ? path.basename(backup) : null,
  });
  activity.note({ name: item.container, action: 'update failed', level: 'error' });
  return { container: item.container, success: false, rolledBack, state: health.state, backup };
}

/**
 * Apply updates. `container` names one; the string "all" takes every update
 * the last check found, one after another — never in parallel, because two
 * simultaneous recreates on one box is how you end up with two half-updated
 * apps and no idea which log belongs to which.
 */
async function apply(which, { onLine = null } = {}) {
  if (applying) throw Object.assign(new Error('an update is already running'), { status: 409 });
  applying = true;
  try {
    const cache = await readCache();
    const list = which === 'all'
      ? cache.available
      : cache.available.filter((u) => u.container === which);

    if (!list.length) {
      throw Object.assign(
        new Error(which === 'all'
          ? 'nothing is waiting to be updated — run a check first'
          : `${which} is not on the list of available updates — run a check and try again`),
        { status: 409 },
      );
    }

    const results = [];
    for (const item of list) {
      try {
        results.push(await applyOne(item, onLine));
      } catch (err) {
        if (onLine) onLine(`==> ${item.container}: ${err.message}`, true);
        await note({
          module: item.module, service: item.service, container: item.container,
          image: item.image, success: false, rolledBack: false, reason: err.message,
        });
        results.push({ container: item.container, success: false, error: err.message });
      }
    }

    // The cache now describes a box that no longer exists. Re-check rather
    // than editing it by hand: the fresh answer is the honest one, and it
    // catches a service that reported healthy but pulled the same digest.
    await check().catch(() => {});

    const failed = results.filter((r) => !r.success);
    return { ok: failed.length === 0, results, updated: results.length - failed.length, failed: failed.length };
  } finally {
    applying = false;
  }
}

module.exports = { check, status, apply, readHistory, STALE_AFTER_MS };
