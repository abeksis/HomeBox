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

// The hero's install card: the command in a terminal line, one big copy button.
const installCard = (lang) => `
<div class="install-card">
  <p class="install-label">${esc(t(lang, 'install_label'))}</p>
  ${installBlock(lang, 'hero-cmd')}
  <p class="install-meta">${esc(t(lang, 'requirements'))} · <a href="${href(lang, 'guides/install/')}">${esc(t(lang, 'install_guide_link'))}</a></p>
</div>`;

// Section header in the house style: small mono label, big heading, and a line of context beside it.
const sectionHead = (eyebrow, heading, side) => `
  <div class="band-head">
    <div class="band-title">
      <p class="eyebrow">${esc(eyebrow)}</p>
      <h2>${esc(heading)}</h2>
    </div>
    ${side ? `<p class="band-side">${esc(side)}</p>` : ''}
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


const catLabel = (cat, lang) => (cat ? t(lang, `cat_${cat.id}`) : '');

/* ----------------------------------------------------------------- pages */

// Everything installable. The dashboard is HomeBox itself, not an app in its catalog.
const catalogOf = (modules) => modules.filter((m) => m.id !== 'dashboard');

// The tiles on the home page, in this order: the apps people come looking for.
const FEATURED = [
  'photos', 'jellyfin', 'cloud', 'passwords', 'pi-hole', 'homeassistant', 'frigate',
  'paperless', 'media/sonarr', 'media/radarr', 'media/prowlarr', 'media/bazarr', 'media/qbittorrent', 'navidrome',
  'automation', 'headscale',
];

function homePage(lang, modules, cats, guides, releases) {
  // The same cards the Apps page lists, so the two counts cannot disagree.
  const cards = catalogCards(modules);
  const featured = FEATURED.map((key) => cards.find((c) => c.key === key)).filter(Boolean);
  if (featured.length !== FEATURED.length) warnings.push('home: a featured app key no longer matches a catalog card');
  const features = ['one', 'updates', 'backups', 'remote', 'logs', 'yours'].map((k, i) => `
    <div class="feature">
      <span class="mono-label">${String(i + 1).padStart(2, '0')}</span>
      <h3>${esc(t(lang, `f_${k}_title`))}</h3>
      <p>${esc(t(lang, `f_${k}_body`))}</p>
    </div>`).join('');
  const stats = [
    [cards.length, t(lang, 'stat_apps')],
    [guides[lang].length, t(lang, 'stat_guides')],
    [releases.length || '—', t(lang, 'stat_releases')],
    [0, t(lang, 'stat_accounts')],
  ].map(([n, label]) => `<div class="stat"><strong>${esc(n)}</strong><span>${esc(label)}</span></div>`).join('');
  const screens = screenshotsHtml(lang);

  return layout({
    lang, pagePath: '', current: 'home',
    body: `
<section class="hero band">
  <div class="wrap hero-in">
    <div class="hero-text">
      <p class="pill">${esc(t(lang, 'eyebrow'))}</p>
      <h1>${esc(t(lang, 'hero_title_a'))} <span class="accent">${esc(t(lang, 'hero_title_b'))}</span></h1>
      <p class="lead">${esc(t(lang, 'hero_lead'))}</p>
    </div>
    ${installCard(lang)}
  </div>
</section>

<section class="stats-band">
  <div class="wrap stats">${stats}</div>
</section>

<section class="band" id="apps-preview">
  <div class="wrap">
    ${sectionHead(t(lang, 'apps_eyebrow'), t(lang, 'apps_heading').replace('{n}', cards.length), t(lang, 'apps_side'))}
    <div class="app-grid tiles">${featured.map((c) => appCard(c, lang, cats)).join('')}</div>
    <p class="more-line"><a class="btn-ghost" href="${href(lang, 'apps/')}">${esc(t(lang, 'more_in_catalog').replace('{n}', cards.length))}</a></p>
  </div>
</section>

<section class="band alt">
  <div class="wrap">
    ${sectionHead(t(lang, 'features_eyebrow'), t(lang, 'features_heading'), t(lang, 'features_side'))}
    <div class="features">${features}</div>
  </div>
</section>

${screens}

<section class="band">
  <div class="wrap">
    ${sectionHead(t(lang, 'guides_eyebrow'), t(lang, 'guides_heading'), '')}
    <div class="guide-grid">${guides[lang].slice(0, 6).map((g, i) => guideCard(g, lang, i)).join('')}</div>
    <p class="more-line"><a href="${href(lang, 'guides/')}">${esc(t(lang, 'all_guides'))}</a></p>
  </div>
</section>

<section class="band cta">
  <div class="wrap cta-in">
    <h2>${esc(t(lang, 'cta_heading'))}</h2>
    ${installBlock(lang, 'cta-cmd')}
  </div>
</section>
`,
  });
}

function screenshotsHtml(lang) {
  const dir = path.join(SITE, 'static', 'screens');
  if (!fs.existsSync(dir)) return '';
  const shots = fs.readdirSync(dir).filter((f) => /\.(png|jpe?g|webp)$/i.test(f)).sort();
  if (!shots.length) return '';
  return `<section class="band wrap">
  <h2>${esc(t(lang, 'screens_title'))}</h2>
  <div class="shots">${shots.map((f) => `<figure><img src="/screens/${esc(f)}" alt="" loading="lazy"></figure>`).join('')}</div>
</section>`;
}

function appsPage(lang, modules, cats) {
  const listed = catalogCards(modules);
  const usedCats = cats.filter((c) => listed.some((card) => card.module.category === c.id));
  const chips = [`<button type="button" class="chip" aria-pressed="true" data-filter="">${esc(t(lang, 'all'))} <span>${listed.length}</span></button>`]
    .concat(usedCats.map((c) => `<button type="button" class="chip" aria-pressed="false" data-filter="${esc(c.id)}">${esc(catLabel(c, lang))} <span>${listed.filter((card) => card.module.category === c.id).length}</span></button>`))
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
    <div class="chips" role="group">${chips}</div>
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
