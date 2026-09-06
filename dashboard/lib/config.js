'use strict';
/**
 * The raw `.env`, as an editable schema.
 *
 * Two rules shape everything here:
 *
 * 1. **The file is the source of truth, and it is edited in place.** Values
 *    are read and written line by line, so comments, ordering and any key
 *    this build does not know about all survive a save. Rewriting the file
 *    from a parsed object is how a config editor quietly eats things.
 *
 * 2. **Only declared keys are writable.** A key that is not in the schema
 *    below is returned as read-only and rejected on save — the endpoint is
 *    unauthenticated, and "write any name you like into .env" is a much
 *    bigger hole than "edit these thirty".
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const state = require('./state-store');
const modulesLib = require('./modules');

const ENV_FILE = path.join(state.ROOT, '.env');

/**
 * Groups that are not owned by a module. Module secrets are appended from
 * each module's own `x-homebox.env_vars`, so a new module brings its settings
 * with it rather than needing an edit here.
 */
const BASE_GROUPS = [
  {
    id: 'paths',
    title: 'Paths and identity',
    description: 'Where HomeBox keeps things, and which user owns the files it writes.',
    keys: [
      { key: 'HB_ROOT', label: 'Install root', readonly: true, hint: 'Set at install time. Moving it means reinstalling.' },
      { key: 'HB_DATA_DIR', label: 'Data pool', hint: 'The root every media path below defaults into.' },
      { key: 'HB_HOST_ADDRESS', label: 'LAN address', hint: 'Used to build the links on the launcher.' },
      { key: 'TZ', label: 'Timezone', hint: 'An IANA name, e.g. Asia/Jerusalem. Container logs follow this.' },
      { key: 'PUID', label: 'User ID', hint: 'Files the apps write are owned by this uid.' },
      { key: 'PGID', label: 'Group ID' },
    ],
  },
  {
    id: 'media',
    title: 'Media',
    description:
      'ONE library root, and folder names inside it. The root is a path on THIS box — a '
      + 'container bind mount cannot address a network share, so a library on a NAS has to be '
      + 'mounted here first with scripts/mount-remote.sh, and the mountpoint goes in the root. '
      + 'The folders below are names inside that root, not paths: everything is mounted as a '
      + 'single /data so a finished download can be HARDLINKED into the library. Mount them '
      + 'separately and the kernel refuses the link across two mount points — even on one '
      + 'disk — and every import becomes a full copy.',
    keys: [
      { key: 'HB_MEDIA_ROOT', label: 'Library root', placeholder: '<data pool>', hint: 'An absolute path on this box, e.g. /mnt/media_disk.' },
      { key: 'HB_MEDIA_MOVIES', label: 'Movies', placeholder: 'media/movies', relative: true },
      { key: 'HB_MEDIA_TV', label: 'TV series', placeholder: 'media/tv', relative: true },
      { key: 'HB_MEDIA_MUSIC', label: 'Music', placeholder: 'music', relative: true },
      { key: 'HB_MEDIA_BOOKS', label: 'Books', placeholder: 'books', relative: true },
      { key: 'HB_MEDIA_PHOTOS', label: 'Photos', placeholder: 'photos', relative: true },
      { key: 'HB_DOWNLOADS', label: 'Downloads', placeholder: 'downloads', relative: true },
    ],
  },
  {
    id: 'proxy',
    title: 'Proxy and ports',
    description: 'What the reverse proxy answers on.',
    keys: [
      { key: 'HTTP_PORT', label: 'HTTP port', placeholder: '80' },
      { key: 'HTTPS_PORT', label: 'HTTPS port', placeholder: '443' },
      { key: 'PORTAINER_PORT', label: 'Portainer port', placeholder: '9000' },
      { key: 'NPM_ADMIN_EMAIL', label: 'Proxy admin email' },
    ],
  },
  {
    id: 'backup',
    title: 'Backup',
    description: 'Change this and every existing archive becomes unreadable.',
    keys: [
      { key: 'HB_BACKUP_KEY', label: 'Backup encryption key', secret: true, dangerous: true },
    ],
  },
];

/* --------------------------------------------------------------- reading */

async function readLines() {
  try {
    return (await fsp.readFile(ENV_FILE, 'utf8')).split(/\r?\n/);
  } catch {
    return [];
  }
}

function valueFrom(lines, key) {
  const prefix = `${key}=`;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || !trimmed.startsWith(prefix)) continue;
    return trimmed.slice(prefix.length).replace(/^["']|["']$/g, '');
  }
  return '';
}

/**
 * Module secrets, grouped per module. `env_vars` already carries the label
 * and the `dangerous` flag, so a module documents its own settings.
 */
async function moduleGroups() {
  const { modules } = await modulesLib.loadAll();
  // A key already shown in a base group is not repeated per module: two
  // inputs bound to one variable is a race the user has to referee.
  const claimed = new Set(BASE_GROUPS.flatMap((g) => g.keys.map((k) => k.key)));
  const groups = [];
  for (const mod of modules) {
    const own = (mod.envVarDetails || []).filter((v) => !claimed.has(v.name));
    if (!own.length) continue;
    own.forEach((v) => claimed.add(v.name));
    groups.push({
      id: `module-${mod.id}`,
      title: mod.title,
      description: mod.tagline,
      keys: own.map((v) => ({
        key: v.name,
        label: v.label || v.name,
        secret: v.type === 'secret',
        dangerous: v.dangerous === true,
        readonly: v.config_editable === false && v.type !== 'secret',
        advanced: v.config_editable === false,
      })),
    });
  }
  return groups;
}

/** The whole schema with current values. Secrets are marked, never hidden. */
async function schema() {
  const lines = await readLines();
  const groups = [...BASE_GROUPS, ...(await moduleGroups())];
  return {
    file: ENV_FILE,
    groups: groups.map((group) => ({
      ...group,
      // Derived, not declared, so a new key cannot forget to raise it. Any
      // secret counts, not just the ones flagged dangerous: the label says
      // "contains security keys", and a proxy admin password is one.
      dangerous: group.keys.some((k) => k.dangerous || k.secret),
      keys: group.keys.map((k) => ({ ...k, value: valueFrom(lines, k.key) })),
    })),
  };
}

/** Keys whose value is a name inside the library root rather than a path. */
async function relativeKeys() {
  const { groups } = await schema();
  const set = new Set();
  for (const group of groups) {
    for (const k of group.keys) if (k.relative) set.add(k.key);
  }
  return set;
}

/** Every key this build will accept a write for. */
async function writableKeys() {
  const { groups } = await schema();
  const set = new Set();
  for (const group of groups) {
    for (const k of group.keys) if (!k.readonly) set.add(k.key);
  }
  return set;
}

/* --------------------------------------------------------- who uses what */

/**
 * Which modules actually reference these variables.
 *
 * Read straight out of each compose file rather than declared in a table
 * here. The file is what Compose interpolates, so scanning it is the one
 * answer that cannot drift from what recreating the module would really
 * produce — the same reason module metadata lives in `x-homebox:` inside the
 * file instead of in a catalog beside it.
 */
async function modulesUsing(keys) {
  if (!keys || !keys.length) return [];
  const wanted = new Set(keys);
  let entries;
  try {
    entries = await fsp.readdir(path.join(state.ROOT, 'modules'), { withFileTypes: true });
  } catch {
    return [];
  }

  const hits = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('_')) continue;
    let text;
    try {
      text = await fsp.readFile(path.join(state.ROOT, 'modules', entry.name, 'docker-compose.yml'), 'utf8');
    } catch {
      continue;
    }
    // Compose interpolates ${VAR}, ${VAR:-default} and bare $VAR alike.
    const used = new Set();
    for (const m of text.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/g)) used.add(m[1]);
    for (const key of wanted) {
      if (used.has(key)) { hits.push(entry.name); break; }
    }
  }
  return hits.sort();
}

/* --------------------------------------------------------------- writing */

const SAFE_VALUE = /^[^\n\r]{0,4096}$/;

/**
 * Update keys in place. Existing lines are rewritten where they sit; new keys
 * are appended. Comments, blank lines and unknown keys are left exactly as
 * they were.
 */
async function save(changes) {
  if (!changes || typeof changes !== 'object') throw new Error('nothing to save');
  const allowed = await writableKeys();

  const rejected = Object.keys(changes).filter((k) => !allowed.has(k));
  if (rejected.length) throw new Error(`not editable: ${rejected.join(', ')}`);

  for (const [key, value] of Object.entries(changes)) {
    if (typeof value !== 'string' || !SAFE_VALUE.test(value)) {
      // A newline would let one field write a second variable.
      throw new Error(`invalid value for ${key}`);
    }
  }

  // A category is a NAME inside the library root, never a path of its own.
  // Typing an absolute path here is the natural mistake — it is what these
  // fields used to take — and it would quietly reintroduce the separate
  // mount that makes hardlinks impossible, so it is refused with the reason.
  const relative = await relativeKeys();
  for (const [key, value] of Object.entries(changes)) {
    if (relative.has(key) && (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value))) {
      // No suggested value: which part of the path is the root and which is
      // the folder is only knowable from what the root is set to, and a
      // confidently wrong suggestion is worse than none.
      throw new Error(
        `${key} is a folder name inside the library root, not a full path. `
        + `Put the shared part (e.g. /mnt/media_disk) in Library root, and just the `
        + `folder name here.`,
      );
    }
  }

  const lines = await readLines();
  const applied = [];
  for (const [key, value] of Object.entries(changes)) {
    if (valueFrom(lines, key) === value) continue;
    const prefix = `${key}=`;
    const at = lines.findIndex((l) => l.trim().startsWith(prefix) && !l.trim().startsWith('#'));
    if (at === -1) {
      // Insert BEFORE any trailing blank lines, not after them. A file ending
      // in a newline splits to a final empty element, so a plain push lands
      // past it: that leaves a stray blank line, and leaves the file with no
      // trailing newline — so the next thing to `>>` the file starts writing
      // on the end of the last key. That produced a real corruption here:
      // `HB_MEDIA_PHOTOS=immichPIHOLE_PASSWORD=...` on one line.
      let end = lines.length;
      while (end > 0 && lines[end - 1].trim() === '') end -= 1;
      lines.splice(end, 0, `${key}=${value}`);
    } else lines[at] = `${key}=${value}`;
    applied.push(key);
  }
  if (!applied.length) return { applied: [] };

  const tmp = `${ENV_FILE}.tmp-${process.pid}`;
  // Exactly one trailing newline, always: this file is appended to by hand and
  // by install.sh, and a missing final newline turns the next append into a
  // corrupted line rather than a new one.
  await fsp.writeFile(tmp, `${lines.join('\n').replace(/\n+$/, '')}\n`, { mode: 0o600 });
  await fsp.rename(tmp, ENV_FILE);
  await matchOwner(ENV_FILE);
  return { applied };
}

/** Keep .env owned by whoever owns the tree, and readable only by them. */
async function matchOwner(file) {
  try {
    const dir = await fsp.stat(state.ROOT);
    await fsp.chown(file, dir.uid, dir.gid);
    await fsp.chmod(file, 0o600);
  } catch {
    /* not root, or a filesystem that will not chown */
  }
}

module.exports = { schema, save, modulesUsing, ENV_FILE };
