'use strict';
/**
 * Image versions chosen on this box, kept OUT of the tracked compose files.
 *
 * The obvious way to apply a version update from a button is to rewrite the
 * `image:` line in modules/<id>/docker-compose.yml. It is also the wrong way:
 * that file is tracked, `git pull` is how HomeBox itself updates, and a
 * locally edited tracked file turns the next upgrade into a merge conflict on
 * somebody's home server. The feature would work once and then quietly break
 * the thing it lives inside.
 *
 * So a pin is recorded in state/image-pins.json and applied through a compose
 * OVERRIDE file — a second `-f` that changes nothing but the tag. Compose
 * merges them itself; the module file stays exactly as shipped, `git pull`
 * stays clean forever, and removing a pin restores the shipped version with
 * no file to repair.
 *
 * It is the same shape as state/catalog.json, which keeps edited module text
 * out of the compose files for the same reason.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const state = require('./state-store');

const FILE = 'image-pins.json';
const OVERRIDE_DIR = path.join(state.ROOT, 'state', 'overrides');

// A tag reaches a compose file and then an image reference. Anything outside
// what a registry actually accepts is refused before it is written.
const TAG_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const SERVICE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/** { "media/radarr": { image: "lscr.io/...", tag: "6.4.1", at: "..." } } */
const read = () => state.readJson(FILE, {});

const keyOf = (moduleId, service) => `${moduleId}/${service}`;

/** The override file for a module, or null when it has no pins. */
function overrideFile(moduleId) {
  const file = path.join(OVERRIDE_DIR, `${moduleId}.yml`);
  return fs.existsSync(file) ? file : null;
}

/**
 * Rewrite a module's override file from the stored pins.
 *
 * Written by hand rather than through a YAML serialiser: this is four lines
 * per service of a format we fully control, and lib/yaml.js is a reader.
 */
async function writeOverride(moduleId, pins) {
  await fsp.mkdir(OVERRIDE_DIR, { recursive: true });
  const file = path.join(OVERRIDE_DIR, `${moduleId}.yml`);

  const mine = Object.entries(pins)
    .filter(([k]) => k.startsWith(`${moduleId}/`))
    .map(([k, v]) => [k.slice(moduleId.length + 1), v]);

  if (!mine.length) {
    await fsp.rm(file, { force: true });
    return null;
  }

  const lines = [
    '# Written by HomeBox. Do not edit.',
    '#',
    '# Version pins chosen from Settings, applied as a compose override so the',
    '# module file this sits beside stays exactly as shipped and `git pull`',
    '# never conflicts. Delete a pin in the dashboard to go back.',
    'services:',
  ];
  for (const [service, pin] of mine) lines.push(`  ${service}:`, `    image: ${pin.image}:${pin.tag}`);
  await fsp.writeFile(file, `${lines.join('\n')}\n`, 'utf8');
  return file;
}

/** Record a pin and regenerate the override. Returns the previous tag, if any. */
async function set(moduleId, service, image, tag) {
  if (!ID_RE.test(moduleId)) throw new Error(`invalid module id: ${moduleId}`);
  if (!SERVICE_RE.test(service)) throw new Error(`invalid service name: ${service}`);
  if (!TAG_RE.test(tag)) throw new Error(`that does not look like an image tag: ${tag}`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._\-/]{0,200}$/.test(image)) throw new Error(`invalid image: ${image}`);

  const pins = await read();
  const key = keyOf(moduleId, service);
  const previous = pins[key] ? pins[key].tag : null;
  pins[key] = { image, tag, at: new Date().toISOString() };
  await state.writeJson(FILE, pins);
  await writeOverride(moduleId, pins);
  return previous;
}

/** Drop a pin, so the module's shipped version applies again. */
async function clear(moduleId, service) {
  const pins = await read();
  delete pins[keyOf(moduleId, service)];
  await state.writeJson(FILE, pins);
  await writeOverride(moduleId, pins);
}

/** Every pin, for the UI. */
async function list() {
  const pins = await read();
  return Object.entries(pins).map(([key, v]) => {
    const slash = key.indexOf('/');
    return { module: key.slice(0, slash), service: key.slice(slash + 1), ...v };
  });
}

module.exports = { read, list, set, clear, overrideFile, writeOverride };
