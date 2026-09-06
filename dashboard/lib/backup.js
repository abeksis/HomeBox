'use strict';
/**
 * Backup Center.
 *
 * An archive here contains `.env` — every generated password on the box — so
 * it is encrypted, always. There is no "unencrypted for convenience" path: if
 * the key is missing the operation fails and says how to create one, rather
 * than quietly writing the box's secrets to a file someone might copy to a
 * NAS.
 *
 * Format, matching the shape SparkBox uses:
 *
 *     [ 16-byte IV ][ AES-256-GCM ciphertext ][ 16-byte auth tag ]
 *
 * The key is scrypt-derived from HB_BACKUP_KEY. GCM only yields its tag after
 * final(), which is why the tag is a footer rather than a header — that lets
 * the ciphertext stream straight to disk instead of buffering the whole
 * archive in memory.
 */

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
const { pipeline } = require('stream/promises');

const state = require('./state-store');

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const TAG_LENGTH = 16;
const SALT = 'homebox-backup-salt';

const ROOT = state.ROOT;
const BACKUP_DIR = path.join(ROOT, 'backups');
const ENV_FILE = path.join(ROOT, '.env');
const SCHEDULE_FILE = 'backup-schedule.json';

// homebox-<kind>-YYYYMMDD_HHMMSS.tar.gz.enc
const NAME_RE = /^homebox-(config|full)-\d{8}_\d{6}\.tar\.gz\.enc$/;

const DEFAULT_SCHEDULE = { enabled: false, preset: 'daily', retention: 7, lastRun: null };
const PRESETS = {
  daily: { label: 'Every day at 02:00', everyMs: 24 * 3600e3 },
  weekly: { label: 'Every Sunday at 02:00', everyMs: 7 * 24 * 3600e3 },
  monthly: { label: 'On the 1st at 02:00', everyMs: 30 * 24 * 3600e3 },
};

class BackupError extends Error {
  constructor(message, hint) {
    super(message);
    this.name = 'BackupError';
    this.hint = hint || null;
  }
}

/* ------------------------------------------------------------------ keys */

/**
 * Read HB_BACKUP_KEY out of .env without pulling the rest of the file into
 * memory as a parsed object — nothing else here has any business with the
 * other values.
 */
function readKeyFromEnv() {
  try {
    for (const line of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
      const m = /^HB_BACKUP_KEY=(.*)$/.exec(line.trim());
      if (m) return m[1].replace(/^["']|["']$/g, '').trim() || null;
    }
  } catch {
    /* no .env: treated the same as no key */
  }
  return null;
}

function requireSecret() {
  const secret = readKeyFromEnv();
  if (!secret) {
    throw new BackupError(
      'No backup encryption key is set',
      'Add HB_BACKUP_KEY to /opt/homebox/.env (or re-run install.sh, which generates one) and restart the dashboard.'
    );
  }
  return secret;
}

const deriveKey = (secret) => crypto.scryptSync(secret, SALT, KEY_LENGTH);

/* ------------------------------------------------------------- utilities */

function timestamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}`
    + `_${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

/** argv only, never a shell string — filenames here reach a real process. */
function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    let stderr = '';
    if (child.stderr) child.stderr.on('data', (c) => { stderr = (stderr + c).slice(-8000); });
    child.on('error', (err) => reject(new BackupError(`${command}: ${err.message}`)));
    child.on('close', (code) => (code === 0
      ? resolve()
      : reject(new BackupError(`${command} exited ${code}`, stderr.trim().slice(0, 400) || null))));
  });
}

async function ensureDir() {
  await fsp.mkdir(BACKUP_DIR, { recursive: true });
}

/* ------------------------------------------------------------ encryption */

async function encryptFile(plainPath, encPath, secret) {
  const key = deriveKey(secret);
  const iv = crypto.randomBytes(IV_LENGTH);
  const tmp = `${encPath}.tmp-${process.pid}`;

  await fsp.writeFile(tmp, iv);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  await pipeline(fs.createReadStream(plainPath), cipher, fs.createWriteStream(tmp, { flags: 'a' }));
  await fsp.appendFile(tmp, cipher.getAuthTag());

  // Read it back and authenticate before it is allowed to become a real
  // backup. An archive that cannot be decrypted is worse than no archive:
  // it is an archive you believe in.
  await decryptToSink(tmp, key);
  await fsp.rename(tmp, encPath);
}

/** Decrypt into nothing, purely to make GCM verify the tag. */
async function decryptToSink(encPath, key) {
  const { size } = await fsp.stat(encPath);
  if (size < IV_LENGTH + TAG_LENGTH) throw new BackupError('archive is too short to be valid');

  const handle = await fsp.open(encPath, 'r');
  try {
    const iv = Buffer.alloc(IV_LENGTH);
    await handle.read(iv, 0, IV_LENGTH, 0);
    const tag = Buffer.alloc(TAG_LENGTH);
    await handle.read(tag, 0, TAG_LENGTH, size - TAG_LENGTH);

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    const body = fs.createReadStream(encPath, { start: IV_LENGTH, end: size - TAG_LENGTH - 1 });
    const sink = new (require('stream').Writable)({ write(_c, _e, cb) { cb(); } });
    await pipeline(body, decipher, sink);
  } finally {
    await handle.close();
  }
}

/** Decrypt to a real file, for restore. */
async function decryptFile(encPath, outPath, secret) {
  const key = deriveKey(secret);
  const { size } = await fsp.stat(encPath);
  const handle = await fsp.open(encPath, 'r');
  try {
    const iv = Buffer.alloc(IV_LENGTH);
    await handle.read(iv, 0, IV_LENGTH, 0);
    const tag = Buffer.alloc(TAG_LENGTH);
    await handle.read(tag, 0, TAG_LENGTH, size - TAG_LENGTH);
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    await pipeline(
      fs.createReadStream(encPath, { start: IV_LENGTH, end: size - TAG_LENGTH - 1 }),
      decipher,
      fs.createWriteStream(outPath)
    );
  } finally {
    await handle.close();
  }
}

/* ---------------------------------------------------------------- create */

/**
 * What goes in.
 *
 * `config` is the useful one: every app's settings and database, the enabled
 * list, and .env. It is small enough to keep many of and fast enough to run
 * nightly.
 *
 * `full` adds the data pool. On a box with a media library that is hundreds
 * of gigabytes, which is why it is not the default and not what the schedule
 * runs.
 */
function tarArgs(kind) {
  const args = ['-czf', '-', '-C', ROOT];
  const modules = fs.existsSync(path.join(ROOT, 'modules')) ? ['modules'] : [];
  const parts = [...modules, 'state'];
  if (fs.existsSync(ENV_FILE)) parts.push('.env');
  if (kind === 'full' && fs.existsSync(path.join(ROOT, 'data'))) parts.push('data');
  // Never fold the backup directory into a backup.
  args.push('--exclude=./backups', '--exclude=backups');
  return args.concat(parts);
}

let inFlight = false;

async function create({ kind = 'config' } = {}) {
  if (!['config', 'full'].includes(kind)) throw new BackupError(`unknown backup kind: ${kind}`);
  if (inFlight) throw new BackupError('a backup is already running');
  const secret = requireSecret();

  inFlight = true;
  const started = Date.now();
  await ensureDir();
  const name = `homebox-${kind}-${timestamp()}.tar.gz.enc`;
  const target = path.join(BACKUP_DIR, name);
  const plain = path.join(BACKUP_DIR, `.staging-${process.pid}.tar.gz`);

  try {
    // tar to a staging file rather than piping into the cipher: a tar that
    // fails halfway would otherwise produce a perfectly decryptable archive
    // of half a box.
    await new Promise((resolve, reject) => {
      const child = spawn('tar', tarArgs(kind), { cwd: ROOT });
      const out = fs.createWriteStream(plain);
      let stderr = '';
      child.stderr.on('data', (c) => { stderr = (stderr + c).slice(-8000); });
      child.stdout.pipe(out);
      child.on('error', reject);
      child.on('close', (code) => {
        out.end();
        // tar exits 1 for "file changed as we read it", which is normal on a
        // live box and does not invalidate the archive. Only 2+ is fatal.
        if (code === 0 || code === 1) resolve();
        else reject(new BackupError(`tar exited ${code}`, stderr.trim().slice(0, 400)));
      });
    });

    await encryptFile(plain, target, secret);
    await matchOwner(target);
    const { size } = await fsp.stat(target);
    await prune();
    return { name, size, kind, seconds: Math.round((Date.now() - started) / 1000) };
  } finally {
    await fsp.rm(plain, { force: true });
    inFlight = false;
  }
}

/**
 * The dashboard runs as root in its container, so anything it writes into the
 * bind-mounted tree lands root-owned and the account that owns /opt/homebox
 * cannot copy or delete its own backups.
 */
async function matchOwner(file) {
  try {
    const dir = await fsp.stat(ROOT);
    await fsp.chown(file, dir.uid, dir.gid);
  } catch {
    /* not root, or a filesystem that will not chown */
  }
}

/* ------------------------------------------------------------------ list */

async function list() {
  await ensureDir();
  let names = [];
  try {
    names = await fsp.readdir(BACKUP_DIR);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (!NAME_RE.test(name)) continue;
    try {
      const st = await fsp.stat(path.join(BACKUP_DIR, name));
      out.push({
        name,
        size: st.size,
        created: st.mtimeMs,
        kind: name.includes('-full-') ? 'full' : 'config',
        encrypted: true,
      });
    } catch {
      /* vanished between readdir and stat */
    }
  }
  return out.sort((a, b) => b.created - a.created);
}

function resolveName(name) {
  if (!NAME_RE.test(name || '')) throw new BackupError(`not a backup filename: ${name}`);
  return path.join(BACKUP_DIR, name);
}

async function remove(name) {
  await fsp.rm(resolveName(name), { force: true });
}

/** Decrypt and authenticate an existing archive without writing anything. */
async function verify(name) {
  const file = resolveName(name);
  await decryptToSink(file, deriveKey(requireSecret()));
  return { name, ok: true };
}

/** Keep the newest `retention`, oldest first out. */
async function prune() {
  const schedule = await getSchedule();
  const keep = Math.max(1, Number(schedule.retention) || DEFAULT_SCHEDULE.retention);
  const all = await list();
  const removed = [];
  for (const b of all.slice(keep)) {
    await remove(b.name);
    removed.push(b.name);
  }
  return removed;
}

/* -------------------------------------------------------------- schedule */

async function getSchedule() {
  const saved = await state.readJson(SCHEDULE_FILE, DEFAULT_SCHEDULE);
  return {
    enabled: saved.enabled === true,
    preset: PRESETS[saved.preset] ? saved.preset : DEFAULT_SCHEDULE.preset,
    retention: Math.min(100, Math.max(1, Number(saved.retention) || DEFAULT_SCHEDULE.retention)),
    lastRun: Number(saved.lastRun) || null,
  };
}

async function setSchedule(input) {
  const next = {
    enabled: input.enabled === true,
    preset: PRESETS[input.preset] ? input.preset : DEFAULT_SCHEDULE.preset,
    retention: Math.min(100, Math.max(1, Number(input.retention) || DEFAULT_SCHEDULE.retention)),
    lastRun: (await getSchedule()).lastRun,
  };
  await state.writeJson(SCHEDULE_FILE, next);
  return next;
}

function nextRunAt(schedule) {
  if (!schedule.enabled) return null;
  const every = PRESETS[schedule.preset].everyMs;
  return (schedule.lastRun || Date.now()) + every;
}

/**
 * Checked once a minute rather than scheduled to the second: a home box gets
 * rebooted, and a timer armed for "in 23 hours" simply never fires. Comparing
 * against a persisted lastRun survives restarts.
 */
function startScheduler() {
  const tick = async () => {
    try {
      const schedule = await getSchedule();
      if (!schedule.enabled || inFlight) return;
      const due = nextRunAt(schedule);
      if (due && Date.now() >= due) {
        await create({ kind: 'config' });
        await state.writeJson(SCHEDULE_FILE, { ...schedule, lastRun: Date.now() });
      }
    } catch (err) {
      console.warn('[homebox] scheduled backup failed:', err.message);
    }
  };
  const timer = setInterval(tick, 60000);
  timer.unref();
  tick();
  return timer;
}

/* --------------------------------------------------------------- status */

/**
 * Backups written to the same filesystem as the thing they protect survive a
 * mistake but not a dead disk. Worth saying out loud rather than implying.
 */
async function sameDiskAsData() {
  try {
    const [backups, data] = await Promise.all([
      fsp.stat(BACKUP_DIR),
      fsp.stat(path.join(ROOT, 'data')).catch(() => fsp.stat(ROOT)),
    ]);
    return backups.dev === data.dev;
  } catch {
    return true;
  }
}

async function status() {
  const [backups, schedule, sameDisk] = await Promise.all([list(), getSchedule(), sameDiskAsData()]);
  const latest = backups[0] || null;
  return {
    directory: BACKUP_DIR,
    hasKey: readKeyFromEnv() != null,
    count: backups.length,
    totalSize: backups.reduce((sum, b) => sum + b.size, 0),
    latest,
    sameDisk,
    running: inFlight,
    schedule: { ...schedule, nextRun: nextRunAt(schedule), presets: PRESETS },
    backups,
  };
}

/** The key itself, for the reveal button. */
function revealKey() {
  return { key: requireSecret() };
}

module.exports = {
  create, list, remove, verify, prune, status,
  getSchedule, setSchedule, startScheduler,
  revealKey, decryptFile, resolveName, BACKUP_DIR, BackupError, PRESETS,
};
