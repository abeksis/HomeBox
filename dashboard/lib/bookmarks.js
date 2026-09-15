'use strict';
/**
 * Quick Access: links to things that are not on this box.
 *
 * Trackers, a router, a NAS, anything with a URL. HomeBox cannot discover
 * these — no container owns them — so they are typed in once and kept.
 *
 * Stored on the SERVER, unlike the Launcher's custom items, which live in
 * localStorage. The difference is what the thing is: hiding a launcher tile is
 * a view preference belonging to one browser, whereas a bookmark is a fact
 * about this setup and should be on the phone as well as the desktop.
 *
 * Icons given as a URL are downloaded through `icons.js` and served from this
 * box, for the same reason as everywhere else: a hot-linked icon breaks when
 * somebody else's server does.
 */

const fsp = require('fs/promises');
const crypto = require('crypto');

const state = require('./state-store');
const icons = require('./icons');

const FILE = 'bookmarks.json';
const MAX = 60;

const clean = (text, max) => String(text == null ? '' : text).replace(/[\r\n]+/g, ' ').trim().slice(0, max);

/** http(s) only: this value becomes an href, and `javascript:` is not a link. */
function cleanUrl(value) {
  const url = clean(value, 500);
  if (!/^https?:\/\//i.test(url)) throw new Error(`the address has to start with http:// or https:// — got "${url || '(empty)'}"`);
  try {
    new URL(url);
  } catch {
    throw new Error(`that is not a valid address: ${url}`);
  }
  return url;
}

async function read() {
  const raw = await state.readJson(FILE, {});
  const items = Array.isArray(raw && raw.items) ? raw.items : [];
  return {
    items: items
      .filter((b) => b && typeof b.url === 'string' && typeof b.name === 'string')
      .map((b) => ({
        id: String(b.id || ''),
        name: clean(b.name, 60),
        url: clean(b.url, 500),
        subtitle: clean(b.subtitle, 60),
        icon: clean(b.icon, 500),
      })),
  };
}

async function write(items) {
  await state.writeJson(FILE, { items });
  return { items };
}

/** Add one, or replace it when `id` names an existing bookmark. */
async function save(input) {
  const { items } = await read();
  const entry = {
    id: clean(input.id, 40) || `bm-${crypto.randomBytes(6).toString('hex')}`,
    name: clean(input.name, 60),
    url: cleanUrl(input.url),
    subtitle: clean(input.subtitle, 60),
    icon: await icons.localise(clean(input.icon, 500)),
  };
  if (!entry.name) throw new Error('a bookmark needs a name');

  const at = items.findIndex((b) => b.id === entry.id);
  if (at === -1) {
    if (items.length >= MAX) throw new Error(`that is ${MAX} bookmarks — more than a quick-access row can be`);
    items.push(entry);
  } else {
    items[at] = entry;
  }
  await write(items);
  return entry;
}

async function remove(id) {
  const { items } = await read();
  const keep = items.filter((b) => b.id !== id);
  if (keep.length === items.length) throw new Error(`no such bookmark: ${id}`);
  await write(keep);
  await pruneIcons(keep);
  return { id };
}

/** Reorder from a list of ids. Anything not named keeps its relative place. */
async function reorder(ids) {
  const { items } = await read();
  const byId = new Map(items.map((b) => [b.id, b]));
  const ordered = [];
  for (const id of Array.isArray(ids) ? ids : []) {
    if (byId.has(id)) { ordered.push(byId.get(id)); byId.delete(id); }
  }
  return write([...ordered, ...byId.values()]);
}

/** Cached icons no bookmark and no module points at any more. */
async function pruneIcons(items) {
  try {
    const referenced = new Set(items.map((b) => b.icon).filter(Boolean));
    const { modules } = await require('./modules').loadAll();
    for (const mod of modules) {
      if (mod.icon) referenced.add(mod.icon);
      for (const svc of mod.services || []) if (svc.icon) referenced.add(svc.icon);
    }
    for (const over of Object.values((await require('./catalog').read()).overrides)) {
      if (over && over.icon) referenced.add(over.icon);
    }
    const path = require('path');
    for (const name of await icons.unused(referenced)) {
      await fsp.rm(path.join(icons.DIR, name), { force: true });
    }
  } catch {
    /* an orphaned icon is harmless; never fail a delete over cleanup */
  }
}

module.exports = { read, save, remove, reorder, MAX };
