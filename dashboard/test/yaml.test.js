'use strict';
/**
 * Tests for the YAML subset parser.
 *
 * The parser is small and hand-written, which is fine right up until a module
 * silently loses half its metadata because a nested list under a dash parsed
 * as a string. These cases are the shapes the module files actually use, plus
 * the failures that must stay loud.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { parse, extractTopLevel, YamlError } = require('../lib/yaml');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (err) {
    console.error(`✗ ${name}\n  ${err.message}`);
    process.exitCode = 1;
  }
}

test('scalars', () => {
  const doc = parse(`
a: hello
b: "quoted: with colon"
c: 'single'
d: 42
e: 1.5
f: true
g: false
h: null
i: ~
`);
  assert.strictEqual(doc.a, 'hello');
  assert.strictEqual(doc.b, 'quoted: with colon');
  assert.strictEqual(doc.c, 'single');
  assert.strictEqual(doc.d, 42);
  assert.strictEqual(doc.e, 1.5);
  assert.strictEqual(doc.f, true);
  assert.strictEqual(doc.g, false);
  assert.strictEqual(doc.h, null);
  assert.strictEqual(doc.i, null);
});

test('a # inside a quoted string is not a comment', () => {
  const doc = parse('color: "#8b5cf6"   # accent\nplain: value # trailing');
  assert.strictEqual(doc.color, '#8b5cf6');
  assert.strictEqual(doc.plain, 'value');
});

test('nested maps', () => {
  const doc = parse(`
theme:
  emoji: "🎬"
  color: "#e5a00d"
outer:
  inner:
    deep: yes
`);
  assert.strictEqual(doc.theme.color, '#e5a00d');
  assert.strictEqual(doc.outer.inner.deep, true);
});

test('sequences of scalars, indented and flush with the key', () => {
  const indented = parse('adopts:\n  - radarr\n  - sonarr\n');
  assert.deepStrictEqual(indented.adopts, ['radarr', 'sonarr']);
  const flush = parse('adopts:\n- radarr\n- sonarr\nnext: 1\n');
  assert.deepStrictEqual(flush.adopts, ['radarr', 'sonarr']);
  assert.strictEqual(flush.next, 1);
});

test('sequence of maps keeps every key of each item', () => {
  const doc = parse(`
env_file:
  - path: /srv/vaultwarden.env
    format: raw
  - path: /other.env
    format: raw
`);
  assert.strictEqual(doc.env_file.length, 2);
  assert.strictEqual(doc.env_file[0].path, '/srv/vaultwarden.env');
  assert.strictEqual(doc.env_file[0].format, 'raw');
  assert.strictEqual(doc.env_file[1].path, '/other.env');
});

test('a key after a nested block returns to the right level', () => {
  const doc = parse(`
services:
  radarr:
    port_map: 7878
  sonarr:
    port_map: 8989
required: false
`);
  assert.strictEqual(doc.services.radarr.port_map, 7878);
  assert.strictEqual(doc.services.sonarr.port_map, 8989);
  assert.strictEqual(doc.required, false);
});

test('extractTopLevel takes only its own block', () => {
  const doc = extractTopLevel(`
# comment
x-homebox:
  id: media
  services:
    radarr:
      port_map: 7878

services:
  radarr:
    image: lscr.io/linuxserver/radarr
    environment:
      - "WEIRD=[value]"
`, 'x-homebox');
  assert.strictEqual(doc.id, 'media');
  assert.strictEqual(doc.services.radarr.port_map, 7878);
  // The flow-collection value in the compose section below must not be
  // reached — that is the whole point of extracting one block.
  assert.strictEqual(doc.image, undefined);
});

test('extractTopLevel returns null when the key is absent', () => {
  assert.strictEqual(extractTopLevel('services:\n  a:\n    image: x\n', 'x-homebox'), null);
});

test('tabs and flow collections throw rather than guess', () => {
  assert.throws(() => parse('a:\n\t- b\n'), YamlError);
  assert.throws(() => parse('a: [1, 2]\n'), YamlError);
});

test('every shipped module parses and declares its required fields', () => {
  const modulesDir = path.join(__dirname, '..', '..', 'modules');
  const ids = fs.readdirSync(modulesDir).filter((d) => fs.statSync(path.join(modulesDir, d)).isDirectory());
  assert.ok(ids.length > 0, 'no modules found');
  for (const id of ids) {
    const file = path.join(modulesDir, id, 'docker-compose.yml');
    const meta = extractTopLevel(fs.readFileSync(file, 'utf8'), 'x-homebox');
    assert.ok(meta, `${id}: no x-homebox block`);
    assert.strictEqual(meta.id, id, `${id}: id does not match directory`);
    for (const key of ['title', 'tagline', 'category']) {
      assert.ok(meta[key], `${id}: missing ${key}`);
    }
    for (const name of meta.adopts || []) {
      assert.strictEqual(typeof name, 'string', `${id}: adopts must be plain names`);
    }
    for (const [name, svc] of Object.entries(meta.services || {})) {
      assert.ok(svc && typeof svc === 'object', `${id}/${name}: service must be a map`);
    }
  }
});

console.log(`${passed} passing${process.exitCode ? ' — with failures above' : ''}`);
