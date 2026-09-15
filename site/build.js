#!/usr/bin/env node
'use strict';
/**
 * Builds homebox.abeksis.net into site/dist.
 *
 *   node site/build.js
 *
 * No dependencies, like the rest of HomeBox. The app catalog and every app
 * page are generated from modules/<id>/docker-compose.yml through the SAME
 * loader the dashboard uses (dashboard/lib/modules.js), so the website cannot
 * describe an app differently from the box that installs it. Add a module,
 * push, and it has a page.
 *
 * Two languages. English is the source — it is what the modules are written
 * in. Hebrew module text lives in site/i18n/he-modules.json with a hash of the
 * English it was translated from; when a module's English changes, the build
 * warns and the Hebrew page falls back to English rather than showing a
 * translation of something the module no longer says.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const SITE = __dirname;
const ROOT = path.resolve(SITE, '..');
const DIST = path.join(SITE, 'dist');
const DOMAIN = 'homebox.abeksis.net';
const INSTALL = 'curl -fsSL https://get.abeksis.net/install.sh | sudo bash';
const REPO = 'https://github.com/abeksis/HomeBox';

// The module loader resolves everything from HOMEBOX_ROOT, read at require time.
process.env.HOMEBOX_ROOT = ROOT;
const modulesLib = require(path.join(ROOT, 'dashboard/lib/modules.js'));

const LANGS = ['en', 'he'];
const UI = JSON.parse(fs.readFileSync(path.join(SITE, 'i18n/ui.json'), 'utf8'));
const HE_MODULES = JSON.parse(fs.readFileSync(path.join(SITE, 'i18n/he-modules.json'), 'utf8'));
const warnings = [];

// Stylesheet and script URLs carry a hash of their content. GitHub Pages lets
// browsers cache them for ten minutes, so without it a fresh page arrives
// styled by the previous site.css.
const assetVersion = (file) => crypto.createHash('sha1').update(fs.readFileSync(path.join(SITE, 'static', file))).digest('hex').slice(0, 10);
const ASSET_V = { css: assetVersion('site.css'), js: assetVersion('site.js') };

/* ---------------------------------------------------------------- helpers */

const esc = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// Backticks in module text are code. Everything else is escaped.
const inline = (v) => esc(v).replace(/`([^`]+)`/g, '<code>$1</code>');

const t = (lang, key) => {
  const entry = UI[key];
  if (!entry) throw new Error(`ui.json has no key "${key}"`);
  return entry[lang] || entry.en;
};

const textHash = (text) => crypto.createHash('sha1').update(String(text)).digest('hex').slice(0, 12);
const sourceHash = (m) => textHash(`${m.tagline}\n${m.description}`);

function write(rel, html) {
  const file = path.join(DIST, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, html);
}

function copyDir(from, to) {
  if (!fs.existsSync(from)) return 0;
  fs.mkdirSync(to, { recursive: true });
  let n = 0;
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, e.name);
    const b = path.join(to, e.name);
    if (e.isDirectory()) n += copyDir(a, b);
    else { fs.copyFileSync(a, b); n += 1; }
  }
  return n;
}

// Site-absolute URL for a page in a language: English at the root, Hebrew under /he.
const href = (lang, p = '') => `${lang === 'he' ? '/he' : ''}/${p}`.replace(/\/+/g, '/');

/* --------------------------------------------------------------- content */

function moduleText(m, lang) {
  if (lang !== 'he') return { tagline: m.tagline, description: m.description, translated: true };
  const he = HE_MODULES[m.id];
  if (!he) {
    warnings.push(`he: no translation for module "${m.id}" — showing English`);
    return { tagline: m.tagline, description: m.description, translated: false };
  }
  if (he.src !== sourceHash(m)) {
    warnings.push(`he: translation of "${m.id}" is stale (English changed) — showing English until it is updated`);
    return { tagline: m.tagline, description: m.description, translated: false };
  }
  return { tagline: he.tagline, description: he.description, translated: true };
}

/**
 * The short description of one app inside a multi-app module, in a language.
 * Same staleness rule as moduleText(): a translation of an English line that
 * has since changed is not shown.
 */
function serviceText(m, svc, lang) {
  const english = svc.description || '';
  if (lang !== 'he') return english;
  const he = HE_MODULES[m.id] && HE_MODULES[m.id].services && HE_MODULES[m.id].services[svc.name];
  if (!he) {
    warnings.push(`he: no translation for app "${m.id}/${svc.name}" — showing English`);
    return english;
  }
  if (he.src !== textHash(english)) {
    warnings.push(`he: translation of "${m.id}/${svc.name}" is stale (English changed) — showing English`);
    return english;
  }
  return he.description;
}

function loadGuides() {
  const guides = {};
  for (const lang of LANGS) {
    const dir = path.join(SITE, 'content', lang);
    guides[lang] = fs.readdirSync(dir).filter((f) => f.endsWith('.html')).map((f) => {
      const raw = fs.readFileSync(path.join(dir, f), 'utf8');
      const head = /^<!--([\s\S]*?)-->/.exec(raw);
      if (!head) throw new Error(`${lang}/${f}: missing <!-- title: … --> header`);
      const meta = {};
      for (const line of head[1].split('\n')) {
        const i = line.indexOf(':');
        if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
      }
      if (!meta.title) throw new Error(`${lang}/${f}: header has no title`);
      return {
        slug: f.replace(/\.html$/, ''),
        title: meta.title,
        summary: meta.summary || '',
        order: Number(meta.order) || 99,
        body: raw.slice(head[0].length).trim(),
      };
    }).sort((a, b) => a.order - b.order);
  }
  const en = guides.en.map((g) => g.slug).join(',');
  const he = guides.he.map((g) => g.slug).join(',');
  if (en !== he) throw new Error(`guides differ between languages:\n  en: ${en}\n  he: ${he}`);
  return guides;
}

/**
 * Every release: the git tags that exist, plus releases/history.json.
 *
 * The repository's history was restarted at 0.4.23, which removed the tags of
 * every release before it. Their notes were kept in history.json so the
 * changelog still reads from the beginning; a tag with the same name wins.
 */
function loadReleases() {
  const byTag = new Map();
  try {
    const past = JSON.parse(fs.readFileSync(path.join(ROOT, 'releases/history.json'), 'utf8'));
    for (const r of past) byTag.set(r.tag, r);
  } catch { /* no history file: tags only */ }
  try {
    const out = execFileSync('git', [
      'for-each-ref', '--sort=-v:refname', '--count=500',
      '--format=%(refname:short)%1f%(creatordate:short)%1f%(contents)%1e',
      'refs/tags/v*',
    ], { cwd: ROOT, encoding: 'utf8' });
    for (const r of out.split('\x1e').map((x) => x.trim()).filter(Boolean)) {
      const [tag, date, contents] = r.split('\x1f');
      const lines = (contents || '').split('\n');
      // "HomeBox 0.4.18" is the subject; the notes are what follows.
      const body = lines.slice(1).join('\n').replace(/-----BEGIN PGP[\s\S]*$/, '').trim();
      byTag.set(tag, { tag, date, body });
    }
  } catch (err) {
    if (!byTag.size) warnings.push(`changelog: git tags unavailable (${err.message.split('\n')[0]}) — page shows a link instead`);
  }
  const num = (tag) => tag.replace(/^v/, '').split('.').map(Number);
  return [...byTag.values()].sort((a, b) => {
    const [x, y] = [num(a.tag), num(b.tag)];
    for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return y[i] - x[i];
    return 0;
  });
}

/* ---------------------------------------------------------------- layout */

function layout({ lang, pagePath, title, description, body, current }) {
  const other = lang === 'he' ? 'en' : 'he';
  const dir = lang === 'he' ? 'rtl' : 'ltr';
  const fullTitle = title ? `${title} · HomeBox` : `HomeBox — ${t(lang, 'tagline')}`;
  const nav = [
    ['home', '', t(lang, 'nav_home')],
    ['apps', 'apps/', t(lang, 'nav_apps')],
    ['guides', 'guides/', t(lang, 'nav_guides')],
    ['changelog', 'changelog/', t(lang, 'nav_changelog')],
  ].map(([id, p, label]) => `<a href="${href(lang, p)}"${current === id ? ' aria-current="page"' : ''}>${esc(label)}</a>`).join('');

  return `<!doctype html>
<html lang="${lang}" dir="${dir}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(fullTitle)}</title>
<meta name="description" content="${esc(description || t(lang, 'meta_description'))}">
<link rel="canonical" href="https://${DOMAIN}${href(lang, pagePath)}">
<link rel="alternate" hreflang="en" href="https://${DOMAIN}${href('en', pagePath)}">
<link rel="alternate" hreflang="he" href="https://${DOMAIN}${href('he', pagePath)}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Heebo:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&family=Manrope:wght@400;500;600;700;800&display=swap">
<link rel="stylesheet" href="/site.css?v=${ASSET_V.css}">
<script defer src="/site.js?v=${ASSET_V.js}"></script>
</head>
<body>
<a class="skip" href="#main">${esc(t(lang, 'skip'))}</a>
<header class="top">
  <div class="wrap top-in">
    <a class="brand" href="${href(lang)}"><img src="/favicon.svg" alt="" width="26" height="26"><span>HomeBox</span></a>
    <nav class="nav" aria-label="${esc(t(lang, 'nav_label'))}">${nav}</nav>
    <div class="top-end">
      <a class="lang" href="${href(other, pagePath)}" hreflang="${other}" lang="${other}">${esc(t(other, 'lang_name'))}</a>
      <a class="gh" href="${REPO}" aria-label="GitHub">GitHub</a>
      <a class="nav-cta" href="${href(lang, 'guides/install/')}">${esc(t(lang, 'nav_install'))}</a>
    </div>
  </div>
</header>
<main id="main">
${body}
</main>
<footer class="foot">
  <div class="wrap foot-in">
    <p>${esc(t(lang, 'footer'))}</p>
    <p><a href="${REPO}">${esc(t(lang, 'source'))}</a> · <a href="${href(lang, 'changelog/')}">${esc(t(lang, 'nav_changelog'))}</a></p>
  </div>
</footer>
</body>
</html>
`;
}

const installBlock = (lang, id = 'install-cmd') => `
<div class="install">
  <div class="terminal" dir="ltr"><span class="prompt" aria-hidden="true">$ </span><code id="${id}">${esc(INSTALL)}</code></div>
  <button type="button" class="copy" data-copy="#${id}" data-done="${esc(t(lang, 'copied'))}">${esc(t(lang, 'copy'))}</button>
</div>`;

function iconHtml(m, size = 40) {
  if (m.icon) return `<img class="app-icon" src="/icons/${esc(m.icon)}" alt="" width="${size}" height="${size}" loading="lazy">`;
  const emoji = (m.theme && m.theme.emoji) || '📦';
  return `<span class="app-icon app-emoji" aria-hidden="true" style="width:${size}px;height:${size}px">${esc(emoji)}</span>`;
}

/**
 * The catalog as the dashboard's launcher shows it: one card per app with a
 * web page. A module that runs several — the media stack is Radarr, Sonarr,
 * Prowlarr, Bazarr and qBittorrent — becomes several cards, each linking to its
 * row on the module's page. Listing the module alone hid five apps people look
 * for by name behind a card called "Media Stack".
 *
 * The launcher's rule is "not internal, and has a port". A module with no such
 * service (game servers, Tailscale, the tunnel) has no tile on a dashboard, but
 * it is still something to install, so here it keeps one card of its own.
 */
function catalogCards(modules) {
  const cards = [];
  for (const m of catalogOf(modules)) {
    const apps = m.services.filter((svc) => !svc.internal && svc.port != null);
    if (apps.length > 1) {
      for (const svc of apps) cards.push({ key: `${m.id}/${svc.name}`, module: m, service: svc });
    } else {
      cards.push({ key: m.id, module: m, service: null });
    }
  }
  return cards.sort((a, b) => cardTitle(a).localeCompare(cardTitle(b)));
}

const cardTitle = (c) => (c.service ? c.service.friendly_name : c.module.title);

function appCard(card, lang, cats) {
  const m = card.module;
  const svc = card.service;
  const cat = cats.find((c) => c.id === m.category);
  const tagline = svc ? serviceText(m, svc, lang) : moduleText(m, lang).tagline;
  const target = svc ? `apps/${m.id}/#svc-${svc.name}` : `apps/${m.id}/`;
  const icon = svc ? { ...m, icon: svc.icon || m.icon } : m;
  // A card for Radarr is also found by searching "media stack".
  const search = [cardTitle(card), m.title, m.tagline, tagline, m.id, svc ? svc.name : '', catLabel(cat, lang)].join(' ').toLowerCase();
  return `<a class="app-card" href="${href(lang, target)}" data-cat="${esc(m.category)}" data-search="${esc(search)}" title="${esc(tagline.replace(/`/g, ''))}">
  ${iconHtml(icon, 24)}
  <span class="app-text">
    <span class="app-title">${esc(cardTitle(card))}</span>
    <span class="app-tag">${inline(tagline)}</span>
  </span>
</a>`;
}


// The dashboard's category glyphs (dashboard/public/js/app.js), on a 24-unit grid.
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

const catLabel = (cat, lang) => (cat ? t(lang, `cat_${cat.id}`) : '');

/* ----------------------------------------------------------------- pages */

// Everything installable. The dashboard is HomeBox itself, not an app in its catalog.
const catalogOf = (modules) => modules.filter((m) => m.id !== 'dashboard');

/*
 * The home page is built from the dashboard's own pieces — the Overview's four
 * numbers, an app tile with its memory bar, the Updates and Backups panels —
 * so the site and the thing it installs look like one product. The figures in
 * those pieces are examples and the preview says so.
 */

const byId = (modules, id) => modules.find((m) => m.id === id);

/** A dashboard-style app tile: icon, name, state dot, memory and a bar. */
function previewTile(lang, m, memory, pct, cpu) {
  if (!m) return '';
  return `<div class="dtile">
    <div class="dtile-head">${iconHtml(m, 20)}<b>${esc(m.title)}</b><span class="dot"></span></div>
    <div class="dtile-use"><span>${esc(t(lang, 'pv_memory'))}${cpu ? ` · CPU ${cpu}%` : ''}</span><b>${esc(memory)}</b></div>
    <div class="dbar"><i style="width:${pct}%"></i></div>
  </div>`;
}

function overviewPreview(lang, modules) {
  const stat = (label, value, extra = '') => `<div class="dstat${extra}"><span>${esc(label)}</span><b>${esc(value)}</b></div>`;
  return `<div class="preview" aria-label="${esc(t(lang, 'preview_note'))}">
    <div class="preview-bar"><i></i><i></i><i></i><span>${esc(t(lang, 'preview_label'))}</span></div>
    <div class="dstats">
      ${stat(t(lang, 'pv_status'), t(lang, 'pv_all_running'), ' is-good')}
      ${stat(t(lang, 'pv_apps'), '11')}
      ${stat(t(lang, 'pv_containers'), t(lang, 'pv_up').replace('{n}', 23))}
      ${stat(t(lang, 'pv_updates'), t(lang, 'pv_waiting').replace('{n}', 2), ' is-waiting')}
    </div>
    <div class="dgroup">
      <div class="dgroup-label">${esc(t(lang, 'cat_media'))} <span>3</span></div>
      <div class="dtiles">
        ${previewTile(lang, byId(modules, 'photos'), '1.4GB', 100, 6)}
        ${previewTile(lang, byId(modules, 'jellyfin'), '459MB', 33, 3)}
        ${previewTile(lang, byId(modules, 'audiobookshelf'), '140MB', 10)}
      </div>
    </div>
    <p class="preview-note">${esc(t(lang, 'preview_note'))}</p>
  </div>`;
}

/** One row of a dashboard list: icon, name with a kind badge, a mono line, a button. */
function panelRow(m, name, badge, line, action, prose = false) {
  if (!m) return '';
  return `<div class="prow">${iconHtml(m, 22)}
    <div class="prow-main"><div>${esc(name)}${badge}</div><div class="prow-line${prose ? ' is-prose' : ''}"${prose ? '' : ' dir="ltr"'}>${esc(line)}</div></div>
    ${action ? `<span class="pbtn">${esc(action)}</span>` : ''}
  </div>`;
}

function homePage(lang, modules, cats, guides) {
  // The same cards the Apps page lists, so the two counts cannot disagree.
  const cards = catalogCards(modules);
  const kind = (cls, key) => `<span class="kind ${cls}">${esc(t(lang, key))}</span>`;

  const updates = `<div class="dpanel">
      <div class="dpanel-head"><h3>${esc(t(lang, 'f_updates_title'))}</h3><small>${esc(t(lang, 'pn_updates_note'))}</small></div>
      ${panelRow(byId(modules, 'bookmarks'), 'linkding', kind('v', 'pn_new_version'), '1.46.2 → 1.47.0', t(lang, 'pn_upgrade'))}
      ${panelRow(byId(modules, 'passwords'), 'Vaultwarden', kind('r', 'pn_rebuild'), t(lang, 'pn_same_version'), t(lang, 'pn_update'))}
      <p class="dpanel-body">${esc(t(lang, 'f_updates_body'))}</p>
    </div>`;
  const backups = `<div class="dpanel is-good">
      <div class="dpanel-head"><h3>${esc(t(lang, 'f_backups_title'))}</h3><small>${esc(t(lang, 'pn_backups_note'))}</small></div>
      <p class="dpanel-answer">${esc(t(lang, 'pn_backed_up'))}</p>
      <p class="dpanel-body">${esc(t(lang, 'f_backups_body'))}</p>
    </div>`;
  const remote = `<div class="dpanel">
      <div class="dpanel-head"><h3>${esc(t(lang, 'f_remote_title'))}</h3></div>
      ${['tailscale', 'headscale', 'vpn', 'tunnel'].map((id) => {
        const m = byId(modules, id);
        return m ? panelRow(m, m.title, '', moduleText(m, lang).tagline, '', true) : '';
      }).join('')}
    </div>`;

  // Three shelves of apps people come looking for, like "Your apps" on a box.
  const groups = [
    ['grp_media', ['photos', 'jellyfin', 'audiobookshelf']],
    ['grp_home', ['homeassistant', 'pi-hole', 'frigate']],
    ['grp_work', ['cloud', 'paperless', 'passwords']],
  ].map(([key, ids]) => {
    const rows = ids.map((id) => byId(modules, id)).filter(Boolean);
    if (rows.length !== ids.length) warnings.push(`home: a group app id no longer matches a module (${key})`);
    return `<div class="dgroup">
      <div class="dgroup-label">${esc(t(lang, key))}</div>
      <div class="dlist">${rows.map((m) => `<a class="dtile is-row" href="${href(lang, `apps/${m.id}/`)}">
        <div class="dtile-head">${iconHtml(m, 20)}<b>${esc(m.title)}</b><span class="dtile-tag">${esc(moduleText(m, lang).tagline)}</span></div>
      </a>`).join('')}</div>
    </div>`;
  }).join('');

  return layout({
    lang, pagePath: '', current: 'home',
    body: `
<section class="hero">
  <div class="wrap hero-in">
    <div class="hero-text">
      <p class="eyebrow">${esc(t(lang, 'eyebrow'))}</p>
      <h1>${esc(t(lang, 'hero_b_title_a'))} <span class="accent">${esc(t(lang, 'hero_b_title_b'))}</span></h1>
      <p class="lead">${esc(t(lang, 'hero_b_lead'))}</p>
      ${installBlock(lang, 'hero-cmd')}
      <p class="install-meta">${esc(t(lang, 'requirements'))} · ${esc(t(lang, 'hero_b_meta'))} · <a href="${href(lang, 'guides/install/')}">${esc(t(lang, 'install_guide_link'))}</a></p>
    </div>
    ${overviewPreview(lang, modules)}
  </div>
</section>

<section class="band">
  <div class="wrap">
    <div class="band-head"><div><h2>${esc(t(lang, 'panels_heading'))}</h2><p class="band-side">${esc(t(lang, 'panels_side'))}</p></div></div>
    <div class="dpanels">${updates}${backups}${remote}</div>
  </div>
</section>

<section class="band">
  <div class="wrap">
    <div class="band-head"><div><h2>${esc(t(lang, 'groups_heading').replace('{n}', cards.length))}</h2><p class="band-side">${esc(t(lang, 'apps_side'))}</p></div>
      <a class="btn-ghost" href="${href(lang, 'apps/')}">${esc(t(lang, 'more_in_catalog').replace('{n}', cards.length))}</a></div>
    <div class="dgroups">${groups}</div>
  </div>
</section>

<section class="band">
  <div class="wrap">
    <div class="band-head"><div><h2>${esc(t(lang, 'guides_heading'))}</h2></div><a class="btn-ghost no-arrow" href="${href(lang, 'guides/')}">${esc(t(lang, 'all_guides'))}</a></div>
    <div class="guide-grid">${guides[lang].slice(0, 6).map((g, i) => guideCard(g, lang, i)).join('')}</div>
  </div>
</section>
`,
  });
}

function appsPage(lang, modules, cats) {
  const listed = catalogCards(modules);
  const usedCats = cats.filter((c) => listed.some((card) => card.module.category === c.id));
  // Category tiles, as on the dashboard's Apps screen: a line glyph, the name, a count.
  const tile = (id, label, n, on) => `<button type="button" class="cat-tile" aria-pressed="${on}" data-filter="${esc(id)}">
      <svg viewBox="0 0 24 24" aria-hidden="true">${CATEGORY_GLYPHS[id || 'all'] || CATEGORY_GLYPHS.core}</svg>
      <span class="cat-name">${esc(label)}</span>
      <span class="cat-count">${esc(t(lang, 'apps_count').replace('{n}', n))}</span>
    </button>`;
  const chips = [tile('', t(lang, 'all'), listed.length, true)]
    .concat(usedCats.map((c) => tile(c.id, catLabel(c, lang), listed.filter((card) => card.module.category === c.id).length, false)))
    .join('');
  return layout({
    lang, pagePath: 'apps/', current: 'apps', title: t(lang, 'nav_apps'),
    description: t(lang, 'apps_lead'),
    body: `
<section class="wrap page">
  <div class="store-head">
    <p class="eyebrow">${esc(t(lang, 'apps_eyebrow'))}</p>
    <h1>${esc(t(lang, 'apps_title').replace('{n}', listed.length))}</h1>
    <p class="lead">${esc(t(lang, 'apps_lead'))}</p>
  </div>
  <div class="filters">
    <input type="search" class="search" placeholder="${esc(t(lang, 'search_apps'))}" aria-label="${esc(t(lang, 'search_apps'))}">
    <div class="cat-tiles" role="group">${chips}</div>
  </div>
  <div class="app-grid tiles store" id="apps">${listed.map((c) => appCard(c, lang, cats)).join('')}</div>
  <p class="empty" hidden>${esc(t(lang, 'no_match'))}</p>
</section>`,
  });
}

function appPage(lang, m, cats) {
  const tx = moduleText(m, lang);
  const cat = cats.find((c) => c.id === m.category);
  const services = m.services.filter((s) => !s.internal);
  // Each app gets its own one-line description only where a module has several;
  // for a single app the module description above already is that line.
  const multiApp = services.filter((s) => s.port != null).length > 1;
  const svcRows = services.map((s) => `
    <tr id="svc-${esc(s.name)}"><td><strong>${esc(s.friendly_name)}</strong>${multiApp && s.description ? `<br><span class="muted">${inline(serviceText(m, s, lang))}</span>` : ''}</td><td dir="ltr">${s.port ? `<code>:${esc(s.port)}</code>` : '—'}</td><td dir="ltr">${s.first_login ? inline(s.first_login) : '—'}</td></tr>`).join('');
  const tipsNote = lang === 'he' && m.tips.length ? `<p class="note">${esc(t(lang, 'tips_in_english'))}</p>` : '';
  const fallback = lang === 'he' && !tx.translated ? `<p class="note">${esc(t(lang, 'text_in_english'))}</p>` : '';

  return layout({
    lang, pagePath: `apps/${m.id}/`, current: 'apps', title: m.title,
    description: tx.tagline,
    body: `
<article class="wrap page app-page">
  <p class="crumbs"><a href="${href(lang, 'apps/')}">${esc(t(lang, 'nav_apps'))}</a> / ${esc(catLabel(cat, lang))}</p>
  <header class="app-head">
    ${iconHtml(m, 64)}
    <div>
      <h1>${esc(m.title)}</h1>
      <p class="lead">${inline(tx.tagline)}</p>
    </div>
  </header>
  ${fallback}
  <p class="desc">${inline(tx.description)}</p>

  <div class="facts">
    <div><span>${esc(t(lang, 'category'))}</span><strong>${esc(catLabel(cat, lang))}</strong></div>
    ${m.ram ? `<div><span>${esc(t(lang, 'memory'))}</span><strong dir="ltr">${esc(m.ram)}</strong></div>` : ''}
    <div><span>${esc(t(lang, 'module_id'))}</span><strong><code>${esc(m.id)}</code></strong></div>
  </div>

  <h2>${esc(t(lang, 'how_install'))}</h2>
  <p>${esc(t(lang, 'how_install_body'))}</p>
  <pre dir="ltr"><code>sudo homebox install ${esc(m.id)}</code></pre>

  ${services.length ? `<h2>${esc(t(lang, 'where_to_open'))}</h2>
  <div class="table-wrap"><table>
    <thead><tr><th>${esc(t(lang, 'service'))}</th><th>${esc(t(lang, 'port'))}</th><th>${esc(t(lang, 'first_login'))}</th></tr></thead>
    <tbody>${svcRows}</tbody>
  </table></div>
  <p class="muted">${esc(t(lang, 'port_note'))}</p>` : ''}

  ${m.tips.length ? `<h2>${esc(t(lang, 'tips'))}</h2>${tipsNote}<ul class="tips" dir="ltr">${m.tips.map((x) => `<li>${inline(x)}</li>`).join('')}</ul>` : ''}

  <p class="source-link"><a href="${REPO}/blob/main/modules/${esc(path.basename(m.dir))}/docker-compose.yml">${esc(t(lang, 'view_definition'))}</a></p>
</article>`,
  });
}

const guideCard = (g, lang, i = null) => `<a class="guide-card" href="${href(lang, `guides/${g.slug}/`)}">
  ${i == null ? '' : `<span class="mono-label">${String(i + 1).padStart(2, '0')}</span>`}
  <span class="guide-title">${esc(g.title)}</span>
  <span class="guide-sum">${esc(g.summary)}</span>
</a>`;

function guidesPage(lang, guides) {
  return layout({
    lang, pagePath: 'guides/', current: 'guides', title: t(lang, 'nav_guides'),
    body: `
<section class="wrap page">
  <h1>${esc(t(lang, 'guides_title'))}</h1>
  <p class="lead">${esc(t(lang, 'guides_lead'))}</p>
  <div class="guide-grid">${guides[lang].map((g, i) => guideCard(g, lang, i)).join('')}</div>
</section>`,
  });
}

function guidePage(lang, g, all) {
  const i = all.findIndex((x) => x.slug === g.slug);
  const prev = all[i - 1];
  const next = all[i + 1];
  const body = g.body.replace(/\{\{install\}\}/g, installBlock(lang));
  return layout({
    lang, pagePath: `guides/${g.slug}/`, current: 'guides', title: g.title, description: g.summary,
    body: `
<article class="wrap page prose">
  <p class="crumbs"><a href="${href(lang, 'guides/')}">${esc(t(lang, 'nav_guides'))}</a></p>
  <h1>${esc(g.title)}</h1>
  ${g.summary ? `<p class="lead">${esc(g.summary)}</p>` : ''}
  ${body}
  <nav class="pager">
    ${prev ? `<a href="${href(lang, `guides/${prev.slug}/`)}">← ${esc(prev.title)}</a>` : '<span></span>'}
    ${next ? `<a href="${href(lang, `guides/${next.slug}/`)}">${esc(next.title)} →</a>` : '<span></span>'}
  </nav>
</article>`,
  });
}

function changelogPage(lang, releases) {
  const items = releases.length
    ? releases.map((r) => `<li class="release">
      <div class="release-head"><h2 dir="ltr">${esc(r.tag)}</h2><time datetime="${esc(r.date)}">${esc(r.date)}</time></div>
      ${r.body ? `<div class="release-body" dir="ltr">${r.body.split(/\n{2,}/).map((p) => `<p>${inline(p.replace(/\n/g, ' '))}</p>`).join('')}</div>` : ''}
    </li>`).join('')
    : `<li><a href="${REPO}/tags">${esc(t(lang, 'see_tags'))}</a></li>`;
  return layout({
    lang, pagePath: 'changelog/', current: 'changelog', title: t(lang, 'nav_changelog'),
    body: `
<section class="wrap page">
  <h1>${esc(t(lang, 'nav_changelog'))}</h1>
  <p class="lead">${esc(t(lang, 'changelog_lead'))}</p>
  ${lang === 'he' ? `<p class="note">${esc(t(lang, 'changelog_english'))}</p>` : ''}
  <ol class="releases">${items}</ol>
</section>`,
  });
}

function notFoundPage() {
  return layout({
    lang: 'en', pagePath: '', title: 'Not found',
    body: `<section class="wrap page"><h1>Not found</h1><p class="lead">That page does not exist. <a href="/">Home</a> · <a href="/he/" lang="he" dir="rtl">דף הבית</a></p></section>`,
  });
}

/* ------------------------------------------------------------------ main */

async function main() {
  const { modules, errors } = await modulesLib.loadAll();
  if (errors.length) throw new Error(`module errors:\n${errors.map((e) => `  ${e.module}: ${e.error}`).join('\n')}`);
  const cats = modulesLib.CATEGORIES;
  const sorted = modules.slice().sort((a, b) => a.title.localeCompare(b.title));
  const guides = loadGuides();
  const releases = loadReleases();

  for (const key of Object.keys(HE_MODULES)) {
    if (!modules.some((m) => m.id === key)) warnings.push(`he: translation for "${key}" has no module — remove it`);
  }

  // Empty dist/ rather than deleting it: on Windows a folder that a terminal
  // or preview server has open cannot be removed, only its contents can.
  fs.mkdirSync(DIST, { recursive: true });
  for (const entry of fs.readdirSync(DIST)) fs.rmSync(path.join(DIST, entry), { recursive: true, force: true });

  let pages = 0;
  const urls = [];
  const emit = (rel, html, url) => { write(rel, html); pages += 1; if (url != null) urls.push(url); };

  for (const lang of LANGS) {
    const base = lang === 'he' ? 'he/' : '';
    emit(`${base}index.html`, homePage(lang, sorted, cats, guides, releases), href(lang));
    emit(`${base}apps/index.html`, appsPage(lang, sorted, cats), href(lang, 'apps/'));
    for (const m of sorted) {
      if (m.id === 'dashboard') continue;
      emit(`${base}apps/${m.id}/index.html`, appPage(lang, m, cats), href(lang, `apps/${m.id}/`));
    }
    emit(`${base}guides/index.html`, guidesPage(lang, guides), href(lang, 'guides/'));
    for (const g of guides[lang]) emit(`${base}guides/${g.slug}/index.html`, guidePage(lang, g, guides[lang]), href(lang, `guides/${g.slug}/`));
    emit(`${base}changelog/index.html`, changelogPage(lang, releases), href(lang, 'changelog/'));
  }
  emit('404.html', notFoundPage(), null);

  const icons = copyDir(path.join(ROOT, 'dashboard/public/icons'), path.join(DIST, 'icons'));
  const statics = copyDir(path.join(SITE, 'static'), DIST);
  fs.writeFileSync(path.join(DIST, 'CNAME'), `${DOMAIN}\n`);
  fs.writeFileSync(path.join(DIST, '.nojekyll'), '');
  fs.writeFileSync(path.join(DIST, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>https://${DOMAIN}${u}</loc></url>`).join('\n')}
</urlset>
`);

  console.log(`built ${pages} pages, ${icons} icons, ${statics} static files, ${releases.length} releases -> ${path.relative(ROOT, DIST)}`);
  if (warnings.length) {
    console.log(`\n${warnings.length} warning(s):`);
    for (const w of warnings) console.log(`  - ${w}`);
  }
  if (process.argv.includes('--strict') && warnings.length) process.exit(2);
}

if (require.main === module) {
  main().catch((err) => { console.error(`build failed: ${err.message}`); process.exit(1); });
}

module.exports = { sourceHash, textHash };
