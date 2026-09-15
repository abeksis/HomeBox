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
  busy: new Set(),
  // App cards whose setup notes are unfolded. The catalog is rebuilt on every
  // module refresh, which would otherwise fold them back under the reader.
  openNotes: new Set(),
  // Mirrors DEFAULT_PREFS in server.js. Only ever seen for the moment before
  // /api/prefs answers, but a mismatch here is a visible flash of the wrong
  // background on every load.
  prefs: { theme: 'dark', accent: 'orange' },
};

/* ------------------------------------------------------------- utilities */

function escapeHtml(text) {
  return String(text == null ? '' : text).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/* ------------------------------------------------------ notices and dialogs */

/**
 * A short notice in the corner. Errors stay longer than confirmations, and a
 * click dismisses any of them early.
 *
 * The message is set as text, never as markup — it is often a server error,
 * and those quote paths and compose output.
 */
function toast(msg, type = 'info', duration = 3500) {
  const stack = $('#toasts');
  if (!stack) return;
  const note = document.createElement('div');
  note.className = `toast is-${type}`;
  note.setAttribute('role', type === 'error' ? 'alert' : 'status');
  note.textContent = msg;
  stack.appendChild(note);

  let gone = false;
  const dismiss = () => {
    if (gone) return;
    gone = true;
    note.classList.add('is-leaving');
    setTimeout(() => note.remove(), 250);
  };
  note.addEventListener('click', dismiss);
  setTimeout(dismiss, Number.isFinite(duration) ? duration : 3500);
}

/**
 * Ask before doing something. Resolves true or false.
 *
 * Built here rather than with window.confirm, which freezes the page, cannot
 * hold a checkbox or a list, and looks like it belongs to a different program.
 */
function confirmDialog({
  title, body, bodyHtml, confirmLabel = 'OK', cancelLabel = 'Cancel', danger = false, wide = false,
}) {
  return new Promise((resolve) => {
    const layer = document.createElement('div');
    layer.className = 'dialog-layer';
    const box = document.createElement('div');
    box.className = `dialog${wide ? ' is-wide' : ''}`;
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');

    const heading = document.createElement('h3');
    heading.className = 'dialog-title';
    heading.textContent = title;
    const content = document.createElement('div');
    content.className = 'dialog-body';
    // `body` is text and assigned as text. `bodyHtml` is markup built in this
    // file, from values that have already been through escapeHtml.
    if (bodyHtml) {
      content.innerHTML = bodyHtml;
      content.classList.add('is-markup');
    } else {
      content.textContent = body;
    }

    const row = document.createElement('div');
    row.className = 'dialog-actions';
    const no = document.createElement('button');
    no.type = 'button';
    no.className = 'button';
    no.textContent = cancelLabel;
    const yes = document.createElement('button');
    yes.type = 'button';
    yes.className = `button ${danger ? 'is-danger-solid' : 'is-primary'}`;
    yes.textContent = confirmLabel;
    row.append(no, yes);

    box.append(heading, content, row);
    layer.appendChild(box);
    document.body.appendChild(layer);

    const finish = (answer) => {
      document.removeEventListener('keydown', onKey);
      layer.remove();
      resolve(answer);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') finish(false);
    };
    yes.addEventListener('click', () => finish(true));
    no.addEventListener('click', () => finish(false));
    layer.addEventListener('mousedown', (e) => {
      if (e.target === layer) finish(false);
    });
    document.addEventListener('keydown', onKey);
    yes.focus();
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

/**
 * The artwork for an app, wherever one is drawn: its image, its emoji, or the
 * monogram passed in. The container it sits in decides the size, so the markup
 * is the same everywhere — `.art-img`, `.art-emoji`, `.art-mono`.
 */
function iconArt(icon, mono) {
  const src = iconSrc(icon);
  if (src) {
    return `<img class="art-img" src="${escapeHtml(src)}" alt="" loading="lazy"
      onerror="this.outerHTML=${escapeHtml(JSON.stringify(mono)).replace(/"/g, '&quot;')}">`;
  }
  if (icon) return `<span class="art-emoji">${escapeHtml(String(icon))}</span>`;
  return mono;
}

/** Two letters for an app with no artwork of its own. */
function initialsOf(label) {
  return String(label || '?').replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || '?';
}

/** A monogram, optionally tinted in the app's own colour. */
function monogram(label, color) {
  const style = color ? ` style="color:${escapeHtml(color)};background:${escapeHtml(tint(color))}"` : '';
  return `<span class="art-mono"${style}>${escapeHtml(initialsOf(label))}</span>`;
}

/**
 * The small icon at the start of a Settings list row. Same resolver as the rest
 * of the page, so an uploaded URL, a shipped file and an emoji all show.
 */
function editorIcon(icon, label) {
  return `<span class="list-art">${iconArt(icon, monogram(label))}</span>`;
}

function iconHtml(icon, label, theme) {
  return iconArt(icon, monogram(label, theme && theme.color));
}

const STATUS_LABEL = {
  available: 'not installed',
  running: 'running',
  partial: 'partly up',
  stopped: 'stopped',
  unhealthy: 'unhealthy',
};

/* --------------------------------------------------------------- routing */

const PAGES = ['home', 'apps', 'logs', 'updates', 'settings'];

function show(page) {
  const target = PAGES.includes(page) ? page : 'home';
  $$('.screen').forEach((el) => el.classList.toggle('is-shown', el.id === `screen-${target}`));
  $$('.nav-item').forEach((el) => {
    const active = el.dataset.page === target;
    el.classList.toggle('is-current', active);
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
  const h = new Date().getHours();
  if (h < 5) return 'Good night';
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

/** Processor, memory and disk at the foot of the sidebar: a number and a thin bar each. */
function renderSideMeters(summary) {
  const { metrics } = summary;
  const set = (id, pct) => {
    const el = $(id);
    $('b', el).textContent = pct == null ? '--' : `${pct}%`;
    $('em', el).style.width = `${pct == null ? 0 : Math.max(0, Math.min(100, pct))}%`;
    const lv = level(pct);
    if (lv) el.dataset.level = lv;
    else delete el.dataset.level;
  };
  set('#side-cpu', metrics.cpu);
  set('#side-ram', metrics.memory.percent);
  set('#side-disk', metrics.disk.percent);
  $('#side-version').textContent = `v${summary.version}`;
}

/**
 * The "This box" facts on the Overview. No bars: the sidebar already draws
 * processor, memory and disk as percentages, so these give the absolute
 * figures behind them instead, coloured when the percentage runs high.
 */
function renderBoxFacts(m) {
  const mark = (id, pct) => {
    const lv = level(pct);
    if (lv) $(id).dataset.level = lv;
    else delete $(id).dataset.level;
  };
  $('#val-uptime').textContent = duration(m.uptime);
  $('#sub-uptime').textContent = 'since the last boot';
  $('#val-load').textContent = m.load[0].toFixed(2);
  $('#sub-load').textContent = `${m.cores} cores`;
  $('#val-ram').textContent = bytes(m.memory.used);
  $('#sub-ram').textContent = `of ${bytes(m.memory.total)}`;
  $('#val-disk').textContent = m.disk.total ? bytes(m.disk.free) : '--';
  $('#sub-disk').textContent = m.disk.total ? `of ${bytes(m.disk.total)}` : '';
  mark('#fact-ram', m.memory.percent);
  mark('#fact-disk', m.disk.percent);
}

function renderHealth(summary) {
  const banner = $('#health');
  const { health } = summary;
  banner.dataset.level = health.level;
  $('#health-mark').textContent = health.level === 'good' ? '✓' : health.level === 'warn' ? '!' : '×';
  $('#health-title').textContent = health.title;
  $('#health-text').textContent = health.sub;

  const action = $('#health-action');
  if (health.names && health.names.length) {
    action.innerHTML = `<button type="button" class="button is-primary is-small" data-log-for="${escapeHtml(health.names[0])}">Read ${escapeHtml(health.names[0])} logs</button>`;
  } else if (summary.counts.installed === 0) {
    action.innerHTML = '<a class="button is-primary is-small" href="#apps" data-page="apps">Choose apps</a>';
  } else {
    action.innerHTML = '';
  }

  $('#welcome-title').textContent = greetingText();
  $('#welcome-text').textContent = health.level === 'good'
    ? `${summary.counts.installed} of ${summary.counts.modules} apps installed, ${summary.counts.running} containers up.`
    : health.sub;
}

function renderLauncher(modules) {
  const prefs = state.launcherPrefs;
  const hidden = new Set(prefs.hidden);
  const tiles = [];
  for (const mod of modules) {
    if (!mod.installed) continue;
    const open = mod.services.filter((svc) => !svc.internal && svc.url);
    for (const svc of open) {
      const key = tileKey(mod.id, svc.name);
      if (hidden.has(key)) continue;
      const over = prefs.overrides[key] || {};
      tiles.push({
        ...svc, module: mod, friendly_name: over.name || svc.friendly_name, customIcon: over.icon || null,
        // An app with one page is charged for everything it runs — Immich is
        // its server, its ML worker and its database, not just the web half.
        // With several pages each shows only its own container, or the same
        // database would be counted once per tile. `svc.container` is only a
        // name and a state, so the figures come from the module's full list.
        load: appLoad(open.length === 1 ? mod.containers
          : mod.containers.filter((c) => svc.container && c.name === svc.container.name)),
      });
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
  $('#dock-count').textContent = tiles.length ? `${tiles.length}` : '';

  if (!tiles.length) {
    $('#dock').innerHTML = '<p class="empty">No apps yet. '
      + '<a href="#apps" data-page="apps">Open the catalog</a> to add some.</p>';
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

  // Bars are measured against the hungriest app on the box, not against total
  // memory: next to 12GB nearly every app is a sliver and the board says nothing.
  const peak = Math.max(1, ...tiles.map((t) => (t.load && t.load.memory) || 0));
  const byMemory = (a, b) => ((b.load && b.load.memory) || 0) - ((a.load && a.load.memory) || 0);

  $('#dock').innerHTML = sorted.map(([category, items]) => `
    <div class="dock-group">
      <div class="dock-label">${escapeHtml(label[category] || category)}<span>${items.length}</span></div>
      <div class="dock-grid">${items.sort(byMemory).map((t) => launchTile(t, peak)).join('')}</div>
    </div>`).join('');
}

/** Memory and CPU summed over a set of containers; nulls when none reported. */
function appLoad(containers) {
  const live = (containers || []).filter((c) => c && c.memory != null);
  if (!live.length) return null;
  return {
    memory: live.reduce((sum, c) => sum + c.memory, 0),
    cpu: live.some((c) => c.cpu != null) ? live.reduce((sum, c) => sum + (c.cpu || 0), 0) : null,
  };
}

/** One app on the Overview: icon, name, state, and how much it is using. */
function launchTile(tile, peak) {
  const st = tile.container ? tile.container.state : null;
  const down = st === 'stopped' || st === 'unhealthy';
  const color = tile.color || (tile.module.theme && tile.module.theme.color) || null;
  const pip = st ? `<span class="dot ${down ? 'is-off' : 'is-on'}" data-state="${escapeHtml(st)}" title="${escapeHtml(st)}"></span>` : '';
  const load = tile.load;
  let usage;
  if (!tile.container) {
    usage = '<div class="dock-usage"><span>Link</span></div>';
  } else if (down) {
    usage = `<div class="dock-usage"><span>${st === 'stopped' ? 'Stopped' : 'Unhealthy'}</span><b>--</b></div><div class="dock-bar"></div>`;
  } else {
    const pct = load ? Math.max(2, Math.round((load.memory / peak) * 100)) : 0;
    usage = `<div class="dock-usage"><span>Memory${load && load.cpu != null ? ` · CPU ${load.cpu}%` : ''}</span><b>${load ? bytes(load.memory) : '--'}</b></div>
      <div class="dock-bar"><i style="width:${pct}%"></i></div>`;
  }

  // A per-browser override wins, then the service's own icon, then the
  // module's emoji — a user-added module has no icon file to point at, so the
  // emoji is all it has.
  const art = iconArt(
    tile.customIcon || tile.icon || (tile.module.theme && tile.module.theme.emoji),
    monogram(tile.friendly_name, color),
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

  // The link covers the name and figures; the buttons sit outside it, since a
  // button inside an <a> is invalid and its click would also open the app.
  return `<div class="dock-tile${down ? ' is-down' : ''}">
      <a class="dock-open" href="${escapeHtml(tile.url)}" target="_blank" rel="noopener noreferrer"${first}
        title="${escapeHtml(tile.description || tile.friendly_name)}">
        <span class="dock-head">
          <span class="dock-art">${art}</span>
          <span class="dock-name">${escapeHtml(tile.friendly_name)}</span>
          ${pip}
        </span>
        ${usage}
      </a>
      ${tile.container ? `<div class="dock-actions">${containerActions(tile.container, st !== 'stopped')}</div>` : ''}
    </div>`;
}

/* ------------------------------------------------- network & maintenance */

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
    return `<button type="button" class="button is-small is-primary" data-container="${id}" data-caction="start">Start</button>`;
  }
  // A plain stop, not Docker's pause: pause freezes a process that still holds
  // its ports, which is not what anyone wants from this button.
  return `<button type="button" class="button is-small" data-log-for="${id}">Logs</button>
    <button type="button" class="button is-small" data-container="${id}" data-caction="restart">Restart</button>
    <button type="button" class="button is-small" data-container="${id}" data-caction="stop"
      title="Its data stays; start it again any time">Stop</button>`;
}

/** Logs / Restart / Stop / Start on one container, from the Overview list. */
async function runContainerAction(name, action) {
  if (action === 'stop') {
    const ok = await confirmDialog({
      title: `Stop ${name}?`,
      body: 'The container stops. Nothing is deleted, and Start runs it again.',
      confirmLabel: 'Stop',
    });
    if (!ok) return;
  }
  const buttons = $$(`[data-container="${CSS.escape(name)}"]`);
  buttons.forEach((b) => { b.disabled = true; });
  const done = { restart: 'restarted', stop: 'stopped', start: 'started' }[action] || action;
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
  $('#net-address').textContent = summary.host.address;
  $('#net-facts').innerHTML = [
    ['Hostname', summary.host.name],
    ['Dashboard', n.dashboard],
    ['Proxy', n.proxy],
    ['Docker networks', n.networks],
  ].map(([label, value]) => factHtml(label, value == null ? '—' : value)).join('');
}

/** A label over a value, in the Addresses grids. */
function factHtml(label, value) {
  return `<div class="fact">
      <div class="fact-key">${escapeHtml(label)}</div>
      <div class="fact-val mono">${escapeHtml(value)}</div>
    </div>`;
}

function renderBackupCard(summary) {
  const b = summary.backups || {};
  $('#safety-count').textContent = b.count ? `${b.count}` : '';
  $('#safety-facts').innerHTML = `
    ${statRow('Archives', b.count || 'none', b.count ? 'good' : 'warn')}
    ${statRow('Latest', b.latest ? `${ago(b.latest.created)} ago` : 'never', b.latest ? 'good' : 'warn')}
    ${statRow('On a schedule', b.scheduled ? 'yes' : 'no', b.scheduled ? 'good' : '')}
    ${statRow('Apps with settings', b.appConfigs)}
    ${statRow('Free disk', bytes(b.diskFree))}
    <p class="small-note">Archives are encrypted and kept on this disk. Make one under
      Settings &rarr; Backups; keeping a copy on another machine is up to you.</p>`;
}

function renderActivity(entries) {
  const list = $('#feed-list');
  if (!entries.length) {
    list.innerHTML = '<li class="empty">No events yet. Installs and container starts and stops appear here.</li>';
    return;
  }
  list.innerHTML = entries.map((e) => `
    <li class="feed-item" data-level="${escapeHtml(e.level)}">
      <span class="feed-mark" data-action="${escapeHtml(e.action)}"></span>
      <span class="feed-who">${escapeHtml(e.name)}</span>
      <span class="feed-what">${escapeHtml(actionText(e))}</span>
      <span class="feed-when">${escapeHtml(ago(e.time))}</span>
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

// Line glyphs for the category tiles, drawn on a 24-unit grid. A category the
// list does not know gets the generic box rather than nothing.
const CATEGORY_GLYPHS = {
  all: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/>',
  core: '<path d="M12 3 20 7.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5 12 12l8-4.5M12 12v9"/>',
  media: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="m10 9 5 3-5 3z"/>',
  photos: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><circle cx="9" cy="10" r="1.8"/><path d="m21 16-5-5-9 8"/>',
  files: '<path d="M3.5 7a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>',
  security: '<path d="M12 3 19 6v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z"/><path d="m9 12 2 2 4-4"/>',
  network: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.5 3.5 5.5 3.5 8.5s-1 6-3.5 8.5c-2.5-2.5-3.5-5.5-3.5-8.5s1-6 3.5-8.5z"/>',
  productivity: '<rect x="4" y="4" width="16" height="17" rx="2"/><path d="M8 3v3M16 3v3M4 9h16M8 13h3M8 17h6"/>',
  system: '<rect x="3.5" y="4" width="17" height="12" rx="2"/><path d="M8 20h8M12 16v4M7 12l3-3 2 2 4-4"/>',
  other: '<circle cx="6" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="18" cy="12" r="1.6"/>',
};

function renderCategories() {
  const used = new Set(state.modules.map((m) => m.category));
  const tiles = [{ id: 'all', label: 'All' }, ...state.categories.filter((c) => used.has(c.id))];
  $('#category-chips').innerHTML = tiles.map((c) => {
    const mods = c.id === 'all' ? state.modules : state.modules.filter((m) => m.category === c.id);
    const installed = mods.filter((m) => m.installed).length;
    const on = state.category === c.id;
    return `<button type="button" class="category-tile${on ? ' is-on' : ''}" data-category="${escapeHtml(c.id)}" aria-pressed="${on}">
      <svg viewBox="0 0 24 24" aria-hidden="true">${CATEGORY_GLYPHS[c.id] || CATEGORY_GLYPHS.core}</svg>
      <span class="category-tile-name">${escapeHtml(c.label)}</span>
      <span class="category-tile-count">${mods.length} app${mods.length === 1 ? '' : 's'}${installed ? ` · <b>${installed} on</b>` : ''}</span>
    </button>`;
  }).join('');
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

  $('#store-summary').textContent =
    `${installed.length} of ${state.modules.length} installed · together they ask for about ${bytes(estimate)}`;
  renderMemoryPlan(installed, estimate, total, percent);
}

/**
 * The memory plan: 100 squares, one per percent of the box's memory, filled
 * in the colour of the app that asks for it, largest first. A bar says how
 * full; this also says who. Anything past 100% is reported in the text, since
 * a square cannot be more than full.
 */
function renderMemoryPlan(installed, estimate, total, percent) {
  const grid = $('#memory-grid');
  if (!grid) return;
  const apps = installed
    .map((m) => ({ title: m.title, ram: parseRam(m.ram), color: (m.theme && m.theme.color) || null }))
    .filter((a) => a.ram > 0)
    .sort((a, b) => b.ram - a.ram);

  const cells = [];
  if (total) {
    let used = 0;
    for (const app of apps) {
      // At least one square per app that asks for anything, so a small app
      // is still visible; the rounding is corrected by the running total.
      const want = Math.max(1, Math.round(((used + app.ram) / total) * 100) - cells.length);
      for (let i = 0; i < want && cells.length < 100; i += 1) cells.push(app);
      used += app.ram;
    }
  }
  const plan = $('#memory-plan');
  const lv = level(percent);
  if (lv) plan.dataset.level = lv;
  else delete plan.dataset.level;

  grid.innerHTML = Array.from({ length: 100 }, (_, i) => {
    const app = cells[i];
    if (!app) return '<i></i>';
    const style = app.color ? ` style="background:${escapeHtml(app.color)}"` : '';
    return `<i class="is-used"${style} title="${escapeHtml(app.title)} · ${escapeHtml(bytes(app.ram))}"></i>`;
  }).join('');

  $('#memory-figure').textContent = total ? `${percent}%` : bytes(estimate);
  $('#memory-sub').textContent = total
    ? `${bytes(estimate)} of ${bytes(total)}${estimate > total ? ' — more than the box has' : ''}`
    : 'The box has not reported its memory yet';
  $('#memory-legend').innerHTML = apps.slice(0, 4).map((a) => `
    <li><span class="swatch"${a.color ? ` style="background:${escapeHtml(a.color)}"` : ''}></span>${escapeHtml(a.title)}<b>${escapeHtml(bytes(a.ram))}</b></li>`).join('')
    + (apps.length > 4 ? `<li class="is-more">and ${apps.length - 4} more</li>` : '');
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
    return '<span class="module-toggle is-busy" aria-live="polite"><span class="spinner"></span>working</span>';
  }
  if (mod.required) {
    return '<span class="module-toggle is-locked" title="The rest of HomeBox depends on it">Base system</span>';
  }
  // Chosen but not applied yet. Clicking again takes the choice back.
  if (state.pending.has(mod.id)) {
    const install = state.pending.get(mod.id);
    return `<button type="button" class="module-toggle ${install ? 'is-queued-add' : 'is-queued-remove'}"
      data-queue="${id}" title="Not applied yet — click to take it back">${install ? 'Will install' : 'Will remove'}</button>`;
  }
  if (!mod.installed) {
    return `<button type="button" class="module-toggle" data-queue="${id}">Add</button>`;
  }
  // Shows "Installed"; on hover or focus it offers removal instead.
  return `<button type="button" class="module-toggle is-installed" data-queue="${id}"
    title="Click to choose removal. Settings and data are kept unless you say otherwise."><span class="when-idle">Installed</span><span class="when-hover">Remove</span></button>`;
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
 * What a module actually runs, listed on its card.
 *
 * A module is often several containers — the media stack is six, on six
 * ports — and the card should say so. A running service with a web page is a
 * link; one that is not running shows its port instead.
 */
function renderIncludedServices(m) {
  if (!m.services || !m.services.length) return '';
  const rows = m.services.map((svc) => {
    // A container with a healthcheck reports 'healthy' rather than 'running',
    // so "up" means anything but stopped or unhealthy.
    const st = svc.container && svc.container.state;
    const live = !!st && st !== 'stopped' && st !== 'unhealthy';
    const end = m.installed && svc.url && live
      ? `<a href="${escapeHtml(svc.url)}" target="_blank" rel="noopener noreferrer" class="module-app-open"
           title="Open ${escapeHtml(svc.friendly_name)}">open</a>`
      : (svc.port ? `<span class="module-app-port mono">:${escapeHtml(String(svc.port))}</span>` : '');
    const art = iconArt(svc.icon || (m.theme && m.theme.emoji), monogram(svc.friendly_name));
    return `<li class="module-app"${svc.description ? ` title="${escapeHtml(svc.description)}"` : ''}>
      <span class="module-app-art">${art}</span>
      <span class="module-app-name">${escapeHtml(svc.friendly_name)}</span>
      ${m.installed ? `<span class="dot ${live ? 'is-on' : 'is-off'}"></span>` : ''}${end}
    </li>`;
  }).join('');
  return `<ul class="module-apps" aria-label="Runs">${rows}</ul>`;
}

/** The setup notes a module declares in `tips:`, folded until asked for. */
function renderTips(m) {
  if (!m.tips || !m.tips.length) return '';
  const count = m.tips.length === 1 ? '1 setup note' : `${m.tips.length} setup notes`;
  return `<details class="module-notes" data-notes="${escapeHtml(m.id)}"${state.openNotes.has(m.id) ? ' open' : ''}>
    <summary>${count}</summary>
    <ul>${m.tips.map((t) => `<li>${escapeHtml(t)}</li>`).join('')}</ul>
  </details>`;
}

function renderApps() {
  const query = state.appQuery.trim().toLowerCase();
  const list = state.modules
    .filter((m) => state.category === 'all' || m.category === state.category)
    .filter((m) => matchesQuery(m, query))
    .sort(SORTS[state.appSort] || SORTS.name);

  $('#catalog-grid').innerHTML = list.map((m) => {
    const art = iconArt(m.icon || (m.theme && m.theme.emoji), monogram(m.title, m.theme && m.theme.color));
    const queued = state.pending.has(m.id)
      ? (state.pending.get(m.id) ? ' is-queued-add' : ' is-queued-remove') : '';
    // Two columns: a rail with everything you glance at (icon, state, memory,
    // category, the button), and the reading on the right.
    return `<article class="module-card${m.installed ? ' is-installed' : ''}${queued}">
      <div class="module-rail">
        <span class="module-art" data-module="${escapeHtml(m.id)}" role="button" tabindex="0"
              title="Details for ${escapeHtml(m.title)}">${art}</span>
        ${m.installed
          ? `<span class="module-state" data-status="${escapeHtml(m.status)}"><span class="dot ${m.status === 'running' ? 'is-on' : 'is-off'}"></span>${escapeHtml(cardStatusLabel(m))}</span>`
          : '<span class="module-state is-idle">Not installed</span>'}
        ${m.ram ? `<span class="module-fact"><span>Memory</span>${escapeHtml(m.ram)}</span>` : ''}
        <span class="badge">${escapeHtml(m.category)}</span>
        ${m.required ? '<span class="badge badge-core">base system</span>' : ''}
        ${appActionButton(m)}
      </div>
      <div class="module-body">
        <h3 class="module-title" data-module="${escapeHtml(m.id)}" role="button" tabindex="0">${escapeHtml(m.title)}</h3>
        ${m.tagline ? `<p class="module-tagline">${escapeHtml(m.tagline)}</p>` : ''}
        <p class="module-text">${escapeHtml(m.description)}</p>
        ${renderIncludedServices(m)}
        ${renderTips(m)}
      </div>
    </article>`;
  }).join('') || '<p class="empty">No app matches that.</p>';

  renderStoreStats();

  const block = $('#orphans');
  if (state.unclaimed.length) {
    block.hidden = false;
    $('#orphans-count').textContent = `${state.unclaimed.length}`;
    $('#orphan-list').innerHTML = state.unclaimed.map((c) => `<span class="orphan mono">${escapeHtml(c.name)}</span>`).join('');
  } else {
    block.hidden = true;
  }
}


/* ------------------------------------------------------------- logs page */

// Split and rejoin on a real newline without an escape sequence in the
// source, so the character survives every tool that rewrites this file.
const NL = String.fromCharCode(10);
let logText = '';
let logTz = null;

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
    logTz = data.timezone || null;
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
/**
 * One row per physical line — the only way that leaves every log's own shape
 * alone.
 *
 * 0.4.12 folded lines that did not look like the start of an entry into the
 * entry above. It fixed Uptime Kuma's multi-line ping reports and destroyed
 * everything drawn in lines: the linuxserver.io banner every LSIO image prints
 * on boot is ASCII art, none of its lines look like an entry, and it was
 * smeared into one row of box-drawing characters glued to
 * "[migrations] no migrations found". A picture is only a picture as lines.
 *
 * What makes a multi-line message readable instead is the Docker timestamp,
 * now requested on every line: a fragment of a ping report gets the same
 * prefix as a real entry, so it reads as a row, not as debris. It is drawn
 * dimmed, because the app usually prints a timestamp of its own and two at
 * full strength are noise.
 */
const DOCKER_TS = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z) /;

/**
 * Docker's timestamp is UTC, always — the API has no other mode, and a
 * container's TZ does not touch it. Left as-is it sits beside the app's own
 * "+03:00" stamp three hours apart, which reads as two clocks disagreeing.
 *
 * Converted here, in the box's timezone — the one HomeBox runs with, sent
 * alongside the logs — not the browser's: a phone abroad should still show
 * the same wall-clock time the apps printed. The exact UTC instant stays on
 * the element as a tooltip.
 *
 * One formatter per zone, built once. An unknown zone makes Intl throw a
 * RangeError, and a missing one means the logs arrived without it; both fall
 * back to the raw stamp rather than silently showing some other zone.
 */
const LOG_TS_FORMATS = new Map();

function logTimeFormat(zone) {
  if (!zone) return null;
  if (LOG_TS_FORMATS.has(zone)) return LOG_TS_FORMATS.get(zone);
  let fmt = null;
  try {
    fmt = new Intl.DateTimeFormat('sv-SE', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
  } catch {
    fmt = null;
  }
  LOG_TS_FORMATS.set(zone, fmt);
  return fmt;
}

function logTimestamp(utc) {
  const fmt = logTimeFormat(logTz);
  const when = new Date(utc);
  if (!fmt || Number.isNaN(when.getTime())) return utc;
  return fmt.format(when);
}

/** The line as the reader sees it — what a filter must match against. */
function logDisplayText(line) {
  const m = DOCKER_TS.exec(line);
  return m ? `${logTimestamp(m[1])} ${line.slice(m[0].length)}` : line;
}

function logLineHtml(line, needle) {
  const m = DOCKER_TS.exec(line);
  const ts = m
    ? `<span class="ln-time" title="${escapeHtml(m[1])}">${escapeHtml(logTimestamp(m[1]))}</span> `
    : '';
  const body = m ? line.slice(m[0].length) : line;
  return `<span class="ln">${ts}${needle ? highlight(body, needle) : escapeHtml(body)}</span>`;
}

function renderLogs() {
  const view = $('#log-view');
  const filter = $('#log-search').value.trim();
  const lines = String(logText).split(NL).filter((l) => l.length);

  if (!filter) {
    view.innerHTML = lines.map((l) => logLineHtml(l, '')).join('');
  } else {
    const needle = filter.toLowerCase();
    const hits = lines.filter((l) => logDisplayText(l).toLowerCase().includes(needle));
    view.innerHTML = hits.length
      ? hits.map((l) => logLineHtml(l, filter)).join('')
      : `<span class="ln is-dim">No line contains ${escapeHtml(filter)}.</span>`;
  }
  if ($('#log-stick').checked) view.parentElement.scrollTop = view.parentElement.scrollHeight;
}

function highlight(line, needle) {
  const at = line.toLowerCase().indexOf(needle.toLowerCase());
  if (at === -1) return escapeHtml(line);
  return escapeHtml(line.slice(0, at))
    + `<mark>${escapeHtml(line.slice(at, at + needle.length))}</mark>`
    + escapeHtml(line.slice(at + needle.length));
}

/**
 * Two names for the same container, and both are worth showing.
 *
 * "npm" is what Docker calls it and what every log line is tagged with;
 * "Nginx Proxy Manager" is what a person calls it. A picker that shows only
 * the first makes you translate, and one that shows only the second makes the
 * log lines look like they belong to something else. So: the friendly name,
 * with the container name after it when the two are genuinely different.
 *
 * "Radarr" and "radarr" are not different — comparing them loosely is what
 * keeps this from printing "Radarr (radarr)" on half the list.
 */
function logPickerEntry(c) {
  const mod = c.project ? state.modules.find((m) => `homebox-${m.id}` === c.project) : null;
  const svc = mod && mod.services ? mod.services.find((x) => x.name === c.service) : null;

  // ONLY the emoji, never the icon file: this is an <option>, and a browser
  // renders exactly one thing inside it — text. An <img> would silently
  // vanish and leave a blank column.
  const emoji = (mod && mod.theme && mod.theme.emoji) || '';
  const friendly = (svc && svc.friendly_name) || c.name;

  // "npm" is what Docker calls it and what every log line is tagged with;
  // "Nginx Proxy Manager" is what a person calls it. Showing only the first
  // makes you translate; only the second makes the log lines look like they
  // belong to something else. So both — but "Radarr" and "radarr" are not
  // two names, and comparing them loosely is what keeps this from printing
  // "Radarr (radarr)" down half the list.
  const loose = (v) => String(v).toLowerCase().replace(/[^a-z0-9]/g, '');
  const alias = loose(friendly) === loose(c.name) ? '' : ` (${c.name})`;

  return {
    // Sorted on the NAME, not on the rendered label. Sorting the label puts
    // the emoji first, and emoji sort by codepoint — which groups the list
    // by picture and scatters the alphabet, so somebody hunting for "Radarr"
    // has to read every line.
    sortKey: `${friendly} ${c.name}`.toLowerCase(),
    label: `${emoji ? `${emoji} ` : ''}${friendly}${alias}${c.state === 'stopped' ? ' — stopped' : ''}`,
  };
}

function renderLogPicker() {
  const picker = $('#log-picker');
  const selected = picker.value;
  picker.innerHTML = '<option value="">Choose a container…</option>' + state.containers
    .map((c) => ({ name: c.name, ...logPickerEntry(c) }))
    .sort((a, b) => a.sortKey.localeCompare(b.sortKey))
    .map((e) => `<option value="${escapeHtml(e.name)}">${escapeHtml(e.label)}</option>`)
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
    return '<span class="button is-busy" aria-live="polite"><span class="spinner"></span>working…</span>';
  }
  const out = [];
  if (!mod.installed) {
    out.push(`<button type="button" class="button is-primary" data-action="install" data-id="${escapeHtml(mod.id)}">Install</button>`);
    return out.join('');
  }
  if (mod.status === 'stopped') {
    out.push(`<button type="button" class="button is-primary" data-action="start" data-id="${escapeHtml(mod.id)}">Start</button>`);
  } else {
    out.push(`<button type="button" class="button" data-action="restart" data-id="${escapeHtml(mod.id)}">Restart</button>`);
    if (!mod.required) {
      out.push(`<button type="button" class="button" data-action="stop" data-id="${escapeHtml(mod.id)}">Stop</button>`);
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

  const button = $(action === 'restart' ? '#restart-all' : '#update-all');
  const labelEl = button ? $('.shortcut-text', button) : null;
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
  const link = $('#open-portainer');
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
    <fieldset class="env-group${group.dangerous ? ' is-sensitive' : ''}">
      <legend class="env-group-title">
        ${escapeHtml(group.title)}
        ${group.dangerous ? '<span class="env-group-warn">holds security keys</span>' : ''}
      </legend>
      ${group.description ? `<p class="env-group-desc">${escapeHtml(group.description)}</p>` : ''}
      ${group.keys.map(configRow).join('')}
    </fieldset>`).join('');
}

function configRow(k) {
  const id = `cfg-${k.key}`;
  const input = `<input class="input" id="${escapeHtml(id)}" data-config-key="${escapeHtml(k.key)}"
    type="${k.secret ? 'password' : 'text'}"
    value="${escapeHtml(k.value || '')}"
    data-original="${escapeHtml(k.value || '')}"
    placeholder="${escapeHtml(k.placeholder || '')}"
    ${k.readonly ? 'disabled' : ''} autocomplete="off" spellcheck="false">`;

  return `<div class="env-row">
    <label class="env-label" for="${escapeHtml(id)}">
      ${escapeHtml(k.label || k.key)}
      <span class="env-key mono">${escapeHtml(k.key)}</span>
    </label>
    ${k.secret
      ? `<span class="env-secret">${input}<button type="button" class="button is-small" data-config-show="${escapeHtml(id)}">Show</button></span>`
      : input}
    ${k.hint ? `<p class="env-hint">${escapeHtml(k.hint)}</p>` : ''}
  </div>`;
}

async function saveConfig() {
  const changes = {};
  for (const input of $$('#config-groups [data-config-key]')) {
    if (input.disabled) continue;
    if (input.value !== input.dataset.original) changes[input.dataset.configKey] = input.value;
  }
  const status = $('#config-save-status');
  const keys = Object.keys(changes);
  if (!keys.length) {
    toast('Nothing has changed.', 'info');
    status.textContent = 'Nothing has changed.';
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

  const button = $('#config-save');
  button.disabled = true;
  button.classList.add('is-busy');
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
    button.classList.remove('is-busy');
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
  if (!b || !$('#archive-list')) return;

  $('#backup-summary').textContent = b.count
    ? `${b.count} archive${b.count === 1 ? '' : 's'} · ${bytes(b.totalSize)}`
    : 'none yet';

  // Without a key nothing can be written, so say so where the button is
  // rather than failing when it is pressed.
  const noKey = $('#backup-no-key');
  noKey.hidden = b.hasKey;
  if (!b.hasKey) {
    noKey.innerHTML = '<strong>No encryption key.</strong>'
      + '<p class="help">An archive contains <code class="mono">.env</code>, so HomeBox will not write one unencrypted. '
      + 'Add <code class="mono">HB_BACKUP_KEY</code> to <code class="mono">/opt/homebox/.env</code> (or re-run <code class="mono">install.sh</code>) and restart the dashboard.</p>';
  }
  $('#backup-now').disabled = !b.hasKey || b.running;
  $('#key-reveal').disabled = !b.hasKey;
  $('#backup-same-disk').hidden = !b.sameDisk;

  $('#backup-latest').textContent = b.latest
    ? `Newest: ${b.latest.name} — ${bytes(b.latest.size)}, ${ago(b.latest.created)} ago.`
    : 'Nothing has been backed up yet.';
  $('#backup-kind-note').textContent = $('#backup-kind').value === 'full'
    ? 'Everything, including the data pool. Can be very large.'
    : 'Module config, state and .env. Small and quick.';

  $('#archive-list').innerHTML = b.backups.map((item) => `
    <div class="archive">
      <span class="archive-main">
        <span class="archive-name">${escapeHtml(item.name)}<span class="lock-tag">encrypted</span></span>
        <span class="archive-meta">${bytes(item.size)} · ${escapeHtml(item.kind)} · ${escapeHtml(new Date(item.created).toLocaleString())}</span>
      </span>
      <span class="archive-actions">
        <a class="button is-small" href="api/backup/download/${encodeURIComponent(item.name)}">Download</a>
        <button type="button" class="button is-small" data-backup-verify="${escapeHtml(item.name)}">Verify</button>
        <button type="button" class="button is-small is-danger" data-backup-delete="${escapeHtml(item.name)}">Delete</button>
      </span>
    </div>`).join('') || '<p class="empty">No archives yet.</p>';

  // --- schedule ---
  const sch = b.schedule;
  $('#schedule-on').checked = sch.enabled;
  $('#schedule-options').hidden = !sch.enabled;
  $('#schedule-keep').value = sch.retention;
  const preset = $('#schedule-every');
  preset.innerHTML = Object.entries(sch.presets)
    .map(([id, p]) => `<option value="${escapeHtml(id)}"${id === sch.preset ? ' selected' : ''}>${escapeHtml(p.label)}</option>`)
    .join('');
  $('#schedule-state').textContent = sch.enabled
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
  const button = $('#backup-now');
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
  $('#gate').hidden = false;
  $('#frame').hidden = true;

  $('#gate-title').textContent = first ? 'Claim this HomeBox' : 'HomeBox';
  $('#gate-text').textContent = first
    ? `Paste the bootstrap token the installer printed, then pick a password (${authState.minPassword}+ characters).`
    : 'Sign in to manage this server.';
  $('#gate-token-field').hidden = !first;
  $('#gate-confirm-field').hidden = !first;
  $('#gate-hint').hidden = !first;
  $('#gate-password-label').textContent = first ? 'New password' : 'Password';
  $('#gate-password').setAttribute('autocomplete', first ? 'new-password' : 'current-password');
  $('#gate-submit').textContent = first ? 'Claim' : 'Sign in';
  // Whatever was typed before a bounce back here is not this person's.
  $('#gate-password').value = '';
  $('#gate-confirm').value = '';
  $('#gate-error').hidden = true;
  (first ? $('#gate-token') : $('#gate-password')).focus();
}

function showDashboard() {
  $('#gate').hidden = true;
  $('#frame').hidden = false;
}

function loginError(message) {
  const box = $('#gate-error');
  box.textContent = message;
  box.hidden = false;
}

async function submitLogin(event) {
  event.preventDefault();
  const first = authState.firstRun;
  const password = $('#gate-password').value;
  const button = $('#gate-submit');

  if (first && password !== $('#gate-confirm').value) {
    loginError('The two passwords do not match.');
    return;
  }
  button.disabled = true;
  button.classList.add('is-busy');
  $('#gate-error').hidden = true;
  try {
    const res = await fetch(first ? 'api/auth/claim' : 'api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(first ? { token: $('#gate-token').value, password } : { password }),
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
    button.classList.remove('is-busy');
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
  const current = $('#pw-old').value;
  const next = $('#pw-next').value;
  const status = $('#pw-status');
  const button = $('#pw-submit');

  if (next !== $('#pw-again').value) {
    status.textContent = 'The new passwords do not match.';
    toast('The new passwords do not match.', 'error');
    return;
  }
  button.disabled = true;
  button.classList.add('is-busy');
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
    $('#pw-old').value = '';
    $('#pw-next').value = '';
    $('#pw-again').value = '';
  } catch (err) {
    status.textContent = err.message;
    toast(err.message, 'error', 8000);
  } finally {
    button.disabled = false;
    button.classList.remove('is-busy');
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
  const card = $('#links-panel');
  const row = $('#links-row');
  if (!card || !row) return;
  const items = state.bookmarks || [];

  // Hidden rather than empty: a card that says "no bookmarks" is a card
  // asking to be tidied away, on the page someone looks at every day.
  card.hidden = items.length === 0;
  if (!items.length) return;

  $('#links-count').textContent = `${items.length}`;
  row.innerHTML = items.map((b) => `<a class="link-card" href="${escapeHtml(b.url)}" target="_blank" rel="noopener noreferrer"
        title="${escapeHtml(b.url)}">
        <span class="link-art">${iconArt(b.icon, monogram(b.name))}</span>
        <span class="link-text">
          <span class="link-name">${escapeHtml(b.name)}</span>
          ${b.subtitle ? `<span class="link-sub">${escapeHtml(b.subtitle)}</span>` : ''}
        </span>
        <svg class="link-go" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 16 16 8M10 8h6v6"/></svg>
      </a>`).join('');
}

function renderQuickEditor() {
  const list = $('#quick-editor-list');
  if (!list) return;
  const items = state.bookmarks || [];
  $('#quick-editor-summary').textContent = items.length ? `${items.length} of ${state.bookmarkMax || 60}` : 'none yet';

  list.innerHTML = items.map((b, i) => `
    <div class="list-row">
      ${editorIcon(b.icon, b.name)}
      <span class="list-main">
        <span class="list-name">${escapeHtml(b.name)}${b.subtitle ? `<span class="list-badge">${escapeHtml(b.subtitle)}</span>` : ''}</span>
        <span class="list-meta">${escapeHtml(b.url)}</span>
      </span>
      <span class="list-actions">
        <button type="button" class="button is-small" data-quick-up="${escapeHtml(b.id)}"${i === 0 ? ' disabled' : ''} title="Move up">↑</button>
        <button type="button" class="button is-small" data-quick-down="${escapeHtml(b.id)}"${i === items.length - 1 ? ' disabled' : ''} title="Move down">↓</button>
        <button type="button" class="button is-small" data-quick-edit="${escapeHtml(b.id)}">Edit</button>
        <button type="button" class="button is-small is-danger" data-quick-delete="${escapeHtml(b.id)}">Delete</button>
      </span>
    </div>`).join('') || '<p class="empty">No links yet — add one below.</p>';
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
    list.innerHTML = '<p class="empty">Nothing to show yet — install an app, or add a link below.</p>';
    return;
  }

  list.innerHTML = rows.map((r) => {
    const source = r.custom ? 'Custom link'
      : r.hidden ? 'Hidden from Launcher'
        : r.edited ? 'Renamed here' : 'Detected automatically';
    const actions = r.custom
      ? `<button type="button" class="button is-small" data-launcher-edit="${escapeHtml(r.key)}">Edit</button>
         <button type="button" class="button is-small is-danger" data-launcher-delete="${escapeHtml(r.key)}">Delete</button>`
      : `<button type="button" class="button is-small" data-launcher-rename="${escapeHtml(r.key)}">Rename</button>
         <button type="button" class="button is-small" data-launcher-toggle="${escapeHtml(r.key)}">${r.hidden ? 'Restore' : 'Hide'}</button>`;
    return `<div class="list-row${r.hidden ? ' is-off' : ''}">
      ${editorIcon(r.icon, r.name)}
      <span class="list-main">
        <span class="list-name">${escapeHtml(r.name)}</span>
        <span class="list-meta">${escapeHtml(source)} · ${escapeHtml(r.url)}</span>
      </span>
      <span class="list-actions">${actions}</span>
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
    const badge = m.user_created ? '<span class="list-badge">Added here</span>'
      : edited ? '<span class="list-badge is-edited">Edited</span>' : '';
    return `<div class="list-row">
      ${editorIcon(m.icon || (m.theme && m.theme.emoji), m.title)}
      <span class="list-main">
        <span class="list-name">${escapeHtml(m.title)}${badge}</span>
        <span class="list-meta">${escapeHtml(m.tagline || m.id)}</span>
      </span>
      <span class="list-actions">
        <button type="button" class="button is-small" data-catalog-edit="${escapeHtml(m.id)}">Edit</button>
        ${edited ? `<button type="button" class="button is-small" data-catalog-reset="${escapeHtml(m.id)}">Reset</button>` : ''}
        ${m.user_created ? `<button type="button" class="button is-small is-danger" data-catalog-delete="${escapeHtml(m.id)}">Delete</button>` : ''}
      </span>
    </div>`;
  }).join('') || '<p class="empty">No modules found.</p>';
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
  form.querySelector('.only-new').hidden = !!mod;
  for (const el of form.querySelectorAll('.only-new input')) el.required = !mod;

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
  $$('.subnav-item').forEach((b) => b.classList.toggle('is-current', b.dataset.stab === tab));
  $$('.subpage').forEach((p) => p.classList.toggle('is-shown', p.dataset.stabPanel === tab));
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
  const netGrid = $('#settings-net-facts');
  if (netGrid) {
    const n = summary.network || {};
    netGrid.innerHTML = [
      ['Hostname', summary.host.name],
      ['Dashboard', n.dashboard],
      ['Proxy', n.proxy],
      ['Docker networks', n.networks],
    ].map(([label, value]) => factHtml(label, value == null ? '—' : value)).join('');
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
        <td class="cell-strong mono"><a class="linkish" href="http://${escapeHtml(host)}:${r.port}" target="_blank" rel="noopener noreferrer">${r.port}</a></td>
        <td>${escapeHtml(r.app)}</td>
        <td class="cell-muted">${escapeHtml(r.container)}</td>
      </tr>`).join('') || '<tr><td colspan="3" class="cell-muted">Nothing published yet.</td></tr>';
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
      <p class="help">Blank WG_HOST hands out configs that point nowhere, so set it before adding a device.</p>`;
    } else {
      vpnState.innerHTML = `<div class="action-row">
        <button type="button" class="button is-primary" data-action="install" data-id="vpn">Install VPN</button>
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
        <td class="cell-strong">${escapeHtml(r.mod.title)}</td>
        <td class="cell-muted">${escapeHtml(r.name)}</td>
        <td class="cell-muted">
          <span class="masked" data-secret="${escapeHtml(r.mod.id)}:${escapeHtml(r.name)}">
            <span class="masked-dots">••••••••</span>
            <button type="button" class="button is-small reveal">Show</button>
          </span>
        </td>
      </tr>`).join('') || '<tr><td colspan="3" class="cell-muted">No module declares a secret.</td></tr>';
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
      ${statRow('Healthy', count((c) => c.state === 'healthy'), 'good')}
      ${statRow('Running (no health check)', count((c) => c.state === 'running'))}
      ${statRow('Starting', count((c) => c.state === 'starting'), 'warn')}
      ${statRow('Unhealthy', count((c) => c.state === 'unhealthy'), count((c) => c.state === 'unhealthy') ? 'warn' : '')}
      ${statRow('Stopped', count((c) => c.state === 'stopped'))}`;
  }
  const monModule = $('#monitoring-module');
  if (monModule) {
    const mon = state.modules.find((x) => x.id === 'monitoring');
    if (!mon) {
      monModule.innerHTML = '';
    } else if (mon.installed) {
      const svc = mon.services.find((x) => x.url);
      monModule.innerHTML = `<p class="help">Uptime Kuma is installed. It is what warns you when something goes down while this page is closed.</p>
        ${svc ? `<div class="action-row"><a class="button is-primary" href="${escapeHtml(svc.url)}" target="_blank" rel="noopener noreferrer">Open Uptime Kuma</a></div>` : ''}`;
    } else {
      monModule.innerHTML = `<p class="help">No alerts are set up. This page shows a problem only while you have it open; the Monitoring module can notify you instead.</p>
        <div class="action-row"><button type="button" class="button is-primary" data-action="install" data-id="monitoring">Install Monitoring</button></div>`;
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

/** A label and a value on one line, with an optional good/warn colour. */
function statRow(label, value, level) {
  return `<div class="stat-row">
    <span class="stat-key">${escapeHtml(label)}</span>
    <span class="stat-val"${level ? ` data-level="${escapeHtml(level)}"` : ''}>${escapeHtml(String(value))}</span>
  </div>`;
}

/* ---------------------------------------------------------------- sheet */

function openModule(id) {
  const mod = state.modules.find((m) => m.id === id);
  if (!mod) return;
  $('#sheet-body').innerHTML = `
    <div class="sheet-head">
      <span class="sheet-art">${iconArt(mod.icon || (mod.theme && mod.theme.emoji), monogram(mod.title, mod.theme && mod.theme.color))}</span>
      <div>
        <h2>${escapeHtml(mod.title)}</h2>
        <p class="sheet-tagline">${escapeHtml(mod.tagline)}</p>
      </div>
    </div>
    <div class="sheet-badges">
      <span class="badge" data-status="${escapeHtml(mod.status)}">${escapeHtml(STATUS_LABEL[mod.status] || mod.status)}</span>
      ${mod.ram ? `<span class="badge">${escapeHtml(mod.ram)} memory</span>` : ''}
      ${mod.required ? '<span class="badge badge-core">base system</span>' : ''}
    </div>
    <p class="text">${escapeHtml(mod.description)}</p>

    <div class="action-row" id="sheet-actions">${actionsFor(mod)}
      ${mod.installed ? `<button type="button" class="button" data-action="update" data-id="${escapeHtml(mod.id)}">Pull updates</button>` : ''}
    </div>

    ${mod.installed && !mod.required ? `
      <h3>Removing it</h3>
      <p class="help">Removing deletes the containers and keeps this app's settings and data in
        <code class="mono">${escapeHtml(mod.dir)}/config</code>, so a reinstall continues where it stopped.
        Removing and erasing deletes that folder too. That cannot be undone.</p>
      <div class="action-row">
        <button type="button" class="button is-danger" data-action="remove" data-id="${escapeHtml(mod.id)}">Remove</button>
        <button type="button" class="button is-danger-solid" data-action="purge" data-id="${escapeHtml(mod.id)}">Remove and erase data</button>
      </div>` : ''}

    <h3>What it runs</h3>
    ${mod.services.map((s) => `
      <div class="sheet-row">
        <span class="sheet-row-art">${iconHtml(s.icon || mod.icon, s.friendly_name, mod.theme)}</span>
        <span class="sheet-row-main">
          <span class="sheet-row-name">${escapeHtml(s.friendly_name)}</span>
          <span class="sheet-row-desc">${escapeHtml(s.description || (s.internal ? 'internal service' : s.name))}</span>
        </span>
        ${s.container ? `<span class="state-pill" data-state="${escapeHtml(s.container.state)}">${escapeHtml(s.container.state)}</span>` : ''}
        ${s.url ? `<a class="linkish" href="${escapeHtml(s.url)}" target="_blank" rel="noopener noreferrer">open</a>` : ''}
      </div>
      ${s.first_login ? `<p class="sheet-note">${escapeHtml(s.first_login)}</p>` : ''}
    `).join('')}

    ${mod.installed ? `
      <h3>Containers</h3>
      ${mod.containers.map((c) => `
        <div class="sheet-row">
          <span class="sheet-row-main">
            <span class="sheet-row-name mono">${escapeHtml(c.name)}</span>
            <span class="sheet-row-desc">${escapeHtml(c.status)}</span>
          </span>
          <span class="state-pill" data-state="${escapeHtml(c.state)}">${escapeHtml(c.state)}</span>
        </div>
        <div class="sheet-row-actions">${containerActions(c, c.state !== 'stopped')}</div>`).join('')}` : ''}

    ${mod.tips.length ? `<h3>Setup notes</h3><ul class="sheet-tips">${mod.tips.map((t) => `<li>${escapeHtml(t)}</li>`).join('')}</ul>` : ''}

    <h3>Files</h3>
    <dl class="kv">
      <dt>Module</dt><dd>${escapeHtml(mod.dir)}</dd>
      <dt>Category</dt><dd>${escapeHtml(mod.category)}</dd>
      ${mod.hostname ? `<dt>Hostname</dt><dd>${escapeHtml(mod.hostname)}.home</dd>` : ''}
      ${mod.env_vars.length ? `<dt>Secrets</dt><dd>${escapeHtml(mod.env_vars.join(', '))}<br><span class="help">homebox secrets ${escapeHtml(mod.id)}</span></dd>` : ''}
    </dl>

    <div class="run-output" id="run-output" hidden></div>`;
  $('#sheet').hidden = false;
  $('#sheet-backdrop').hidden = false;
  $('#sheet').dataset.module = mod.id;
}

function closeSheet() {
  $('#sheet').hidden = true;
  $('#sheet-backdrop').hidden = true;
  delete $('#sheet').dataset.module;
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
      <label class="erase-option">
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
    closeSheet();
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
  if ($('#sheet').dataset.module === id) openModule(id);

  const out = $('#run-output');
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
    if ($('#sheet').dataset.module === id) {
      const keep = out ? out.textContent : null;
      openModule(id);
      if (keep) {
        const fresh = $('#run-output');
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
      renderLogPicker();
      renderLauncher(state.modules);
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
    .catch((err) => {
      // Said in the console, not swallowed: a render that throws here leaves
      // half the page empty, and without this there is no trace of why.
      console.error('[homebox] module list could not be shown:', err);
      return null;
    });
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
  renderSideMeters(summary);
  renderHealth(summary);
  renderBoxFacts(summary.metrics);
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
  const dot = $('#conn');

  source.addEventListener('summary', (event) => {
    dot.dataset.state = 'up';
    $('.conn-text', dot).textContent = 'connected';
    applySummary(JSON.parse(event.data));
  });

  source.addEventListener('activity', () => {
    // The feed is small and the server keeps the tail; re-fetching is simpler
    // than merging one event into a list that may have scrolled.
    fetch('api/activity?limit=25').then((r) => r.json()).then((d) => renderActivity(d.entries)).catch(() => {});
  });

  source.onerror = () => {
    dot.dataset.state = 'down';
    $('.conn-text', dot).textContent = 'reconnecting';
  };
}

/* ------------------------------------------------------------ preferences */

/* The Appearance choices. Each id has a matching [data-theme] or
   [data-accent] block in css/homebox.css, and server.js accepts only these. */
const THEMES = [
  { id: 'dark', label: 'Dark' },
  { id: 'dim', label: 'Dim' },
  { id: 'light', label: 'Light' },
];

const ACCENTS = [
  { id: 'orange', label: 'Orange' },
  { id: 'blue', label: 'Blue' },
  { id: 'violet', label: 'Violet' },
  { id: 'teal', label: 'Teal' },
  { id: 'green', label: 'Green' },
  { id: 'amber', label: 'Amber' },
  { id: 'rose', label: 'Rose' },
];

function applyPrefs(prefs) {
  state.prefs = prefs;
  document.documentElement.dataset.theme = prefs.theme;
  document.documentElement.dataset.accent = prefs.accent;
  renderChoices();
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
 * The Appearance buttons. Each preview carries its own data-theme or
 * data-accent attribute, so the same CSS that colours the page colours the
 * preview — there is no second copy of the palette to drift.
 */
function renderChoices() {
  const themeBox = $('#theme-choices');
  const accentBox = $('#accent-choices');
  if (!themeBox || !accentBox) return;

  const choice = (kind, item, current) => `
    <button type="button" class="choice${item.id === current ? ' is-chosen' : ''}"
      data-${kind}-value="${escapeHtml(item.id)}" aria-pressed="${item.id === current}">
      <span class="choice-preview" data-${kind}="${escapeHtml(item.id)}"><i></i><i></i></span>
      <span class="choice-name">${escapeHtml(item.label)}</span>
    </button>`;

  themeBox.innerHTML = THEMES.map((t) => choice('theme', t, state.prefs.theme)).join('');
  accentBox.innerHTML = ACCENTS.map((a) => choice('accent', a, state.prefs.accent)).join('');
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
          <div class="unlock-row">
            <span class="unlock-art">${iconArt(a.icon, monogram(a.title))}</span>
            <span class="unlock-main">
              <strong>${escapeHtml(a.title)}</strong>
              <small>${escapeHtml(a.available ? a.label : (a.why || 'nothing to reset'))}</small>
            </span>
            ${a.available
              ? `<button type="button" class="button is-small" data-reset="${escapeHtml(a.module)}:${escapeHtml(a.service)}">Reset login</button>`
              : '<span class="unlock-open">open</span>'}
          </div>`).join('')
      : '<p class="empty">None of the installed apps declares a login this build can reset.</p>';
  } catch {
    list.innerHTML = '<p class="empty">Could not read which apps can be reset.</p>';
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
          <div class="mount">
            <div class="mount-main">
              <div class="mount-target mono">${escapeHtml(m.target)}</div>
              <div class="mount-source mono">${escapeHtml(m.source)} · ${escapeHtml(m.fstype || '')}${
                m.size ? ` · ${escapeHtml(m.used || '?')} of ${escapeHtml(m.size)} used` : ''}</div>
            </div>
            <button type="button" class="button is-small" data-unmount="${escapeHtml(m.target)}">Detach</button>
          </div>`).join('')
      : '<p class="empty">No network share is mounted on this box.</p>';
  } catch {
    list.innerHTML = '<p class="empty">Could not read what is mounted.</p>';
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
  if (!server) { box.innerHTML = '<p class="inline-note is-bad">Enter the NAS address first.</p>'; return; }

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
      box.innerHTML = `<p class="inline-note is-bad">${escapeHtml(server)} answered, but exports nothing.</p>`;
      return;
    }
    const me = (data.addresses || []).join(', ') || 'this box';
    box.innerHTML = `
      <p class="inline-note">${escapeHtml(server)} exports these. This box is ${escapeHtml(me)}.</p>
      ${data.exports.map((e) => `
        <div class="export ${e.allowed ? 'is-ok' : 'is-bad'}">
          <button type="button" class="export-pick mono" data-export="${escapeHtml(e.path)}">${escapeHtml(e.path)}</button>
          <span class="export-clients">${e.allowed
            ? 'allowed here'
            : `only for ${escapeHtml(e.clients.join(', '))} — add this box on the NAS first`}</span>
        </div>`).join('')}`;
  } catch (err) {
    box.innerHTML = `<p class="inline-note is-bad">${escapeHtml(err.message)}</p>`;
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
 * So the first click on an app's tile shows its generated sign-in before the
 * app opens, with a tick to stop showing it. Everything needed already exists:
 * the module's `env_vars` name the keys, /api/config returns their values
 * behind the session, and `first_login` carries the app's own instructions.
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
    <div class="signin-row">
      <span class="signin-key">${escapeHtml(c.label || c.key)}</span>
      <code class="signin-val mono">${escapeHtml(c.value)}</code>
      <button type="button" class="button is-small copy-btn" data-copy="${escapeHtml(c.value)}">Copy</button>
    </div>`).join('');

  const body = `
    ${svc.first_login ? `<p class="signin-hint">${escapeHtml(svc.first_login)}</p>` : ''}
    ${rows
      ? `<div class="signin-list">${rows}</div>
         <p class="signin-note">Created by HomeBox when the app was installed. You can find them again under
            Settings → Passwords, or on the server with
            <code class="mono">homebox secrets ${escapeHtml(mod.id)}</code>.</p>`
      : `<p class="signin-note">HomeBox did not create a login for this app. Whatever
            ${escapeHtml(svc.friendly_name)} asks for the first time, you choose.</p>`}
    <label class="signin-skip">
      <input type="checkbox" id="signin-skip-box">
      <span>Stop showing this for ${escapeHtml(svc.friendly_name)}</span>
    </label>`;

  // The dialog removes itself before the promise resolves, so the tick has to
  // be recorded while the box still exists. Honoured whichever button was
  // pressed: someone who ticks it and then closes has still said they do not
  // want to see it again.
  let dismiss = false;
  const watch = (event) => {
    if (event.target.id === 'signin-skip-box') dismiss = event.target.checked;
  };
  document.addEventListener('change', watch);

  const ok = await confirmDialog({
    title: `Your login for ${svc.friendly_name}`,
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
  const link = event.target.closest('.dock-open[data-first-login]');
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
  const btn = event.target.closest('.reveal');
  if (!btn) return;
  const wrap = btn.closest('.masked');
  const [moduleId, key] = String(wrap.dataset.secret || '').split(':');
  const found = (await moduleEnv(moduleId)).find((c) => c.key === key && c.value);
  if (!found) {
    wrap.querySelector('.masked-dots').textContent = 'not set';
    btn.remove();
    return;
  }
  wrap.innerHTML = `<code class="mono">${escapeHtml(found.value)}</code>`
    + `<button type="button" class="button is-small copy-btn" data-copy="${escapeHtml(found.value)}">Copy</button>`;
});

/** Copy buttons inside the credentials dialog. */
document.addEventListener('click', async (event) => {
  const btn = event.target.closest('.copy-btn');
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
  return `<div class="pulse-head">
    <span class="pulse-head-art"><img src="icons/${escapeHtml(icon)}" alt="" loading="lazy"></span>
    <span class="pulse-head-text">
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

  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
      <path class="chart-area" d="${area}"></path>
      <path class="chart-down" d="${line('down')}"></path>
      <path class="chart-up" d="${line('up')}"></path>
    </svg>
    <div class="chart-legend mono">
      <span>${escapeHtml(rate(peak))} peak</span>
      <span>${pts.length} samples</span>
    </div>`;
}

function transfersPanel(qb) {
  if (!qb || qb.installed === false) return '';
  if (qb.error) {
    return `<section class="pulse-part">
      ${liveHead('qbittorrent.svg', 'Transfers', 'qBittorrent')}
      <p class="pulse-note">${escapeHtml(qb.error)}</p>
    </section>`;
  }
  const moving = qb.torrents || [];
  const rows = moving.length
    ? moving.map((t) => `
        <div class="torrent">
          <div class="torrent-top">
            <span class="torrent-name">${escapeHtml(t.name)}</span>
            <span class="torrent-eta mono">${escapeHtml(etaText(t.eta) || '')}</span>
          </div>
          <div class="progressbar"><span style="width:${Math.max(0, Math.min(100, t.progress))}%"></span></div>
          <div class="torrent-foot mono">${t.progress.toFixed(1)}% · ${escapeHtml(rate(t.downSpeed))}</div>
        </div>`).join('')
    : '<p class="pulse-note">Nothing is downloading right now.</p>';

  return `<section class="pulse-part">
    ${liveHead('qbittorrent.svg', 'Transfers', 'qBittorrent')}
    <div class="speeds">
      <div class="speed"><span class="speed-dir is-down">↓</span><strong class="mono">${escapeHtml(rate(qb.downSpeed))}</strong></div>
      <div class="speed"><span class="speed-dir is-up">↑</span><strong class="mono">${escapeHtml(rate(qb.upSpeed))}</strong></div>
      <div class="speed is-quiet"><strong class="mono">${qb.activeCount}</strong><span>active</span></div>
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

  return `<section class="pulse-part">
    ${liveHead(apps.length === 1 ? apps[0].icon : 'radarr.png', 'Queues', sub)}
    ${apps.map((a) => `
      <div class="queue-row">
        <span class="queue-art"><img src="icons/${escapeHtml(a.icon)}" alt="" loading="lazy"></span>
        <span class="queue-app">${escapeHtml(a.name)}</span>
        ${a.d.error
          ? `<span class="pulse-note">${escapeHtml(a.d.error)}</span>`
          : `<span class="queue-nums mono"><b>${a.d.queue}</b> fetching · <b>${a.d.missing}</b> missing</span>`}
      </div>`).join('')}
  </section>`;
}

function upcomingPanel(data) {
  const rows = data.upcoming || [];
  if (!rows.length && !data.upcomingError) return '';
  return `<section class="pulse-part">
    ${liveHead('sonarr.png', 'Upcoming', `next ${data.upcomingDays} days`)}
    ${data.upcomingError
      ? `<p class="pulse-note">${escapeHtml(data.upcomingError)}</p>`
      : rows.map((r) => `
          <div class="soon-row">
            <span class="soon-dot${r.have ? ' is-have' : ''}" title="${r.have ? 'already downloaded' : 'not downloaded yet'}"></span>
            <span class="soon-title">${escapeHtml(r.title)}</span>
            <span class="soon-detail">${escapeHtml(r.detail)}</span>
            <span class="soon-when">${escapeHtml(whenText(r.date))}</span>
          </div>`).join('')}
  </section>`;
}

function renderInsights(data) {
  insightsData = data;
  const card = $('#pulse-panel');
  const box = $('#pulse-body');
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
  $('#pulse-time').textContent = new Date(data.at).toLocaleTimeString();
}

async function loadInsights({ force = false } = {}) {
  if (!insightsOn()) { const c = $('#pulse-panel'); if (c) c.hidden = true; return; }
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
    updateBadge((apps.available || []).length + (apps.newVersions || []).length, self.updateAvailable ? self.latest : null);
  } catch { /* leave the dot as it was */ }
}

function updateBadge(count, platformVersion = null) {
  const badge = $('#updates-dot');
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
  // like twelve things are broken.
  //
  // The `hidden` ATTRIBUTE, not a `.hidden` class: this stylesheet styles
  // `[hidden]` and defines no `.hidden` rule, so a class here is a button
  // that is always on screen no matter what the code thinks it set.
  badge.hidden = !count;
  badge.title = count
    ? `${count} app update${count === 1 ? '' : 's'} waiting`
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

  // The summary box above the card, which is there even when the card is not.
  if (data.current) {
    $('#updates-homebox').textContent = data.current;
    $('#updates-homebox-note').textContent = running ? `updating to ${p ? p.to : 'a new version'}`
      : data.frozen ? 'updates are paused'
        : data.updateAvailable ? `${data.latest} is available` : 'up to date';
  }

  if (!data.updateAvailable && !data.frozen && !data.reason && !running && !interrupted) {
    card.hidden = true;
    return;
  }
  card.hidden = false;

  const head = (title, sub) => `
    <div class="block-head">
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
      <div class="release-phase-row">
        <span class="release-phase mono">${escapeHtml(phase)}</span>
        <span class="release-message">${escapeHtml(msg)}</span>
      </div>`;
    return;
  }

  if (data.frozen) {
    card.innerHTML = `${head('Updates are paused', 'The maintainer has stopped this release from being installed.')}
      <p class="release-reason">${escapeHtml(data.reason || '')}</p>`;
    return;
  }

  if (data.reason) {
    card.innerHTML = `${head(`HomeBox ${data.latest || ''} is available`, 'It cannot be installed from here.')}
      <p class="release-reason">${escapeHtml(data.reason)}</p>`;
    return;
  }

  // Truncate BEFORE escaping. Slicing escaped markup can cut an entity in
  // half and leave `&am` on the page.
  const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);
  const notesText = data.notes
    ? [data.notes.name, data.notes.body].filter(Boolean).join('\n\n')
    : '';
  const notes = notesText
    ? `<div class="release-notes-body">${escapeHtml(clip(notesText, 1200))}</div>`
    : '';
  const link = data.notes && data.notes.url
    ? `<a class="release-link" href="${escapeHtml(data.notes.url)}" target="_blank" rel="noopener noreferrer">Full release notes</a>`
    : '';

  // Version-to-version on one line, rather than a sentence.
  //
  // "HomeBox 0.3.5 is available / This box is on 0.3.4" makes you read two
  // lines and hold both numbers to work out the direction. `0.3.4 → 0.3.5`
  // is the same fact in one glance, and it is what every updater worth
  // copying does.
  card.innerHTML = `
    <div class="block-head">
      <div>
        <h2>HomeBox</h2>
        <small class="release-versions">
          Current version <b>${escapeHtml(data.current)}</b>
          <span class="release-arrow">→</span>
          <b class="release-next">${escapeHtml(data.latest)}</b> available
        </small>
      </div>
      <div class="release-actions">
        <button type="button" class="button is-small" id="platform-check">Check</button>
        <button type="button" class="button is-small is-primary" id="platform-go">Update HomeBox</button>
      </div>
    </div>
    <p class="release-reassure">Takes about a minute. Your apps keep running and their data is not touched, and if the new version does not start, this box puts ${escapeHtml(data.current)} back on its own.<br>
    You can close this page — the update runs on the box, not in the browser, and this card picks it up again when you come back.</p>
    ${notes ? `<div class="release-notes">
      <span class="release-notes-label">Changes in ${escapeHtml(data.latest)}</span>
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
          // No history entry means the run never got far enough to write one
          // — most often it never started at all. The progress file is the
          // only thing that knows why, so say what it says rather than the
          // useless truth that something stopped.
          const why = data.progress && data.progress.message;
          closeProgress(false, why || 'The update stopped');
          if (why) toast(why, 'error', 12000);
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
  const list = $('#update-items');
  if (!list) return;
  try {
    const data = await (await fetch('api/updates')).json();
    renderUpdates(data);
    // Nothing cached, or cached long enough ago that showing it without
    // saying "this is old" would be misleading. Re-check in the background.
    if ((force || data.stale) && !data.checking && !data.applying) runUpdateCheck({ quiet: true });
  } catch (err) {
    list.innerHTML = `<p class="empty">Could not read the update state: ${escapeHtml(err.message)}</p>`;
  }
}

function renderUpdates(data) {
  updatesState = data;
  const list = $('#update-items');
  const rebuilds = data.available || [];
  const versions = data.newVersions || [];
  const held = data.heldBack || [];
  const count = rebuilds.length + versions.length;

  $('#updates-count').textContent = String(count);
  $('#updates-count-note').textContent = count
    ? [plural(versions.length, 'new version'), plural(rebuilds.length, 'rebuild')].filter(Boolean).join(' · ')
    : 'nothing waiting';
  $('#updates-apps-box').classList.toggle('is-waiting', count > 0);
  $('#updates-held').textContent = String(held.length);
  $('#updates-held-note').textContent = held.length ? 'needs a manual migration' : 'nothing needs a manual step';
  updateBadge(count);

  // Never say "up to date" without a check behind it — that is a claim, and
  // an install that has never checked has no basis for making it.
  if (!data.lastCheck) {
    $('#update-state').textContent = 'No check has run on this box yet.';
  } else {
    const skipped = (data.skipped || []).length;
    $('#update-state').textContent =
      `Last checked ${new Date(data.lastCheck).toLocaleString()} · `
      + `${data.checked} of ${data.containers} containers compared`
      + (skipped ? ` · ${skipped} could not be reached` : '')
      // Say that it is automatic. Without this the page shows a timestamp
      // and a button, which reads as "press this to find out" — and somebody
      // reasonably concluded exactly that. Check now is for impatience, not
      // for operation.
      + ' · Checks again on its own every 6 hours';
  }

  // Rebuilds only. A new version is confirmed one at a time, because it can
  // migrate data; and with a single rebuild the row's own button is the same
  // action, one click closer.
  $('#updates-all').hidden = rebuilds.length < 2;

  if (!data.lastCheck) {
    list.innerHTML = '<p class="note-box">Press <strong>Check now</strong> to compare every app against its registry.</p>';
  } else if (!count && !held.length) {
    list.innerHTML = '<p class="note-box"><strong>Everything is current.</strong> Every app on this box is on the newest build of its version, and no newer version is waiting.</p>';
  } else {
    // New versions first: they are the news. Rebuilds next, held-back last
    // and without a button — shown, so an old database is not a secret.
    list.innerHTML = [
      ...versions.map((r) => updateRow(r, {
        kind: 'version', label: 'new version',
        title: 'A newer version of this app has been published.',
        detail: `${r.tag} → ${r.newerVersion}`,
        action: `<button type="button" class="button is-small" data-upgrade="${escapeHtml(r.container)}">Upgrade</button>`,
      })),
      ...rebuilds.map((u) => updateRow(u, {
        kind: 'rebuild', label: 'security rebuild',
        title: 'The publisher rebuilt this same version with new layers — usually security patches underneath.',
        detail: `${u.tag || 'same version'} · same version, patched image`,
        action: `<button type="button" class="button is-small" data-update="${escapeHtml(u.container)}">Update</button>`,
      })),
      ...held.map((h) => updateRow(h, {
        kind: 'held', label: 'held back',
        title: 'Not offered here: this needs a migration, not an image swap.',
        detail: `${h.tag} → ${h.newerVersion} · ${h.why}`,
        action: '',
      })),
    ].join('');
  }

  // Whatever could not be checked is shown, not swallowed. A box where the
  // registry was unreachable for half its images must not look like a box
  // that is fully up to date.
  if ((data.skipped || []).length) {
    list.insertAdjacentHTML('beforeend', `
      <div class="skipped-box">
        <strong>Not checked</strong>
        ${data.skipped.map((s) => `<div><span class="mono">${escapeHtml(s.container)}</span> — ${escapeHtml(s.reason)}</div>`).join('')}
      </div>`);
  }

  renderUpdateHistory(data.history || []);
}

function plural(n, word) {
  return n ? `${n} ${word}${n === 1 ? '' : 's'}` : '';
}

/**
 * One row of App updates: the app's own icon and name, what kind of update
 * it is, versions, and the button that kind takes. Names and icons come from
 * the module list, so a row reads "Linkding" rather than a container name.
 */
function updateRow(item, { kind, label, title, detail, action }) {
  const mod = state.modules.find((m) => m.id === item.module);
  const svc = mod && mod.services.find((s) => s.name === item.service);
  const name = (svc && svc.friendly_name) || item.title || item.container;
  const color = (svc && svc.color) || (mod && mod.theme && mod.theme.color) || null;
  const art = iconArt((svc && svc.icon) || (mod && (mod.icon || (mod.theme && mod.theme.emoji))), monogram(name, color));
  return `
    <div class="update-item is-${kind}" data-container="${escapeHtml(item.container)}">
      <span class="update-item-art">${art}</span>
      <div class="update-item-main">
        <div class="update-item-name">${escapeHtml(name)}
          <span class="kind ${kind}" title="${escapeHtml(title)}">${escapeHtml(label)}</span>
        </div>
        <div class="update-item-digest mono">${escapeHtml(detail)}</div>
      </div>
      ${action}
    </div>`;
}

function renderUpdateHistory(history) {
  const el = $('#update-log');
  if (!el) return;
  if (!history.length) {
    el.innerHTML = '<p class="empty">No updates have been applied from this page yet.</p>';
    return;
  }
  el.innerHTML = history.map((h) => {
    const kind = h.success ? 'is-ok' : (h.rolledBack ? 'is-rolled-back' : 'is-failed');
    const label = h.success ? 'Updated' : (h.rolledBack ? 'Rolled back' : 'Failed');
    return `
      <div class="history-row">
        <span class="history-kind ${kind}">${label}</span>
        <span class="history-name mono">${escapeHtml(h.container || h.module || '')}</span>
        <span class="history-time">${escapeHtml(new Date(h.timestamp).toLocaleString())}</span>
        ${h.reason ? `<span class="history-reason">${escapeHtml(h.reason)}</span>` : ''}
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
      <p class="signin-note">A backup of this app is taken first, automatically. If the app does not
      come back healthy, the previous version is put straight back.</p>
      <p class="signin-note"><strong>Worth knowing:</strong> a new version can migrate its database on
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
  const btn = $('#check-updates');
  if (btn) { btn.disabled = true; btn.textContent = 'Checking…'; }
  if (!quiet) $('#update-state').textContent = 'Asking each registry for the newest build…';

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
    $('#update-state').textContent = `The last check did not finish: ${err.message}`;
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

/* ------------------------------------------------------- work in progress */

/**
 * A dialog that shows what the box is doing while it does it.
 *
 * An install pulls images and can take minutes. Saying nothing until the end
 * is exactly when someone decides it has hung and reloads mid-pull, so the
 * server streams compose's own output and it is shown as it arrives.
 */
let progress = null;

function openProgress(title) {
  const layer = document.createElement('div');
  layer.className = 'dialog-layer';
  layer.innerHTML = `
    <div class="dialog is-wide is-progress" role="dialog" aria-modal="true" aria-labelledby="run-title">
      <h3 class="dialog-title" id="run-title"></h3>
      <p class="stay-note" id="run-warning">
        The work continues on the server if you close this page, but this is the only place its output is shown.
      </p>
      <div class="step-chips" id="run-steps"></div>
      <pre class="stream" id="run-stream" tabindex="0" aria-live="polite"></pre>
      <div class="dialog-actions" id="run-actions" hidden>
        <button type="button" class="button is-primary" data-act="progress-close">Close</button>
      </div>
    </div>`;
  document.body.appendChild(layer);
  layer.querySelector('#run-title').textContent = title;

  progress = { overlay: layer, log: layer.querySelector('#run-stream'), steps: layer.querySelector('#run-steps'), stuck: false };
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
  // "Container y Started". Checked against the compose v5.5.1 on this box.
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
        `<span class="step-chip is-active" data-step="${escapeHtml(key)}">${escapeHtml(verb)} ${escapeHtml(label)}</span>`);
    } else if (DONE.includes(verb)) {
      if (chip) {
        chip.classList.remove('is-active');
        chip.classList.add('is-done');
        chip.textContent = `${verb} ${label}`;
      } else {
        // Already up, so there was never a "busy" line to open a chip.
        steps.insertAdjacentHTML('beforeend',
          `<span class="step-chip is-done" data-step="${escapeHtml(key)}">${escapeHtml(verb)} ${escapeHtml(label)}</span>`);
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
  progress.steps.querySelectorAll('.step-chip.is-active').forEach((el) => {
    el.classList.remove('is-active');
    if (ok) el.classList.add('is-done');
  });
  progress.overlay.querySelector('#run-title').textContent = title;
  progress.overlay.querySelector('#run-warning').hidden = true;
  progress.overlay.querySelector('#run-actions').hidden = false;
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
            if (progress) progress.log.classList.add('has-error');
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
    if (progress) progress.log.classList.add('has-error');
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
  let bar = $('#pending-bar');
  if (!state.pending.size) {
    if (bar) bar.remove();
    return;
  }
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'pending-bar';
    bar.className = 'pending-bar';
    document.body.appendChild(bar);
  }
  const install = [...state.pending.values()].filter(Boolean).length;
  const remove = state.pending.size - install;
  const bits = [];
  if (install) bits.push(`install <strong>${install}</strong>`);
  if (remove) bits.push(`remove <strong>${remove}</strong>`);
  bar.innerHTML = `
    <div class="pending-summary">Ready to ${bits.join(' and ')}</div>
    <div class="pending-actions">
      <button type="button" class="button is-small" id="pending-cancel">Discard</button>
      <button type="button" class="button is-small is-primary" id="pending-apply">Review and apply</button>
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
    html += '<div class="plan-section"><div class="plan-section-title">Will be installed</div>';
    for (const m of installMods) {
      const services = m.services || [];
      containers += services.length;
      const open = services.filter((sv) => sv.port).map((sv) => sv.port);
      ports += open.length;
      html += `<div class="plan-item is-add">
        <div class="plan-item-name">${escapeHtml(m.title)}</div>
        <div class="plan-item-apps">${escapeHtml(services.map((sv) => sv.friendly_name).join(', ') || m.title)}</div>
        <div class="plan-item-detail">
          <span class="plan-chip">${services.length} container${services.length === 1 ? '' : 's'}</span>
          ${open.length ? `<span class="plan-chip mono">port ${escapeHtml(open.join(', '))}</span>` : ''}
          ${m.ram ? `<span class="plan-chip">${escapeHtml(m.ram)} memory</span>` : ''}
        </div>
      </div>`;
    }
    html += '</div>';
  }

  if (removeMods.length) {
    html += '<div class="plan-section"><div class="plan-section-title">Will be removed</div>';
    for (const m of removeMods) {
      html += `<div class="plan-item is-remove">
        <div class="plan-item-name">${escapeHtml(m.title)}</div>
        <div class="plan-item-detail">Its containers are deleted. Settings and data in
          <code>modules/${escapeHtml(m.id)}/config</code> are kept, so a reinstall brings it back as it was.</div>
      </div>`;
    }
    html += '</div>';
  }

  const meta = [];
  if (containers) meta.push(`${containers} container${containers === 1 ? '' : 's'} created`);
  if (ports) meta.push(`${ports} port${ports === 1 ? '' : 's'} opened to your network`);

  const notice = installMods.length ? `<p class="plan-wait">
      First installs take a while: downloading the images is usually one to three minutes, and some
      apps need another minute before their page answers. A tile that does not open straight away is
      most likely still starting.
    </p>` : '';

  // Removing from a card offers the same choice as removing from the sheet:
  // keep the settings for a later reinstall, or erase them for a fresh start.
  const erase = removeMods.length ? `
    <label class="erase-option">
      <input type="checkbox" id="remove-erase-box">
      <span>
        <strong>Erase their settings and data as well</strong>
        <small>Deletes each app's <code class="mono">config</code> folder — its database and accounts.
        Leave it unticked and a reinstall continues where it stopped.</small>
      </span>
    </label>` : '';

  removeDialog.erase = false;
  return confirmDialog({
    title: 'Review changes',
    bodyHtml: `<p class="plan-intro">This is what will happen on the server:</p>
      <div class="plan-list">${html}</div>
      <div class="plan-foot">
        ${meta.length ? `<div class="plan-meta">${escapeHtml(meta.join(' · '))}</div>` : ''}
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

// `toggle` does not bubble, hence the capture phase.
document.addEventListener('toggle', (event) => {
  const notes = event.target.closest && event.target.closest('[data-notes]');
  if (!notes) return;
  if (notes.open) state.openNotes.add(notes.dataset.notes);
  else state.openNotes.delete(notes.dataset.notes);
}, true);

document.addEventListener('click', async (event) => {
  const queueBtn = event.target.closest('[data-queue]');
  if (queueBtn) {
    event.preventDefault();
    queueChange(queueBtn.dataset.queue);
    return;
  }
  if (event.target.closest('#sign-out')) { signOut(); return; }
  if (event.target.closest('#pending-cancel')) { cancelPending(); return; }
  if (event.target.closest('#pending-apply')) { applyPending(); return; }

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
    closeSheet();
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
  if (event.target.closest('#config-save')) return saveConfig();

  const showBtn = event.target.closest('[data-config-show]');
  if (showBtn) {
    const field = document.getElementById(showBtn.dataset.configShow);
    const hidden = field.type === 'password';
    field.type = hidden ? 'text' : 'password';
    showBtn.textContent = hidden ? 'Hide' : 'Show';
    return undefined;
  }

  if (event.target.closest('#backup-now')) return createBackup();

  if (event.target.closest('#key-reveal')) {
    return backupCall('key', {}, (data) => {
      const box = $('#backup-key-text');
      box.textContent = data.key;
      box.hidden = false;
      $('#key-copy').hidden = false;
      $('#key-reveal').textContent = 'Backup key';
    });
  }
  if (event.target.closest('#key-copy')) {
    const key = $('#backup-key-text').textContent;
    navigator.clipboard.writeText(key).then(
      () => { $('#key-copy').textContent = 'Copied'; },
      () => { $('#key-copy').textContent = 'Copy failed'; }
    );
    return undefined;
  }
  if (event.target.closest('#schedule-save')) {
    return backupCall('schedule', {
      enabled: $('#schedule-on').checked,
      preset: $('#schedule-every').value,
      retention: Number($('#schedule-keep').value),
    }, () => {
      toast($('#schedule-on').checked
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
    const row = lRename.closest('.list-row');
    launcherFormMode({
      key,
      detected: true,
      name: over.name || row.querySelector('.list-name').textContent,
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

  if (event.target.closest('#restart-all')) return bulkAction('restart', 'Restart');
  if (event.target.closest('#update-all')) return bulkAction('update', 'Update');

  const stab = event.target.closest('[data-stab]');
  if (stab) return showSettingsTab(stab.dataset.stab);

  const themeBtn = event.target.closest('[data-theme-value]');
  if (themeBtn) return savePrefs({ theme: themeBtn.dataset.themeValue });

  const accentBtn = event.target.closest('[data-accent-value]');
  if (accentBtn) return savePrefs({ accent: accentBtn.dataset.accentValue });

  if (event.target.closest('#sheet-close') || event.target.closest('#sheet-backdrop')) closeSheet();
});

$('#store-query').addEventListener('input', (e) => {
  state.appQuery = e.target.value;
  $('#store-clear').hidden = !e.target.value;
  renderApps();
});
$('#store-clear').addEventListener('click', () => {
  state.appQuery = '';
  $('#store-query').value = '';
  $('#store-clear').hidden = true;
  renderApps();
  $('#store-query').focus();
});
$('#store-order').addEventListener('change', (e) => {
  state.appSort = e.target.value;
  renderApps();
});
$('#schedule-on').addEventListener('change', (e) => {
  $('#schedule-options').hidden = !e.target.checked;
});
$('#backup-kind').addEventListener('change', () => renderBackups());

document.addEventListener('input', (event) => {
  const field = event.target.closest('[data-config-key]');
  if (field) field.classList.toggle('is-changed', field.value !== field.dataset.original);
});

$('#launcher-add-form').addEventListener('submit', submitLauncherForm);
$('#catalog-form').addEventListener('submit', submitCatalogForm);
$('#quick-form').addEventListener('submit', submitQuickForm);
$('#password-form').addEventListener('submit', submitPasswordChange);
state.launcherPrefs = readLauncherPrefs();

['#live-enabled', '#live-transfers', '#live-queues', '#live-upcoming'].forEach((sel) => {
  $(sel).addEventListener('change', saveInsightPrefs);
});
$('#pulse-panel').addEventListener('click', (event) => {
  // The timestamp is the refresh control: clicking it drops the server-side
  // caches and asks every app again, which is what someone wants when they
  // just started a download and the card still says nothing is moving.
  if (event.target.closest('#pulse-time')) loadInsights({ force: true });
});

$('#reset-list').addEventListener('click', (event) => {
  const btn = event.target.closest('[data-reset]');
  if (!btn) return;
  const [moduleId, service] = btn.dataset.reset.split(':');
  resetAppLogin(moduleId, service, btn.closest('.unlock-row').querySelector('strong').textContent);
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

$('#check-updates').addEventListener('click', () => runUpdateCheck());
$('#updates-all').addEventListener('click', () => applyUpdate('all'));
$('#update-items').addEventListener('click', (event) => {
  const btn = event.target.closest('[data-update]');
  if (btn) { applyUpdate(btn.dataset.update); return; }
  const up = event.target.closest('[data-upgrade]');
  if (!up) return;
  const row = (updatesState.newVersions || []).find((v) => v.container === up.dataset.upgrade);
  if (row) upgradeVersion(row.container, row.tag, row.newerVersion);
});

$('#log-reload').addEventListener('click', () => loadLogs());
$('#log-search').addEventListener('input', () => renderLogs());
$('#log-stick').addEventListener('change', () => renderLogs());
$('#log-picker').addEventListener('change', () => loadLogs());
$('#log-tail').addEventListener('change', () => loadLogs());

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeSheet();
  if (event.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)) {
    location.hash = '#apps';
    event.preventDefault();
    $('#store-query').focus();
  }
});

async function boot() {
  // The dashboard is hidden until the server answers. Doing it the other way
  // round flashes a full page of empty cards at someone who is not signed in.
  $('#gate-form').addEventListener('submit', submitLogin);
  if (await checkAuth()) await init();
}

async function init() {
  try {
    applyPrefs(await (await fetch('api/prefs')).json());
  } catch {
    applyPrefs(state.prefs);
  }
  $('#store-order').value = state.appSort;
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
