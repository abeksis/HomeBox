'use strict';
/* =========================================================================
   HomeBox dashboard — front end.

   One SSE connection carries the whole live picture (host metrics, health
   verdict, container state) and everything on screen is a pure render of the
   last snapshot. No framework, no build step: the file you edit is the file
   the browser runs.
   ========================================================================= */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  summary: null,
  modules: [],
  unclaimed: [],
  categories: [],
  containers: [],
  host: 'localhost',
  category: 'all',
  appQuery: '',
  appSort: 'status',
  settingsTab: 'general',
  // Read once at startup; the Launcher renders before Settings is opened.
  launcherPrefs: { hidden: [], custom: [], overrides: {} },
  catalog: null,
  bookmarks: [],
  bookmarkMax: 60,
  // Card clicks queue here instead of firing; the apply bar commits the set.
  pending: new Map(),
  containerFilter: 'all',
  containerQuery: '',
  busy: new Set(),
  // Mirrors DEFAULT_PREFS in server.js. Only ever seen for the moment before
  // /api/prefs answers, but a mismatch here is a visible flash of the wrong
  // background on every load.
  prefs: { theme: 'dark', atmo: 'wp-purple' },
};

/* ------------------------------------------------------------- utilities */

function escapeHtml(text) {
  return String(text == null ? '' : text).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/* ------------------------------------------------------- toast and confirm */

/**
 * A toast, in the source's shape: top-right, slide in, fade out after a while.
 *
 * `textContent`, never innerHTML — a toast usually carries a server error
 * message, and those quote paths and compose output.
 */
function toast(msg, type = 'info', duration = 3500) {
  const wrap = $('#toast-wrap');
  if (!wrap) return;
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.setAttribute('role', 'alert');
  el.textContent = msg;
  wrap.appendChild(el);
  const ms = Number.isFinite(duration) ? duration : 3500;
  setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, ms);
}

/**
 * The confirm dialog the source uses before a settings save, replacing the
 * browser's own. `window.confirm` blocks the event loop, cannot say which
 * fields need a recreate, and looks like a different application.
 */
function confirmDialog({
  title, body, bodyHtml, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false, wide = false,
}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal-card${wide ? ' modal-card-wide' : ''}" role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <h3 class="modal-title" id="modal-title"></h3>
        <div class="modal-body"></div>
        <div class="modal-actions">
          <button type="button" class="btn-pill" data-act="cancel"></button>
          <button type="button" class="btn-pill primary${danger ? ' btn-danger' : ''}" data-act="confirm"></button>
        </div>
      </div>`;
    overlay.querySelector('.modal-title').textContent = title;
    // `body` is plain text and is escaped by assignment; `bodyHtml` is markup
    // this file builds, and every value interpolated into it has already gone
    // through escapeHtml. Callers never pass anything from the server here.
    if (bodyHtml) overlay.querySelector('.modal-body').innerHTML = bodyHtml;
    else overlay.querySelector('.modal-body').textContent = body;
    overlay.querySelector('[data-act="cancel"]').textContent = cancelLabel;
    overlay.querySelector('[data-act="confirm"]').textContent = confirmLabel;
    document.body.appendChild(overlay);

    const close = (val) => {
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      resolve(val);
    };
    const onKey = (e) => { if (e.key === 'Escape') close(false); };
    overlay.querySelector('[data-act="confirm"]').addEventListener('click', () => close(true));
    overlay.querySelector('[data-act="cancel"]').addEventListener('click', () => close(false));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(false); });
    document.addEventListener('keydown', onKey);
    overlay.querySelector('[data-act="confirm"]').focus();
  });
}

function bytes(n) {
  if (n == null) return '--';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)}${units[i]}`;
}

function duration(seconds) {
  if (seconds == null) return '--';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

function ago(ts) {
  const secs = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  return `${Math.floor(secs / 86400)}d`;
}

/** Warn at 80, alarm at 92 — the thresholds the health verdict also uses. */
function level(percent) {
  if (percent == null) return '';
  if (percent >= 92) return 'bad';
  if (percent >= 80) return 'warn';
  return '';
}

/**
 * Icon, with a coloured monogram fallback. A module may name an icon this
 * install does not ship, and a broken <img> looks like a bug — so the
 * fallback is built in rather than bolted on.
 */
/**
 * Resolve an icon value to an image `src`, or null when it is not an image.
 *
 * Three kinds of value arrive here:
 *
 *   - a bare filename, one of the icons shipped in `public/icons`;
 *   - an absolute http(s) URL to an image hosted elsewhere, which must NOT be
 *     run through encodeURIComponent — that turns it into a relative path and
 *     is why pasting a URL used to produce a broken image;
 *   - anything else, which is text: an emoji, rendered as itself.
 *
 * Only http(s) is accepted as a URL. The value reaches an attribute, and a
 * `javascript:` or `data:` icon is not something an icon field should carry.
 */
function iconSrc(icon) {
  if (!icon) return null;
  const value = String(icon).trim();
  // Downloaded and cached on this server — already a path, so it must not be
  // prefixed or component-encoded.
  if (/^user-icons\/[a-f0-9]{16}\.[a-z]{3,4}$/.test(value)) return value;
  if (/^https?:\/\//i.test(value)) return value;
  if (/^[\w.-]+\.(png|jpe?g|svg|webp|gif|ico)$/i.test(value)) return `icons/${encodeURIComponent(value)}`;
  return null;
}

/** Icon markup for any of the four places one is drawn. */
function iconArt(icon, mono, cls) {
  const src = iconSrc(icon);
  if (src) {
    return `<img${cls ? ` class="${cls}-icon"` : ''} src="${escapeHtml(src)}" alt="" loading="lazy"
      onerror="this.outerHTML=${escapeHtml(JSON.stringify(mono)).replace(/"/g, '&quot;')}">`;
  }
  if (icon) return `<span class="icon-emoji${cls ? ` ${cls}-emoji` : ''}">${escapeHtml(String(icon))}</span>`;
  return mono;
}

/**
 * The small icon on a Settings editor row. Same resolver as everywhere else,
 * so a downloaded URL, a shipped filename and an emoji all work — a row that
 * showed only text made a list of sixteen modules read as a list of strings
 * rather than a list of apps.
 */
function editorIcon(icon, label) {
  const initials = String(label || '?').replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || '?';
  const mono = `<span class="editor-icon-mono">${escapeHtml(initials)}</span>`;
  return `<span class="editor-icon">${iconArt(icon, mono, 'editor')}</span>`;
}

function iconHtml(icon, label, theme, cls) {
  const color = (theme && theme.color) || 'var(--accent)';
  const bg = (theme && theme.bg) || 'var(--accent-soft)';
  const initials = String(label || '?').replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || '?';
  const mono = `<span class="${cls}-mono" style="background:${escapeHtml(bg)};color:${escapeHtml(color)}">${escapeHtml(initials)}</span>`;
  return iconArt(icon, mono, cls);
}

const STATUS_LABEL = {
  available: 'not installed',
  running: 'running',
  partial: 'partly up',
  stopped: 'stopped',
  unhealthy: 'unhealthy',
};

/* --------------------------------------------------------------- routing */

const PAGES = ['home', 'apps', 'containers', 'logs', 'updates', 'settings'];

function show(page) {
  const target = PAGES.includes(page) ? page : 'home';
  $$('.page').forEach((el) => el.classList.toggle('active', el.id === `page-${target}`));
  $$('.tab').forEach((el) => {
    const active = el.dataset.page === target;
    el.classList.toggle('active', active);
    if (active) el.setAttribute('aria-current', 'page');
    else el.removeAttribute('aria-current');
  });
  if (target !== 'home') loadModules();
  if (target === 'home') loadInsights();
  if (target === 'updates') { loadUpdates(); loadPlatform(); }
  if (target === 'settings') { loadBackups(); loadConfig(); loadCatalog(); loadStorage(); loadResets(); }
  if (target === 'settings' || target === 'home') loadBookmarks();
  window.scrollTo({ top: 0, behavior: 'instant' });
}

const currentPage = () => (location.hash || '#home').slice(1).split('?')[0];

window.addEventListener('hashchange', () => show(currentPage()));

document.addEventListener('click', (event) => {
  const link = event.target.closest('[data-page]');
  if (!link) return;
  event.preventDefault();
  location.hash = `#${link.dataset.page}`;
  if (currentPage() === link.dataset.page) show(link.dataset.page);
});

/* ------------------------------------------------------------ home render */

function greetingText() {
  // Three bands, switching to evening at 17:00 - the source's boundaries,
  // and its crescent moon rather than a dusk skyline.
  const h = new Date().getHours();
  if (h < 12) return 'Good morning! ☀️';
  if (h < 17) return 'Good afternoon! 👋';
  return 'Good evening! 🌙';
}

function renderTopbar(summary) {
  const { metrics } = summary;
  const set = (id, text, pct) => {
    const el = $(id);
    el.textContent = text;
    const lv = level(pct);
    if (lv) el.dataset.level = lv;
    else delete el.dataset.level;
  };
  set('#topbar-cpu', `CPU ${metrics.cpu == null ? '--' : `${metrics.cpu}%`}`, metrics.cpu);
  set('#topbar-ram', `RAM ${metrics.memory.percent}%`, metrics.memory.percent);
  set('#topbar-disk', `Disk ${metrics.disk.percent == null ? '--' : `${metrics.disk.percent}%`}`, metrics.disk.percent);
  $('#brand-version').textContent = `v${summary.version}`;
}

function renderGauge(prefix, percent, detail) {
  const ring = $(`#ring-${prefix}`);
  const arc = $(`#arc-${prefix}`);
  const pct = percent == null ? 0 : Math.max(0, Math.min(100, percent));
  arc.setAttribute('stroke-dasharray', `${pct},100`);
  $(`#val-${prefix}`).textContent = percent == null ? '--' : `${percent}%`;
  const lv = level(percent);
  if (lv) ring.dataset.level = lv;
  else delete ring.dataset.level;
  if (detail != null) $(`#detail-${prefix}`).textContent = detail;
}

function renderHealth(summary) {
  const hero = $('#status-hero');
  const { health } = summary;
  hero.dataset.level = health.level;
  $('#sh-icon').textContent = health.level === 'good' ? '✓' : health.level === 'warn' ? '!' : '×';
  $('#sh-title').textContent = health.title;
  $('#sh-sub').textContent = health.sub;

  const cta = $('#sh-cta');
  if (health.names && health.names.length) {
    cta.innerHTML = `<button type="button" class="btn btn-primary" data-log-for="${escapeHtml(health.names[0])}">Open ${escapeHtml(health.names[0])} logs</button>`;
  } else if (summary.counts.installed === 0) {
    cta.innerHTML = '<a class="btn btn-primary" href="#apps" data-page="apps">Browse apps</a>';
  } else {
    cta.innerHTML = '';
  }

  $('#greeting').textContent = greetingText();
  $('#hero-sub').textContent = health.level === 'good'
    ? `${summary.counts.installed} of ${summary.counts.modules} apps installed, ${summary.counts.running} containers up.`
    : health.sub;
}

function renderLauncher(modules) {
  const prefs = state.launcherPrefs;
  const hidden = new Set(prefs.hidden);
  const tiles = [];
  for (const mod of modules) {
    if (!mod.installed) continue;
    for (const svc of mod.services) {
      if (svc.internal || !svc.url) continue;
      const key = tileKey(mod.id, svc.name);
      if (hidden.has(key)) continue;
      const over = prefs.overrides[key] || {};
      tiles.push({ ...svc, module: mod, friendly_name: over.name || svc.friendly_name, customIcon: over.icon || null });
    }
  }
  // Personal links sit in their own group at the end: they are not apps on
  // this box, and mixing them into a category would imply HomeBox manages them.
  for (const item of prefs.custom) {
    tiles.push({
      name: item.id,
      friendly_name: item.name,
      url: item.url,
      customIcon: item.icon || null,
      description: item.url,
      container: null,
      module: { id: item.id, category: '_custom', theme: {} },
    });
  }
  $('#launcher-meta').textContent = tiles.length ? `${tiles.length} apps` : '';

  if (!tiles.length) {
    $('#launcher').innerHTML = '<p class="activity-empty">Nothing installed yet. '
      + '<a class="link-btn" href="#apps" data-page="apps">Browse the apps</a> and pick one.</p>';
    return;
  }

  // Grouped by category, in the catalog's own order, so the launcher keeps a
  // stable shape as apps come and go instead of reshuffling on every render.
  const order = state.categories.map((c) => c.id);
  const label = Object.fromEntries(state.categories.map((c) => [c.id, c.label]));
  label._custom = 'Your links';
  const groups = new Map();
  for (const tile of tiles) {
    const key = tile.module.category;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(tile);
  }
  const sorted = [...groups.entries()].sort(
    (a, b) => (order.indexOf(a[0]) + 1 || 99) - (order.indexOf(b[0]) + 1 || 99)
  );

  $('#launcher').innerHTML = sorted.map(([category, items]) => `
    <div class="launcher-category">
      <div class="launcher-category-title">${escapeHtml(label[category] || category)}</div>
      <div class="launcher-grid">${items.map(launchTile).join('')}</div>
    </div>`).join('');
}

/** One keycap: the app's own icon on a gradient key, with a state pip. */
function launchTile(tile) {
  const st = tile.container ? tile.container.state : null;
  const down = st === 'stopped' || st === 'unhealthy';
  const color = tile.color || (tile.module.theme && tile.module.theme.color) || 'var(--accent)';
  const pip = st ? `<span class="keycap-status" data-state="${escapeHtml(st)}" title="${escapeHtml(st)}"></span>` : '';

  // The icon carries the brand colour; the key stays neutral. A module may
  // name an icon this install does not ship, so a monogram stands in.
  const initials = String(tile.friendly_name || '?').replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || '?';
  const mono = `<span class="keycap-mono" style="background:${escapeHtml(color)}22;color:${escapeHtml(color)}">${escapeHtml(initials)}</span>`;
  // A per-browser override wins, then the service's own icon, then the
  // module's emoji — a user-added module has no icon file to point at, so the
  // emoji is all it has.
  const art = iconArt(
    tile.customIcon || tile.icon || (tile.module.theme && tile.module.theme.emoji),
    mono, 'keycap',
  );

  // `noreferrer` is not decoration, and it is not the same as `noopener`.
  //
  // Without it the browser sends `Referer: http://<box>:8443/` to the app
  // being opened, and an app with CSRF protection compares that origin to
  // its own, sees a mismatch and refuses the request. qBittorrent answers a
  // bare "Unauthorized" — no login form, no explanation — so it reads as a
  // broken password rather than a header the launcher should not have sent.
  // Its log is where this is actually visible:
  //
  //   WebUI: Referer header & Target origin mismatch!
  //   Referer header: 'http://192.168.1.77:8443/' Target origin: '192.168.1.77:8080'
  //
  // Every outbound link on this page carries it, for the same reason.
  // A service with a first_login note has something to say before it opens —
  // usually the generated password, which otherwise lives only in .env and a
  // CLI command. Marked here; the click is intercepted once, and the tick in
  // that dialog removes the marker for good.
  //
  // `data-fl-*` and NOT `data-module`: the document click handler opens the
  // module drawer for anything matching `[data-module]`, so naming it that
  // made every marked launcher tile slide the drawer open behind the dialog.
  // A generic attribute name on a shared document listener is a collision
  // waiting to happen.
  let first = '';
  try {
    if (tile.first_login && !localStorage.getItem(seenKey(tile.name))) {
      first = ` data-first-login="1" data-fl-service="${escapeHtml(tile.name)}" data-fl-module="${escapeHtml(tile.module.id)}"`;
    }
  } catch { /* localStorage blocked: show it, which is the safe direction */ }

  return `<a class="launch${down ? ' is-down' : ''}" href="${escapeHtml(tile.url)}" target="_blank" rel="noopener noreferrer"${first}
      title="${escapeHtml(tile.description || tile.friendly_name)}">
      <span class="keycap">${art}${pip}</span>
      <span class="launch-name">${escapeHtml(tile.friendly_name)}</span>
    </a>`;
}

/* ------------------------------------------------- network & maintenance */

/**
 * Every container HomeBox owns, with the app it implements and where to
 * reach it. This is the "what is actually running" answer that the module
 * cards only summarise.
 */
function renderRunning(modules) {
  const rows = [];
  for (const mod of modules) {
    if (!mod.installed) continue;
    for (const container of mod.containers) {
      const svc = mod.services.find((x) => x.name === container.service);
      rows.push({ container, svc, mod });
    }
  }
  rows.sort((a, b) => a.container.name.localeCompare(b.container.name));

  $('#running-meta').textContent = rows.length
    ? `${rows.filter((r) => r.container.state !== 'stopped').length}/${rows.length} up`
    : '';

  $('#running-list').innerHTML = rows.map(runningRow).join('')
    || '<p class="activity-empty">Nothing installed yet.</p>';
}

function runningRow({ container, svc, mod }) {
  const name = svc ? svc.friendly_name : container.name;
  const icon = (svc && svc.icon) || mod.icon;
  const color = (svc && svc.color) || (mod.theme && mod.theme.color) || 'var(--accent)';
  const on = container.state !== 'stopped';
  const initials = String(name).replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || '?';

  // A tinted square with the icon in the brand colour — the Running list's
  // own treatment, distinct from the launcher's neutral keycap.
  const mono = `<span style="color:${escapeHtml(color)}">${escapeHtml(initials)}</span>`;
  const art = iconArt(icon || (mod.theme && mod.theme.emoji), mono, 'run');

  const badge = container.state === 'unhealthy' ? '<span class="health-badge unhealthy">Unhealthy</span>'
    : container.state === 'starting' ? '<span class="health-badge starting">Starting</span>'
      : '';
  const core = mod.required ? '<span class="critical-badge">Core</span>' : '';

  return `<div class="running-row" data-down="${on ? '0' : '1'}">
    <span class="running-icon" style="background:${tint(color)}">${art}</span>
    <span class="running-info">
      <span class="running-name">${escapeHtml(name)}${core}${badge}</span>
      <span class="running-detail">
        <span class="status-dot ${on ? 'on' : 'off'}"></span>
        ${escapeHtml(container.status || container.state)}
      </span>
    </span>
    <span class="running-stats">
      <span class="mini-stat">
        <span class="mini-stat-val">${container.cpu == null ? '--' : `${container.cpu}%`}</span>
        <span class="mini-stat-label">CPU</span>
      </span>
      <span class="mini-stat">
        <span class="mini-stat-val">${container.memory == null ? '--' : bytes(container.memory)}</span>
        <span class="mini-stat-label">MEM</span>
      </span>
    </span>
    <span class="running-actions">${containerActions(container, on)}</span>
  </div>`;
}

/** A hex brand colour as a low-opacity tint, for the icon's backing square. */
function tint(color) {
  const hex = String(color).replace('#', '');
  if (hex.length !== 6) return 'rgba(255,255,255,0.06)';
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.substring(i, i + 2), 16));
  return `rgba(${r},${g},${b},0.12)`;
}

function containerActions(container, on) {
  const id = escapeHtml(container.name);
  if (!on) {
    return `<button type="button" class="btn-pill primary" data-container="${id}" data-caction="start">Resume</button>`;
  }
  // "Pause" is a stop: the container and its data stay, it just is not
  // running. Docker's own pause freezes a process still holding its ports,
  // which is not what anyone means by pausing an app.
  return `<button type="button" class="btn-pill" data-log-for="${id}">Logs</button>
    <button type="button" class="btn-pill" data-container="${id}" data-caction="restart">Restart</button>
    <button type="button" class="btn-pill" data-container="${id}" data-caction="stop"
      title="Keeps all data — resume any time">Pause</button>`;
}

/** Logs / Restart / Pause on one container, straight from the Running list. */
async function runContainerAction(name, action) {
  if (action === 'stop') {
    const ok = await confirmDialog({
      title: `Pause ${name}?`,
      body: 'It stops running. Nothing is deleted, and Resume brings it back.',
      confirmLabel: 'Pause',
    });
    if (!ok) return;
  }
  const buttons = $$(`[data-container="${CSS.escape(name)}"]`);
  buttons.forEach((b) => { b.disabled = true; });
  const done = { restart: 'restarted', stop: 'paused', start: 'resumed' }[action] || action;
  try {
    const res = await fetch(`api/containers/${encodeURIComponent(name)}/${encodeURIComponent(action)}`, { method: 'POST' });
    const data = await res.json();
    if (!data.ok) toast(`${action} failed: ${data.error}`, 'error', 8000);
    else toast(`${name} ${done}.`, 'success');
  } catch (err) {
    toast(`${action} failed: ${err.message}`, 'error', 8000);
  } finally {
    await loadModules(true);
  }
}

function renderNetwork(summary) {
  const n = summary.network || {};
  $('#network-meta').textContent = summary.host.address;
  $('#network-grid').innerHTML = [
    ['Hostname', summary.host.name],
    ['Dashboard', n.dashboard],
    ['Proxy', n.proxy],
    ['Docker networks', n.networks],
  ].map(([label, value]) => `
    <div class="network-item">
      <div class="network-label">${escapeHtml(label)}</div>
      <div class="network-value mono">${escapeHtml(value == null ? '—' : value)}</div>
    </div>`).join('');
}

function renderBackupCard(summary) {
  const b = summary.backups || {};
  $('#backup-meta').textContent = b.count ? `${b.count} archive${b.count === 1 ? '' : 's'}` : 'none yet';
  $('#backup-body').innerHTML = `
    ${backupRow('Archives', b.count || 'none', b.count ? 'good' : 'warn')}
    ${backupRow('Newest', b.latest ? `${ago(b.latest.created)} ago` : 'never', b.latest ? 'good' : 'warn')}
    ${backupRow('Scheduled', b.scheduled ? 'yes' : 'manual only', b.scheduled ? 'good' : '')}
    ${backupRow('App config', `${b.appConfigs} module${b.appConfigs === 1 ? '' : 's'}`)}
    ${backupRow('Disk free', bytes(b.diskFree))}
    <p class="backup-note">Archives are encrypted and sit on this same disk.
      Settings &rarr; Backup takes one; copying them somewhere else is still your job.</p>`;
}

function renderActivity(entries) {
  const list = $('#activity-list');
  if (!entries.length) {
    list.innerHTML = '<li class="activity-empty">Nothing yet. Installs and container events show up here.</li>';
    return;
  }
  list.innerHTML = entries.map((e) => `
    <li class="activity-item" data-level="${escapeHtml(e.level)}">
      <span class="activity-dot" data-action="${escapeHtml(e.action)}"></span>
      <span class="activity-name">${escapeHtml(e.name)}</span>
      <span class="activity-what">${escapeHtml(actionText(e))}</span>
      <span class="activity-when">${escapeHtml(ago(e.time))}</span>
    </li>`).join('');
}

function actionText(entry) {
  if (entry.action === 'die') return entry.exitCode ? `exited with code ${entry.exitCode}` : 'stopped';
  return {
    start: 'started', stop: 'was stopped', restart: 'restarted', create: 'was created',
    destroy: 'was removed', kill: 'was killed', oom: 'ran out of memory',
    pause: 'was paused', unpause: 'was resumed',
    install: 'was installed', update: 'was updated', remove: 'was removed',
  }[entry.action] || entry.action;
}

/* ------------------------------------------------------------- apps page */

function renderCategories() {
  const used = new Set(state.modules.map((m) => m.category));
  const chips = [{ id: 'all', label: 'All' }, ...state.categories.filter((c) => used.has(c.id))];
  $('#category-chips').innerHTML = chips.map((c) => `
    <button type="button" class="chip${state.category === c.id ? ' active' : ''}" data-category="${escapeHtml(c.id)}">${escapeHtml(c.label)}</button>`).join('');
}

function matchesQuery(mod, query) {
  if (!query) return true;
  return [mod.title, mod.tagline, mod.description, mod.id, ...mod.services.map((s) => `${s.friendly_name} ${s.name}`)]
    .join(' ').toLowerCase().includes(query);
}

/** "~1.2GB" → bytes, so estimates can be summed and compared to real RAM. */
function parseRam(text) {
  const m = /([\d.]+)\s*(TB|GB|MB|KB)/i.exec(String(text || ''));
  if (!m) return 0;
  const scale = { KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };
  return Number(m[1]) * scale[m[2].toUpperCase()];
}

/**
 * The estimate bar. It sums the `ram` figures the modules declare rather than
 * measuring containers, on purpose: the question it answers is "can this box
 * take the thing I am about to install", and that has to be answerable before
 * anything is running.
 */
function renderStoreStats() {
  const installed = state.modules.filter((m) => m.installed);
  const estimate = installed.reduce((sum, m) => sum + parseRam(m.ram), 0);
  const total = state.summary && state.summary.metrics ? state.summary.metrics.memory.total : null;
  const percent = total ? Math.min(100, Math.round((estimate / total) * 100)) : 0;

  $('#store-stats').textContent =
    `${installed.length} of ${state.modules.length} apps installed · about ${bytes(estimate)} of estimated memory`;
  $('#ram-usage-text').textContent = total ? `${bytes(estimate)} / ${bytes(total)}` : bytes(estimate);
  const fill = $('#ram-bar-fill');
  fill.style.width = `${percent}%`;
  const lv = level(percent);
  if (lv) fill.dataset.level = lv;
  else delete fill.dataset.level;
}

const SORTS = {
  name: (a, b) => a.title.localeCompare(b.title),
  ram: (a, b) => parseRam(b.ram) - parseRam(a.ram),
  status: (a, b) => (Number(b.installed) - Number(a.installed)) || a.title.localeCompare(b.title),
};

/** The card's one button, in whichever state the module is actually in. */
function appActionButton(mod) {
  const id = escapeHtml(mod.id);
  if (state.busy.has(mod.id)) {
    return '<span class="app-action-btn" aria-live="polite"><span class="spinner"></span></span>';
  }
  if (mod.required) {
    return '<span class="app-action-btn locked" title="Always on — the box needs it">Always On</span>';
  }
  // Queued: the click is staged, not done. Says so, and clicking again undoes it.
  if (state.pending.has(mod.id)) {
    const install = state.pending.get(mod.id);
    return `<button type="button" class="app-action-btn ${install ? 'queued-install' : 'queued-remove'}"
      data-queue="${id}" title="Queued — click to undo, or Apply changes to run it"
      >${install ? '\u2713 Queued' : '\u2715 Queued'}</button>`;
  }
  if (!mod.installed) {
    return `<button type="button" class="app-action-btn" data-queue="${id}">+ Install</button>`;
  }
  // Reads "Installed", becomes a red "Remove" on hover or keyboard focus.
  return `<button type="button" class="app-action-btn is-installed" data-queue="${id}"
    title="Installed — click to queue removal. Settings and data are kept.">Installed</button>`;
}

/**
 * The status line under the name on an installed card. Counts, not just a
 * word: "2/6 running" is the difference between a module that is fine and one
 * that is half up, and the single dot cannot say which.
 */
function cardStatusLabel(m) {
  const { total = 0, running = 0, unhealthy = 0 } = m.counts || {};
  if (unhealthy) return unhealthy === 1 ? '1 service unhealthy' : `${unhealthy} services unhealthy`;
  if (m.status === 'running') return 'Running';
  if (m.status === 'stopped') return 'Stopped';
  return `${running}/${total} running`;
}

/**
 * "Included services" — the grey well listing what a module actually starts.
 *
 * A module is not one container, and the card used to hide that: installing
 * "Media" starts six things on six ports, and there was nowhere to see them.
 * A running service with a reachable port becomes a real link, because a bare
 * ":8989" invites a click that goes nowhere.
 */
function renderIncludedServices(m) {
  if (!m.services || !m.services.length) return '';
  const rows = m.services.map((svc) => {
    // A container WITH a healthcheck reports 'healthy', not 'running' — so
    // testing for 'running' alone marks every well-behaved service red and
    // leaves only the ones nobody wrote a healthcheck for green. Up means not
    // stopped; 'unhealthy' is excluded because a green dot on a failing
    // healthcheck is a lie the rest of the page does not tell.
    const st = svc.container && svc.container.state;
    const live = !!st && st !== 'stopped' && st !== 'unhealthy';
    const right = m.installed && svc.url && live
      ? `<a href="${escapeHtml(svc.url)}" target="_blank" rel="noopener noreferrer" class="app-service-open"
           title="Open ${escapeHtml(svc.friendly_name)} in a new tab">Open ↗</a>`
      : (svc.port ? `<span class="app-service-port">:${escapeHtml(String(svc.port))}</span>` : '');
    // Every service already declares its own icon, and the module's emoji
    // stands in for the ones that do not — a row of names alone is harder to
    // scan than the same row with the marks people actually recognise.
    const art = iconArt(
      svc.icon || (m.theme && m.theme.emoji),
      `<span class="app-service-mono">${escapeHtml(
        String(svc.friendly_name || '?').replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || '?',
      )}</span>`,
      'app-service',
    );
    return `<div class="app-service-row"${svc.description ? ` title="${escapeHtml(svc.description)}"` : ''}>
      <span class="app-service-mark">${art}</span>
      <span class="app-service-name">${escapeHtml(svc.friendly_name)}</span>
      <span class="app-service-right">
        ${m.installed ? `<span class="status-dot ${live ? 'on' : 'off'}"></span>` : ''}${right}
      </span>
    </div>`;
  }).join('');
  return `<div class="app-services">
    <div class="app-services-title">Included services</div>
    ${rows}
  </div>`;
}

/** The per-module setup notes every module already declares in `tips:`. */
function renderTips(m) {
  if (!m.tips || !m.tips.length) return '';
  return `<div class="app-tips">${m.tips.map((t) => `<div class="app-tip">${escapeHtml(t)}</div>`).join('')}</div>`;
}

function renderApps() {
  const query = state.appQuery.trim().toLowerCase();
  const list = state.modules
    .filter((m) => state.category === 'all' || m.category === state.category)
    .filter((m) => matchesQuery(m, query))
    .sort(SORTS[state.appSort] || SORTS.name);

  $('#apps-grid').innerHTML = list.map((m) => {
    const color = (m.theme && m.theme.color) || 'var(--accent)';
    const initials = String(m.title).replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || '?';
    const mono = `<span style="color:${escapeHtml(color)};font-weight:800;font-size:1.05rem">${escapeHtml(initials)}</span>`;
    const art = iconArt(m.icon || (m.theme && m.theme.emoji), mono, 'app');
    const queued = state.pending.has(m.id)
      ? (state.pending.get(m.id) ? ' pending-install' : ' pending-remove') : '';
    return `<div class="app-card${m.installed ? ' is-installed' : ''}${queued}">
      <div class="app-top">
        <span class="app-icon" data-module="${escapeHtml(m.id)}" role="button" tabindex="0"
              title="${escapeHtml(m.title)} — details">${art}</span>
        ${appActionButton(m)}
      </div>
      <div class="app-name" data-module="${escapeHtml(m.id)}" role="button" tabindex="0">${escapeHtml(m.title)}</div>
      ${m.installed ? `<div class="app-card-status" data-status="${escapeHtml(m.status)}">
        <span class="status-dot ${m.status === 'running' ? 'on' : 'off'}"></span>${escapeHtml(cardStatusLabel(m))}
      </div>` : ''}
      ${m.tagline ? `<span class="app-tagline">${escapeHtml(m.tagline)}</span>` : ''}
      <p class="app-desc">${escapeHtml(m.description)}</p>
      ${renderIncludedServices(m)}
      ${renderTips(m)}
      <div class="app-meta">
        <span class="app-tag ${m.required ? 'required' : 'optional'}">${m.required ? 'Always On' : 'Optional'}</span>
        ${m.ram ? `<span class="app-tag ram">${escapeHtml(m.ram)}</span>` : ''}
        ${m.installed ? `<span class="app-tag state" data-status="${escapeHtml(m.status)}">${escapeHtml(STATUS_LABEL[m.status] || m.status)}</span>` : ''}
      </div>
    </div>`;
  }).join('') || '<p class="activity-empty">Nothing matches that.</p>';

  renderStoreStats();

  const block = $('#unclaimed-block');
  if (state.unclaimed.length) {
    block.hidden = false;
    $('#unclaimed-meta').textContent = `${state.unclaimed.length} containers`;
    $('#unclaimed-list').innerHTML = state.unclaimed.map((c) => `<span class="unclaimed-item">${escapeHtml(c.name)}</span>`).join('');
  } else {
    block.hidden = true;
  }
}

/* -------------------------------------------------------- containers page */

const CONTAINER_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'running', label: 'Running' },
  { id: 'stopped', label: 'Stopped' },
  { id: 'unhealthy', label: 'Needs attention' },
];

function renderContainerChips() {
  $('#container-chips').innerHTML = CONTAINER_FILTERS.map((f) => `
    <button type="button" class="chip${state.containerFilter === f.id ? ' active' : ''}" data-cfilter="${escapeHtml(f.id)}">${escapeHtml(f.label)}</button>`).join('');
}

function moduleForContainer(c) {
  if (!c.project) return null;
  const mod = state.modules.find((m) => `homebox-${m.id}` === c.project);
  return mod ? mod.title : null;
}

function renderContainers() {
  const query = state.containerQuery.trim().toLowerCase();
  const rows = state.containers
    .filter((c) => {
      if (state.containerFilter === 'running') return c.state !== 'stopped';
      if (state.containerFilter === 'stopped') return c.state === 'stopped';
      if (state.containerFilter === 'unhealthy') return c.state === 'unhealthy' || c.state === 'starting';
      return true;
    })
    .filter((c) => !query || `${c.name} ${c.image}`.toLowerCase().includes(query))
    .sort((a, b) => a.name.localeCompare(b.name));

  $('#containers-body').innerHTML = rows.map((c) => `
    <tr>
      <td><span class="state" data-state="${escapeHtml(c.state)}">${escapeHtml(c.state)}</span></td>
      <td class="cell-name">${escapeHtml(c.name)}</td>
      <td class="cell-dim">${escapeHtml(c.image)}</td>
      <td class="cell-dim">${c.ports.length ? escapeHtml(c.ports.join(', ')) : '—'}</td>
      <td class="cell-dim">${escapeHtml(moduleForContainer(c) || '—')}</td>
      <td><button type="button" class="link-btn" data-log-for="${escapeHtml(c.name)}">logs</button></td>
    </tr>`).join('') || '<tr><td colspan="6" class="cell-dim">Nothing matches that.</td></tr>';
}

/* ------------------------------------------------------------- logs page */

// Split and rejoin on a real newline without an escape sequence in the
// source, so the character survives every tool that rewrites this file.
const NL = String.fromCharCode(10);
let logText = '';

async function loadLogs(name) {
  const picker = $('#log-picker');
  if (name) picker.value = name;
  if (!picker.value) return;
  const view = $('#log-view');
  view.textContent = 'Loading…';
  try {
    const res = await fetch(`api/logs?name=${encodeURIComponent(picker.value)}&tail=${encodeURIComponent($('#log-tail').value)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    logText = data.text.trim() || '(no output)';
    renderLogs();
  } catch (err) {
    logText = '';
    view.textContent = `Could not read logs: ${err.message}`;
  }
}

/**
 * Filtering keeps only matching lines and highlights the match. Done here
 * rather than server-side so changing the filter is instant and does not
 * re-read the container.
 */
function renderLogs() {
  const view = $('#log-view');
  const filter = $('#log-filter').value.trim();
  if (!filter) {
    view.textContent = logText;
  } else {
    const needle = filter.toLowerCase();
    const lines = logText.split(NL).filter((l) => l.toLowerCase().includes(needle));
    view.innerHTML = lines.length
      ? lines.map((line) => highlight(line, filter)).join(NL)
      : `<span style="opacity:.6">No line matches ${escapeHtml(filter)}.</span>`;
  }
  if ($('#log-follow').checked) view.parentElement.scrollTop = view.parentElement.scrollHeight;
}

function highlight(line, needle) {
  const at = line.toLowerCase().indexOf(needle.toLowerCase());
  if (at === -1) return escapeHtml(line);
  return escapeHtml(line.slice(0, at))
    + `<mark>${escapeHtml(line.slice(at, at + needle.length))}</mark>`
    + escapeHtml(line.slice(at + needle.length));
}

function renderLogPicker() {
  const picker = $('#log-picker');
  const selected = picker.value;
  picker.innerHTML = '<option value="">Pick a service…</option>' + state.containers
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((c) => `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)}${c.state === 'stopped' ? ' (stopped)' : ''}</option>`)
    .join('');
  if (selected) picker.value = selected;
}

function openLogs(name) {
  location.hash = '#logs';
  show('logs');
  loadModules(true).then(() => loadLogs(name));
}

/**
 * The drawer's control set. The card carries one button by design; the drawer
 * is where the full lifecycle lives, so it needs its own builder.
 */
function actionsFor(mod) {
  if (state.busy.has(mod.id)) {
    return '<span class="btn btn-busy" aria-live="polite"><span class="spinner"></span>working…</span>';
  }
  const out = [];
  if (!mod.installed) {
    out.push(`<button type="button" class="btn btn-primary" data-action="install" data-id="${escapeHtml(mod.id)}">Install</button>`);
    return out.join('');
  }
  if (mod.status === 'stopped') {
    out.push(`<button type="button" class="btn btn-primary" data-action="start" data-id="${escapeHtml(mod.id)}">Start</button>`);
  } else {
    out.push(`<button type="button" class="btn" data-action="restart" data-id="${escapeHtml(mod.id)}">Restart</button>`);
    if (!mod.required) {
      out.push(`<button type="button" class="btn" data-action="stop" data-id="${escapeHtml(mod.id)}">Stop</button>`);
    }
  }
  return out.join('');
}

/* ------------------------------------------------------- system actions */

/**
 * Restart or update everything installed, one module at a time.
 *
 * The dashboard is skipped on purpose: restarting the container serving this
 * page kills the request mid-flight, and from the outside the button looks
 * like it did nothing. Restart that one from a shell.
 */
async function bulkAction(action, label) {
  const targets = state.modules.filter((m) => m.installed && m.id !== 'dashboard');
  if (!targets.length) return;
  const plural = targets.length === 1 ? '' : 's';
  const ok = await confirmDialog({
    title: `${label} ${targets.length} installed app${plural}?`,
    body: 'The dashboard itself is left alone so this page survives.',
    confirmLabel: label,
  });
  if (!ok) return;

  const button = $(action === 'restart' ? '#action-restart-all' : '#action-update-all');
  const labelEl = button ? $('.qa-label', button) : null;
  const original = labelEl ? labelEl.textContent : '';
  let done = 0;
  for (const mod of targets) {
    if (labelEl) labelEl.textContent = `${done}/${targets.length}`;
    try {
      await fetch(`api/modules/${encodeURIComponent(mod.id)}/${action}`, { method: 'POST' });
    } catch {
      /* one module failing should not abandon the rest */
    }
    done++;
  }
  if (labelEl) labelEl.textContent = original;
  await loadModules(true);
}

/** The Portainer tile opens it when installed, and offers it when not. */
function updatePortainerAction() {
  const link = $('#action-portainer');
  if (!link) return;
  const core = state.modules.find((m) => m.id === 'core');
  const svc = core && core.installed ? core.services.find((x) => x.name === 'portainer' && x.url) : null;
  if (svc) {
    link.href = svc.url;
    link.target = '_blank';
    // noreferrer as well, for the same reason every other outbound link on
    // this page carries it: an app with a strict referer check refuses a
    // request that says it came from the dashboard's port.
    link.rel = 'noopener noreferrer';
    delete link.dataset.page;
    link.title = 'Open Portainer';
  } else {
    link.href = '#apps';
    link.removeAttribute('target');
    link.dataset.page = 'apps';
    link.title = 'Portainer is part of the Core module';
  }
}

/* ------------------------------------------------ raw configuration editor */

let configSchema = null;

async function loadConfig() {
  if (!$('#config-groups')) return;
  try {
    configSchema = await (await fetch('api/config')).json();
  } catch {
    return;
  }
  $('#config-file-note').innerHTML =
    `Edited in place in <code class="mono">${escapeHtml(configSchema.file)}</code>. Comments and anything HomeBox does not know about are left alone. `
    + 'Most changes need the affected app restarted before they take effect.';

  $('#config-groups').innerHTML = configSchema.groups.map((group) => `
    <div class="settings-group${group.dangerous ? ' dangerous-group' : ''}">
      <div class="settings-group-title">
        ${escapeHtml(group.title)}
        ${group.dangerous ? '<span class="group-warning">Contains security keys — be careful!</span>' : ''}
      </div>
      ${group.description ? `<p class="settings-group-desc">${escapeHtml(group.description)}</p>` : ''}
      ${group.keys.map(configRow).join('')}
    </div>`).join('');
}

function configRow(k) {
  const id = `cfg-${k.key}`;
  const input = `<input class="config-input" id="${escapeHtml(id)}" data-config-key="${escapeHtml(k.key)}"
    type="${k.secret ? 'password' : 'text'}"
    value="${escapeHtml(k.value || '')}"
    data-original="${escapeHtml(k.value || '')}"
    placeholder="${escapeHtml(k.placeholder || '')}"
    ${k.readonly ? 'disabled' : ''} autocomplete="off" spellcheck="false">`;

  return `<div class="config-row">
    <label class="config-label" for="${escapeHtml(id)}">
      ${escapeHtml(k.label || k.key)}
      <span class="config-key">${escapeHtml(k.key)}</span>
    </label>
    ${k.secret
      ? `<span class="config-secret">${input}<button type="button" class="btn-pill" data-config-show="${escapeHtml(id)}">Show</button></span>`
      : input}
    ${k.hint ? `<p class="config-hint">${escapeHtml(k.hint)}</p>` : ''}
  </div>`;
}

async function saveConfig() {
  const changes = {};
  for (const input of $$('#config-groups .config-input')) {
    if (input.disabled) continue;
    if (input.value !== input.dataset.original) changes[input.dataset.configKey] = input.value;
  }
  const status = $('#config-save-status');
  const keys = Object.keys(changes);
  if (!keys.length) {
    toast('No changes to save.', 'info');
    status.textContent = 'Nothing changed.';
    return;
  }

  // Say up front what this will do to running apps. A settings save that
  // silently replaces containers is worse than one that does nothing.
  const ok = await confirmDialog({
    title: 'Save settings?',
    body: `This rewrites ${keys.length} value${keys.length === 1 ? '' : 's'} in .env:\n${keys.join(', ')}\n\n`
      + 'A container keeps the paths it was created with, so HomeBox will recreate any installed '
      + 'app that uses one of these — briefly interrupting it.',
    confirmLabel: 'Save and apply',
  });
  if (!ok) return;

  const button = $('#btn-save-config');
  button.disabled = true;
  button.classList.add('btn-busy');
  status.textContent = 'Saving…';
  try {
    const res = await fetch('api/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ changes }),
    });
    const data = await res.json();
    if (!data.ok) {
      toast(data.error, 'error', 8000);
      status.textContent = `Failed: ${data.error}`;
      return;
    }

    const saved = `Saved ${data.applied.length} value${data.applied.length === 1 ? '' : 's'}.`;
    const restarting = data.restarting || [];
    const failed = data.failed || [];
    const manual = data.manual || [];

    // Report what the server actually did, not what the key list implies.
    // Telling someone to restart something that has already been restarted is
    // how a save reads as "did nothing".
    if (failed.length) {
      toast(`${saved} ${failed.map((f) => `${f.id}: ${f.error}`).join(' · ')}`, 'error', 14000);
    } else if (restarting.length) {
      // The dashboard recreates itself a moment after answering, so the page
      // is about to lose its connection. Saying so beats a live dot going red
      // for no visible reason directly after a save.
      const self = restarting.includes('dashboard');
      toast(`${saved} Recreated ${restarting.join(', ')} so the new values actually take effect.`
        + (self ? ' The dashboard restarts itself in a moment — this page will reconnect on its own.' : '')
        + (manual.length ? ` ${manual.join(', ')} needs a manual restart.` : ''), 'info', self ? 12000 : 9000);
    } else if (manual.length) {
      toast(`${saved} ${manual.join(', ')} uses these values but was left alone — restart it yourself.`, 'warning', 10000);
    } else {
      toast(`${saved} Nothing installed uses them yet.`, 'success');
    }
    status.textContent = restarting.length ? `Recreated ${restarting.join(', ')}.` : saved;
    await loadConfig();
    if (restarting.length) loadModules();
  } catch (err) {
    toast(err.message, 'error', 8000);
    status.textContent = `Failed: ${err.message}`;
  } finally {
    button.disabled = false;
    button.classList.remove('btn-busy');
  }
}

/* --------------------------------------------------------- backup center */

let backupState = null;

async function loadBackups() {
  try {
    backupState = await (await fetch('api/backup')).json();
  } catch {
    backupState = null;
  }
  renderBackups();
}

function renderBackups() {
  const b = backupState;
  if (!b || !$('#backup-list')) return;

  $('#backup-summary').textContent = b.count
    ? `${b.count} archive${b.count === 1 ? '' : 's'} · ${bytes(b.totalSize)}`
    : 'none yet';

  // Without a key nothing can be written, so say so where the button is
  // rather than failing when it is pressed.
  const noKey = $('#backup-no-key');
  noKey.hidden = b.hasKey;
  if (!b.hasKey) {
    noKey.innerHTML = '<strong>No encryption key.</strong>'
      + '<p class="hint">An archive contains <code class="mono">.env</code>, so HomeBox will not write one unencrypted. '
      + 'Add <code class="mono">HB_BACKUP_KEY</code> to <code class="mono">/opt/homebox/.env</code> (or re-run <code class="mono">install.sh</code>) and restart the dashboard.</p>';
  }
  $('#btn-create-backup').disabled = !b.hasKey || b.running;
  $('#btn-reveal-key').disabled = !b.hasKey;
  $('#backup-same-disk').hidden = !b.sameDisk;

  $('#backup-latest').textContent = b.latest
    ? `Newest: ${b.latest.name} — ${bytes(b.latest.size)}, ${ago(b.latest.created)} ago.`
    : 'Nothing has been backed up yet.';
  $('#backup-kind-note').textContent = $('#backup-kind').value === 'full'
    ? 'Everything, including the data pool. Can be very large.'
    : 'Module config, state and .env. Small and quick.';

  $('#backup-list').innerHTML = b.backups.map((item) => `
    <div class="archive-row">
      <span class="archive-row-info">
        <span class="archive-row-name">${escapeHtml(item.name)}<span class="badge-encrypted">encrypted</span></span>
        <span class="archive-row-meta">${bytes(item.size)} · ${escapeHtml(item.kind)} · ${escapeHtml(new Date(item.created).toLocaleString())}</span>
      </span>
      <span class="archive-row-actions">
        <a class="btn-pill" href="api/backup/download/${encodeURIComponent(item.name)}">Download</a>
        <button type="button" class="btn-pill" data-backup-verify="${escapeHtml(item.name)}">Verify</button>
        <button type="button" class="btn-pill btn-danger" data-backup-delete="${escapeHtml(item.name)}">Delete</button>
      </span>
    </div>`).join('') || '<p class="activity-empty">No archives yet.</p>';

  // --- schedule ---
  const sch = b.schedule;
  $('#backup-schedule-enabled').checked = sch.enabled;
  $('#backup-schedule-config').hidden = !sch.enabled;
  $('#backup-schedule-retention').value = sch.retention;
  const preset = $('#backup-schedule-preset');
  preset.innerHTML = Object.entries(sch.presets)
    .map(([id, p]) => `<option value="${escapeHtml(id)}"${id === sch.preset ? ' selected' : ''}>${escapeHtml(p.label)}</option>`)
    .join('');
  $('#backup-schedule-status').textContent = sch.enabled
    ? (sch.nextRun ? `Next run in about ${duration(Math.max(0, Math.round((sch.nextRun - Date.now()) / 1000)))}. Keeping the newest ${sch.retention}.` : '')
    : 'Automatic backups are off.';

  const restore = $('#backup-restore-cmd');
  const name = b.latest ? b.latest.name : 'homebox-config-YYYYMMDD_HHMMSS.tar.gz.enc';
  restore.textContent = [
    '# 1. decrypt (asks for the key you kept elsewhere)',
    `homebox restore ${name}`,
    '',
    '# or by hand, if you only have the archive and the key:',
    '#   the file is [16-byte IV][AES-256-GCM ciphertext][16-byte tag],',
    '#   key = scrypt(HB_BACKUP_KEY, "homebox-backup-salt", 32)',
  ].join(NL);
}

async function createBackup() {
  const button = $('#btn-create-backup');
  const original = button.textContent;
  button.disabled = true;
  button.textContent = 'Working…';
  try {
    const res = await fetch('api/backup/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: $('#backup-kind').value }),
    });
    const data = await res.json();
    if (!data.ok) toast(`Backup failed: ${data.error}${data.hint ? ` — ${data.hint}` : ''}`, 'error', 12000);
    else toast(`Backup written: ${data.name || 'archive created'}. Keep the encryption key somewhere else.`, 'success', 7000);
  } catch (err) {
    toast(`Backup failed: ${err.message}`, 'error', 8000);
  } finally {
    button.textContent = original;
    await loadBackups();
  }
}

async function backupCall(path, body, onOk) {
  try {
    const res = await fetch(`api/backup/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    const data = await res.json();
    if (!res.ok || data.error) {
      toast(`${data.error}${data.hint ? ` — ${data.hint}` : ''}`, 'error', 12000);
      return null;
    }
    if (onOk) onOk(data);
    return data;
  } catch (err) {
    toast(err.message, 'error', 8000);
    return null;
  }
}

/* ------------------------------------------------------------------- auth */

/**
 * Nothing on the page is real until the server says who you are.
 *
 * Two states beyond "signed in": a box that has never been claimed asks for
 * the installer's one-time token plus a new password, and a claimed box asks
 * for the password. The dashboard markup stays in the document either way —
 * it holds no data, because every value on it comes from an API call the
 * server refuses without a session.
 */
let authState = { authenticated: false, firstRun: false, minPassword: 8 };

async function checkAuth() {
  try {
    authState = await (await fetch('api/auth/status')).json();
  } catch {
    authState = { authenticated: false, firstRun: false, minPassword: 8 };
  }
  if (authState.authenticated) showDashboard();
  else showLogin();
  return authState.authenticated;
}

function showLogin() {
  const first = authState.firstRun;
  $('#login-screen').hidden = false;
  $('.shell').hidden = true;
  $('.topbar').hidden = true;

  $('#login-title').textContent = first ? 'Claim this HomeBox' : 'HomeBox';
  $('#login-sub').textContent = first
    ? `Paste the bootstrap token the installer printed, then pick a password (${authState.minPassword}+ characters).`
    : 'Sign in to manage this server.';
  $('#login-token-field').hidden = !first;
  $('#login-confirm-field').hidden = !first;
  $('#login-hint').hidden = !first;
  $('#login-password-label').textContent = first ? 'New password' : 'Password';
  $('#login-password').setAttribute('autocomplete', first ? 'new-password' : 'current-password');
  $('#login-btn').textContent = first ? 'Claim' : 'Sign in';
  // Whatever was typed before a bounce back here is not this person's.
  $('#login-password').value = '';
  $('#login-confirm').value = '';
  $('#login-error').hidden = true;
  (first ? $('#login-token') : $('#login-password')).focus();
}

function showDashboard() {
  $('#login-screen').hidden = true;
  $('.shell').hidden = false;
  $('.topbar').hidden = false;
}

function loginError(message) {
  const box = $('#login-error');
  box.textContent = message;
  box.hidden = false;
}

async function submitLogin(event) {
  event.preventDefault();
  const first = authState.firstRun;
  const password = $('#login-password').value;
  const button = $('#login-btn');

  if (first && password !== $('#login-confirm').value) {
    loginError('The two passwords do not match.');
    return;
  }
  button.disabled = true;
  button.classList.add('btn-busy');
  $('#login-error').hidden = true;
  try {
    const res = await fetch(first ? 'api/auth/claim' : 'api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(first ? { token: $('#login-token').value, password } : { password }),
    });
    const data = await res.json();
    if (!data.ok) { loginError(data.error || 'That did not work.'); return; }
    authState.authenticated = true;
    authState.firstRun = false;
    showDashboard();
    await init();
    toast(first ? 'Claimed. This box is yours.' : 'Signed in.', 'success');
  } catch (err) {
    loginError(err.message);
  } finally {
    button.disabled = false;
    button.classList.remove('btn-busy');
  }
}

async function signOut() {
  try { await fetch('api/auth/logout', { method: 'POST' }); } catch { /* leaving anyway */ }
  authState = { authenticated: false, firstRun: false, minPassword: 8 };
  showLogin();
}

/**
 * A session can end while the page is open — it expired, or somebody changed
 * the password. Every fetch goes through here so that lands on the login
 * screen rather than as a wall of failed requests.
 */
const rawFetch = window.fetch.bind(window);
window.fetch = async (input, opts) => {
  const res = await rawFetch(input, opts);
  const url = String(typeof input === 'string' ? input : input.url || '');
  if (res.status === 401 && url.includes('api/') && !url.includes('api/auth/')) {
    if (authState.authenticated) {
      authState.authenticated = false;
      showLogin();
      loginError('Your session ended. Sign in again.');
    }
  }
  return res;
};

/**
 * Change the dashboard password. Validated here as well as on the server so a
 * typo in the confirmation costs nothing, but the server is the one that
 * decides: it re-checks the current password and the minimum length, because
 * this form is not the only thing that can POST here.
 */
async function submitPasswordChange(event) {
  event.preventDefault();
  const current = $('#pw-current').value;
  const next = $('#pw-new').value;
  const status = $('#pw-status');
  const button = $('#btn-change-password');

  if (next !== $('#pw-confirm').value) {
    status.textContent = 'The new passwords do not match.';
    toast('The new passwords do not match.', 'error');
    return;
  }
  button.disabled = true;
  button.classList.add('btn-busy');
  status.textContent = 'Changing…';
  try {
    const res = await fetch('api/auth/password', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ current, next }),
    });
    const data = await res.json();
    if (!data.ok) {
      status.textContent = data.error;
      toast(data.error, 'error', 8000);
      return;
    }
    const others = Number(data.otherSessionsSignedOut) || 0;
    toast(others
      ? `Password changed. ${others} other device${others === 1 ? '' : 's'} signed out.`
      : 'Password changed.', 'success', 7000);
    status.textContent = '';
    $('#pw-current').value = '';
    $('#pw-new').value = '';
    $('#pw-confirm').value = '';
  } catch (err) {
    status.textContent = err.message;
    toast(err.message, 'error', 8000);
  } finally {
    button.disabled = false;
    button.classList.remove('btn-busy');
  }
}

/* --------------------------------------------------- quick access (server) */

/**
 * Links to things that are NOT on this box.
 *
 * Kept on the server, unlike the Launcher's custom items. The two look
 * similar and are not: hiding a launcher tile is one browser's view of the
 * apps here, while a bookmark to a tracker is a fact about the setup and
 * belongs on the phone too.
 */
async function loadBookmarks() {
  try {
    state.bookmarks = (await (await fetch('api/bookmarks')).json()).items || [];
  } catch {
    state.bookmarks = [];
  }
  renderQuickAccess();
  renderQuickEditor();
}

function renderQuickAccess() {
  const card = $('#quick-card');
  const row = $('#quick-row');
  if (!card || !row) return;
  const items = state.bookmarks || [];

  // Hidden rather than empty: a card that says "no bookmarks" is a card
  // asking to be tidied away, on the page someone looks at every day.
  card.hidden = items.length === 0;
  if (!items.length) return;

  $('#quick-meta').textContent = `${items.length} link${items.length === 1 ? '' : 's'}`;
  row.innerHTML = items.map((b) => {
    const mono = `<span class="quick-mono">${escapeHtml(String(b.name).slice(0, 2).toUpperCase())}</span>`;
    return `<a class="quick-item" href="${escapeHtml(b.url)}" target="_blank" rel="noopener noreferrer"
        title="${escapeHtml(b.url)}">
        <span class="quick-icon">${iconArt(b.icon, mono, 'quick')}</span>
        <span class="quick-text">
          <span class="quick-name">${escapeHtml(b.name)}</span>
          ${b.subtitle ? `<span class="quick-sub">${escapeHtml(b.subtitle)}</span>` : ''}
        </span>
        <span class="quick-go" aria-hidden="true">↗</span>
      </a>`;
  }).join('');
}

function renderQuickEditor() {
  const list = $('#quick-editor-list');
  if (!list) return;
  const items = state.bookmarks || [];
  $('#quick-editor-summary').textContent = items.length ? `${items.length} of ${state.bookmarkMax || 60}` : 'none yet';

  list.innerHTML = items.map((b, i) => `
    <div class="editor-row">
      ${editorIcon(b.icon, b.name)}
      <span class="editor-row-info">
        <span class="editor-row-name">${escapeHtml(b.name)}${b.subtitle ? `<span class="editor-badge">${escapeHtml(b.subtitle)}</span>` : ''}</span>
        <span class="editor-row-meta">${escapeHtml(b.url)}</span>
      </span>
      <span class="editor-row-actions">
        <button type="button" class="btn-pill" data-quick-up="${escapeHtml(b.id)}"${i === 0 ? ' disabled' : ''} title="Move up">↑</button>
        <button type="button" class="btn-pill" data-quick-down="${escapeHtml(b.id)}"${i === items.length - 1 ? ' disabled' : ''} title="Move down">↓</button>
        <button type="button" class="btn-pill" data-quick-edit="${escapeHtml(b.id)}">Edit</button>
        <button type="button" class="btn-pill btn-danger" data-quick-delete="${escapeHtml(b.id)}">Delete</button>
      </span>
    </div>`).join('') || '<p class="activity-empty">No links yet — add one below.</p>';
}

function quickFormMode(item) {
  const form = $('#quick-form');
  form.reset();
  form.elements.id.value = item ? item.id : '';
  form.elements.name.value = item ? item.name : '';
  form.elements.subtitle.value = item ? item.subtitle || '' : '';
  form.elements.url.value = item ? item.url : '';
  form.elements.icon.value = item ? item.icon || '' : '';
  $('#quick-form-title').textContent = item ? `Edit ${item.name}` : 'Add a link';
  $('#quick-save').textContent = item ? 'Save' : 'Add link';
  $('#quick-cancel').hidden = !item;
  $('#quick-status').textContent = '';
}

async function quickCall(path, body, okMessage) {
  const status = $('#quick-status');
  status.textContent = 'Saving…';
  try {
    const res = await fetch(`api/bookmarks${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!data.ok) {
      toast(data.error, 'error', 10000);
      status.textContent = data.error;
      return false;
    }
    if (okMessage) toast(okMessage, 'success');
    status.textContent = '';
    await loadBookmarks();
    return true;
  } catch (err) {
    toast(err.message, 'error', 8000);
    status.textContent = err.message;
    return false;
  }
}

async function submitQuickForm(event) {
  event.preventDefault();
  const form = $('#quick-form');
  const body = Object.fromEntries(new FormData(form).entries());
  const editing = !!body.id;
  if (await quickCall('', body, editing ? `${body.name} updated.` : `${body.name} added to Quick access.`)) {
    quickFormMode(null);
  }
}

/** Swap a bookmark with its neighbour and persist the whole order. */
function moveBookmark(id, delta) {
  const items = [...(state.bookmarks || [])];
  const at = items.findIndex((b) => b.id === id);
  const to = at + delta;
  if (at === -1 || to < 0 || to >= items.length) return undefined;
  [items[at], items[to]] = [items[to], items[at]];
  // Render immediately so the list does not appear to lag the click, then
  // persist; loadBookmarks() re-reads the server's answer either way.
  state.bookmarks = items;
  renderQuickEditor();
  renderQuickAccess();
  return quickCall('/reorder', { ids: items.map((b) => b.id) }, null);
}

/* ------------------------------------------------- launcher contents (local) */

/**
 * What the Launcher shows is a VIEW preference, so it lives in this browser.
 *
 * Hiding an app does not stop it, and a personal link to a router is not a
 * fact about this box -- neither belongs in server state that every device
 * and every backup then carries. The App Store editor is the opposite case
 * and is stored on the server.
 */
const LAUNCHER_KEY = 'homebox-launcher-v1';
const EMPTY_LAUNCHER_PREFS = { hidden: [], custom: [], overrides: {} };

function readLauncherPrefs() {
  try {
    const raw = JSON.parse(localStorage.getItem(LAUNCHER_KEY) || '{}');
    return {
      hidden: Array.isArray(raw.hidden) ? raw.hidden.filter((k) => typeof k === 'string') : [],
      custom: Array.isArray(raw.custom) ? raw.custom.filter((c) => c && c.name && c.url) : [],
      overrides: raw.overrides && typeof raw.overrides === 'object' ? raw.overrides : {},
    };
  } catch {
    // A private window, cleared site data, or storage the browser refuses to
    // open. The Launcher must still render, just without customisation.
    return { ...EMPTY_LAUNCHER_PREFS };
  }
}

function writeLauncherPrefs(prefs) {
  state.launcherPrefs = prefs;
  try {
    localStorage.setItem(LAUNCHER_KEY, JSON.stringify(prefs));
  } catch {
    toast('This browser will not let the page save settings, so the change is only until reload.', 'warning', 8000);
  }
  renderLauncher(state.modules);
  renderLauncherEditor();
}

/** Stable key for a detected tile: a service name is only unique per module. */
const tileKey = (moduleId, serviceName) => `${moduleId}:${serviceName}`;

function renderLauncherEditor() {
  const list = $('#launcher-editor-list');
  if (!list) return;
  const prefs = state.launcherPrefs;
  const hidden = new Set(prefs.hidden);

  const detected = [];
  for (const mod of state.modules) {
    if (!mod.installed) continue;
    for (const svc of mod.services) {
      if (svc.internal || !svc.url) continue;
      const key = tileKey(mod.id, svc.name);
      const over = prefs.overrides[key] || {};
      detected.push({
        key,
        name: over.name || svc.friendly_name,
        url: svc.url,
        // The same order the Launcher itself resolves: a per-browser override
        // first, then the service's own icon, then the module's emoji.
        icon: over.icon || svc.icon || (mod.theme && mod.theme.emoji),
        hidden: hidden.has(key),
        edited: !!(over.name || over.icon),
        custom: false,
      });
    }
  }
  const custom = prefs.custom.map((c) => ({ ...c, key: c.id, custom: true, hidden: false, edited: false }));
  const rows = [...detected, ...custom];

  $('#launcher-editor-summary').textContent = rows.length
    ? `${rows.length - hidden.size} shown · ${custom.length} custom`
    : 'nothing installed yet';

  if (!rows.length) {
    list.innerHTML = '<p class="activity-empty">Nothing to show yet — install an app, or add a link below.</p>';
    return;
  }

  list.innerHTML = rows.map((r) => {
    const source = r.custom ? 'Custom link'
      : r.hidden ? 'Hidden from Launcher'
        : r.edited ? 'Renamed here' : 'Detected automatically';
    const actions = r.custom
      ? `<button type="button" class="btn-pill" data-launcher-edit="${escapeHtml(r.key)}">Edit</button>
         <button type="button" class="btn-pill btn-danger" data-launcher-delete="${escapeHtml(r.key)}">Delete</button>`
      : `<button type="button" class="btn-pill" data-launcher-rename="${escapeHtml(r.key)}">Rename</button>
         <button type="button" class="btn-pill" data-launcher-toggle="${escapeHtml(r.key)}">${r.hidden ? 'Restore' : 'Hide'}</button>`;
    return `<div class="editor-row${r.hidden ? ' is-off' : ''}">
      ${editorIcon(r.icon, r.name)}
      <span class="editor-row-info">
        <span class="editor-row-name">${escapeHtml(r.name)}</span>
        <span class="editor-row-meta">${escapeHtml(source)} · ${escapeHtml(r.url)}</span>
      </span>
      <span class="editor-row-actions">${actions}</span>
    </div>`;
  }).join('');
}

/** Put the form into "edit this one" mode, or back to "add a new one". */
function launcherFormMode(item) {
  $('#launcher-form-title').textContent = item ? `Edit ${item.name}` : 'Add a custom item';
  $('#launcher-submit').textContent = item ? 'Save' : 'Add to Launcher';
  $('#launcher-cancel').hidden = !item;
  $('#launcher-add-form').dataset.editing = item ? item.key : '';
  $('#launcher-name').value = item ? item.name || '' : '';
  $('#launcher-address').value = item ? item.url || '' : '';
  $('#launcher-icon').value = item ? item.icon || '' : '';
  // A rename targets a detected app, whose address belongs to the module.
  $('#launcher-address').disabled = !!(item && item.detected);
  $('#launcher-editor-status').textContent = '';
}

function submitLauncherForm(event) {
  event.preventDefault();
  const prefs = state.launcherPrefs;
  const editing = $('#launcher-add-form').dataset.editing;
  const name = $('#launcher-name').value.trim();
  const url = $('#launcher-address').value.trim();
  const icon = $('#launcher-icon').value.trim();
  if (!name) return;

  if (editing && editing.includes(':')) {
    prefs.overrides[editing] = { name, icon };
  } else if (editing) {
    const item = prefs.custom.find((c) => c.id === editing);
    if (item) Object.assign(item, { name, url, icon });
  } else {
    if (!url) return;
    prefs.custom.push({ id: `custom-${Date.now().toString(36)}`, name, url, icon });
  }
  writeLauncherPrefs(prefs);
  launcherFormMode(null);
  toast(editing ? 'Launcher updated.' : `${name} added to the Launcher.`, 'success');
}

/* ------------------------------------------------ app store contents (server) */

async function loadCatalog() {
  try {
    state.catalog = await (await fetch('api/catalog')).json();
  } catch {
    state.catalog = { overrides: {} };
  }
  renderCatalogEditor();
}

function renderCatalogEditor() {
  const list = $('#catalog-editor-list');
  if (!list || !state.catalog) return;
  const overrides = state.catalog.overrides || {};

  list.innerHTML = state.modules.map((m) => {
    const edited = !!overrides[m.id];
    const badge = m.user_created ? '<span class="editor-badge">Added here</span>'
      : edited ? '<span class="editor-badge is-edited">Edited</span>' : '';
    return `<div class="editor-row">
      ${editorIcon(m.icon || (m.theme && m.theme.emoji), m.title)}
      <span class="editor-row-info">
        <span class="editor-row-name">${escapeHtml(m.title)}${badge}</span>
        <span class="editor-row-meta">${escapeHtml(m.tagline || m.id)}</span>
      </span>
      <span class="editor-row-actions">
        <button type="button" class="btn-pill" data-catalog-edit="${escapeHtml(m.id)}">Edit</button>
        ${edited ? `<button type="button" class="btn-pill" data-catalog-reset="${escapeHtml(m.id)}">Reset</button>` : ''}
        ${m.user_created ? `<button type="button" class="btn-pill btn-danger" data-catalog-delete="${escapeHtml(m.id)}">Delete</button>` : ''}
      </span>
    </div>`;
  }).join('') || '<p class="activity-empty">No modules found.</p>';
}

/**
 * Open the form. With a module, it edits text only: image and ports are what
 * the compose file already runs, and changing them here would describe an app
 * that is not the one installed.
 */
function catalogFormMode(mod) {
  const form = $('#catalog-form');
  // Filled from the live list rather than hard-coded: free text here is what
  // let "Network" be saved instead of "network", which put the app in no
  // group at all. A picker cannot produce a category that does not exist.
  $('#catalog-category').innerHTML = state.categories
    .map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.label)}</option>`).join('');
  form.hidden = false;
  form.reset();
  form.elements.id.value = mod ? mod.id : '';
  $('#catalog-form-title').textContent = mod ? `Edit ${mod.title}` : 'Add an application';
  $('#catalog-save').textContent = mod ? 'Save changes' : 'Add application';
  form.querySelector('.editor-new-only').hidden = !!mod;
  for (const el of form.querySelectorAll('.editor-new-only input')) el.required = !mod;

  if (mod) {
    form.elements.name.value = mod.title || '';
    form.elements.tagline.value = mod.tagline || '';
    form.elements.description.value = mod.description || '';
    form.elements.category.value = mod.category || '';
    form.elements.ramMb.value = parseInt(String(mod.ram || '').replace(/[^0-9]/g, ''), 10) || 256;
    form.elements.tips.value = (mod.tips || []).join('\n');
    form.elements.icon.value = mod.icon || (mod.theme && mod.theme.emoji) || '';
  }
  $('#catalog-status').textContent = '';
  form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function submitCatalogForm(event) {
  event.preventDefault();
  const form = $('#catalog-form');
  const body = Object.fromEntries(new FormData(form).entries());
  const editing = !!body.id;
  const button = $('#catalog-save');
  button.disabled = true;
  $('#catalog-status').textContent = 'Saving…';
  try {
    const res = await fetch(editing ? 'api/catalog/override' : 'api/catalog/app', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!data.ok) {
      toast(data.error, 'error', 10000);
      $('#catalog-status').textContent = data.error;
      return;
    }
    toast(editing ? `${body.name} updated — it reads that way everywhere now.`
      : `${body.name} added. Install it from the App Store.`, 'success', 7000);
    form.hidden = true;
    await loadModules();
    await loadCatalog();
  } catch (err) {
    toast(err.message, 'error', 8000);
  } finally {
    button.disabled = false;
    $('#catalog-status').textContent = '';
  }
}

async function catalogCall(path, id, okMessage) {
  try {
    const res = await fetch(`api/catalog/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    const data = await res.json();
    if (!data.ok) { toast(data.error, 'error', 10000); return; }
    toast(okMessage, 'success');
    await loadModules();
    await loadCatalog();
  } catch (err) {
    toast(err.message, 'error', 8000);
  }
}

/* ------------------------------------------------------------- settings */

function showSettingsTab(tab) {
  state.settingsTab = tab;
  $$('.settings-tab').forEach((b) => b.classList.toggle('active', b.dataset.stab === tab));
  $$('.settings-panel').forEach((p) => p.classList.toggle('active', p.dataset.stabPanel === tab));
}

/**
 * Everything below renders from data already on the page — the live summary
 * and the module list. No panel makes its own request, so switching tabs is
 * instant and nothing here can be stale in a way the rest of the UI is not.
 */
function renderSettings() {
  const summary = state.summary;
  if (!summary) return;
  const cfg = summary.config || {};
  const host = summary.host.address;

  // --- Server config ---
  const serverConfig = $('#server-config');
  if (serverConfig) {
    serverConfig.innerHTML = kvRows([
      ['Install root', cfg.root],
      ['Modules', cfg.modulesDir],
      ['Data pool', cfg.dataDir],
      ['Timezone', cfg.timezone],
      ['Dashboard port', cfg.port],
      ['Docker', summary.docker ? `${summary.docker.version} · API ${summary.docker.apiVersion} · ${summary.docker.arch}` : 'unreachable'],
    ]);
  }
  const tree = $('#server-tree');
  if (tree) {
    tree.textContent = [
      `${cfg.root}/`,
      '├── homebox              the CLI',
      '├── install.sh           clean Debian to running HomeBox',
      '├── .env                 generated secrets, mode 600',
      '├── modules/<id>/',
      '│   ├── docker-compose.yml   services + x-homebox metadata',
      '│   ├── setup.sh             optional, seeds what an image will not',
      '│   └── config/<app>/        that app config, inside its module',
      '├── data/                shared pool: media, photos, downloads',
      '├── dashboard/           this UI',
      '└── state/               enabled list, activity, prefs',
    ].join(NL);
  }

  // --- Network ---
  const netGrid = $('#settings-network-grid');
  if (netGrid) {
    const n = summary.network || {};
    netGrid.innerHTML = [
      ['Hostname', summary.host.name],
      ['Dashboard', n.dashboard],
      ['Proxy', n.proxy],
      ['Docker networks', n.networks],
    ].map(([label, value]) => `
      <div class="network-item">
        <div class="network-label">${escapeHtml(label)}</div>
        <div class="network-value mono">${escapeHtml(value == null ? '-' : value)}</div>
      </div>`).join('');
  }

  const portsBody = $('#ports-body');
  if (portsBody) {
    const rows = [];
    for (const mod of state.modules) {
      for (const c of mod.containers) {
        const svc = mod.services.find((x) => x.name === c.service);
        for (const port of c.ports) rows.push({ port, app: svc ? svc.friendly_name : mod.title, container: c.name });
      }
    }
    rows.sort((a, b) => a.port - b.port);
    $('#ports-meta').textContent = `${rows.length} published`;
    portsBody.innerHTML = rows.map((r) => `
      <tr>
        <td class="cell-name mono"><a class="link-btn" href="http://${escapeHtml(host)}:${r.port}" target="_blank" rel="noopener noreferrer">${r.port}</a></td>
        <td>${escapeHtml(r.app)}</td>
        <td class="cell-dim">${escapeHtml(r.container)}</td>
      </tr>`).join('') || '<tr><td colspan="3" class="cell-dim">Nothing published yet.</td></tr>';
  }

  // --- Remote access ---
  const vpnState = $('#remote-vpn-state');
  if (vpnState) {
    const vpn = state.modules.find((m) => m.id === 'vpn');
    if (!vpn) {
      vpnState.innerHTML = '';
    } else if (vpn.installed) {
      vpnState.innerHTML = `<dl class="kv">
        <dt>VPN module</dt><dd>${escapeHtml(STATUS_LABEL[vpn.status] || vpn.status)}</dd>
        <dt>Set WG_HOST</dt><dd>the address clients reach from OUTSIDE, in .env</dd>
      </dl>
      <p class="hint">Blank WG_HOST hands out configs that point nowhere, so set it before adding a device.</p>`;
    } else {
      vpnState.innerHTML = `<div class="drawer-actions">
        <button type="button" class="btn btn-primary" data-action="install" data-id="vpn">Install VPN</button>
      </div>`;
    }
  }

  const remoteProxy = $('#remote-proxy');
  if (remoteProxy) {
    const core = state.modules.find((m) => m.id === 'core');
    remoteProxy.innerHTML = kvRows([
      ['Proxy', core && core.installed ? 'Nginx Proxy Manager, running' : 'core not installed'],
      ['Admin UI', `http://${host}:81`],
      ['Public ports', '80 and 443'],
      ['Sign in with', 'homebox secrets core'],
    ]);
  }

  // --- Passwords ---
  const secretsBody = $('#secrets-body');
  if (secretsBody) {
    const rows = [];
    for (const mod of state.modules) {
      for (const name of mod.env_vars) rows.push({ mod, name });
    }
    $('#secrets-meta').textContent = `${rows.length} across ${new Set(rows.map((r) => r.mod.id)).size} modules`;
    // The value, not a command to go and run. This page used to list the
    // names and tell you to SSH in — which meant the answer to "what is my
    // qBittorrent password" was never on the screen showing your passwords.
    // /api/config already returns these behind the same session gate.
    secretsBody.innerHTML = rows.map((r) => `
      <tr>
        <td class="cell-name">${escapeHtml(r.mod.title)}</td>
        <td class="cell-dim">${escapeHtml(r.name)}</td>
        <td class="cell-dim">
          <span class="secret-value" data-secret="${escapeHtml(r.mod.id)}:${escapeHtml(r.name)}">
            <span class="secret-hidden">••••••••</span>
            <button type="button" class="btn-soft secret-reveal">Show</button>
          </span>
        </td>
      </tr>`).join('') || '<tr><td colspan="3" class="cell-dim">No module declares a secret.</td></tr>';
  }

  // --- Monitoring ---
  const m = summary.metrics;
  const monHost = $('#monitoring-host');
  if (monHost) {
    monHost.innerHTML = kvRows([
      ['CPU', m.cpu == null ? '-' : `${m.cpu}% of ${m.cores} cores`],
      ['Memory', `${bytes(m.memory.used)} of ${bytes(m.memory.total)} (${m.memory.percent}%)`],
      ['Disk', m.disk.percent == null ? '-' : `${bytes(m.disk.used)} of ${bytes(m.disk.total)} (${m.disk.percent}%)`],
      ['Uptime', duration(m.uptime)],
      ['Load', m.load.join('  ')],
    ]);
  }
  const monHealth = $('#monitoring-health');
  if (monHealth) {
    const all = state.modules.flatMap((x) => x.containers);
    const count = (fn) => all.filter(fn).length;
    $('#monitoring-meta').textContent = `${all.length} containers`;
    monHealth.innerHTML = `
      ${backupRow('Healthy', count((c) => c.state === 'healthy'), 'good')}
      ${backupRow('Running', count((c) => c.state === 'running'))}
      ${backupRow('Starting', count((c) => c.state === 'starting'), 'warn')}
      ${backupRow('Unhealthy', count((c) => c.state === 'unhealthy'), count((c) => c.state === 'unhealthy') ? 'warn' : '')}
      ${backupRow('Stopped', count((c) => c.state === 'stopped'))}`;
  }
  const monModule = $('#monitoring-module');
  if (monModule) {
    const mon = state.modules.find((x) => x.id === 'monitoring');
    if (!mon) {
      monModule.innerHTML = '';
    } else if (mon.installed) {
      const svc = mon.services.find((x) => x.url);
      monModule.innerHTML = `<p class="hint">Uptime Kuma is watching. It is the piece that tells you something went down while you were not looking at this page.</p>
        ${svc ? `<div class="drawer-actions"><a class="btn btn-primary" href="${escapeHtml(svc.url)}" target="_blank" rel="noopener noreferrer">Open Uptime Kuma</a></div>` : ''}`;
    } else {
      monModule.innerHTML = `<p class="hint">Nothing is alerting you yet. This page only tells you about a problem while you are looking at it.</p>
        <div class="drawer-actions"><button type="button" class="btn btn-primary" data-action="install" data-id="monitoring">Install Monitoring</button></div>`;
    }
  }

  // --- Tools ---
  const cli = $('#tools-cli');
  if (cli) {
    cli.textContent = [
      'homebox list                    what is available, and what is running',
      'homebox info <module>           what it is, where it is, how to log in',
      'homebox install <module>        seed, pull, start, mark enabled',
      'homebox remove <module> --yes   stop and delete containers, keep data',
      'homebox remove <module> --yes --purge   ...and delete the data',
      'homebox update <module>         pull newer images and recreate',
      'homebox logs <module|container> [lines]',
      'homebox secrets <module>        print its generated passwords',
      'homebox status                  every container HomeBox runs',
    ].join(NL);
  }
}

function kvRows(pairs) {
  return pairs.map(([label, value]) => `
    <dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value == null ? '-' : String(value))}</dd>`).join('');
}

function backupRow(label, value, level) {
  return `<div class="backup-row">
    <span class="backup-label">${escapeHtml(label)}</span>
    <span class="backup-value"${level ? ` data-level="${escapeHtml(level)}"` : ''}>${escapeHtml(String(value))}</span>
  </div>`;
}

/* --------------------------------------------------------------- drawer */

function openModule(id) {
  const mod = state.modules.find((m) => m.id === id);
  if (!mod) return;
  $('#drawer-body').innerHTML = `
    <h2>${escapeHtml((mod.theme && mod.theme.emoji) || '📦')} ${escapeHtml(mod.title)}</h2>
    <p class="drawer-tagline">${escapeHtml(mod.tagline)}</p>
    <div class="drawer-pills">
      <span class="pill" data-status="${escapeHtml(mod.status)}">${escapeHtml(STATUS_LABEL[mod.status] || mod.status)}</span>
      ${mod.ram ? `<span class="pill">${escapeHtml(mod.ram)}</span>` : ''}
      ${mod.required ? '<span class="pill">required</span>' : ''}
    </div>
    <p>${escapeHtml(mod.description)}</p>

    <div class="drawer-actions" id="drawer-actions">${actionsFor(mod)}
      ${mod.installed ? `<button type="button" class="btn" data-action="update" data-id="${escapeHtml(mod.id)}">Update</button>` : ''}
    </div>

    ${mod.installed && !mod.required ? `
      <h3>Removing it</h3>
      <p class="hint">Uninstall deletes the containers but keeps this module's settings and data in
        <code class="mono">${escapeHtml(mod.dir)}/config</code>, so installing it again picks up where you left off.
        Erasing deletes that directory too, and there is no undo.</p>
      <div class="drawer-actions">
        <button type="button" class="btn btn-danger" data-action="remove" data-id="${escapeHtml(mod.id)}">Uninstall</button>
        <button type="button" class="btn btn-danger-solid" data-action="purge" data-id="${escapeHtml(mod.id)}">Uninstall &amp; erase data</button>
      </div>` : ''}

    <h3>Apps</h3>
    ${mod.services.map((s) => `
      <div class="svc-row">
        ${iconHtml(s.icon || mod.icon, s.friendly_name, mod.theme, 'svc')}
        <span class="svc-body">
          <span class="svc-name">${escapeHtml(s.friendly_name)}</span>
          <span class="svc-desc">${escapeHtml(s.description || (s.internal ? 'internal service' : s.name))}</span>
        </span>
        ${s.container ? `<span class="state" data-state="${escapeHtml(s.container.state)}">${escapeHtml(s.container.state)}</span>` : ''}
        ${s.url ? `<a class="link-btn" href="${escapeHtml(s.url)}" target="_blank" rel="noopener noreferrer">open</a>` : ''}
      </div>
      ${s.first_login ? `<p class="svc-note">${escapeHtml(s.first_login)}</p>` : ''}
    `).join('')}

    ${mod.installed ? `
      <h3>Containers</h3>
      ${mod.containers.map((c) => `
        <div class="svc-row">
          <span class="svc-body">
            <span class="svc-name mono">${escapeHtml(c.name)}</span>
            <span class="svc-desc">${escapeHtml(c.status)}</span>
          </span>
          <span class="state" data-state="${escapeHtml(c.state)}">${escapeHtml(c.state)}</span>
          <button type="button" class="link-btn" data-log-for="${escapeHtml(c.name)}">logs</button>
        </div>`).join('')}` : ''}

    ${mod.tips.length ? `<h3>Worth knowing</h3><ul class="tip-list">${mod.tips.map((t) => `<li>${escapeHtml(t)}</li>`).join('')}</ul>` : ''}

    <h3>On disk</h3>
    <dl class="kv">
      <dt>Module</dt><dd>${escapeHtml(mod.dir)}</dd>
      <dt>Category</dt><dd>${escapeHtml(mod.category)}</dd>
      ${mod.hostname ? `<dt>Hostname</dt><dd>${escapeHtml(mod.hostname)}.home</dd>` : ''}
      ${mod.env_vars.length ? `<dt>Secrets</dt><dd>${escapeHtml(mod.env_vars.join(', '))}<br><span class="hint">homebox secrets ${escapeHtml(mod.id)}</span></dd>` : ''}
    </dl>

    <div class="action-output" id="action-output" hidden></div>`;
  $('#drawer').hidden = false;
  $('#drawer-backdrop').hidden = false;
  $('#drawer').dataset.module = mod.id;
}

function closeDrawer() {
  $('#drawer').hidden = true;
  $('#drawer-backdrop').hidden = true;
  delete $('#drawer').dataset.module;
}

/* ---------------------------------------------------------------- actions */

/**
 * "Remove" asks WHICH removal, instead of quietly picking one.
 *
 * Keeping the config directory is the right default — reinstalling then picks
 * up your library, indexers and settings where you left them. But it is also
 * how a broken app stays broken across a reinstall: a bad account, a config
 * pointing at a database that is not there, a half-migrated restore. Someone
 * removing an app to start over got the same app back, and nothing on screen
 * had said the settings survived.
 *
 * Both readings of "remove" are legitimate, so the dialog asks rather than
 * guesses. Unchecked keeps the safe default; checked is one click, and says
 * exactly which directory goes.
 *
 * Resolves to 'remove', 'purge', or null if cancelled.
 */
async function removeDialog(title, id) {
  // Cleared every time, or a box ticked once would silently erase the NEXT
  // app someone removes.
  removeDialog.erase = false;
  const ok = await confirmDialog({
    title: `Remove ${title}?`,
    bodyHtml: `
      <p>Its containers are deleted.</p>
      <label class="remove-erase">
        <input type="checkbox" id="remove-erase-box">
        <span>
          <strong>Also erase its settings and data</strong>
          <small>Deletes <code class="mono">modules/${escapeHtml(id)}/config</code> — the app's database,
          its accounts and everything it has learned. Installing it again gives you a brand new app.
          Leave this off and a reinstall picks up exactly where you left off.</small>
        </span>
      </label>`,
    confirmLabel: 'Remove',
    danger: true,
    wide: true,
  });
  if (!ok) return null;
  // Read inside the dialog's lifetime — confirmDialog removes the node before
  // it resolves, so a lookup after this point finds nothing.
  return removeDialog.erase ? 'purge' : 'remove';
}

// The checkbox lives inside a dialog that is gone by the time the promise
// settles, so its state is captured on change.
document.addEventListener('change', (event) => {
  if (event.target.id === 'remove-erase-box') removeDialog.erase = event.target.checked;
});

async function runAction(id, action) {
  if (state.busy.has(id)) return;
  const mod = state.modules.find((m) => m.id === id);
  const title = mod ? mod.title : id;
  // Confirmation scales with the damage: stopping is reversible, uninstalling
  // loses the containers, erasing loses the data and cannot be undone.
  if (action === 'stop') {
    const ok = await confirmDialog({ title: `Stop ${title}?`, body: 'It stops running. Nothing is deleted.', confirmLabel: 'Stop' });
    if (!ok) return;
  }
  if (action === 'remove') {
    const choice = await removeDialog(title, id);
    if (!choice) return;
    action = choice;   // 'remove' keeps the config directory, 'purge' erases it
  }
  if (action === 'purge') {
    const typed = prompt(`This deletes ${title} AND all of its data. There is no undo.

Type the module name to confirm:`);
    if (typed !== id) return;
  }

  // A pull takes minutes, so the long actions get the live log — the same
  // dialog the Apply-changes flow opens. Without this, installing from the
  // drawer froze a button and said nothing until it was over, which is the
  // exact silence the dialog exists to remove. Start/stop/restart take
  // seconds and stay on the toast path, where a modal would just be noise.
  const LONG_VERB = { install: 'Installing', update: 'Updating', remove: 'Removing', purge: 'Erasing' };
  if (LONG_VERB[action]) {
    closeDrawer();
    openProgress(`${LONG_VERB[action]} ${title}…`);
    const ok = await runActionStreamed(id, action);
    closeProgress(ok, ok ? 'Done' : 'Something went wrong');
    if (ok) toast(`${title}: ${action} finished.`, 'success');
    else toast(`${title}: ${action} failed — the log in the dialog says why.`, 'error', 12000);
    await loadModules(true);
    return;
  }

  state.busy.add(id);
  renderApps();
  if ($('#drawer').dataset.module === id) openModule(id);

  const out = $('#action-output');
  if (out) {
    out.hidden = false;
    out.textContent = `${action}…`;
  }

  try {
    const res = await fetch(`api/modules/${encodeURIComponent(id)}/${encodeURIComponent(action)}`, { method: 'POST' });
    const data = await res.json();
    if (out) {
      out.textContent = data.ok
        ? `${action} finished in ${data.seconds}s\n\n${(data.output || '').trim()}`
        : `${action} failed: ${data.error}\n\n${(data.output || '').trim()}`;
    }
    // The drawer's transcript is the detail; the toast is what someone sees
    // when the action was fired from a card and the drawer is not open.
    if (data.ok) toast(`${title}: ${action} finished in ${data.seconds}s.`, 'success');
    else toast(`${title}: ${action} failed — ${data.error}`, 'error', 12000);
  } catch (err) {
    if (out) out.textContent = `${action} failed: ${err.message}`;
    toast(`${title}: ${action} failed — ${err.message}`, 'error', 8000);
  } finally {
    state.busy.delete(id);
    await loadModules(true);
    if ($('#drawer').dataset.module === id) {
      const keep = out ? out.textContent : null;
      openModule(id);
      if (keep) {
        const fresh = $('#action-output');
        fresh.hidden = false;
        fresh.textContent = keep;
      }
    }
  }
}

/* ----------------------------------------------------------------- data */

let modulesPromise = null;
let modulesLoadedAt = 0;

function loadModules(force = false) {
  if (!force && modulesPromise && Date.now() - modulesLoadedAt < 8000) return modulesPromise;
  modulesLoadedAt = Date.now();
  modulesPromise = fetch('api/modules')
    .then((r) => r.json())
    .then((data) => {
      state.modules = data.modules || [];
      state.unclaimed = data.unclaimed || [];
      state.categories = data.categories || [];
      state.host = data.host || state.host;
      state.containers = state.modules.flatMap((m) => m.containers).concat(state.unclaimed);
      renderCategories();
      renderApps();
      renderContainerChips();
      renderContainers();
      renderLogPicker();
      renderLauncher(state.modules);
      renderRunning(state.modules);
      renderModuleErrors(data.errors || []);
      updatePortainerAction();
      renderSettings();
      // The two content editors list modules too, and they follow the same
      // rule as the rest of Settings: rendered from data already on the page,
      // so switching sub-tabs is instant and no panel can be stale on its own.
      renderLauncherEditor();
      renderCatalogEditor();
      return data;
    })
    .catch(() => null);
  return modulesPromise;
}

function renderModuleErrors(errors) {
  const card = $('#module-errors-card');
  if (!errors.length) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  $('#module-errors').innerHTML = errors
    .map((e) => `<li><strong>${escapeHtml(e.module || 'modules')}</strong>: ${escapeHtml(e.error)}</li>`).join('');
}

function applySummary(summary) {
  state.summary = summary;
  // Set before anything renders: the launcher builds its dismissal keys from
  // it, and a tile drawn under the fallback key would be dismissible into a
  // slot nothing ever reads again.
  state.installId = summary.installId || null;
  // The server is the authority on what is mid-install: a page opened after
  // an install started should still show it as busy.
  state.busy = new Set(summary.busy || []);
  renderTopbar(summary);
  renderHealth(summary);
  const m = summary.metrics;
  renderGauge('cpu', m.cpu, `${m.cores} cores`);
  renderGauge('ram', m.memory.percent, `${bytes(m.memory.used)} / ${bytes(m.memory.total)}`);
  renderGauge('disk', m.disk.percent, m.disk.total ? `${bytes(m.disk.free)} free` : '');
  $('#val-uptime').textContent = duration(m.uptime);
  $('#detail-load').textContent = `load ${m.load[0].toFixed(2)}`;
  if (state.modules.length) renderStoreStats();
  renderSettings();
  renderNetwork(summary);
  renderBackupCard(summary);
  renderInstallInfo(summary);
}

function renderInstallInfo(summary) {
  $('#install-info').innerHTML = `
    <dt>HomeBox</dt><dd>v${escapeHtml(summary.version)}</dd>
    <dt>Host</dt><dd>${escapeHtml(summary.host.name)} (${escapeHtml(summary.host.address)})</dd>
    <dt>Docker</dt><dd>${summary.docker ? escapeHtml(`${summary.docker.version} · API ${summary.docker.apiVersion}`) : 'socket unreachable'}</dd>
    <dt>Apps</dt><dd>${summary.counts.installed} installed of ${summary.counts.modules} available</dd>
    <dt>Containers</dt><dd>${summary.counts.running} running of ${summary.counts.containers}</dd>`;
}

function connect() {
  const source = new EventSource('api/events');
  const dot = $('#live-dot');

  source.addEventListener('summary', (event) => {
    dot.dataset.state = 'up';
    $('.live-label', dot).textContent = 'live';
    applySummary(JSON.parse(event.data));
  });

  source.addEventListener('activity', () => {
    // The feed is small and the server keeps the tail; re-fetching is simpler
    // than merging one event into a list that may have scrolled.
    fetch('api/activity?limit=25').then((r) => r.json()).then((d) => renderActivity(d.entries)).catch(() => {});
  });

  source.onerror = () => {
    dot.dataset.state = 'down';
    $('.live-label', dot).textContent = 'reconnecting';
  };
}

/* ------------------------------------------------------------ preferences */

/* Every option the Appearance picker offers. The ids must match the
   :root[data-theme=...] / [data-atmo=...] blocks in themes.css and app.css,
   and the server keeps the same lists as a whitelist. */
const THEMES = [
  { id: 'dark', label: 'Default' },
  { id: 'midnight-purple', label: 'Midnight' },
  { id: 'forest', label: 'Forest' },
  { id: 'sunset', label: 'Sunset' },
  { id: 'arctic', label: 'Arctic' },
  { id: 'rose', label: 'Rose' },
  { id: 'light', label: 'Light' },
  { id: 'light-forest', label: 'Light Forest' },
  { id: 'light-sunset', label: 'Light Sunset' },
  { id: 'light-arctic', label: 'Light Arctic' },
  { id: 'light-rose', label: 'Light Rose' },
];

// Order is the recommendation. The wallpapers lead because they are what a
// fresh install looks like, and the first swatch is the one someone compares
// the rest against; the generated gradients follow.
const BACKGROUNDS = [
  { id: 'wp-purple', label: 'Purple Sky' },
  { id: 'wp-blue', label: 'Deep Blue' },
  { id: 'aurora', label: 'Aurora' },
  { id: 'nebula', label: 'Nebula' },
  { id: 'deep', label: 'Deep' },
  { id: 'slate', label: 'Slate' },
  { id: 'void', label: 'Void' },
  { id: 'solid', label: 'Solid' },
];

function applyPrefs(prefs) {
  state.prefs = prefs;
  document.documentElement.dataset.theme = prefs.theme;
  document.documentElement.dataset.atmo = prefs.atmo;
  renderSwatches();
  renderInsightToggles();
  // A panel that was just switched off should leave the card now, not at the
  // next poll — the checkbox is a claim about the page and it should be true
  // by the time the eye moves back to it.
  if (insightsData) renderInsights(insightsData);
  else if (insightsOn()) loadInsights();
}

/** The Settings checkboxes, from whatever the server actually stored. */
function renderInsightToggles() {
  const i = (state.prefs && state.prefs.insights) || {};
  const set = (sel, value) => { const el = $(sel); if (el) el.checked = value !== false; };
  set('#live-enabled', i.enabled);
  set('#live-transfers', i.transfers);
  set('#live-queues', i.queues);
  set('#live-upcoming', i.upcoming);
}

function saveInsightPrefs() {
  savePrefs({
    insights: {
      enabled: $('#live-enabled').checked,
      transfers: $('#live-transfers').checked,
      queues: $('#live-queues').checked,
      upcoming: $('#live-upcoming').checked,
    },
  });
}

/**
 * Previews are painted by CSS class, not inline style, so each swatch shows
 * the real palette or the real photo rather than an approximation written
 * twice.
 */
function renderSwatches() {
  const themeBox = $('#theme-swatches');
  const atmoBox = $('#atmo-swatches');
  if (!themeBox || !atmoBox) return;

  const swatch = (kind, item, current) => `
    <button type="button" class="swatch sw-${escapeHtml(item.id)}${item.id === current ? ' selected' : ''}"
      data-${kind}-value="${escapeHtml(item.id)}" aria-pressed="${item.id === current}">
      <span class="swatch-preview"></span>
      <span class="swatch-name">${escapeHtml(item.label)}</span>
    </button>`;

  themeBox.innerHTML = THEMES.map((t) => swatch('theme', t, state.prefs.theme)).join('');
  atmoBox.innerHTML = BACKGROUNDS.map((b) => swatch('atmo', b, state.prefs.atmo)).join('');
}

async function savePrefs(patch) {
  const next = { ...state.prefs, ...patch };
  applyPrefs(next); // optimistic: the UI should never wait on a round trip
  try {
    await fetch('api/prefs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(next),
    });
  } catch {
    /* appearance is cosmetic; a failed save is not worth an error banner */
  }
}

/* --------------------------------------------------- reset app login */

/**
 * The way back into an app you are locked out of.
 *
 * Each row is one installed service that declares a strategy lib/reset.js
 * implements. An app whose login is already open says so and offers no
 * button — there is nothing to do, and a button that does nothing is worse
 * than no button.
 */
async function loadResets() {
  const list = $('#reset-list');
  if (!list) return;
  try {
    const { apps } = await (await fetch('api/reset')).json();
    $('#reset-meta').textContent = apps.length ? `${apps.length} apps` : '';
    list.innerHTML = apps.length
      ? apps.map((a) => `
          <div class="reset-row">
            <span class="reset-icon">${iconArt(a.icon, `<span class="reset-mono">${escapeHtml(
              String(a.title || '?').replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase(),
            )}</span>`, 'reset')}</span>
            <span class="reset-info">
              <strong>${escapeHtml(a.title)}</strong>
              <small>${escapeHtml(a.available ? a.label : (a.why || 'nothing to reset'))}</small>
            </span>
            ${a.available
              ? `<button type="button" class="btn-soft" data-reset="${escapeHtml(a.module)}:${escapeHtml(a.service)}">Reset login</button>`
              : '<span class="reset-done">open</span>'}
          </div>`).join('')
      : '<p class="empty-state">None of the installed apps declares a login this build can reset.</p>';
  } catch {
    list.innerHTML = '<p class="empty-state">Could not read which apps can be reset.</p>';
  }
}

async function resetAppLogin(moduleId, service, title) {
  const ok = await confirmDialog({
    title: `Reset the login for ${title}?`,
    body: `${title} will be restarted with its login turned off, so anyone who can reach its port `
      + 'can use it until you set a new password. Its config file is backed up first, and none of '
      + 'its data is touched. Do this only while you are at the keyboard and can finish the job.',
    confirmLabel: 'Reset login',
    danger: true,
  });
  if (!ok) return;

  openProgress(`Resetting ${title}`);
  let success = false;
  let next = '';
  try {
    const res = await fetch('api/reset', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ module: moduleId, service }),
    });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const raw of lines) {
        if (!raw.trim()) continue;
        let msg;
        try { msg = JSON.parse(raw); } catch { continue; }
        if (msg.done) { success = msg.ok === true; next = msg.next || ''; }
        else if (typeof msg.line === 'string') progressLine(msg.line);
      }
    }
  } catch (err) {
    progressLine(`ERROR: ${err.message}`);
  }
  closeProgress(success, success ? `${title} is open` : 'Could not reset it');
  if (success && next) toast(next, 'info', 14000);
  loadResets();
}

/* ----------------------------------------------------- remote storage */

/**
 * Attaching a NAS from Settings, instead of from an SSH session.
 *
 * The "Check the NAS" step exists because of one specific failure: a box that
 * is not in the server's export list gets a mount that hangs and then dies
 * with "access denied by server", which reads like a credentials problem and
 * is not one. Asking the server what it exports takes a second and turns that
 * into "add 192.168.1.218 on the NAS" while the form is still open.
 */
let storageMounts = [];

/**
 * Warn when the mountpoint in the form is already in use.
 *
 * The field is pre-filled with /mnt/media_disk because that is the right
 * answer on a fresh box — and the wrong one on a box that already has it,
 * where pressing Mount unmounts and remounts a live library. The script
 * handles it safely; the form should still not invite it.
 */
function checkMountpointCollision() {
  const field = $('#storage-mountpoint');
  const note = $('#storage-collision');
  if (!field || !note) return;
  const target = field.value.trim().replace(/\/+$/, '');
  const clash = storageMounts.includes(target);
  note.hidden = !clash;
  if (clash) {
    note.textContent = `${target} is already mounted. Mounting here again unmounts the current share `
      + 'first — fine if you are repointing it at a different export, but not what you want otherwise.';
  }
}

async function loadStorage() {
  const list = $('#storage-list');
  if (!list) return;
  try {
    const data = await (await fetch('api/storage')).json();
    const mounts = data.mounts || [];
    $('#storage-meta').textContent = mounts.length ? `${mounts.length} mounted` : '';
    // Remember them for the collision check below.
    storageMounts = mounts.map((m) => m.target);
    checkMountpointCollision();

    list.innerHTML = mounts.length
      ? mounts.map((m) => `
          <div class="storage-row">
            <div class="storage-row-info">
              <div class="storage-row-target mono">${escapeHtml(m.target)}</div>
              <div class="storage-row-source mono">${escapeHtml(m.source)} · ${escapeHtml(m.fstype || '')}${
                m.size ? ` · ${escapeHtml(m.used || '?')} of ${escapeHtml(m.size)} used` : ''}</div>
            </div>
            <button type="button" class="btn-soft" data-unmount="${escapeHtml(m.target)}">Detach</button>
          </div>`).join('')
      : '<p class="empty-state">No network share is mounted on this box.</p>';
  } catch {
    list.innerHTML = '<p class="empty-state">Could not read what is mounted.</p>';
  }
}

function storageKindChanged() {
  const smb = $('#storage-kind').value === 'cifs';
  $$('.storage-smb').forEach((el) => { el.hidden = !smb; });
  $('#storage-server-row').hidden = smb;
  $('#storage-share-label').textContent = smb ? 'Share' : 'Export path';
  $('#storage-share').placeholder = smb ? '//192.168.1.48/media' : '/mnt/media/media_disk';
  // Probing is an NFS thing — SMB has no equivalent of showmount.
  $('#storage-check').hidden = smb;
  $('#storage-probe').innerHTML = '';
}

async function probeStorage() {
  const box = $('#storage-probe');
  const server = $('#storage-server').value.trim();
  if (!server) { box.innerHTML = '<p class="storage-note bad">Enter the NAS address first.</p>'; return; }

  const btn = $('#storage-check');
  btn.disabled = true;
  btn.textContent = 'Asking…';
  box.innerHTML = '';
  try {
    const res = await fetch('api/storage/probe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'nfs', server }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'the probe failed');

    if (!data.exports.length) {
      box.innerHTML = `<p class="storage-note bad">${escapeHtml(server)} answered, but exports nothing.</p>`;
      return;
    }
    const me = (data.addresses || []).join(', ') || 'this box';
    box.innerHTML = `
      <p class="storage-note">${escapeHtml(server)} exports these. This box is ${escapeHtml(me)}.</p>
      ${data.exports.map((e) => `
        <div class="storage-export ${e.allowed ? 'ok' : 'bad'}">
          <button type="button" class="storage-export-pick mono" data-export="${escapeHtml(e.path)}">${escapeHtml(e.path)}</button>
          <span class="storage-export-clients">${e.allowed
            ? 'allowed here'
            : `only for ${escapeHtml(e.clients.join(', '))} — add this box on the NAS first`}</span>
        </div>`).join('')}`;
  } catch (err) {
    box.innerHTML = `<p class="storage-note bad">${escapeHtml(err.message)}</p>`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Check the NAS';
  }
}

async function submitStorageForm(event) {
  event.preventDefault();
  const kind = $('#storage-kind').value;
  const body = {
    kind,
    server: $('#storage-server').value.trim(),
    share: $('#storage-share').value.trim(),
    mountpoint: $('#storage-mountpoint').value.trim(),
    user: $('#storage-user').value.trim(),
    password: $('#storage-pass').value,
  };

  const ok = await confirmDialog({
    title: `Mount ${body.share || 'the share'}?`,
    body: 'HomeBox writes a systemd automount on this box and mounts it now. Nothing on the NAS is '
      + 'changed or written to. Afterwards, point Server Config → Media at the mountpoint — the apps '
      + 'keep the bind they were created with, so they are recreated for you when you save that.',
    confirmLabel: 'Mount',
  });
  if (!ok) return;

  openProgress(`Mounting ${body.share}`);
  let success = false;
  try {
    const res = await fetch('api/storage/mount', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const raw of lines) {
        if (!raw.trim()) continue;
        let msg;
        try { msg = JSON.parse(raw); } catch { continue; }
        if (msg.done) success = msg.ok === true;
        else if (typeof msg.line === 'string') progressLine(msg.line);
      }
    }
  } catch (err) {
    progressLine(`ERROR: ${err.message}`);
  }
  closeProgress(success, success ? 'Mounted' : 'Could not mount');
  $('#storage-pass').value = '';
  if (success) toast('Mounted. Now set the Library root under Server Config → Media.', 'success', 9000);
  loadStorage();
}

async function detachStorage(mountpoint) {
  const ok = await confirmDialog({
    title: `Detach ${mountpoint}?`,
    body: 'The share is unmounted and its systemd units removed. Nothing on the NAS is deleted — but '
      + 'any app pointing at this path loses its library until you attach it again.',
    confirmLabel: 'Detach',
    danger: true,
  });
  if (!ok) return;
  try {
    const res = await fetch('api/storage/unmount', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mountpoint }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'could not detach');
    toast(`${mountpoint} detached.`, 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
  loadStorage();
}

/* ------------------------------------------------------- first login */

/**
 * "What is the username and password for this app?"
 *
 * HomeBox generates a password for every module that needs one and writes it
 * to .env — and until now the only way to read it was to SSH in and run
 * `homebox secrets <module>`. Installing the Media Stack handed you a
 * qBittorrent you could not sign in to without leaving the dashboard, which
 * is the one thing a dashboard exists to prevent.
 *
 * The source solves it by intercepting the FIRST click on an app's launcher
 * tile and showing the credentials before the app opens, with a "don't show
 * this again" tick. This is that, built on what HomeBox already has: the
 * module's own `env_vars` declare the keys, /api/config already returns their
 * values behind the session, and `first_login` already carries the sentence
 * explaining the app's own quirks.
 *
 * Dismissal is per-browser (localStorage) and per-service, because it is a
 * statement about what THIS person has already seen, not about the box.
 */
/**
 * The dismissal key, scoped to THIS install of the box.
 *
 * localStorage belongs to the browser, so wiping the server cannot clear it.
 * Keyed on the service alone, "don't show this again" outlived a full
 * uninstall and reinstall: the box came back with a brand new generated
 * password and the dialog that exists to show it stayed silent, which reads
 * exactly like the uninstall left something behind.
 *
 * The install id changes whenever state/ is recreated, so a reinstalled box
 * is a different box as far as this is concerned. Falls back to the bare name
 * only before the first summary lands, which at worst shows the dialog once
 * more than needed — the right direction to fail in.
 */
const seenKey = (service) => `hb-first-login-seen-${state.installId || 'pending'}-${service}`;

/** Every setting a module declares, with its current value. */
async function moduleEnv(moduleId) {
  if (!configSchema) {
    try {
      configSchema = await (await fetch('api/config')).json();
    } catch {
      return [];
    }
  }
  const group = (configSchema.groups || []).find((g) => g.id === `module-${moduleId}`);
  return group ? group.keys : [];
}

/**
 * Just the ones that read as a sign-in, for the first-login dialog.
 *
 * A module declares plenty of settings that are not credentials — PUID is
 * not a password, and listing it in a dialog headed "signing in" is noise
 * that makes the two lines that matter harder to find.
 */
async function moduleCredentials(moduleId) {
  const keys = await moduleEnv(moduleId);
  return keys.filter((k) => (k.secret || /USER|NAME|EMAIL/.test(k.key)) && k.value);
}

/**
 * The first-run dialog for one service. Resolves when it is dismissed.
 */
async function firstLoginDialog(svc, mod) {
  const creds = await moduleCredentials(mod.id);
  const rows = creds.map((c) => `
    <div class="cred-row">
      <span class="cred-label">${escapeHtml(c.label || c.key)}</span>
      <code class="cred-value mono">${escapeHtml(c.value)}</code>
      <button type="button" class="btn-soft cred-copy" data-copy="${escapeHtml(c.value)}">Copy</button>
    </div>`).join('');

  const body = `
    ${svc.first_login ? `<p class="cred-hint">${escapeHtml(svc.first_login)}</p>` : ''}
    ${rows
      ? `<div class="cred-box">${rows}</div>
         <p class="cred-note">HomeBox generated these at install. They are also under
            Settings → Passwords, and on the server with
            <code class="mono">homebox secrets ${escapeHtml(mod.id)}</code>.</p>`
      : `<p class="cred-note">This module declares no generated credentials — whatever
            ${escapeHtml(svc.friendly_name)} asks for on first run is yours to choose.</p>`}
    <label class="cred-dismiss">
      <input type="checkbox" id="cred-dismiss-box">
      <span>Don't show this again for ${escapeHtml(svc.friendly_name)}</span>
    </label>`;

  // The dialog removes itself before the promise resolves, so the tick has to
  // be recorded while the box still exists. Honoured whichever button was
  // pressed: someone who ticks it and then closes has still said they do not
  // want to see it again.
  let dismiss = false;
  const watch = (event) => {
    if (event.target.id === 'cred-dismiss-box') dismiss = event.target.checked;
  };
  document.addEventListener('change', watch);

  const ok = await confirmDialog({
    title: `Signing in to ${svc.friendly_name}`,
    bodyHtml: body,
    confirmLabel: `Open ${svc.friendly_name}`,
    cancelLabel: 'Close',
    wide: true,
  });

  document.removeEventListener('change', watch);
  return { open: ok, dismiss };
}

/**
 * Intercept the first launch of a service that has something to tell you.
 *
 * Bound in the capture phase on the whole document so it runs before the link
 * navigates, and so a tile re-rendered by the 20s poll is still covered —
 * rebinding per tile would lose the handler on every refresh.
 */
document.addEventListener('click', async (event) => {
  const link = event.target.closest('.launch[data-first-login]');
  if (!link) return;
  event.preventDefault();

  const service = link.dataset.flService;
  const mod = state.modules.find((m) => m.id === link.dataset.flModule);
  const svc = mod && mod.services.find((s) => s.name === service);
  if (!svc) { window.open(link.href, '_blank', 'noopener,noreferrer'); return; }

  const { open, dismiss } = await firstLoginDialog(svc, mod);
  if (dismiss) {
    try { localStorage.setItem(seenKey(service), '1'); } catch { /* private mode: it just asks again */ }
    link.removeAttribute('data-first-login');
  }
  if (open) window.open(link.href, '_blank', 'noopener,noreferrer');
});

/**
 * Reveal one secret on the Passwords tab.
 *
 * One row at a time and never on load: a page that prints every password the
 * moment it opens is a page you cannot show anyone, screen-share, or
 * screenshot for a support question.
 */
document.addEventListener('click', async (event) => {
  const btn = event.target.closest('.secret-reveal');
  if (!btn) return;
  const wrap = btn.closest('.secret-value');
  const [moduleId, key] = String(wrap.dataset.secret || '').split(':');
  const found = (await moduleEnv(moduleId)).find((c) => c.key === key && c.value);
  if (!found) {
    wrap.querySelector('.secret-hidden').textContent = 'not set';
    btn.remove();
    return;
  }
  wrap.innerHTML = `<code class="mono">${escapeHtml(found.value)}</code>`
    + `<button type="button" class="btn-soft cred-copy" data-copy="${escapeHtml(found.value)}">Copy</button>`;
});

/** Copy buttons inside the credentials dialog. */
document.addEventListener('click', async (event) => {
  const btn = event.target.closest('.cred-copy');
  if (!btn) return;
  event.preventDefault();
  try {
    await navigator.clipboard.writeText(btn.dataset.copy);
    const was = btn.textContent;
    btn.textContent = 'Copied';
    setTimeout(() => { btn.textContent = was; }, 1200);
  } catch {
    toast('The browser would not let the page copy — select the value and copy it by hand.', 'error');
  }
});

/* ----------------------------------------------------- live activity */

/**
 * The Home card that answers "what are my apps doing right now".
 *
 * The rule throughout: a source that could not be reached SAYS so. Painting a
 * calm `0 B/s` for an app that never answered would send someone looking for
 * a stalled download that is actually fine — so an unreachable app gets a
 * line of plain text explaining itself, and a working one gets numbers.
 *
 * The whole card hides when every panel is empty. A box with no media apps
 * should not carry a permanent invitation to configure something.
 */
let insightsData = null;
let insightsTimer = null;

const insightsOn = () => !state.prefs || !state.prefs.insights || state.prefs.insights.enabled !== false;
const panelOn = (name) => {
  const i = (state.prefs && state.prefs.insights) || {};
  return i[name] !== false;
};

function rate(bytesPerSecond) {
  if (!bytesPerSecond) return '0 B/s';
  return `${bytes(bytesPerSecond)}/s`;
}

/** "2h 14m", "3m", "48s" — the shape a person reads, not 8040 seconds. */
function etaText(seconds) {
  if (seconds == null) return null;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h) return `${h}h ${m}m left`;
  if (m) return `${m}m left`;
  return `${seconds}s left`;
}

/** "tonight", "Fri", "in 12 days" — a date only matters relative to today. */
function whenText(iso) {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return '';
  const days = Math.round((then.setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 86400000);
  if (days < 0) return 'out now';
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days < 7) return new Date(iso).toLocaleDateString(undefined, { weekday: 'long' });
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/**
 * A panel heading, built like a Quick access item: the app's own icon in a
 * small tile, then the name and what it is. Two cards in the same band should
 * read as the same kind of object, and an icon is what anchors a row.
 *
 * The icon files already ship in public/icons — these are HomeBox's own
 * modules, so there is nothing to download or configure.
 */
function liveHead(icon, title, sub) {
  return `<div class="live-head">
    <span class="live-head-icon"><img src="icons/${escapeHtml(icon)}" alt="" loading="lazy"></span>
    <span class="live-head-text">
      <strong>${escapeHtml(title)}</strong>
      <small>${escapeHtml(sub)}</small>
    </span>
  </div>`;
}

/**
 * The transfer sparkline: down as a filled area, up as a line over it.
 *
 * Hand-built SVG rather than a charting library, for the same reason the
 * server has no dependencies — and because what is wanted here is one glance:
 * is it moving, is it climbing, has it stalled. A chart with axes and a
 * legend would answer questions nobody asks of a 200px card.
 *
 * BOTH SERIES SHARE ONE SCALE. Giving each its own would draw a 20 KB/s
 * upload at the same height as a 5 MB/s download — two lines that look equal
 * and are not, which is worse than no graph.
 */
function transferSpark(history) {
  const pts = (history || []).filter((p) => p && typeof p.down === 'number');
  // Two points is the minimum that can be a line rather than a dot.
  if (pts.length < 2) return '';

  const W = 100;
  const H = 30;
  const peak = Math.max(1, ...pts.map((p) => Math.max(p.down, p.up)));
  const x = (i) => (i / (pts.length - 1)) * W;
  const y = (v) => H - (v / peak) * (H - 1);

  const line = (key) => pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p[key]).toFixed(1)}`).join(' ');
  const area = `${line('down')} L${W} ${H} L0 ${H} Z`;

  return `<svg class="live-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
      <path class="live-spark-fill" d="${area}"></path>
      <path class="live-spark-down" d="${line('down')}"></path>
      <path class="live-spark-up" d="${line('up')}"></path>
    </svg>
    <div class="live-spark-scale mono">
      <span>${escapeHtml(rate(peak))} peak</span>
      <span>${pts.length} samples</span>
    </div>`;
}

function transfersPanel(qb) {
  if (!qb || qb.installed === false) return '';
  if (qb.error) {
    return `<section class="live-panel">
      ${liveHead('qbittorrent.svg', 'Transfers', 'qBittorrent')}
      <p class="live-note">${escapeHtml(qb.error)}</p>
    </section>`;
  }
  const moving = qb.torrents || [];
  const rows = moving.length
    ? moving.map((t) => `
        <div class="live-torrent">
          <div class="live-torrent-top">
            <span class="live-torrent-name">${escapeHtml(t.name)}</span>
            <span class="live-torrent-eta mono">${escapeHtml(etaText(t.eta) || '')}</span>
          </div>
          <div class="live-bar"><span style="width:${Math.max(0, Math.min(100, t.progress))}%"></span></div>
          <div class="live-torrent-foot mono">${t.progress.toFixed(1)}% · ${escapeHtml(rate(t.downSpeed))}</div>
        </div>`).join('')
    : '<p class="live-note">Nothing is downloading right now.</p>';

  return `<section class="live-panel">
    ${liveHead('qbittorrent.svg', 'Transfers', 'qBittorrent')}
    <div class="live-figures">
      <div class="live-figure"><span class="live-arrow down">↓</span><strong class="mono">${escapeHtml(rate(qb.downSpeed))}</strong></div>
      <div class="live-figure"><span class="live-arrow up">↑</span><strong class="mono">${escapeHtml(rate(qb.upSpeed))}</strong></div>
      <div class="live-figure quiet"><strong class="mono">${qb.activeCount}</strong><span>active</span></div>
    </div>
    ${transferSpark(qb.history)}
    ${rows}
  </section>`;
}

function queuesPanel(data) {
  const apps = [
    { name: 'Radarr', icon: 'radarr.png', d: data.radarr },
    { name: 'Sonarr', icon: 'sonarr.png', d: data.sonarr },
  ].filter((a) => a.d && a.d.installed !== false);
  if (!apps.length) return '';

  // Named after whichever is actually installed — "Radarr & Sonarr" on a box
  // running only one of them is a heading that describes someone else's box.
  const sub = apps.map((a) => a.name).join(' & ');

  return `<section class="live-panel">
    ${liveHead(apps.length === 1 ? apps[0].icon : 'radarr.png', 'Download queue', sub)}
    ${apps.map((a) => `
      <div class="live-queue-row">
        <span class="live-queue-icon"><img src="icons/${escapeHtml(a.icon)}" alt="" loading="lazy"></span>
        <span class="live-queue-app">${escapeHtml(a.name)}</span>
        ${a.d.error
          ? `<span class="live-note">${escapeHtml(a.d.error)}</span>`
          : `<span class="live-queue-nums mono"><b>${a.d.queue}</b> fetching · <b>${a.d.missing}</b> missing</span>`}
      </div>`).join('')}
  </section>`;
}

function upcomingPanel(data) {
  const rows = data.upcoming || [];
  if (!rows.length && !data.upcomingError) return '';
  return `<section class="live-panel">
    ${liveHead('sonarr.png', 'Coming soon', `next ${data.upcomingDays} days`)}
    ${data.upcomingError
      ? `<p class="live-note">${escapeHtml(data.upcomingError)}</p>`
      : rows.map((r) => `
          <div class="live-soon">
            <span class="live-soon-dot ${r.have ? 'have' : ''}" title="${r.have ? 'already downloaded' : 'not downloaded yet'}"></span>
            <span class="live-soon-title">${escapeHtml(r.title)}</span>
            <span class="live-soon-detail">${escapeHtml(r.detail)}</span>
            <span class="live-soon-when">${escapeHtml(whenText(r.date))}</span>
          </div>`).join('')}
  </section>`;
}

function renderInsights(data) {
  insightsData = data;
  const card = $('#live-card');
  const box = $('#live-panels');
  if (!card || !box) return;

  if (!insightsOn()) { card.hidden = true; return; }

  const panels = [
    panelOn('transfers') ? transfersPanel(data.qbittorrent) : '',
    panelOn('queues') ? queuesPanel(data) : '',
    panelOn('upcoming') ? upcomingPanel(data) : '',
  ].filter(Boolean);

  // Nothing to say: no media apps installed, or every panel switched off.
  // Hiding beats an empty card asking to be configured.
  card.hidden = !panels.length;
  if (!panels.length) return;

  box.innerHTML = panels.join('');
  $('#live-meta').textContent = new Date(data.at).toLocaleTimeString();
}

async function loadInsights({ force = false } = {}) {
  if (!insightsOn()) { const c = $('#live-card'); if (c) c.hidden = true; return; }
  try {
    const res = await fetch('api/insights', force ? { method: 'POST' } : {});
    renderInsights(await res.json());
  } catch {
    /* the card keeps what it had; a poll that missed is not worth a banner */
  }
}

/**
 * Poll only while Home is on screen and the tab is visible.
 *
 * Every tick asks qBittorrent and (past its cache) Radarr and Sonarr for
 * numbers, and doing that to a backgrounded tab for hours is load on the
 * user's own apps in exchange for a card nobody is looking at.
 */
function scheduleInsights() {
  clearInterval(insightsTimer);
  insightsTimer = null;
  if (!insightsOn()) return;
  insightsTimer = setInterval(() => {
    if (document.hidden || currentPage() !== 'home') return;
    loadInsights();
  }, 10000);
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && currentPage() === 'home') loadInsights();
});

/* ----------------------------------------------------------- updates */

/**
 * The Updates page.
 *
 * What it lists is narrower than the word suggests, and the page says so:
 * every module pins an exact image version, so this never offers to move an
 * app to a new release. It offers the thing a pinned version does NOT protect
 * you from — the publisher re-pushing that same version with patched base
 * layers, which only the image digest reveals.
 *
 * The server keeps the last answer, so opening this tab shows something
 * immediately and only goes to the registries when what it has is stale.
 */
let updatesState = { available: [], lastCheck: null, applying: false };

/**
 * The nav dot, refreshed in the background.
 *
 * The server checks every six hours on its own and caches the answer, so this
 * only reads what is already there — no registry traffic, no waiting. Called
 * on boot and then on a timer, because an update you have to go and look for
 * is an update that does not get found.
 *
 * Two kinds, and they are not the same news:
 *   app images  — optional rebuilds, accent dot
 *   HomeBox     — a new release of the thing itself, RED
 */
async function refreshUpdateBadge() {
  try {
    const [apps, self] = await Promise.all([
      fetch('api/updates').then((r) => r.json()).catch(() => ({})),
      fetch('api/platform').then((r) => r.json()).catch(() => ({})),
    ]);
    updateBadge((apps.available || []).length, self.updateAvailable ? self.latest : null);
  } catch { /* leave the dot as it was */ }
}

function updateBadge(count, platformVersion = null) {
  const badge = $('#updates-badge');
  if (!badge) return;

  // A HomeBox release outranks any number of image rebuilds, and says so in a
  // different colour. Rebuilds are housekeeping; this is a new version of the
  // thing the box IS.
  badge.classList.toggle('is-platform', !!platformVersion);
  if (platformVersion) {
    badge.hidden = false;
    badge.title = `HomeBox ${platformVersion} is available`;
    return;
  }
  // A dot, not a number. These are optional rebuilds, and a red "12" reads
  // like twelve things are broken — the source made the same call.
  //
  // The `hidden` ATTRIBUTE, not a `.hidden` class: this stylesheet styles
  // `[hidden]` and defines no `.hidden` rule, so a class here is a button
  // that is always on screen no matter what the code thinks it set.
  badge.hidden = !count;
  badge.title = count
    ? `${count} container${count === 1 ? ' has' : 's have'} a newer image available`
    : '';
}

/* ---------------------------------------------------- HomeBox itself ---- */

let platformPoll = null;

/**
 * The card for updating HomeBox, as opposed to the apps it runs.
 *
 * Four states, and only one of them has a button: an update is available; the
 * maintainer has paused updates; this box is too old to jump automatically; an
 * update is running or was interrupted.
 */
function renderPlatform(data) {
  const card = $('#platform-card');
  if (!card) return;

  const p = data.progress;
  const running = data.running;
  const interrupted = p && !running && !['done', 'failed'].includes(p.phase);

  if (!data.updateAvailable && !data.frozen && !data.reason && !running && !interrupted) {
    card.hidden = true;
    return;
  }
  card.hidden = false;

  const head = (title, sub) => `
    <div class="updates-card-head">
      <div><h2>${escapeHtml(title)}</h2><small>${escapeHtml(sub)}</small></div>
    </div>`;

  if (running || interrupted) {
    const phase = (p && p.phase) || 'starting';
    const msg = (p && p.message) || '';
    card.innerHTML = `${head(
      interrupted ? 'An update was interrupted' : `Updating to ${p ? p.to : ''}`,
      interrupted
        ? `It stopped while ${phase}. This box is still usable — check the History below.`
        : 'The dashboard will restart partway through. This page will pick up where it left off.',
    )}
      <div class="platform-progress">
        <span class="platform-phase mono">${escapeHtml(phase)}</span>
        <span class="platform-message">${escapeHtml(msg)}</span>
      </div>`;
    return;
  }

  if (data.frozen) {
    card.innerHTML = `${head('Updates are paused', 'The maintainer has stopped this release from being installed.')}
      <p class="platform-reason">${escapeHtml(data.reason || '')}</p>`;
    return;
  }

  if (data.reason) {
    card.innerHTML = `${head(`HomeBox ${data.latest || ''} is available`, 'It cannot be installed from here.')}
      <p class="platform-reason">${escapeHtml(data.reason)}</p>`;
    return;
  }

  // Truncate BEFORE escaping. Slicing escaped markup can cut an entity in
  // half and leave `&am` on the page.
  const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);
  const notesText = data.notes
    ? [data.notes.name, data.notes.body].filter(Boolean).join('\n\n')
    : '';
  const notes = notesText
    ? `<div class="platform-notes">${escapeHtml(clip(notesText, 1200))}</div>`
    : '';
  const link = data.notes && data.notes.url
    ? `<a class="platform-notes-link" href="${escapeHtml(data.notes.url)}" target="_blank" rel="noopener noreferrer">Full release notes</a>`
    : '';

  // Version-to-version on one line, rather than a sentence.
  //
  // "HomeBox 0.3.5 is available / This box is on 0.3.4" makes you read two
  // lines and hold both numbers to work out the direction. `0.3.4 → 0.3.5`
  // is the same fact in one glance, and it is what every updater worth
  // copying does.
  card.innerHTML = `
    <div class="updates-card-head">
      <div>
        <h2>HomeBox</h2>
        <small class="platform-versions">
          Current version <b>${escapeHtml(data.current)}</b>
          <span class="platform-arrow">→</span>
          <b class="platform-next">${escapeHtml(data.latest)}</b> available
        </small>
      </div>
      <div class="platform-actions">
        <button type="button" class="btn-soft" id="platform-check">Check</button>
        <button type="button" class="btn-pill primary" id="platform-go">Update HomeBox</button>
      </div>
    </div>
    <p class="platform-reassure">Takes about a minute. Your apps keep running and their data is not touched, and if the new version does not start, this box puts ${escapeHtml(data.current)} back on its own.<br>
    You can close this page — the update runs on the box, not in the browser, and this card picks it up again when you come back.</p>
    ${notes ? `<div class="platform-whatsnew">
      <span class="platform-whatsnew-label">What's new in ${escapeHtml(data.latest)}</span>
      ${notes}${link}
    </div>` : ''}`;

  $('#platform-go').addEventListener('click', () => startPlatformUpgrade(data));
  $('#platform-check').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true; btn.textContent = 'Checking…';
    try {
      await fetch('api/platform/check', { method: 'POST' });
      await loadPlatform();
    } finally {
      if (document.body.contains(btn)) { btn.disabled = false; btn.textContent = 'Check'; }
    }
  });
}

async function startPlatformUpgrade(data) {
  const ok = await confirmDialog({
    title: `Update HomeBox to ${data.latest}?`,
    body: 'The dashboard restarts partway through and is unreachable for about a minute. '
      + 'Your apps keep running, and nothing in their data is changed. '
      + 'If the new version fails to start, this box puts itself back on '
      + `${data.current} on its own.`,
    confirmLabel: 'Update HomeBox',
  });
  if (!ok) return;

  try {
    const res = await fetch('api/platform/upgrade', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: data.latest }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || `the server answered ${res.status}`);
    // The same dialog an image upgrade uses. A button that goes quiet for a
    // minute while the page it is on restarts needs to show its work.
    platformShown = 0;
    openProgress(`Updating HomeBox to ${data.latest}`);
    pollPlatform();
  } catch (err) {
    toast(`Could not start the update: ${err.message}`, 'error', 8000);
  }
}

// Lines already shown, so a poll only appends what is new. The log is re-read
// whole each time — it is the only thing that survives the restart — and
// replaying it would repeat the entire update every two seconds.
let platformShown = 0;

/**
 * Poll while an update runs — and keep polling THROUGH the restart.
 *
 * The dashboard is rebuilt partway through, so these requests will fail for
 * roughly a minute. That is the expected middle of a successful update, not an
 * error, and reporting it as one would tell the user their update broke at the
 * exact moment it is working. Failures are counted, not shown, and only a long
 * silence gives up.
 */
function pollPlatform() {
  if (platformPoll) clearInterval(platformPoll);
  let missed = 0;
  const started = Date.now();

  platformPoll = setInterval(async () => {
    try {
      const data = await (await fetch('api/platform')).json();
      missed = 0;
      renderPlatform(data);

      // Append only what the dialog has not shown. After the dashboard
      // restarts, this poll returns every line including the ones written
      // while the browser could not reach anything — which is exactly the
      // stretch somebody wants to read.
      const lines = data.log || [];
      for (let i = platformShown; i < lines.length; i += 1) progressLine(lines[i]);
      platformShown = lines.length;

      if (!data.running) {
        clearInterval(platformPoll);
        platformPoll = null;
        const last = (data.history || [])[0];
        if (last && last.kind === 'platform') {
          closeProgress(last.ok, last.ok ? `Now on ${last.to}` : `Rolled back to ${last.from}`);
          // The version changed underneath this page, so its CSS and JS are
          // now the previous release's. Reload rather than leave a mixed page
          // — but only after the dialog has had a moment to be read.
          if (last.ok) { setTimeout(() => location.reload(), 2500); return; }
          toast(`The update did not finish: ${last.detail}`, 'error', 12000);
        } else {
          closeProgress(false, 'The update stopped');
        }
        loadUpdates();
      }
    } catch {
      missed += 1;
      // Five minutes of silence is a real problem. A minute of it is the
      // dashboard being rebuilt by the very update being watched.
      if (Date.now() - started > 300000 && missed > 3) {
        clearInterval(platformPoll);
        platformPoll = null;
        toast('Lost contact with the box while updating. Refresh in a moment.', 'error', 12000);
      }
    }
  }, 2000);
}

async function loadPlatform() {
  try {
    const data = await (await fetch('api/platform')).json();
    renderPlatform(data);
    if (data.running && !platformPoll) {
      // Rejoining an update already in flight — after a reload, or after the
      // dashboard restarted under the page. Open the dialog and start from the
      // beginning of the log, so what happened while the browser was away is
      // read rather than skipped. Without the dialog, progressLine has nowhere
      // to write and every line is silently dropped.
      platformShown = 0;
      openProgress(`Updating HomeBox to ${data.progress ? data.progress.to : ''}`);
      pollPlatform();
    }
  } catch { /* the card simply stays hidden */ }
}

async function loadUpdates({ force = false } = {}) {
  const list = $('#updates-list');
  if (!list) return;
  try {
    const data = await (await fetch('api/updates')).json();
    renderUpdates(data);
    // Nothing cached, or cached long enough ago that showing it without
    // saying "this is old" would be misleading. Re-check in the background.
    if ((force || data.stale) && !data.checking && !data.applying) runUpdateCheck({ quiet: true });
  } catch (err) {
    list.innerHTML = `<p class="empty-state">Could not read the update state: ${escapeHtml(err.message)}</p>`;
  }
}

function renderUpdates(data) {
  updatesState = data;
  const list = $('#updates-list');
  const count = (data.available || []).length;

  $('#updates-count').textContent = String(count);
  $('#updates-server').textContent = location.hostname || 'this box';
  updateBadge(count);

  // Never say "up to date" without a check behind it — that is a claim, and
  // an install that has never checked has no basis for making it.
  if (!data.lastCheck) {
    $('#updates-status').textContent = 'No check has run on this box yet.';
  } else {
    const skipped = (data.skipped || []).length;
    $('#updates-status').textContent =
      `Last checked ${new Date(data.lastCheck).toLocaleString()} · `
      + `${data.checked} of ${data.containers} containers compared`
      + (skipped ? ` · ${skipped} could not be reached` : '')
      // Say that it is automatic. Without this the page shows a timestamp
      // and a button, which reads as "press this to find out" — and somebody
      // reasonably concluded exactly that. Check now is for impatience, not
      // for operation.
      + ' · Checks again on its own every 6 hours';
  }

  // Only worth offering when there is more than one thing to do — with a
  // single update the row's own button is the same action, one click closer.
  $('#updates-all').hidden = count < 2;

  if (!data.lastCheck) {
    list.innerHTML = '<p class="empty-state">Press <strong>Check now</strong> to compare every running image against its registry.</p>';
  } else if (!count) {
    list.innerHTML = '<p class="empty-state"><strong>Everything is current.</strong> Every image running on this box matches the newest build the registry has for its pinned version.</p>';
  } else {
    list.innerHTML = data.available.map((u) => `
      <div class="update-row" data-container="${escapeHtml(u.container)}">
        <div class="update-row-info">
          <div class="update-row-name">
            ${escapeHtml(u.container)}
            <span class="update-tag" title="The publisher rebuilt this same version tag with new layers. Same version number, usually security patches underneath.">rebuild</span>
          </div>
          <div class="update-row-image mono">${escapeHtml(u.image)}</div>
          <div class="update-row-digest mono">${escapeHtml(String(u.currentDigest).slice(7, 19))} → ${escapeHtml(String(u.latestDigest).slice(7, 19))}</div>
        </div>
        <button type="button" class="btn-soft" data-update="${escapeHtml(u.container)}">Update</button>
      </div>`).join('');
  }

  // Whatever could not be checked is shown, not swallowed. A box where the
  // registry was unreachable for half its images must not look like a box
  // that is fully up to date.
  if ((data.skipped || []).length) {
    list.insertAdjacentHTML('beforeend', `
      <div class="updates-skipped">
        <strong>Not checked</strong>
        ${data.skipped.map((s) => `<div><span class="mono">${escapeHtml(s.container)}</span> — ${escapeHtml(s.reason)}</div>`).join('')}
      </div>`);
  }

  renderNewVersions(data.newVersions || [], data.heldBack || []);
  renderUpdateHistory(data.history || []);
}

/**
 * Newer VERSIONS, kept apart from the rebuild list above.
 *
 * A rebuild is a button: the same version, safe to pull, rolled back if it
 * misbehaves. A new version is a line in a compose file — it can change a
 * config format or need a migration — so it is news to act on, not a click.
 * One list would hide two very different risks behind one button.
 */
function renderNewVersions(rows, held = []) {
  const box = $('#updates-versions');
  if (!box) return;
  if ((!rows || !rows.length) && !held.length) { box.hidden = true; return; }
  box.hidden = false;

  // Versions that exist and cannot be taken by swapping an image. Rendered
  // WITHOUT a button, and said out loud rather than hidden: a database left on
  // an old major version is worth knowing about, and silence is how a box
  // quietly ages.
  const heldHtml = held.length ? `
    <div class="update-row held-back">
      <div class="update-row-info">
        <div class="update-row-name">Not offered here
          <span class="update-tag" title="These need a migration, not an image swap.">needs a migration</span>
        </div>
        ${held.map((h) => `<div class="update-row-digest mono">${escapeHtml(h.container)}: ${escapeHtml(h.tag)} → ${escapeHtml(h.newerVersion)} — ${escapeHtml(h.why)}</div>`).join('')}
      </div>
    </div>` : '';
  if (!rows || !rows.length) {
    box.innerHTML = `<div class="updates-card-head">
        <div><h2>Newer versions published</h2>
        <small>Nothing here can be applied from this page.</small></div>
      </div>${heldHtml}`;
    return;
  }

  box.innerHTML = `<div class="updates-card-head">
      <div>
        <h2>Newer versions published</h2>
        <small>Not applied from here. A version change can need a config migration, so it arrives
        with a HomeBox release — or edit the tag in the module and run
        <code class="mono">homebox update &lt;module&gt;</code>.</small>
      </div>
    </div>` + rows.map((r) => `
      <div class="update-row">
        <div class="update-row-info">
          <div class="update-row-name">${escapeHtml(r.container)}
            <span class="update-tag version" title="A newer tag exists in the registry for this image.">new version</span>
          </div>
          <div class="update-row-image mono">${escapeHtml(r.image)}</div>
          <div class="update-row-digest mono">${escapeHtml(r.tag)} → ${escapeHtml(r.newerVersion)}</div>
        </div>
        <button type="button" class="btn-soft" data-upgrade="${escapeHtml(r.container)}">Upgrade</button>
      </div>`).join('') + heldHtml;
}

function renderUpdateHistory(history) {
  const el = $('#updates-history');
  if (!el) return;
  if (!history.length) {
    el.innerHTML = '<p class="empty-state">No updates have been applied from this page yet.</p>';
    return;
  }
  el.innerHTML = history.map((h) => {
    const kind = h.success ? 'ok' : (h.rolledBack ? 'rolled-back' : 'failed');
    const label = h.success ? 'Updated' : (h.rolledBack ? 'Rolled back' : 'Failed');
    return `
      <div class="update-history-row">
        <span class="update-history-tag ${kind}">${label}</span>
        <span class="update-history-name mono">${escapeHtml(h.container || h.module || '')}</span>
        <span class="update-history-time">${escapeHtml(new Date(h.timestamp).toLocaleString())}</span>
        ${h.reason ? `<span class="update-history-reason">${escapeHtml(h.reason)}</span>` : ''}
      </div>`;
  }).join('');
}

/**
 * Move one service to a newer version, from the button.
 *
 * Warned about more heavily than a rebuild, because it is a heavier thing: a
 * rebuild rolls back by re-tagging an image still on disk, while a new
 * version may migrate a database on first start — and a migration is not
 * undone by putting the old tag back. Hence the backup, and hence saying so.
 */
async function upgradeVersion(container, from, to) {
  const ok = await confirmDialog({
    title: `Upgrade ${container} to ${to}?`,
    bodyHtml: `
      <p>Moving from <code class="mono">${escapeHtml(from)}</code> to
         <code class="mono">${escapeHtml(to)}</code>.</p>
      <p class="cred-note">A full config backup is taken first, automatically. If the app does not
      come back healthy, the previous version is put straight back.</p>
      <p class="cred-note"><strong>Worth knowing:</strong> a new version can migrate its database on
      first start, and putting the old version back does not undo a migration. That is what the
      backup is for. The version is recorded in HomeBox's own state, so a later
      <code class="mono">git pull</code> will not conflict.</p>`,
    confirmLabel: `Upgrade to ${to}`,
    danger: true,
    wide: true,
  });
  if (!ok) return;

  openProgress(`Upgrading ${container} to ${to}`);
  let success = false;
  try {
    const res = await fetch('api/updates/upgrade', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ container }),
    });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const raw of lines) {
        if (!raw.trim()) continue;
        let msg;
        try { msg = JSON.parse(raw); } catch { continue; }
        if (msg.done) success = msg.ok === true;
        else if (typeof msg.line === 'string') progressLine(msg.line);
      }
    }
  } catch (err) {
    progressLine(`ERROR: ${err.message}`);
  }
  closeProgress(success, success ? `${container} is on ${to}` : 'Rolled back');
  toast(success
    ? `${container} upgraded to ${to}.`
    : `${container} was put back on ${from} — the log says why.`, success ? 'success' : 'error', 12000);
  loadUpdates();
}

async function runUpdateCheck({ quiet = false } = {}) {
  const btn = $('#updates-check');
  if (btn) { btn.disabled = true; btn.textContent = 'Checking…'; }
  if (!quiet) $('#updates-status').textContent = 'Asking each registry for the newest build…';

  // HomeBox itself, alongside the images.
  //
  // "Check now" used to ask the registries and nothing else, so a box whose
  // cached platform answer was stale had no way to refresh it from the
  // interface at all — the button was right there, said "Check now", and did
  // not check the one thing the user was looking at. The only route was
  // `homebox self-update --check` over SSH, which is what this whole feature
  // exists to remove.
  //
  // Deliberately not awaited into the same try: one static JSON file failing
  // should not make the registry check look like it failed too.
  fetch('api/platform/check', { method: 'POST' })
    .then(() => loadPlatform())
    .catch(() => {});

  try {
    const res = await fetch('api/updates/check', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'the check did not complete');
    renderUpdates({ ...data, history: updatesState.history || [] });
    if (!quiet) {
      const n = (data.available || []).length;
      toast(n
        ? `${n} container${n === 1 ? '' : 's'} can be updated.`
        : 'Everything on this box is running the newest build of its version.', 'success');
    }
  } catch (err) {
    if (!quiet) toast(err.message, 'error');
    $('#updates-status').textContent = `The last check did not finish: ${err.message}`;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Check now'; }
  }
}

/**
 * Apply one update, or all of them, with the server's progress in the same
 * dialog an install uses. Confirmed first, always: this recreates a running
 * container, which means a short outage for that app.
 */
async function applyUpdate(which) {
  const many = which === 'all';
  const target = many
    ? `all ${updatesState.available.length} containers`
    : which;
  const ok = await confirmDialog({
    title: many ? 'Update everything?' : `Update ${which}?`,
    body: `HomeBox will back up the module's config, pull the new image and recreate ${target} `
      + 'one at a time, waiting for each to come back healthy. Anything that does not come back '
      + 'is put straight back on the image it was running. Expect a brief outage per app.',
    confirmLabel: many ? 'Update all' : 'Update',
  });
  if (!ok) return;

  openProgress(many ? 'Updating all containers' : `Updating ${which}`);
  let success = false;
  try {
    const res = await fetch('api/updates/apply', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ container: which }),
    });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const raw of lines) {
        if (!raw.trim()) continue;
        let msg;
        try { msg = JSON.parse(raw); } catch { continue; }
        if (msg.done) success = msg.ok === true;
        else if (typeof msg.line === 'string') progressLine(msg.line);
      }
    }
  } catch (err) {
    progressLine(`ERROR: ${err.message}`);
  }
  closeProgress(success, success ? 'Update complete' : 'Update did not finish');
  toast(success ? 'Update complete.' : 'The update did not finish — read the log above.', success ? 'success' : 'error');
  loadUpdates();
}

/* ------------------------------------------------ live install progress */

/**
 * The third dialog: what the box is actually doing, while it does it.
 *
 * An install pulls images and can take minutes. Answering only at the end
 * means a long silence, which is exactly when someone concludes it has hung
 * and reloads the page mid-pull. So the server streams compose's own output
 * and it goes on screen verbatim — the same text an SSH session would show.
 */
let progress = null;

function openProgress(title) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-card modal-card-wide progress-card" role="dialog" aria-modal="true">
      <h3 class="modal-title" id="progress-title"></h3>
      <div class="progress-do-not-close" id="progress-warning">
        <strong>Leave this open.</strong>
        Closing the page will not stop the install — but you will lose the log, and this is
        the only place it is shown.
      </div>
      <div class="progress-steps" id="progress-steps"></div>
      <pre class="progress-log" id="progress-log" tabindex="0" aria-live="polite"></pre>
      <div class="modal-actions" id="progress-actions" hidden>
        <button type="button" class="btn-pill primary" data-act="progress-close">Close</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('#progress-title').textContent = title;

  progress = { overlay, log: overlay.querySelector('#progress-log'), steps: overlay.querySelector('#progress-steps'), stuck: false };
  return progress;
}

/**
 * One line of output. Compose's own words go through untouched; the step
 * chips above are read off them so there is a summary without inventing a
 * second source of truth about what happened.
 *
 * Which stream a line came from is deliberately ignored. `docker compose`
 * writes ALL of its progress to stderr -- "Container x Started" included --
 * so treating stderr as failure paints every successful install red.
 */
function progressLine(line) {
  if (!progress) return;
  const steps = progress.steps;

  // Compose v2 puts the SUBJECT first and the verb last — "Image x Pulling",
  // "Container y Started". The source's regexes are v1 (verb first) and match
  // nothing on a current compose, which is why no chip ever appeared. Checked
  // against the v5.5.1 on this box.
  const m = /^\s*(Image|Container)\s+(\S+)\s+([A-Za-z]+)\s*$/.exec(line);
  if (m) {
    const [, kind, subject, verb] = m;
    const key = `${kind}:${subject}`;
    // An image ref is long and mostly registry; the last segment is the part
    // that identifies it on a chip.
    const label = kind === 'Image' ? subject.split('/').pop() : subject;
    const BUSY = ['Pulling', 'Creating', 'Recreating', 'Starting'];
    const DONE = ['Pulled', 'Created', 'Started', 'Running', 'Healthy', 'Skipped', 'Stopped', 'Removed'];

    const chip = steps.querySelector(`[data-step="${CSS.escape(key)}"]`);
    if (BUSY.includes(verb) && !chip) {
      steps.insertAdjacentHTML('beforeend',
        `<span class="progress-step active" data-step="${escapeHtml(key)}">${escapeHtml(verb)} ${escapeHtml(label)}</span>`);
    } else if (DONE.includes(verb)) {
      if (chip) {
        chip.classList.remove('active');
        chip.classList.add('done');
        chip.textContent = `${verb} ${label}`;
      } else {
        // Already up, so there was never a "busy" line to open a chip.
        steps.insertAdjacentHTML('beforeend',
          `<span class="progress-step done" data-step="${escapeHtml(key)}">${escapeHtml(verb)} ${escapeHtml(label)}</span>`);
      }
    }
  }

  // Written as a text node, never innerHTML: this is container output, and
  // an image that prints a tag is not a reason to render it.
  progress.log.appendChild(document.createTextNode(`${line}\n`));
  progress.log.scrollTop = progress.log.scrollHeight;
}

function closeProgress(ok, title) {
  if (!progress) return;
  progress.steps.querySelectorAll('.progress-step.active').forEach((el) => {
    el.classList.remove('active');
    if (ok) el.classList.add('done');
  });
  progress.overlay.querySelector('#progress-title').textContent = title;
  progress.overlay.querySelector('#progress-warning').hidden = true;
  progress.overlay.querySelector('#progress-actions').hidden = false;
  const done = progress;
  progress = null;
  done.overlay.querySelector('[data-act="progress-close"]').addEventListener('click', () => {
    done.overlay.remove();
    loadModules(true);
  });
}

/**
 * Run one module action with its output streamed into the open dialog.
 * Falls back to the non-streaming endpoint if the stream cannot be read, so
 * an old browser still installs — it just does it silently.
 */
async function runActionStreamed(id, action) {
  const mod = state.modules.find((m) => m.id === id);
  const title = mod ? mod.title : id;
  progressLine(`\n==> ${action} ${title}`);
  state.busy.add(id);
  try {
    const res = await fetch(`api/modules/${encodeURIComponent(id)}/${encodeURIComponent(action)}/stream`, { method: 'POST' });
    if (!res.body) {
      const plain = await (await fetch(`api/modules/${encodeURIComponent(id)}/${encodeURIComponent(action)}`, { method: 'POST' })).json();
      progressLine(plain.output || plain.error || '(no output)');
      return plain.ok !== false;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let ok = true;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const raw of lines) {
        if (!raw.trim()) continue;
        let msg;
        try { msg = JSON.parse(raw); } catch { continue; }
        if (msg.done) {
          ok = msg.ok !== false;
          if (msg.error) {
            progressLine(`ERROR: ${msg.error}`);
            // The red border marks a real failure -- the exit code -- not the
            // fact that compose talks on stderr.
            if (progress) progress.log.classList.add('has-stderr');
          } else {
            progressLine(`==> ${action} finished in ${msg.seconds}s`);
          }
        } else if (typeof msg.line === 'string') {
          progressLine(msg.line);
        }
      }
    }
    return ok;
  } catch (err) {
    progressLine(`ERROR: ${err.message}`);
    if (progress) progress.log.classList.add('has-stderr');
    return false;
  } finally {
    state.busy.delete(id);
  }
}

/* --------------------------------------------------- staged installs */

/**
 * Clicking a card queues the change; the apply bar commits the batch.
 *
 * Installing is not a small act — it pulls images, creates containers and
 * opens ports on the LAN — and the old behaviour fired on the first click
 * with no way back. Queueing turns a slip into something you can cancel, and
 * lets someone pick four apps and review the whole set once.
 */
function queueChange(id) {
  const mod = state.modules.find((m) => m.id === id);
  if (!mod || mod.required || state.busy.has(id)) return;

  // Toggling back to the state it is already in is not a change: drop it,
  // rather than queueing a no-op that the bar would then count.
  const wanted = state.pending.has(id) ? !state.pending.get(id) : !mod.installed;
  if (wanted === mod.installed) state.pending.delete(id);
  else state.pending.set(id, wanted);

  renderApps();
  renderApplyBar();
}

function cancelPending() {
  state.pending.clear();
  renderApps();
  renderApplyBar();
}

function renderApplyBar() {
  let bar = $('#apps-apply-bar');
  if (!state.pending.size) {
    if (bar) bar.remove();
    return;
  }
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'apps-apply-bar';
    bar.className = 'apps-apply-bar';
    document.body.appendChild(bar);
  }
  const install = [...state.pending.values()].filter(Boolean).length;
  const remove = state.pending.size - install;
  const bits = [];
  if (install) bits.push(`<strong>${install}</strong> to install`);
  if (remove) bits.push(`<strong>${remove}</strong> to remove`);
  bar.innerHTML = `
    <div class="apps-apply-bar-summary">${bits.join(' · ')}</div>
    <div class="apps-apply-bar-actions">
      <button type="button" class="btn-pill" id="apps-apply-cancel">Cancel</button>
      <button type="button" class="btn-pill primary" id="apps-apply-go">Apply changes</button>
    </div>`;
}

/**
 * The second dialog: exactly what is about to happen, before it happens.
 *
 * Counts of containers and ports come from each module's declared services,
 * so this cannot promise something different from what compose will do. The
 * patience notice is here because a first install pulls images and an app
 * that is not reachable after ten seconds looks broken when it is only slow.
 */
function installDisclosure(installIds, removeIds) {
  const byId = new Map(state.modules.map((m) => [m.id, m]));
  const installMods = installIds.map((id) => byId.get(id)).filter(Boolean);
  const removeMods = removeIds.map((id) => byId.get(id)).filter(Boolean);

  let containers = 0;
  let ports = 0;
  let html = '';

  if (installMods.length) {
    html += '<div class="install-disclosure-section"><div class="install-disclosure-section-title">Installing</div>';
    for (const m of installMods) {
      const services = m.services || [];
      containers += services.length;
      const open = services.filter((sv) => sv.port).map((sv) => sv.port);
      ports += open.length;
      html += `<div class="install-disclosure-item install-disclosure-item-enable">
        <div class="install-disclosure-item-name">${escapeHtml(m.title)}</div>
        <div class="install-disclosure-item-detail">
          <span class="install-disclosure-chip">${services.length} service${services.length === 1 ? '' : 's'}</span>
          ${open.length ? `<span class="install-disclosure-chip">Ports: ${escapeHtml(open.join(', '))}</span>` : ''}
          ${m.ram ? `<span class="install-disclosure-chip">RAM: ${escapeHtml(m.ram)}</span>` : ''}
        </div>
        <div class="install-disclosure-item-services">${escapeHtml(services.map((sv) => sv.friendly_name).join(', ') || m.title)}</div>
      </div>`;
    }
    html += '</div>';
  }

  if (removeMods.length) {
    html += '<div class="install-disclosure-section"><div class="install-disclosure-section-title">Removing</div>';
    for (const m of removeMods) {
      html += `<div class="install-disclosure-item install-disclosure-item-disable">
        <div class="install-disclosure-item-name">${escapeHtml(m.title)}</div>
        <div class="install-disclosure-item-detail">Containers stop and are deleted.
          Settings and data in <code>modules/${escapeHtml(m.id)}/config</code> stay on disk, so installing it again brings it back.</div>
      </div>`;
    }
    html += '</div>';
  }

  const parts = [];
  if (installMods.length) parts.push(`${installMods.length} app${installMods.length === 1 ? '' : 's'} to install`);
  if (removeMods.length) parts.push(`${removeMods.length} app${removeMods.length === 1 ? '' : 's'} to remove`);

  const meta = [];
  if (containers) meta.push(`${containers} new container${containers === 1 ? '' : 's'}`);
  if (ports) meta.push(`${ports} port${ports === 1 ? '' : 's'} opened on your LAN`);

  const notice = installMods.length ? `<div class="install-disclosure-notice">
      <span class="install-disclosure-notice-icon">⏱</span>
      <div class="install-disclosure-notice-text">
        <strong>Give it a minute.</strong> A first install pulls the images, which usually takes
        <strong>1–3 minutes</strong>, and some apps need another minute after that before they answer.
        Nothing is wrong if a tile is not reachable straight away.
      </div>
    </div>` : '';

  // Removing from the App Store card offers the same choice the drawer does.
  // Without it "Remove" here silently kept the config, which is how an app
  // someone removed to start over came back with the same broken account.
  const erase = removeMods.length ? `
    <label class="remove-erase">
      <input type="checkbox" id="remove-erase-box">
      <span>
        <strong>Also erase settings and data</strong>
        <small>Deletes each removed app's <code class="mono">config</code> directory — its database,
        its accounts, everything it has learned. Off means a reinstall picks up where you left off.</small>
      </span>
    </label>` : '';

  removeDialog.erase = false;
  return confirmDialog({
    title: 'Apply these changes?',
    bodyHtml: `<p class="install-disclosure-intro">${escapeHtml(parts.join(' · '))}. Here is what will happen:</p>
      <div class="install-disclosure-list">${html}</div>
      <div class="install-disclosure-footer">
        ${meta.length ? `<div class="install-disclosure-meta">${escapeHtml(meta.join(' · '))}</div>` : ''}
        ${erase}
        ${notice}
      </div>`,
    confirmLabel: installMods.length ? 'Install' : 'Remove',
    danger: !installMods.length,
    wide: true,
  });
}

async function applyPending() {
  const installIds = [...state.pending.entries()].filter(([, v]) => v).map(([k]) => k);
  const removeIds = [...state.pending.entries()].filter(([, v]) => !v).map(([k]) => k);
  if (!(await installDisclosure(installIds, removeIds))) return;

  state.pending.clear();
  renderApplyBar();
  renderApps();

  const total = installIds.length + removeIds.length;
  openProgress(total === 1 ? 'Working…' : `Working… (${total} apps)`);

  // Sequential, not parallel: two compose projects pulling at once saturate
  // the link, and two sets of progress interleaved in one log is unreadable.
  let ok = true;
  for (const id of installIds) ok = (await runActionStreamed(id, 'install')) && ok;
  // Whatever the disclosure's checkbox said, applied to every app being
  // removed in this batch.
  const removeVerb = removeDialog.erase ? 'purge' : 'remove';
  for (const id of removeIds) ok = (await runActionStreamed(id, removeVerb)) && ok;

  closeProgress(ok, ok ? 'Done' : 'Something went wrong');
  if (ok) toast(total === 1 ? 'Done.' : `${total} apps done.`, 'success');
  else toast('Something failed — the log in the dialog says what.', 'error', 10000);
}

/* ----------------------------------------------------------------- wiring */

document.addEventListener('click', async (event) => {
  const queueBtn = event.target.closest('[data-queue]');
  if (queueBtn) {
    event.preventDefault();
    queueChange(queueBtn.dataset.queue);
    return;
  }
  if (event.target.closest('#btn-signout')) { signOut(); return; }
  if (event.target.closest('#apps-apply-cancel')) { cancelPending(); return; }
  if (event.target.closest('#apps-apply-go')) { applyPending(); return; }

  const actionBtn = event.target.closest('[data-action][data-id]');
  if (actionBtn) {
    event.preventDefault();
    runAction(actionBtn.dataset.id, actionBtn.dataset.action);
    return;
  }
  const containerBtn = event.target.closest('[data-container][data-caction]');
  if (containerBtn) {
    event.preventDefault();
    runContainerAction(containerBtn.dataset.container, containerBtn.dataset.caction);
    return;
  }
  const logBtn = event.target.closest('[data-log-for]');
  if (logBtn) {
    closeDrawer();
    openLogs(logBtn.dataset.logFor);
    return;
  }
  const moduleBtn = event.target.closest('[data-module]');
  if (moduleBtn) return openModule(moduleBtn.dataset.module);

  const chip = event.target.closest('[data-category]');
  if (chip) {
    state.category = chip.dataset.category;
    renderCategories();
    renderApps();
    return;
  }
  const cfilter = event.target.closest('[data-cfilter]');
  if (cfilter) {
    state.containerFilter = cfilter.dataset.cfilter;
    renderContainerChips();
    renderContainers();
    return;
  }
  if (event.target.closest('#btn-save-config')) return saveConfig();

  const showBtn = event.target.closest('[data-config-show]');
  if (showBtn) {
    const field = document.getElementById(showBtn.dataset.configShow);
    const hidden = field.type === 'password';
    field.type = hidden ? 'text' : 'password';
    showBtn.textContent = hidden ? 'Hide' : 'Show';
    return undefined;
  }

  if (event.target.closest('#btn-create-backup')) return createBackup();

  if (event.target.closest('#btn-reveal-key')) {
    return backupCall('key', {}, (data) => {
      const box = $('#backup-key-value');
      box.textContent = data.key;
      box.hidden = false;
      $('#btn-copy-key').hidden = false;
      $('#btn-reveal-key').textContent = 'Backup key';
    });
  }
  if (event.target.closest('#btn-copy-key')) {
    const key = $('#backup-key-value').textContent;
    navigator.clipboard.writeText(key).then(
      () => { $('#btn-copy-key').textContent = 'Copied'; },
      () => { $('#btn-copy-key').textContent = 'Copy failed'; }
    );
    return undefined;
  }
  if (event.target.closest('#btn-save-schedule')) {
    return backupCall('schedule', {
      enabled: $('#backup-schedule-enabled').checked,
      preset: $('#backup-schedule-preset').value,
      retention: Number($('#backup-schedule-retention').value),
    }, () => {
      toast($('#backup-schedule-enabled').checked
        ? 'Schedule saved — HomeBox will take config backups on its own.'
        : 'Automatic backups turned off.', 'success');
      loadBackups();
    });
  }

  const verifyBtn = event.target.closest('[data-backup-verify]');
  if (verifyBtn) {
    const name = verifyBtn.dataset.backupVerify;
    verifyBtn.disabled = true;
    verifyBtn.textContent = 'Checking…';
    return backupCall('verify', { name }, () => {
      verifyBtn.textContent = 'Valid';
      toast(`${name} decrypts and authenticates cleanly.`, 'success');
    }).finally(() => { verifyBtn.disabled = false; });
  }

  const deleteBtn = event.target.closest('[data-backup-delete]');
  if (deleteBtn) {
    const name = deleteBtn.dataset.backupDelete;
    const ok = await confirmDialog({
      title: `Delete ${name}?`,
      body: 'There is no undo, and this may be the only copy.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return undefined;
    return backupCall('delete', { name }, () => { toast(`${name} deleted.`, 'success'); loadBackups(); });
  }

  // --- quick access ---
  const qEdit = event.target.closest('[data-quick-edit]');
  if (qEdit) {
    quickFormMode((state.bookmarks || []).find((b) => b.id === qEdit.dataset.quickEdit));
    return undefined;
  }
  const qUp = event.target.closest('[data-quick-up]');
  if (qUp) return moveBookmark(qUp.dataset.quickUp, -1);
  const qDown = event.target.closest('[data-quick-down]');
  if (qDown) return moveBookmark(qDown.dataset.quickDown, 1);
  const qDel = event.target.closest('[data-quick-delete]');
  if (qDel) {
    const item = (state.bookmarks || []).find((b) => b.id === qDel.dataset.quickDelete);
    const ok = await confirmDialog({
      title: `Remove ${item ? item.name : 'this link'}?`,
      body: 'It disappears from Quick access. Nothing else is affected.',
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!ok) return undefined;
    return quickCall('/delete', { id: qDel.dataset.quickDelete }, 'Link removed.');
  }
  if (event.target.closest('#quick-cancel')) { quickFormMode(null); return undefined; }

  // --- launcher contents ---
  const lToggle = event.target.closest('[data-launcher-toggle]');
  if (lToggle) {
    const key = lToggle.dataset.launcherToggle;
    const prefs = state.launcherPrefs;
    prefs.hidden = prefs.hidden.includes(key) ? prefs.hidden.filter((k) => k !== key) : [...prefs.hidden, key];
    writeLauncherPrefs(prefs);
    return undefined;
  }
  const lRename = event.target.closest('[data-launcher-rename]');
  if (lRename) {
    const key = lRename.dataset.launcherRename;
    const over = state.launcherPrefs.overrides[key] || {};
    const row = lRename.closest('.editor-row');
    launcherFormMode({
      key,
      detected: true,
      name: over.name || row.querySelector('.editor-row-name').textContent,
      icon: over.icon || '',
    });
    return undefined;
  }
  const lEdit = event.target.closest('[data-launcher-edit]');
  if (lEdit) {
    const item = state.launcherPrefs.custom.find((c) => c.id === lEdit.dataset.launcherEdit);
    if (item) launcherFormMode({ ...item, key: item.id });
    return undefined;
  }
  const lDelete = event.target.closest('[data-launcher-delete]');
  if (lDelete) {
    const id = lDelete.dataset.launcherDelete;
    const prefs = state.launcherPrefs;
    prefs.custom = prefs.custom.filter((c) => c.id !== id);
    writeLauncherPrefs(prefs);
    toast('Link removed.', 'success');
    return undefined;
  }
  if (event.target.closest('#launcher-cancel')) { launcherFormMode(null); return undefined; }

  // --- app store contents ---
  if (event.target.closest('#catalog-add')) { catalogFormMode(null); return undefined; }
  if (event.target.closest('#catalog-cancel')) { $('#catalog-form').hidden = true; return undefined; }

  const cEdit = event.target.closest('[data-catalog-edit]');
  if (cEdit) {
    catalogFormMode(state.modules.find((m) => m.id === cEdit.dataset.catalogEdit));
    return undefined;
  }
  const cReset = event.target.closest('[data-catalog-reset]');
  if (cReset) {
    const id = cReset.dataset.catalogReset;
    const ok = await confirmDialog({
      title: `Reset ${id}?`,
      body: 'Your edits are discarded and the text goes back to what the module ships with.',
      confirmLabel: 'Reset',
    });
    if (!ok) return undefined;
    return catalogCall('override/reset', id, `${id} reset to its original text.`);
  }
  const cDelete = event.target.closest('[data-catalog-delete]');
  if (cDelete) {
    const id = cDelete.dataset.catalogDelete;
    const ok = await confirmDialog({
      title: `Delete ${id}?`,
      body: 'The module directory and its config folder are removed from the server. This cannot be undone.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return undefined;
    return catalogCall('app/delete', id, `${id} deleted.`);
  }

  if (event.target.closest('#action-restart-all')) return bulkAction('restart', 'Restart');
  if (event.target.closest('#action-update-all')) return bulkAction('update', 'Update');

  const stab = event.target.closest('[data-stab]');
  if (stab) return showSettingsTab(stab.dataset.stab);

  const themeBtn = event.target.closest('[data-theme-value]');
  if (themeBtn) return savePrefs({ theme: themeBtn.dataset.themeValue });

  const atmoBtn = event.target.closest('[data-atmo-value]');
  if (atmoBtn) return savePrefs({ atmo: atmoBtn.dataset.atmoValue });

  if (event.target.closest('#drawer-close') || event.target.closest('#drawer-backdrop')) closeDrawer();
});

$('#app-search').addEventListener('input', (e) => {
  state.appQuery = e.target.value;
  $('#store-search-clear').classList.toggle('hidden', !e.target.value);
  renderApps();
});
$('#store-search-clear').addEventListener('click', () => {
  state.appQuery = '';
  $('#app-search').value = '';
  $('#store-search-clear').classList.add('hidden');
  renderApps();
  $('#app-search').focus();
});
$('#store-sort-select').addEventListener('change', (e) => {
  state.appSort = e.target.value;
  renderApps();
});
$('#container-search').addEventListener('input', (e) => {
  state.containerQuery = e.target.value;
  renderContainers();
});
$('#backup-schedule-enabled').addEventListener('change', (e) => {
  $('#backup-schedule-config').hidden = !e.target.checked;
});
$('#backup-kind').addEventListener('change', () => renderBackups());

document.addEventListener('input', (event) => {
  const field = event.target.closest('.config-input');
  if (field) field.classList.toggle('changed', field.value !== field.dataset.original);
});

$('#launcher-add-form').addEventListener('submit', submitLauncherForm);
$('#catalog-form').addEventListener('submit', submitCatalogForm);
$('#quick-form').addEventListener('submit', submitQuickForm);
$('#password-form').addEventListener('submit', submitPasswordChange);
state.launcherPrefs = readLauncherPrefs();

['#live-enabled', '#live-transfers', '#live-queues', '#live-upcoming'].forEach((sel) => {
  $(sel).addEventListener('change', saveInsightPrefs);
});
$('#live-card').addEventListener('click', (event) => {
  // The timestamp is the refresh control: clicking it drops the server-side
  // caches and asks every app again, which is what someone wants when they
  // just started a download and the card still says nothing is moving.
  if (event.target.closest('#live-meta')) loadInsights({ force: true });
});

$('#reset-list').addEventListener('click', (event) => {
  const btn = event.target.closest('[data-reset]');
  if (!btn) return;
  const [moduleId, service] = btn.dataset.reset.split(':');
  resetAppLogin(moduleId, service, btn.closest('.reset-row').querySelector('strong').textContent);
});

$('#storage-kind').addEventListener('change', storageKindChanged);
$('#storage-check').addEventListener('click', probeStorage);
$('#storage-mountpoint').addEventListener('input', checkMountpointCollision);
$('#storage-form').addEventListener('submit', submitStorageForm);
$('#storage-list').addEventListener('click', (event) => {
  const btn = event.target.closest('[data-unmount]');
  if (btn) detachStorage(btn.dataset.unmount);
});
$('#storage-probe').addEventListener('click', (event) => {
  // Clicking an export fills the field, so nobody retypes a path they can see.
  const pick = event.target.closest('[data-export]');
  if (pick) $('#storage-share').value = pick.dataset.export;
});

$('#updates-check').addEventListener('click', () => runUpdateCheck());
$('#updates-all').addEventListener('click', () => applyUpdate('all'));
$('#updates-list').addEventListener('click', (event) => {
  const btn = event.target.closest('[data-update]');
  if (btn) applyUpdate(btn.dataset.update);
});
$('#updates-versions').addEventListener('click', (event) => {
  const btn = event.target.closest('[data-upgrade]');
  if (!btn) return;
  const row = (updatesState.newVersions || []).find((v) => v.container === btn.dataset.upgrade);
  if (row) upgradeVersion(row.container, row.tag, row.newerVersion);
});

$('#log-refresh').addEventListener('click', () => loadLogs());
$('#log-filter').addEventListener('input', () => renderLogs());
$('#log-follow').addEventListener('change', () => renderLogs());
$('#log-picker').addEventListener('change', () => loadLogs());
$('#log-tail').addEventListener('change', () => loadLogs());

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeDrawer();
  if (event.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)) {
    const box = currentPage() === 'containers' ? $('#container-search') : $('#app-search');
    if (currentPage() !== 'containers') location.hash = '#apps';
    event.preventDefault();
    box.focus();
  }
});

async function boot() {
  // The dashboard is hidden until the server answers. Doing it the other way
  // round flashes a full page of empty cards at someone who is not signed in.
  $('#login-form').addEventListener('submit', submitLogin);
  if (await checkAuth()) await init();
}

async function init() {
  try {
    applyPrefs(await (await fetch('api/prefs')).json());
  } catch {
    applyPrefs(state.prefs);
  }
  $('#store-sort-select').value = state.appSort;
  show(currentPage());
  await loadModules(true);
  fetch('api/activity?limit=25').then((r) => r.json()).then((d) => renderActivity(d.entries)).catch(() => {});
  // The nav dot, from the cached answer only. Boot must never wait on a
  // dozen registry round-trips, and it must never set them off either.
  refreshUpdateBadge();
  loadInsights();
  scheduleInsights();
  connect();
  setInterval(() => loadModules(true), 20000);
  // Every five minutes, from the cached answer only. The server does the
  // actual checking on its own schedule; this just notices that it did.
  setInterval(refreshUpdateBadge, 300000);
}

boot();
