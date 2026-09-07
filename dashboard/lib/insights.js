'use strict';
/**
 * What the apps are actually DOING, on the home page.
 *
 * The launcher tells you qBittorrent is running. It does not tell you it is
 * pulling 4 MB/s with two hours left, and finding that out means opening
 * qBittorrent — which is the one thing a dashboard exists to save you.
 *
 * So: a small poller that asks each installed app its own question and folds
 * the answers into one card.
 *
 *   qBittorrent   down/up speed, how many torrents are moving, the nearest ETA
 *   Radarr        what is downloading, what is released and still missing
 *   Sonarr        the same, plus what airs in the next few days
 *
 * THREE RULES, because this file talks to software HomeBox does not control:
 *
 * 1. **Every source fails on its own.** One app being down, slow or
 *    mid-restart must never blank the card or hold up the others, so each
 *    collector is wrapped and returns an `error` string instead of throwing.
 *
 * 2. **Never invent a number.** A source that could not be reached reports
 *    that it could not be reached. Rendering a confident `0 MB/s` for an app
 *    that did not answer is worse than rendering nothing — you would go
 *    looking for a stalled download that is actually fine.
 *
 * 3. **Credentials are read, never stored here.** The *arr apps keep an API
 *    key in their own config.xml and that is where it is read from, so there
 *    is nothing for anyone to set up. qBittorrent has no such file, so its
 *    login comes from .env like every other HomeBox secret.
 *
 * Addressed by container name on homebox_proxy (`http://radarr:7878`), not by
 * the LAN address: the ports a service publishes are for people, and a
 * published port is something the user is free to change or remove.
 */

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const modulesLib = require('./modules');
const state = require('./state-store');

// Live numbers go stale in seconds; a release calendar does not move for
// hours. Polling them at the same rate means either a laggy speed readout or
// pointless load on apps that had nothing new to say.
const TTL = { fast: 8000, slow: 5 * 60 * 1000 };

const TIMEOUT_MS = 6000;

const cache = new Map();   // key -> { at, value }

/* ------------------------------------------------------------------ http */

/**
 * A JSON request to an app on the internal network.
 *
 * Plain `http` rather than fetch-with-a-library for the same reason as the
 * rest of this server: no dependency tree behind a process that holds the
 * Docker socket.
 */
function request(url, { method = 'GET', headers = {}, body = null, raw = false } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = http.request({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname + target.search,
      method,
      headers: {
        accept: 'application/json',
        ...(body ? { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(body) } : {}),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 400) {
          reject(Object.assign(new Error(`${target.host} answered ${res.statusCode}`), { status: res.statusCode }));
          return;
        }
        if (raw) return resolve({ text, headers: res.headers });
        try {
          resolve(text ? JSON.parse(text) : null);
        } catch {
          reject(new Error(`${target.host} did not return JSON`));
        }
      });
    });
    req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error(`${target.host} did not answer in ${TIMEOUT_MS / 1000}s`)));
    req.on('error', (err) => reject(new Error(err.message)));
    if (body) req.write(body);
    req.end();
  });
}

/* ------------------------------------------------------- where things are */

/**
 * The internal address of a service, from the module metadata.
 *
 * `container_port` and not `port_map`: the published port is a convenience
 * for people on the LAN and the user may change or remove it, while the port
 * inside the container is fixed by the image. The container NAME is the
 * compose service name, which is what Docker's DNS answers to on the shared
 * network.
 */
async function addressOf(serviceName) {
  const { modules } = await modulesLib.loadAll();
  for (const mod of modules) {
    const svc = mod.services.find((s) => s.name === serviceName);
    if (svc && svc.containerPort) return `http://${serviceName}:${svc.containerPort}`;
  }
  return null;
}

/** Is this service's container actually up? Nothing else is worth trying if not. */
async function isRunning(serviceName, containers) {
  return containers.some((c) => c.service === serviceName && c.state !== 'stopped');
}

/* ---------------------------------------------------------------- the arrs */

/**
 * Radarr and Sonarr keep their API key in their own config.xml, which is on
 * a volume this process can already read. So there is nothing to configure:
 * install the app and the card starts working.
 */
async function arrApiKey(serviceName) {
  const file = path.join(state.ROOT, 'modules', 'media', 'config', serviceName, 'config.xml');
  const xml = await fsp.readFile(file, 'utf8');
  const match = /<ApiKey>([a-f0-9]+)<\/ApiKey>/i.exec(xml);
  if (!match) throw new Error(`${serviceName} has not written an API key yet`);
  return match[1];
}

/**
 * One *arr app's numbers.
 *
 * `queue` is what it is fetching right now; `missing` is what it wants and
 * has not found. Both are asked for with pageSize=1 — only the record COUNT
 * is on screen, and pulling the full list to call .length on it would move
 * megabytes for one integer.
 */
async function arrStats(serviceName, containers) {
  if (!(await isRunning(serviceName, containers))) return { installed: false };
  const base = await addressOf(serviceName);
  if (!base) return { installed: false };

  const key = await arrApiKey(serviceName);
  const headers = { 'x-api-key': key };
  const get = (p) => request(`${base}/api/v3/${p}`, { headers });

  const [queue, missing] = await Promise.all([
    get('queue?pageSize=1'),
    get('wanted/missing?pageSize=1'),
  ]);

  return {
    installed: true,
    queue: Number(queue.totalRecords) || 0,
    missing: Number(missing.totalRecords) || 0,
  };
}

/**
 * What is coming out soon.
 *
 * Sonarr's calendar is episode air dates; Radarr's is cinema/physical/digital
 * release dates. Both answer the same question the user actually asked — "is
 * anything I follow out yet?" — so they are normalised into one list and
 * sorted by date, rather than kept as two rows nobody wants to cross-read.
 */
async function arrCalendar(serviceName, containers, days) {
  if (!(await isRunning(serviceName, containers))) return [];
  const base = await addressOf(serviceName);
  if (!base) return [];

  const key = await arrApiKey(serviceName);
  const start = new Date();
  const end = new Date(Date.now() + days * 86400000);
  const iso = (d) => d.toISOString().slice(0, 10);

  const rows = await request(
    `${base}/api/v3/calendar?start=${iso(start)}&end=${iso(end)}&unmonitored=false`,
    { headers: { 'x-api-key': key } },
  );

  return (Array.isArray(rows) ? rows : []).map((r) => {
    // A Sonarr row is an episode and carries its series; a Radarr row IS the
    // movie. The shapes have nothing in common, so each is read on its own
    // terms rather than through a guessed common field.
    if (serviceName === 'sonarr') {
      const series = (r.series && r.series.title) || 'Unknown series';
      const num = `S${String(r.seasonNumber).padStart(2, '0')}E${String(r.episodeNumber).padStart(2, '0')}`;
      return {
        source: 'sonarr',
        title: series,
        detail: `${num}${r.title ? ` · ${r.title}` : ''}`,
        date: r.airDateUtc || r.airDate || null,
        have: r.hasFile === true,
      };
    }
    // Radarr publishes up to three dates and they are not interchangeable —
    // digital is the one that means "you can actually have it now".
    const date = r.digitalRelease || r.physicalRelease || r.inCinemas || null;
    return {
      source: 'radarr',
      title: r.title || 'Unknown film',
      detail: r.year ? String(r.year) : '',
      date,
      have: r.hasFile === true,
    };
  }).filter((row) => row.date);
}

/* ----------------------------------------------------------- qbittorrent */

/**
 * qBittorrent's Web API is session-based: POST the login, keep the cookie.
 *
 * The cookie NAME is read from the response rather than assumed. qBittorrent
 * 5.x calls it `SID_<port>` where older builds called it `SID`, and a client
 * that hardcodes one gets a 403 on every call after a perfectly successful
 * login — which reads exactly like wrong credentials and is not.
 */
let qbSession = null;   // { cookie, at }
const QB_SESSION_MS = 30 * 60 * 1000;

// One message for every shape of "that login did not work", because from the
// user's side they are the same problem. The temporary-password note is here
// because it is the likeliest cause on a fresh box and the least guessable:
// a qBittorrent that has never had a password set generates a NEW one every
// restart and prints it to its log, so the panel works today and fails
// tomorrow for a reason that looks nothing like a rotated password.
const BAD_LOGIN =
  'qBittorrent rejected the username or password. Check them against qBittorrent itself '
  + '(Options → Web UI). If you never set a password there, it generates a new temporary one '
  + 'every restart and prints it to the log — set a permanent one, then put it in '
  + 'Settings → Server Config → Media Stack.';

async function qbLogin(base, user, pass) {
  if (qbSession && Date.now() - qbSession.at < QB_SESSION_MS) return qbSession.cookie;

  const body = `username=${encodeURIComponent(user)}&password=${encodeURIComponent(pass)}`;
  let res;
  try {
    res = await request(`${base}/api/v2/auth/login`, {
      method: 'POST', body, raw: true,
      // qBittorrent rejects a login whose Referer is not its own origin. This
      // is its CSRF defence and it applies to us as much as to a browser.
      headers: { referer: base, origin: base },
    });
  } catch (err) {
    // Version drift again, and this one reaches the user as a bare status
    // code: 4.x answered bad credentials with `200 Fails.`, 5.x answers
    // 401 (403 once it has banned the client for trying too often). Left to
    // the generic handler that surfaces as "qbittorrent:8080 answered 401",
    // which tells someone nothing about which password to go and check.
    if (err.status === 401 || err.status === 403) throw new Error(BAD_LOGIN);
    throw err;
  }

  // The cookie IS the success signal, and it is the only reliable one.
  // qBittorrent 4.x answered a good login with `200 Ok.`; 5.x answers
  // `204 No Content` with an empty body, so checking the text for "Ok"
  // reports a perfectly successful login as wrong credentials.
  if (/fails/i.test(res.text)) throw new Error(BAD_LOGIN);
  const setCookie = [].concat(res.headers['set-cookie'] || [])[0];
  if (!setCookie) throw new Error(BAD_LOGIN);

  qbSession = { cookie: setCookie.split(';')[0], at: Date.now() };
  return qbSession.cookie;
}

async function qbittorrent(containers, env) {
  if (!(await isRunning('qbittorrent', containers))) return { installed: false };
  const base = await addressOf('qbittorrent');
  if (!base) return { installed: false };

  const user = env.HB_QBIT_USER;
  const pass = env.HB_QBIT_PASS;
  if (!user || !pass) {
    return {
      installed: true,
      needsSetup: true,
      error: 'Add the qBittorrent username and password under Settings → Server Config → Media Stack.',
    };
  }

  let cookie;
  try {
    cookie = await qbLogin(base, user, pass);
  } catch (err) {
    qbSession = null;
    throw err;
  }

  const headers = { cookie };
  const fetchWithRetry = async (p) => {
    try {
      return await request(`${base}${p}`, { headers });
    } catch (err) {
      // A session expires, qBittorrent restarts, the cookie stops working.
      // One silent re-login is the difference between a card that recovers
      // by itself and one that shows an error until someone reloads.
      // Both codes, not just 403: an unauthenticated call to 5.x is a 401.
      if (err.status !== 401 && err.status !== 403) throw err;
      qbSession = null;
      const fresh = await qbLogin(base, user, pass);
      return request(`${base}${p}`, { headers: { cookie: fresh } });
    }
  };

  const [transfer, torrents] = await Promise.all([
    fetchWithRetry('/api/v2/transfer/info'),
    fetchWithRetry('/api/v2/torrents/info?filter=downloading&sort=eta&limit=5'),
  ]);

  const active = Array.isArray(torrents) ? torrents : [];
  return {
    installed: true,
    connection: transfer.connection_status || 'unknown',
    downSpeed: Number(transfer.dl_info_speed) || 0,
    upSpeed: Number(transfer.up_info_speed) || 0,
    downSession: Number(transfer.dl_info_data) || 0,
    upSession: Number(transfer.up_info_data) || 0,
    activeCount: active.length,
    torrents: active.map((t) => ({
      name: t.name,
      progress: Math.round((Number(t.progress) || 0) * 1000) / 10,
      downSpeed: Number(t.dlspeed) || 0,
      // qBittorrent uses 8640000 (100 days) to mean "no idea", which renders
      // as a straight-faced "100d left" if it is passed through.
      eta: Number(t.eta) > 0 && Number(t.eta) < 8640000 ? Number(t.eta) : null,
      state: t.state,
    })),
  };
}

/* ------------------------------------------------------------- assembling */

/** Run a collector, and turn any failure into a reported error, not a throw. */
async function safely(name, fn) {
  try {
    return await fn();
  } catch (err) {
    return { installed: true, error: err.message || String(err) };
  }
}

async function cached(key, ttl, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.value;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  return value;
}

/** The .env values this file needs, read fresh so a save takes effect at once. */
function readEnv() {
  const out = {};
  try {
    for (const line of fs.readFileSync(path.join(state.ROOT, '.env'), 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* no .env yet */ }
  return out;
}

const UPCOMING_DAYS = 21;

/**
 * Everything the Home card needs, in one call.
 *
 * The two rates are the point of the split: the transfer numbers are refetched
 * every few seconds because they are meaningless a minute later, while the
 * calendar and the library counts are cached for minutes because they are not
 * going to change and Radarr should not be asked sixty times an hour.
 */
async function snapshot() {
  const docker = require('./docker');
  const containers = await docker.listContainers();
  const env = readEnv();

  const [qbit, radarr, sonarr, upcoming] = await Promise.all([
    cached('qbit', TTL.fast, () => safely('qbittorrent', () => qbittorrent(containers, env))),
    cached('radarr', TTL.slow, () => safely('radarr', () => arrStats('radarr', containers))),
    cached('sonarr', TTL.slow, () => safely('sonarr', () => arrStats('sonarr', containers))),
    cached('upcoming', TTL.slow, () => safely('calendar', async () => {
      const [r, s] = await Promise.all([
        arrCalendar('radarr', containers, UPCOMING_DAYS).catch(() => []),
        arrCalendar('sonarr', containers, UPCOMING_DAYS).catch(() => []),
      ]);
      return [...r, ...s].sort((a, b) => new Date(a.date) - new Date(b.date)).slice(0, 8);
    })),
  ]);

  return {
    at: new Date().toISOString(),
    qbittorrent: qbit,
    radarr,
    sonarr,
    upcoming: Array.isArray(upcoming) ? upcoming : [],
    upcomingError: upcoming && upcoming.error ? upcoming.error : null,
    upcomingDays: UPCOMING_DAYS,
  };
}

/** Drop every cached answer, for the card's own refresh button. */
function invalidate() {
  cache.clear();
  qbSession = null;
}

module.exports = { snapshot, invalidate, TTL };
