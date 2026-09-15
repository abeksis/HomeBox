#!/usr/bin/env node
'use strict';
/**
 * Mark Hebrew module translations as current.
 *
 *   node site/stamp-he.js jellyfin media     # after re-translating those two
 *   node site/stamp-he.js --all              # only when every entry was just translated
 *
 * Each entry in i18n/he-modules.json records a hash of the English it was
 * translated from. The build compares it against the module as it is now and
 * shows English for any entry whose source moved. Stamping says "this Hebrew
 * matches the current English" — so stamp only what you actually re-read.
 */
const fs = require('fs');
const path = require('path');

const SITE = __dirname;
const ROOT = path.resolve(SITE, '..');
process.env.HOMEBOX_ROOT = ROOT;
const modulesLib = require(path.join(ROOT, 'dashboard/lib/modules.js'));
const { sourceHash, textHash } = require('./build.js');

const FILE = path.join(SITE, 'i18n/he-modules.json');
const args = process.argv.slice(2);
if (!args.length) {
  console.error('usage: node site/stamp-he.js <module-id>... | --all');
  process.exit(1);
}

modulesLib.loadAll().then(({ modules }) => {
  const he = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  const ids = args.includes('--all') ? Object.keys(he) : args;
  let n = 0;
  for (const id of ids) {
    const m = modules.find((x) => x.id === id);
    if (!m) { console.error(`no module "${id}"`); process.exitCode = 1; continue; }
    if (!he[id]) { console.error(`no Hebrew entry for "${id}"`); process.exitCode = 1; continue; }
    he[id].src = sourceHash(m);
    // The short descriptions of the apps inside a multi-app module.
    for (const [name, entry] of Object.entries(he[id].services || {})) {
      const svc = m.services.find((x) => x.name === name);
      if (svc) entry.src = textHash(svc.description || '');
      else console.error(`"${id}" has no app "${name}" — its translation is left unstamped`);
    }
    n += 1;
  }
  fs.writeFileSync(FILE, `${JSON.stringify(he, null, 2)}\n`);
  console.log(`stamped ${n} translation(s)`);
});
