'use strict';
/**
 * HomeBox dashboard server.
 *
 * No framework and no npm dependencies: the image builds on a box with
 * nothing but a node base image, and there is no dependency tree to audit
 * for a process that holds a Docker socket.
 *
 * This process CAN create and destroy containers, so every route is behind a
 * session — see lib/auth.js. The gate is deny-by-default: PUBLIC_PATHS lists
 * the handful of things the login screen itself needs, and anything not on
 * that list requires a signed-in cookie. A route added tomorrow is protected
 * the moment it exists rather than the moment somebody remembers.
 *
 * It publishes 8443 on the LAN and joins no public network — read
 * docs/SECURITY.md before changing either.
 */

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const docker = require('./lib/docker');
const composeLib = require('./lib/compose');
const modulesLib = require('./lib/modules');
const hostMetrics = require('./lib/host-metrics');
const activity = require('./lib/activity');
const backup = require('./lib/backup');
const config = require('./lib/config');
const catalog = require('./lib/catalog');
const icons = require('./lib/icons');
const bookmarks = require('./lib/bookmarks');
const auth = require('./lib/auth');
const updates = require('./lib/updates');
const stats = require('./lib/stats');
const state = require('./lib/state-store');

const PORT = Number(process.env.PORT || 8443);
const PUBLIC_DIR = path.join(__dirname, 'public');
const HOST_ADDRESS = process.env.HB_HOST_ADDRESS || 'localhost';

/**
 * The only paths reachable without a session: the login screen and the files
 * it is built from. Listed explicitly rather than pattern-matched, so nothing
 * becomes public by accident when a new asset is added.
 */
const PUBLIC_PATHS = new Set([
  // Liveness only — no data. The container healthcheck runs before anyone has
  // signed in and must not need a session; pointing it at a real endpoint
  // instead made the dashboard report itself unhealthy the moment auth landed.
  '/healthz',
  '/',
  '/index.html',
  '/css/tokens.css',
  '/css/themes.css',
  '/css/app.css',
  '/js/app.js',
  '/icons/homebox.svg',
]);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function readVersion() {
  try {
    return fs.readFileSync(path.join(state.ROOT, 'VERSION'), 'utf8').trim();
  } catch {
    return '0.0.0';
  }
}
const VERSION = readVersion();

// Appearance. These lists are the contract with themes.css and app.css —
// a name here must have a matching :root[data-theme=...] / [data-atmo=...].
const THEMES = [
  'dark', 'midnight-purple', 'forest', 'sunset', 'arctic', 'rose',
  'light', 'light-forest', 'light-sunset', 'light-arctic', 'light-rose',
];
const BACKGROUNDS = ['aurora', 'nebula', 'deep', 'slate', 'void', 'solid', 'wp-purple', 'wp-blue'];
const DEFAULT_PREFS = { theme: 'dark', atmo: 'aurora' };

/**
 * Both values end up in a DOM attribute the stylesheet selects on, so they
 * are whitelisted rather than escaped — an unknown name falls back to the
 * default instead of producing a selector that matches nothing.
 */
function cleanPrefs(input) {
  const p = input && typeof input === 'object' ? input : {};
  return {
    theme: THEMES.includes(p.theme) ? p.theme : DEFAULT_PREFS.theme,
    atmo: BACKGROUNDS.includes(p.atmo) ? p.atmo : DEFAULT_PREFS.atmo,
  };
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

/**
 * index.html is the one file rendered rather than streamed, so `?v=` on every
 * asset carries the running version — the source does the same (`?v=1.6.660`).
 *
 * Without it a redeploy leaves the browser on the previous CSS and JS: the
 * files are served `no-cache`, which means "revalidate", and a browser that
 * decides not to bother shows old UI against a new API with nothing on screen
 * to say so. A changing URL removes the judgement call.
 */
/**
 * The cache key: the version, plus when the assets were last built.
 *
 * VERSION alone is not enough — it changes on a release, while the files
 * change on every deploy, and it is the deploys in between that leave a stale
 * page. The assets are baked into the image, so they cannot change under a
 * running process: computing this once at startup is exact.
 */
const ASSET_TAG = (() => {
  let newest = 0;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else newest = Math.max(newest, fs.statSync(full).mtimeMs);
    }
  };
  try {
    for (const sub of ['css', 'js']) walk(path.join(PUBLIC_DIR, sub));
  } catch { /* fall back to the version alone */ }
  return newest ? `${VERSION}-${Math.round(newest / 1000).toString(36)}` : VERSION;
})();

async function serveIndex(res) {
  const html = (await fsp.readFile(path.join(PUBLIC_DIR, 'index.html'), 'utf8'))
    .replace(/__V__/g, encodeURIComponent(ASSET_TAG));
  res.writeHead(200, {
    'content-type': MIME['.html'],
    'content-length': Buffer.byteLength(html),
    'cache-control': 'no-cache',
  });
  res.end(html);
}

async function serveStatic(res, urlPath) {
  if (urlPath === '/' || urlPath === '/index.html') return serveIndex(res);

  // Downloaded icons live in state/, outside public/, because public/ is baked
  // into the image and a rebuild would erase them. Names are the hash of the
  // bytes, so a name can only ever mean one file — hence immutable caching.
  if (urlPath.startsWith('/user-icons/')) {
    const file = icons.resolve(decodeURIComponent(urlPath.slice('/user-icons/'.length)));
    if (!file) { res.writeHead(404).end('not found'); return; }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': 'public, max-age=31536000, immutable',
    });
    fs.createReadStream(file).pipe(res);
    return;
  }
  const rel = urlPath.replace(/^\/+/, '');
  // Resolve, then verify the result is still inside public/: decoded "..",
  // encoded "%2e%2e" and absolute paths all collapse here.
  const target = path.resolve(PUBLIC_DIR, rel);
  if (target !== PUBLIC_DIR && !target.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    const stat = await fsp.stat(target);
    if (stat.isDirectory()) {
      res.writeHead(404).end('not found');
      return;
    }
    const ext = path.extname(target).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'content-length': stat.size,
      // Icons rarely change; HTML and code must not be cached or a redeploy
      // leaves stale JS talking to a new API.
      'cache-control': ext === '.html' || ext === '.js' || ext === '.css' ? 'no-cache' : 'public, max-age=86400',
    });
    fs.createReadStream(target).pipe(res);
  } catch {
    res.writeHead(404).end('not found');
  }
}

/** Container names are a closed set; never interpolate a client string blind. */
async function resolveContainerName(name) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(name || '')) return null;
  const containers = await docker.listContainers();
  return containers.some((c) => c.name === name) ? name : null;
}

/**
 * One verdict for the whole box, in the words someone would use out loud.
 * Ordering matters: an unhealthy container is worse news than a stopped one,
 * because a stopped container is usually stopped on purpose.
 */
function healthVerdict(containers, metrics, dockerOk) {
  if (!dockerOk) {
    return {
      level: 'bad',
      title: 'Cannot reach Docker',
      sub: 'The socket is not answering, so the state below is empty — not healthy.',
      names: [],
    };
  }
  const running = containers.filter((c) => c.state !== 'stopped');
  const unhealthy = containers.filter((c) => c.state === 'unhealthy');
  const stopped = containers.filter((c) => c.state === 'stopped');
  const starting = containers.filter((c) => c.state === 'starting');

  if (unhealthy.length) {
    return {
      level: 'bad',
      title: unhealthy.length === 1 ? `${unhealthy[0].name} is unhealthy` : `${unhealthy.length} apps are unhealthy`,
      sub: 'Their healthcheck is failing — open the logs to see why.',
      names: unhealthy.map((c) => c.name),
    };
  }
  if (starting.length) {
    return {
      level: 'warn',
      title: `${starting.length} app${starting.length > 1 ? 's are' : ' is'} still starting`,
      sub: 'Give it a moment and this settles by itself.',
      names: starting.map((c) => c.name),
    };
  }
  if (metrics.disk && metrics.disk.percent != null && metrics.disk.percent >= 90) {
    return {
      level: 'warn',
      title: `Disk is ${metrics.disk.percent}% full`,
      sub: 'Apps start failing in ways that look unrelated once the disk fills.',
      names: [],
    };
  }
  if (stopped.length) {
    return {
      level: 'warn',
      title: `${stopped.length} container${stopped.length > 1 ? 's are' : ' is'} stopped`,
      sub: 'Fine if you stopped them on purpose.',
      names: stopped.map((c) => c.name),
    };
  }
  if (running.length === 0) {
    return {
      level: 'warn',
      title: 'Nothing installed yet',
      sub: 'Open Apps and install something — Monitoring and File Browser are good first picks.',
      names: [],
    };
  }
  return {
    level: 'good',
    title: 'Everything is running',
    sub: `${running.length} containers up, nothing needs you right now.`,
    names: [],
  };
}

/**
 * What the Network card shows. Everything here is a fact we can actually
 * check — no placeholder rows that look like features.
 */
function networkInfo(modules, networks) {
  const core = modules.find((m) => m.id === 'core');
  const proxyUp = core && core.installed && core.status !== 'stopped';
  const ours = networks.filter((n) => n.startsWith('homebox'));
  return {
    dashboard: `http://${HOST_ADDRESS}:${PORT}`,
    proxy: proxyUp ? `http://${HOST_ADDRESS} · admin :81` : 'core not running',
    networks: ours.length ? ours.join(', ') : 'none',
  };
}

/**
 * Backups. HomeBox does not take any yet, and saying so plainly is more
 * useful than a card that implies it does — so this reports what WOULD be
 * lost and where it lives.
 */
async function backupInfo(modules, metrics) {
  const withConfig = modules.filter((m) => {
    try {
      return fs.existsSync(path.join(m.dir, 'config'));
    } catch {
      return false;
    }
  }).length;
  // Real figures from the Backup Center rather than a stub, so the home card
  // cannot claim nothing is set up while archives sit on disk.
  let center = { count: 0, latest: null, schedule: { enabled: false } };
  try {
    center = await backup.status();
  } catch {
    /* backup dir unreadable: the card degrades to "none" rather than erroring */
  }
  return {
    configured: center.count > 0 || center.schedule.enabled,
    scheduled: center.schedule.enabled,
    count: center.count,
    latest: center.latest,
    appConfigs: withConfig,
    dataDir: path.join(state.ROOT, 'data'),
    diskFree: metrics.disk ? metrics.disk.free : null,
  };
}

async function apiSummary() {
  const [{ modules, errors }, containers, metrics, dockerVersion, networks] = await Promise.all([
    modulesLib.loadAll(),
    docker.listContainers().catch(() => []),
    hostMetrics.snapshot(),
    docker.version(),
    docker.listNetworks(),
  ]);
  const { modules: withState, unclaimed } = modulesLib.withContainers(modules, containers, HOST_ADDRESS);
  return {
    // What install.sh wrote, so Settings can show it without reading .env —
    // that file holds every secret and the dashboard has no business in it.
    config: {
      root: state.ROOT,
      modulesDir: modulesLib.MODULES_DIR,
      dataDir: path.join(state.ROOT, 'data'),
      timezone: process.env.TZ || 'UTC',
      port: PORT,
    },
    network: networkInfo(withState, networks),
    backups: await backupInfo(withState, metrics),
    version: VERSION,
    host: { address: HOST_ADDRESS, name: metrics.hostname },
    docker: dockerVersion,
    metrics,
    health: healthVerdict(containers, metrics, dockerVersion != null),
    counts: {
      modules: modules.length,
      installed: withState.filter((m) => m.installed).length,
      containers: containers.length,
      running: containers.filter((c) => c.state !== 'stopped').length,
      unclaimed: unclaimed.length,
    },
    moduleErrors: errors,
    busy: [...inFlight],
  };
}

/**
 * Saving a setting has to TAKE EFFECT, not just be recorded.
 *
 * A container keeps the bind mounts and environment it was created with, so a
 * changed `.env` means nothing at all until the containers are replaced —
 * which is why editing a media path used to leave the apps looking at the old
 * one until somebody ran the CLI. `compose up -d` does the replacing, and does
 * it only where needed: it compares each service against the file and leaves
 * alone anything whose resolved config did not actually move.
 *
 * Two things are deliberately left out:
 *
 *   - modules that are not installed — there is nothing to recreate, and the
 *     new value applies the moment they are;
 *   - `dashboard` — it is the container serving this request, and replacing it
 *     mid-response kills the reply, so the page would report a failure for
 *     something that in fact worked. It is named in `manual` instead.
 */
async function applySaved(keys) {
  const affected = await config.modulesUsing(keys);
  if (!affected.length) return { restarting: [], failed: [], manual: [] };

  const containers = await docker.listContainers().catch(() => []);
  const { modules } = modulesLib.withContainers(
    (await modulesLib.loadAll()).modules, containers, HOST_ADDRESS,
  );
  const installed = new Set(modules.filter((m) => m.installed).map((m) => m.id));

  const restarting = [];
  const failed = [];
  const manual = [];
  for (const id of affected) {
    if (!installed.has(id)) continue;
    if (id === 'dashboard') { manual.push(id); continue; }
    try {
      // No activity entry is written here on purpose: recreating a container
      // emits real Docker create/start events, and the activity feed is fed by
      // that stream. A hand-written note would show the same thing twice.
      await composeLib.start(id);
      restarting.push(id);
    } catch (err) {
      // The likeliest cause by far is a bind source that is not mounted, so
      // pass compose's own words through rather than a generic failure.
      failed.push({ id, error: (err.stderr || err.message || '').trim().split('\n').pop() });
    }
  }
  return { restarting, failed, manual };
}

async function apiModules() {
  const [{ modules, errors }, containers] = await Promise.all([
    modulesLib.loadAll(),
    docker.listContainers().catch(() => []),
  ]);
  // Figures come from the background sampler, never from a blocking read —
  // /stats takes a second per container by design.
  for (const c of containers) Object.assign(c, stats.get(c.name));
  const enabled = modulesLib.enabledIds(modules);
  const { modules: withState, unclaimed } = modulesLib.withContainers(modules, containers, HOST_ADDRESS);
  return {
    modules: withState.map((m) => ({ ...m, enabled: enabled.has(m.id) })),
    unclaimed,
    categories: modulesLib.CATEGORIES,
    host: HOST_ADDRESS,
    errors,
    busy: [...inFlight],
  };
}

/* ------------------------------------------------------------------ actions */

// One operation per module at a time. Two overlapping `compose up` runs on
// the same project fight over the same containers and leave one of them in a
// half-created state.
const inFlight = new Set();

const ACTIONS = {
  install: composeLib.install,
  start: composeLib.start,
  stop: composeLib.stop,
  restart: composeLib.restart,
  update: composeLib.update,
  // Uninstall keeps modules/<id>/config so a reinstall comes back with its
  // settings; purge deletes it and is the only irreversible action here.
  remove: composeLib.down,
  purge: composeLib.purge,
};

async function runAction(id, action, onLine = null) {
  const fn = ACTIONS[action];
  if (!fn) return { status: 400, body: { error: `unknown action: ${action}` } };
  if (!composeLib.ID_PATTERN.test(id)) return { status: 400, body: { error: 'invalid module id' } };

  const { modules } = await modulesLib.loadAll();
  const mod = modules.find((m) => m.id === id);
  if (!mod) return { status: 404, body: { error: `no such module: ${id}` } };
  // Stopping the proxy or the dashboard from the dashboard is a way to lose
  // the page you are clicking in. Required modules are restart-only.
  if (mod.required && ['stop', 'remove', 'purge'].includes(action)) {
    return { status: 409, body: { error: `${mod.title} is required and cannot be stopped from here` } };
  }
  if (inFlight.has(id)) {
    return { status: 409, body: { error: `${mod.title} is already busy` } };
  }

  inFlight.add(id);
  const started = Date.now();
  try {
    const result = await fn(id, { onLine });
    const output = typeof result === 'string' ? result : `${result.stdout || ''}${result.stderr || ''}`;
    activity.note({ name: id, action, level: 'info' });
    return { status: 200, body: { ok: true, id, action, seconds: Math.round((Date.now() - started) / 1000), output } };
  } catch (err) {
    activity.note({ name: id, action: `${action} failed`, level: 'error' });
    return {
      status: 500,
      body: { ok: false, id, action, error: err.message, output: `${err.stdout || ''}${err.stderr || ''}` },
    };
  } finally {
    inFlight.delete(id);
  }
}

/* -------------------------------------------------------------------- SSE */

function serveEvents(req, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(': connected\n\n');

  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  let closed = false;
  const tick = async () => {
    if (closed) return;
    try {
      send('summary', await apiSummary());
    } catch (err) {
      send('error', { message: err.message });
    }
  };
  tick();
  const timer = setInterval(tick, 5000);
  const unsubscribe = activity.subscribe((entry) => send('activity', entry));

  req.on('close', () => {
    closed = true;
    clearInterval(timer);
    unsubscribe();
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      // Every POST here is a few dozen bytes; anything larger is a bug or an
      // attempt to exhaust memory on an unauthenticated endpoint.
      if (data.length > 16384) reject(new Error('body too large'));
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const route = url.pathname;

  try {
    // ---------------------------------------------------------------------
    // THE GATE.
    //
    // Deny by default: everything below this block requires a session, and a
    // new route is protected the moment it is added rather than the moment
    // someone remembers to protect it. Only what is needed to log in, and the
    // assets the login screen itself is made of, are open.
    //
    // The login screen lives in index.html, so index.html and the CSS/JS it
    // pulls have to be reachable while signed out. They contain no data —
    // every value on the page arrives from an /api call that IS gated.
    // ---------------------------------------------------------------------
    // Liveness. Deliberately says nothing beyond "this process answers".
    if (route === '/healthz') {
      return sendJson(res, 200, { ok: true, version: VERSION });
    }

    if (route.startsWith('/api/auth/')) {
      try {
        if (route === '/api/auth/status') return sendJson(res, 200, await auth.status(req));
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });

        if (route === '/api/auth/claim') {
          const { cookie } = await auth.claim(req, await readBody(req));
          res.setHeader('set-cookie', cookie);
          activity.note({ name: 'dashboard', action: 'claimed', level: 'info' });
          return sendJson(res, 200, { ok: true });
        }
        if (route === '/api/auth/login') {
          const { cookie } = await auth.login(req, await readBody(req));
          res.setHeader('set-cookie', cookie);
          return sendJson(res, 200, { ok: true });
        }
        if (route === '/api/auth/logout') {
          const { cookie } = await auth.logout(req);
          res.setHeader('set-cookie', cookie);
          return sendJson(res, 200, { ok: true });
        }
        // Changing a password is not a way IN, so it needs a session.
        if (route === '/api/auth/password') {
          if (!(await auth.isAuthenticated(req))) return sendJson(res, 401, { error: 'not signed in' });
          const result = await auth.changePassword(req, await readBody(req));
          res.setHeader('set-cookie', result.cookie);
          return sendJson(res, 200, { ok: true, otherSessionsSignedOut: result.otherSessionsSignedOut });
        }
        return sendJson(res, 404, { error: 'no such endpoint' });
      } catch (err) {
        return sendJson(res, err.status || 400, { ok: false, error: err.message });
      }
    }

    if (!PUBLIC_PATHS.has(route) && !(await auth.isAuthenticated(req))) {
      // 401 for the API so the page can bounce to the login screen; for a
      // document request, serve the page itself, which shows the login screen
      // on its own once /api/auth/status answers.
      if (route.startsWith('/api/')) return sendJson(res, 401, { error: 'not signed in' });
      return serveIndex(res);
    }

    // POST /api/containers/<name>/<action> — the Running list's buttons.
    const containerAction = /^\/api\/containers\/([^/]+)\/([^/]+)$/.exec(route);
    if (containerAction) {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
      const name = await resolveContainerName(decodeURIComponent(containerAction[1]));
      if (!name) return sendJson(res, 404, { error: 'no such container' });
      const verb = containerAction[2];
      try {
        await composeLib.containerAction(name, verb);
        activity.note({ name, action: verb, level: 'info' });
        return sendJson(res, 200, { ok: true, name, action: verb });
      } catch (err) {
        return sendJson(res, 500, { ok: false, name, action: verb, error: err.message });
      }
    }

    // POST /api/modules/<id>/<action>/stream
    //
    // The plain route below answers once, after the whole install. That is a
    // minute or more of silence for a pull, which is exactly when someone
    // decides it has hung. This one streams compose's own output line by line
    // as NDJSON, so the page can show the work happening.
    //
    // Chunked POST rather than SSE: EventSource is GET-only, and a GET that
    // installs software is a URL a prefetch or a history entry can fire.
    const streamed = /^\/api\/modules\/([^/]+)\/([^/]+)\/stream$/.exec(route);
    if (streamed) {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
      res.writeHead(200, {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'cache-control': 'no-store',
        'x-accel-buffering': 'no',
      });
      const send = (obj) => { if (!res.writableEnded) res.write(`${JSON.stringify(obj)}
`); };
      const result = await runAction(
        decodeURIComponent(streamed[1]), streamed[2],
        (line, isErr) => send({ line, err: isErr }),
      );
      send({ done: true, status: result.status, ...result.body });
      return res.end();
    }

    // POST /api/modules/<id>/<action>
    const action = /^\/api\/modules\/([^/]+)\/([^/]+)$/.exec(route);
    if (action) {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
      const result = await runAction(decodeURIComponent(action[1]), action[2]);
      return sendJson(res, result.status, result.body);
    }

    // --- Updates ---
    //
    // GET  /api/updates          the cached answer + history (never checks)
    // POST /api/updates/check    ask the registries now
    // POST /api/updates/apply    {container: "<name>" | "all"} — streams NDJSON
    //
    // The check is a POST even though it reads nothing on this box: it makes
    // a dozen outbound registry requests, and a GET is something a browser
    // prefetch or a refresh can fire on its own.
    if (route.startsWith('/api/updates')) {
      const tail = route.slice('/api/updates'.length).replace(/^\//, '');
      try {
        if (!tail && req.method === 'GET') return sendJson(res, 200, await updates.status());

        if (tail === 'check' && req.method === 'POST') {
          return sendJson(res, 200, { ok: true, ...(await updates.check()) });
        }

        if (tail === 'apply' && req.method === 'POST') {
          const body = await readBody(req);
          const which = String(body.container || '').trim();
          if (!which) return sendJson(res, 400, { error: 'which container?' });

          // Same shape as the module action stream: an update pulls an image
          // and waits on a healthcheck, which is minutes of silence unless
          // the page can watch the work happen.
          res.writeHead(200, {
            'content-type': 'application/x-ndjson; charset=utf-8',
            'cache-control': 'no-store',
            'x-accel-buffering': 'no',
          });
          const send = (obj) => { if (!res.writableEnded) res.write(`${JSON.stringify(obj)}\n`); };
          try {
            const result = await updates.apply(which, {
              onLine: (line, isErr) => send({ line, err: isErr }),
            });
            send({ done: true, ...result });
          } catch (err) {
            send({ line: err.message, err: true });
            send({ done: true, ok: false, error: err.message });
          }
          return res.end();
        }

        return sendJson(res, 404, { error: 'no such endpoint' });
      } catch (err) {
        return sendJson(res, err.status || 500, { error: err.message });
      }
    }

    // --- Backup Center ---
    if (route.startsWith('/api/backup')) {
      const action = route.slice('/api/backup'.length).replace(/^\//, '');
      try {
        if (route === '/api/backup' && req.method === 'GET') {
          return sendJson(res, 200, await backup.status());
        }
        if (action === 'create' && req.method === 'POST') {
          const body = await readBody(req);
          const made = await backup.create({ kind: body.kind });
          activity.note({ name: made.name, action: 'backup', level: 'info' });
          return sendJson(res, 200, { ok: true, ...made });
        }
        if (action === 'delete' && req.method === 'POST') {
          const body = await readBody(req);
          await backup.remove(body.name);
          return sendJson(res, 200, { ok: true, name: body.name });
        }
        if (action === 'verify' && req.method === 'POST') {
          const body = await readBody(req);
          return sendJson(res, 200, { ok: true, ...(await backup.verify(body.name)) });
        }
        if (action === 'key' && req.method === 'POST') {
          // POST, not GET: a secret must not be fetchable by a link, a
          // prefetch or anything that lands in a browser history.
          return sendJson(res, 200, backup.revealKey());
        }
        if (action === 'schedule' && req.method === 'POST') {
          return sendJson(res, 200, await backup.setSchedule(await readBody(req)));
        }
        if (action.startsWith('download/') && req.method === 'GET') {
          const name = decodeURIComponent(action.slice('download/'.length));
          const file = backup.resolveName(name);
          const stat = await fsp.stat(file);
          res.writeHead(200, {
            'content-type': 'application/octet-stream',
            'content-length': stat.size,
            'content-disposition': `attachment; filename="${name}"`,
          });
          return fs.createReadStream(file).pipe(res);
        }
        return sendJson(res, 404, { error: 'no such endpoint' });
      } catch (err) {
        return sendJson(res, err.name === 'BackupError' ? 400 : 500, { error: err.message, hint: err.hint || null });
      }
    }

    // --- raw .env editor ---
    if (route === '/api/config') {
      if (req.method === 'GET') return sendJson(res, 200, await config.schema());
      if (req.method === 'POST') {
        try {
          const saved = await config.save((await readBody(req)).changes);
          return sendJson(res, 200, { ok: true, ...saved, ...(await applySaved(saved.applied)) });
        } catch (err) {
          return sendJson(res, 400, { ok: false, error: err.message });
        }
      }
      return sendJson(res, 405, { error: 'method not allowed' });
    }

    // --- App Store contents: module text, and user-added apps ---
    if (route.startsWith('/api/catalog')) {
      if (route === '/api/catalog' && req.method === 'GET') return sendJson(res, 200, await catalog.read());
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
      try {
        const body = await readBody(req);
        if (route === '/api/catalog/override') {
          return sendJson(res, 200, { ok: true, ...(await catalog.saveOverride(body.id, body)) });
        }
        if (route === '/api/catalog/override/reset') {
          return sendJson(res, 200, { ok: true, ...(await catalog.resetOverride(body.id)) });
        }
        if (route === '/api/catalog/app') {
          return sendJson(res, 200, { ok: true, ...(await catalog.createApp(body)) });
        }
        if (route === '/api/catalog/app/delete') {
          // Whether it is installed is decided here, from Docker, not taken
          // from the page: the button that sends this is drawn from a list
          // that may be seconds out of date.
          const containers = await docker.listContainers().catch(() => []);
          const { modules } = modulesLib.withContainers(
            (await modulesLib.loadAll()).modules, containers, HOST_ADDRESS,
          );
          const mod = modules.find((m) => m.id === body.id);
          return sendJson(res, 200, { ok: true, ...(await catalog.deleteApp(body.id, { installed: !!(mod && mod.installed) })) });
        }
        return sendJson(res, 404, { error: 'no such endpoint' });
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: err.message });
      }
    }

    // --- Quick Access bookmarks ---
    if (route.startsWith('/api/bookmarks')) {
      try {
        if (route === '/api/bookmarks' && req.method === 'GET') return sendJson(res, 200, await bookmarks.read());
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
        const body = await readBody(req);
        if (route === '/api/bookmarks') return sendJson(res, 200, { ok: true, item: await bookmarks.save(body) });
        if (route === '/api/bookmarks/delete') return sendJson(res, 200, { ok: true, ...(await bookmarks.remove(body.id)) });
        if (route === '/api/bookmarks/reorder') return sendJson(res, 200, { ok: true, ...(await bookmarks.reorder(body.ids)) });
        return sendJson(res, 404, { error: 'no such endpoint' });
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: err.message });
      }
    }

    if (route === '/api/summary') return sendJson(res, 200, await apiSummary());
    if (route === '/api/modules') return sendJson(res, 200, await apiModules());
    if (route === '/api/containers') return sendJson(res, 200, { containers: await docker.listContainers() });
    if (route === '/api/metrics') return sendJson(res, 200, await hostMetrics.snapshot());
    if (route === '/api/activity') {
      return sendJson(res, 200, { entries: activity.list(Number(url.searchParams.get('limit')) || 50) });
    }
    if (route === '/api/logs') {
      const name = await resolveContainerName(url.searchParams.get('name'));
      if (!name) return sendJson(res, 404, { error: 'no such container' });
      const tail = Math.min(Math.max(Number(url.searchParams.get('tail')) || 200, 1), 2000);
      return sendJson(res, 200, { name, tail, text: await docker.logs(name, tail) });
    }
    if (route === '/api/prefs') {
      if (req.method === 'GET') {
        // Validated on the way OUT as well as in: a prefs.json written by an
        // older version has keys this one does not know, and handing those
        // straight to the page puts "undefined" in a DOM attribute.
        return sendJson(res, 200, cleanPrefs(await state.readJson('prefs.json', DEFAULT_PREFS)));
      }
      if (req.method === 'POST') {
        const prefs = cleanPrefs(await readBody(req));
        await state.writeJson('prefs.json', prefs);
        return sendJson(res, 200, prefs);
      }
      return sendJson(res, 405, { error: 'method not allowed' });
    }
    if (route === '/api/events') return serveEvents(req, res);
    if (route.startsWith('/api/')) return sendJson(res, 404, { error: 'no such endpoint' });

    return serveStatic(res, route);
  } catch (err) {
    return sendJson(res, 500, { error: err.message });
  }
});

async function main() {
  hostMetrics.start();
  await activity.load();
  backup.startScheduler();
  if (await docker.reachable()) {
    activity.start();
    stats.start(async () => {
      const containers = await docker.listContainers().catch(() => []);
      return containers.filter((c) => c.state !== 'stopped').map((c) => c.name);
    });
  } else {
    console.warn('[homebox] docker socket unreachable — status and logs will be empty');
  }
  if (!(await composeLib.available())) {
    console.warn('[homebox] `docker compose` is not usable from this container — installs will fail');
  }
  server.listen(PORT, () => {
    console.log(`[homebox] v${VERSION} listening on :${PORT} (root ${state.ROOT}, host ${HOST_ADDRESS})`);
  });
}

main().catch((err) => {
  console.error('[homebox] failed to start:', err);
  process.exit(1);
});
