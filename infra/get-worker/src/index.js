/**
 * get.abeksis.net — the front door for installing and updating Podhouse.
 *
 *   /install.sh      scripts/bootstrap.sh on main
 *   /uninstall.sh    scripts/uninstall.sh on main
 *   /manifest.json   releases/manifest.json on main (what boxes check for updates)
 *   /stats           counts, for the maintainer (needs STATS_TOKEN)
 *   anything else    → the website
 *
 * It replaces a plain Cloudflare redirect so the project can know two numbers:
 * how many installs start, and how many boxes are running which version. Both
 * are counted without keeping anything that identifies a person or a box:
 *
 * - An install is one increment of a (day, script, country) counter. No IP, no
 *   user agent, nothing per request is stored.
 * - A running box is recognised within ONE day by a hash of its IP, the date
 *   and a secret salt, so its 96 update checks a day count once. The hash
 *   cannot be reversed without the salt, cannot be linked to the same box on
 *   another day (the date is inside it), and the rows holding it are folded
 *   into plain per-version totals and deleted by the daily rollup.
 *
 * Counting is best effort and never in the way: the file is served whether or
 * not the database write works, and GitHub's answer (including 304) is passed
 * straight through.
 */

const REPO = 'abeksis/Podhouse';
const RAW = `https://raw.githubusercontent.com/${REPO}/main`;
const SITE = 'https://podhouse.abeksis.net';

const FILES = {
  '/install.sh': { path: 'scripts/bootstrap.sh', kind: 'install', type: 'text/x-shellscript; charset=utf-8' },
  '/uninstall.sh': { path: 'scripts/uninstall.sh', kind: 'uninstall', type: 'text/x-shellscript; charset=utf-8' },
  '/manifest.json': { path: 'releases/manifest.json', kind: 'check', type: 'application/json; charset=utf-8' },
};

// Raw rows older than this are folded into totals and removed.
const KEEP_RAW_DAYS = 2;

const today = () => new Date().toISOString().slice(0, 10);
const VERSION = /^\d+\.\d+\.\d+$/;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/stats' || url.pathname === '/stats.json') return stats(request, env, url);

    const file = FILES[url.pathname];
    if (!file) return Response.redirect(SITE, 302);
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('method not allowed', { status: 405 });

    const upstream = await fetch(`${RAW}/${file.path}`, {
      method: request.method,
      headers: pick(request.headers, ['if-none-match', 'if-modified-since']),
      cf: { cacheTtl: 60, cacheEverything: true },
    });

    // Count only real GETs that got the file (or a 304 for it). A HEAD, or a
    // GitHub error, is not an install and not a box.
    if (request.method === 'GET' && (upstream.status === 200 || upstream.status === 304) && env.DB) {
      ctx.waitUntil(count(file.kind, request, env).catch((err) => console.log(`count failed: ${err.message}`)));
      ctx.waitUntil(maybeRollup(env).catch((err) => console.log(`rollup failed: ${err.message}`)));
    }

    const headers = new Headers();
    for (const h of ['etag', 'last-modified', 'content-length']) {
      const v = upstream.headers.get(h);
      if (v) headers.set(h, v);
    }
    headers.set('content-type', file.type);
    headers.set('cache-control', 'no-cache');
    return new Response(upstream.body, { status: upstream.status, headers });
  },

  // Kept for accounts that can use a cron trigger; maybeRollup() covers the rest.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(rollup(env));
  },
};

function pick(headers, names) {
  const out = {};
  for (const n of names) {
    const v = headers.get(n);
    if (v) out[n] = v;
  }
  return out;
}

function country(request) {
  const c = request.cf && request.cf.country;
  return typeof c === 'string' && /^[A-Z]{2}$/.test(c) ? c : 'XX';
}

async function count(kind, request, env) {
  const day = today();
  const cc = country(request);

  if (kind !== 'check') {
    await env.DB.prepare(
      `INSERT INTO events (day, kind, country, n) VALUES (?1, ?2, ?3, 1)
       ON CONFLICT (day, kind, country) DO UPDATE SET n = n + 1`,
    ).bind(day, kind, cc).run();
    return;
  }

  // A box says which version it is on; anything that is not plainly a
  // version (a browser, curl by hand) is not counted as a box.
  const version = (request.headers.get('x-homebox-version') || '').trim();
  if (!VERSION.test(version)) return;

  const ip = request.headers.get('cf-connecting-ip') || '';
  const id = await sha256(`${env.SALT || ''}|${day}|${ip}`);
  // INSERT OR IGNORE: a box's later checks the same day write nothing.
  await env.DB.prepare(
    'INSERT OR IGNORE INTO boxes (day, id, version, country) VALUES (?1, ?2, ?3, ?4)',
  ).bind(day, id.slice(0, 32), version, cc).run();
}

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// The rollup is idempotent, so running it once per isolate per day is enough
// and needs no schedule: whichever request arrives first after midnight does it.
let rolledUpDay = null;
function maybeRollup(env) {
  const day = today();
  if (rolledUpDay === day) return Promise.resolve();
  rolledUpDay = day;
  return rollup(env);
}

async function rollup(env) {
  const cutoff = new Date(Date.now() - KEEP_RAW_DAYS * 86400000).toISOString().slice(0, 10);
  // A box that changed version mid-day is counted under the version it first
  // reported that day — one row per box per day, never two.
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO box_days (day, version, country, n)
       SELECT day, version, country, COUNT(*) FROM boxes WHERE day < ?1 GROUP BY day, version, country
       ON CONFLICT (day, version, country) DO UPDATE SET n = excluded.n`,
    ).bind(cutoff),
    env.DB.prepare('DELETE FROM boxes WHERE day < ?1').bind(cutoff),
  ]);
}

/* ----------------------------------------------------------------- stats */

async function stats(request, env, url) {
  const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '') || url.searchParams.get('key') || '';
  if (!env.STATS_TOKEN || !(await sameSecret(token, env.STATS_TOKEN))) {
    return new Response('not found', { status: 404 });
  }

  const days = Math.min(Math.max(Number(url.searchParams.get('days')) || 30, 1), 365);
  const since = new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10);

  // Live rows for the last two days, folded totals before that.
  const boxesSql = `
    SELECT day, version, country, n FROM box_days WHERE day >= ?1
    UNION ALL
    SELECT day, version, country, COUNT(*) AS n FROM boxes WHERE day >= ?1 GROUP BY day, version, country`;

  const [events, boxes] = await Promise.all([
    env.DB.prepare('SELECT day, kind, country, n FROM events WHERE day >= ?1 ORDER BY day').bind(since).all(),
    env.DB.prepare(boxesSql).bind(since).all(),
  ]);

  const byDay = {};
  const row = (d) => (byDay[d] ||= { day: d, install: 0, uninstall: 0, boxes: 0, versions: {} });
  const countries = {};
  for (const e of events.results) {
    row(e.day)[e.kind] += e.n;
    if (e.kind === 'install') countries[e.country] = (countries[e.country] || 0) + e.n;
  }
  for (const b of boxes.results) {
    const r = row(b.day);
    r.boxes += b.n;
    r.versions[b.version] = (r.versions[b.version] || 0) + b.n;
  }
  const daysList = Object.values(byDay).sort((a, b) => a.day.localeCompare(b.day));
  const latest = daysList.filter((d) => d.boxes > 0).pop() || null;
  const summary = {
    days,
    since,
    installs: daysList.reduce((s, d) => s + d.install, 0),
    uninstalls: daysList.reduce((s, d) => s + d.uninstall, 0),
    active_boxes_latest_day: latest ? latest.boxes : 0,
    latest_day: latest ? latest.day : null,
    versions_latest_day: latest ? latest.versions : {},
    install_countries: countries,
    by_day: daysList,
  };

  if (url.pathname === '/stats.json') {
    return new Response(JSON.stringify(summary, null, 2), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
  }
  return new Response(statsHtml(summary), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' } });
}

async function sameSecret(a, b) {
  const [x, y] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i += 1) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function statsHtml(s) {
  const max = Math.max(1, ...s.by_day.map((d) => Math.max(d.install, d.boxes)));
  const bars = s.by_day.map((d) => `
    <tr><td>${esc(d.day)}</td>
      <td><span class="bar i" style="width:${(d.install / max) * 100}%"></span>${d.install}</td>
      <td><span class="bar b" style="width:${(d.boxes / max) * 100}%"></span>${d.boxes}</td>
      <td>${d.uninstall}</td>
      <td class="v">${Object.entries(d.versions).sort((a, b) => b[1] - a[1]).map(([v, n]) => `${esc(v)}×${n}`).join(' ')}</td></tr>`).reverse().join('');
  const list = (obj) => Object.entries(obj).sort((a, b) => b[1] - a[1]).map(([k, n]) => `<li><span>${esc(k)}</span><b>${n}</b></li>`).join('') || '<li><span>—</span></li>';
  return `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Podhouse · סטטיסטיקה</title><meta name="robots" content="noindex">
<style>
body{margin:0;background:#0b0b10;color:#f8fafc;font:15px/1.5 system-ui,Segoe UI,Arial,sans-serif;padding:32px 20px}
.w{max-width:1000px;margin:auto}h1{margin:0 0 4px;font-size:28px}.m{color:#94a3b8;margin:0 0 24px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;margin-bottom:24px}
.c{background:#20202b;border:1px solid rgba(255,255,255,.12);border-radius:12px;padding:16px}.c b{display:block;font-size:30px}.c span{color:#94a3b8;font-size:13px}
.cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:10px;margin-bottom:24px}
ul{list-style:none;margin:0;padding:0}li{display:flex;justify-content:space-between;border-bottom:1px solid rgba(255,255,255,.08);padding:4px 0}
h2{font-size:15px;color:#a78bfa;margin:0 0 8px}.t{overflow-x:auto}table{width:100%;border-collapse:collapse;background:#20202b;border-radius:12px;overflow:hidden}
th,td{padding:7px 10px;border-bottom:1px solid rgba(255,255,255,.08);text-align:start;white-space:nowrap;font-size:13.5px}th{color:#94a3b8;font-weight:500}
td{position:relative}.bar{position:absolute;inset-block:5px;inset-inline-start:0;opacity:.28;border-radius:3px}.bar.i{background:#a78bfa}.bar.b{background:#4ade80}.v{color:#94a3b8;direction:ltr;text-align:right}
</style></head><body><div class="w">
<h1>סטטיסטיקת Podhouse</h1><p class="m">${s.days} ימים אחרונים, מ-${esc(s.since)} · ספירה אנונימית, בלי כתובות IP</p>
<div class="cards">
<div class="c"><b>${s.installs}</b><span>הרצות של install.sh</span></div>
<div class="c"><b>${s.active_boxes_latest_day}</b><span>מערכות פעילות${s.latest_day ? ` (${esc(s.latest_day)})` : ''}</span></div>
<div class="c"><b>${s.uninstalls}</b><span>הרצות של uninstall.sh</span></div>
</div>
<div class="cols"><div class="c"><h2>גרסאות (יום אחרון)</h2><ul>${list(s.versions_latest_day)}</ul></div>
<div class="c"><h2>התקנות לפי מדינה</h2><ul>${list(s.install_countries)}</ul></div></div>
<div class="t"><table><thead><tr><th>יום</th><th>התקנות</th><th>מערכות פעילות</th><th>הסרות</th><th>גרסאות</th></tr></thead><tbody>${bars}</tbody></table></div>
</div></body></html>`;
}
