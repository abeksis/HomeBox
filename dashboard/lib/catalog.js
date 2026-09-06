'use strict';
/**
 * App Store contents: editing what a module SAYS, and adding new ones.
 *
 * Two different problems, deliberately solved two different ways.
 *
 * 1. **Editing the text of a module that ships with HomeBox** writes to
 *    `state/catalog.json`, not to the module's compose file. A shipped module
 *    is replaced wholesale by an upgrade, so an edit written into it is an
 *    edit that disappears the next time the box is updated. An override layer
 *    survives that, and it can be reset back to whatever the module ships
 *    with — which an in-place edit cannot.
 *
 * 2. **Adding an app writes a real module.** In HomeBox a module IS a compose
 *    file with an `x-homebox:` block, so a user-added app that is anything
 *    less than that would need its own parallel install path, its own status
 *    plumbing and its own backup story. Generating the file instead means it
 *    installs, uninstalls, backs up and appears in the CLI exactly like every
 *    other module, with no code that knows the difference.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const state = require('./state-store');
const yaml = require('./yaml');
const icons = require('./icons');

const MODULES_DIR = path.join(state.ROOT, 'modules');
const FILE = 'catalog.json';

/** Fields the editor may override on a module. Anything else is ignored. */
const TEXT_FIELDS = ['title', 'tagline', 'description', 'category', 'ram', 'icon'];

const SLUG = /^[a-z0-9][a-z0-9-]{1,39}$/;
const IS_IMAGE = (v) => /^https?:\/\//i.test(v) || /\.(png|jpe?g|svg|webp|gif|ico)$/i.test(v);

/**
 * Coerce a category to one the rest of the UI knows about.
 *
 * Required in the browser and again here: the filter chips, the launcher
 * groups and the module sort all key off these ids, so a category that is not
 * in the list is an app that quietly belongs to no group at all.
 *
 * `modules` is required lazily because it requires THIS file at load time;
 * by the time anything calls in, both are fully initialised.
 */
function validCategory(value) {
  const { CATEGORIES } = require('./modules');
  const wanted = String(value || '').trim().toLowerCase();
  return CATEGORIES.some((c) => c.id === wanted) ? wanted : 'other';
}
// A compose image reference. Deliberately strict: this string is written into
// a file that `docker compose` executes.
const IMAGE = /^[A-Za-z0-9][A-Za-z0-9._\-/]{0,200}(:[A-Za-z0-9._-]{1,128})?(@sha256:[a-f0-9]{64})?$/;

/* ------------------------------------------------------------- overrides */

async function read() {
  const raw = await state.readJson(FILE, {});
  return { overrides: raw && typeof raw.overrides === 'object' && raw.overrides ? raw.overrides : {} };
}

/**
 * Merge the override layer onto a list of modules from `modules.loadAll()`.
 * Only known fields, only strings, and `tips` only as an array of strings —
 * this object came from disk and lands directly in the page.
 */
function apply(modules, overrides) {
  if (!overrides) return modules;
  return modules.map((mod) => {
    const over = overrides[mod.id];
    if (!over || typeof over !== 'object') return mod;
    const patch = {};
    for (const key of TEXT_FIELDS) {
      if (typeof over[key] === 'string' && over[key].trim()) patch[key] = over[key];
    }
    if (Array.isArray(over.tips)) patch.tips = over.tips.filter((t) => typeof t === 'string' && t.trim());
    return Object.keys(patch).length ? { ...mod, ...patch, edited: true } : mod;
  });
}

function clean(text, max) {
  return String(text == null ? '' : text).replace(/[\r\n]+/g, ' ').trim().slice(0, max);
}

/** Save an override for one module. Empty fields clear back to the shipped text. */
async function saveOverride(id, fields) {
  if (!SLUG.test(id || '')) throw new Error(`invalid module id: ${id}`);
  if (!fs.existsSync(path.join(MODULES_DIR, id, 'docker-compose.yml'))) {
    throw new Error(`no such module: ${id}`);
  }
  const data = await read();
  const entry = {};
  for (const key of TEXT_FIELDS) {
    let value = clean(fields[key], key === 'description' ? 1200 : key === 'icon' ? 500 : 180);
    // `normalize()` checks a module's declared category against the known
    // list, but an override is patched on AFTER that and would otherwise slip
    // an unknown one straight through — "Network" with a capital N stopped
    // matching `network` and the app vanished from its own group.
    if (key === 'category' && value) value = validCategory(value);
    if (value) entry[key] = value;
  }
  if (fields.tips != null) {
    // The form is a textarea, one note per line — the same shape as `tips:`.
    const tips = (Array.isArray(fields.tips) ? fields.tips : String(fields.tips).split('\n'))
      .map((t) => clean(t, 400))
      .filter(Boolean)
      .slice(0, 12);
    if (tips.length) entry.tips = tips;
  }

  // A URL is fetched and replaced with a local path here rather than saved
  // as-is: an icon that lives on somebody else's server disappears when they
  // do. Failing loudly beats silently keeping the fragile version.
  if (entry.icon) entry.icon = await icons.localise(entry.icon);

  if (Object.keys(entry).length) data.overrides[id] = entry;
  else delete data.overrides[id];
  await state.writeJson(FILE, data);
  await pruneIcons();   // the icon this one replaced may now be unreferenced
  return { id, override: data.overrides[id] || null };
}

/** Drop an override, so the module reads exactly as it ships again. */
async function resetOverride(id) {
  if (!SLUG.test(id || '')) throw new Error(`invalid module id: ${id}`);
  const data = await read();
  delete data.overrides[id];
  await state.writeJson(FILE, data);
  await pruneIcons();
  return { id };
}

/**
 * Delete cached icons nothing points at any more.
 *
 * Referenced means referenced by a module OR one of its services OR a live
 * override — an icon still named by a compose file must survive its override
 * being reset. Computed from the merged module list, so it cannot miss one.
 */
async function pruneIcons() {
  try {
    const { modules } = await require('./modules').loadAll();
    const referenced = new Set();
    for (const mod of modules) {
      if (mod.icon) referenced.add(mod.icon);
      for (const svc of mod.services || []) if (svc.icon) referenced.add(svc.icon);
    }
    for (const over of Object.values((await read()).overrides)) {
      if (over && over.icon) referenced.add(over.icon);
    }
    for (const name of await icons.unused(referenced)) {
      await fsp.rm(path.join(icons.DIR, name), { force: true });
    }
  } catch {
    /* an orphaned icon is harmless; never fail a save over cleanup */
  }
}

/* ----------------------------------------------------- user-added modules */

/** YAML double-quoted scalar. The value is data, and must not become syntax. */
function q(text) {
  return `"${String(text == null ? '' : text).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function composeFor(app) {
  const tips = app.tips.length
    ? `  tips:\n${app.tips.map((t) => `    - ${q(t)}`).join('\n')}\n`
    : '';
  return `# Generated by HomeBox from Settings > App Store contents.
#
# This is an ordinary module: edit it by hand, back it up, or delete the
# directory. \`user_created\` only tells the App Store it may offer a Delete
# button, since removing a shipped module would just come back on upgrade.
x-homebox:
  id: ${q(app.slug)}
  title: ${q(app.name)}
  tagline: ${q(app.tagline)}
  description: ${q(app.description)}
  category: ${q(app.category)}
  ram: ${q(app.ram)}
  user_created: true
${app.iconIsImage ? `  icon: ${q(app.icon)}\n` : ''}  theme:
    emoji: ${q(app.iconIsImage ? '\u{1F4E6}' : (app.icon || '\u{1F4E6}'))}
  services:
    ${app.serviceName}:
      friendly_name: ${q(app.name)}
      description: ${q(app.tagline)}
${app.iconIsImage ? `      icon: ${q(app.icon)}\n` : ''}      port_map: ${app.port}
      container_port: ${app.containerPort}
      url_scheme: "http"
${tips}
services:
  ${app.serviceName}:
    image: ${q(app.image)}
    container_name: ${app.serviceName}
    restart: unless-stopped
    environment:
      - TZ=\${TZ:-UTC}
      - PUID=\${PUID:-1000}
      - PGID=\${PGID:-1000}
    volumes:
      - \${HB_ROOT:-/opt/homebox}/modules/${app.slug}/config:/config
    ports:
      - "${app.port}:${app.containerPort}"
    networks:
      - homebox_proxy

networks:
  homebox_proxy:
    external: true
`;
}

function validate(input) {
  const slug = clean(input.slug || input.name, 40).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!SLUG.test(slug)) throw new Error('the name needs at least two letters or digits');

  const image = clean(input.image, 300);
  if (!IMAGE.test(image)) throw new Error(`that does not look like a Docker image: ${image || '(empty)'}`);

  const port = Number(input.port);
  const containerPort = Number(input.containerPort);
  for (const [label, value] of [['Host port', port], ['Container port', containerPort]]) {
    if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error(`${label} must be 1-65535`);
  }

  const serviceName = clean(input.serviceName || slug, 40).toLowerCase().replace(/[^a-z0-9-]+/g, '-') || slug;
  const ramMb = Number(input.ramMb);

  return {
    slug,
    serviceName,
    image,
    port,
    containerPort,
    name: clean(input.name, 80) || slug,
    tagline: clean(input.tagline, 180),
    description: clean(input.description, 1200),
    category: validCategory(input.category),
    ram: Number.isFinite(ramMb) && ramMb > 0 ? `${Math.round(ramMb)}MB` : '?',
    icon: clean(input.icon, 500),
    // A URL or a filename is an image the renderer loads; anything else is an
    // emoji, and the two are read by different fields.
    iconIsImage: IS_IMAGE(clean(input.icon, 500)),
    tips: String(input.tips || '').split('\n').map((t) => clean(t, 400)).filter(Boolean).slice(0, 12),
  };
}

/**
 * Write a new module. Parsed back before it is accepted: a file that does not
 * round-trip through the same reader the rest of HomeBox uses would show up
 * as a broken module on the Apps page with no clue where it came from.
 */
async function createApp(input) {
  const app = validate(input || {});
  if (app.iconIsImage && icons.isRemote(app.icon)) app.icon = await icons.localise(app.icon);
  const dir = path.join(MODULES_DIR, app.slug);
  if (fs.existsSync(dir)) throw new Error(`a module called "${app.slug}" already exists`);

  const text = composeFor(app);
  const meta = yaml.extractTopLevel(text, 'x-homebox');
  if (!meta || !meta.id) throw new Error('the generated module did not parse — nothing was written');

  await fsp.mkdir(path.join(dir, 'config'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'docker-compose.yml'), text, 'utf8');
  await matchOwner(dir);
  return { id: app.slug, file: path.join(dir, 'docker-compose.yml') };
}

/**
 * Delete a user-added module. Refuses a shipped one — the directory would
 * come back on the next upgrade, so the button would be a lie — and refuses
 * while containers still exist, because uninstalling is a separate, visible
 * step and deleting the file first would strand them with nothing that owns
 * them.
 */
async function deleteApp(id, { installed }) {
  if (!SLUG.test(id || '')) throw new Error(`invalid module id: ${id}`);
  const dir = path.join(MODULES_DIR, id);
  const file = path.join(dir, 'docker-compose.yml');
  if (!fs.existsSync(file)) throw new Error(`no such module: ${id}`);

  const meta = yaml.extractTopLevel(await fsp.readFile(file, 'utf8'), 'x-homebox') || {};
  if (meta.user_created !== true) {
    throw new Error(`${id} ships with HomeBox — it can be edited, but not deleted`);
  }
  if (installed) throw new Error(`uninstall ${id} first, then delete it`);

  await fsp.rm(dir, { recursive: true, force: true });
  await resetOverride(id);   // also prunes any icon it was the last user of
  return { id };
}

/** Keep generated files owned by whoever owns the tree, like the CLI does. */
async function matchOwner(target) {
  try {
    const root = await fsp.stat(state.ROOT);
    await fsp.chown(target, root.uid, root.gid);
    for (const entry of await fsp.readdir(target, { withFileTypes: true })) {
      await fsp.chown(path.join(target, entry.name), root.uid, root.gid);
    }
  } catch {
    /* not root, or a filesystem that will not chown */
  }
}

module.exports = { read, apply, saveOverride, resetOverride, createApp, deleteApp, TEXT_FIELDS };
