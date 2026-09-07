'use strict';
/**
 * Mounting a NAS from the Settings page.
 *
 * A media library on a NAS is the normal case, and until now the only way to
 * attach one was to SSH in and run scripts/mount-remote.sh by hand. That is
 * the same trip through a terminal the rest of this dashboard exists to
 * remove — and it is the WORST one to leave manual, because the script
 * encodes several things nobody would guess (the immutable bit on the
 * mountpoint, the docker.service ordering, hard mounts, the export ACL
 * check). Sending someone to a terminal for that means sending them to
 * `mount` and a hand-written fstab line, which is how you end up with an
 * *arr app "repairing" a library that was simply not mounted yet.
 *
 * HOW A CONTAINER MOUNTS SOMETHING ON ITS HOST
 *
 * It cannot, directly. A mount lives in the host's mount namespace, the
 * systemd units live in the host's filesystem, and `systemctl` has to talk to
 * the host's PID 1. So the work is handed to a throwaway privileged container
 * that enters the host's namespaces with nsenter and runs the very same
 * script an SSH session would — one code path, not two.
 *
 * ON THE PRIVILEGE THIS TAKES
 *
 * `--privileged --pid=host` is as powerful as it sounds. It is worth being
 * plain that it does NOT widen this dashboard's blast radius: the process
 * already holds the Docker socket, and anyone who can reach that can already
 * start exactly this container. The capability was always there; this only
 * puts a deliberate, audited door on it instead of leaving it implicit.
 * Everything here is still behind the session gate, and every argument that
 * reaches the host is validated below rather than trusted.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const composeLib = require('./compose');
const docker = require('./docker');
const state = require('./state-store');

// A mountpoint becomes a systemd unit name and a path in an argv slot. An
// absolute path of ordinary characters, and nothing that could climb out.
const MOUNTPOINT_RE = /^\/(?!.*\/\.\.(?:\/|$))[A-Za-z0-9._\-/]{1,120}$/;
// host or host:/export — no shell metacharacters, no spaces.
const SERVER_RE = /^[A-Za-z0-9._-]{1,253}$/;
const EXPORT_RE = /^\/[A-Za-z0-9._\-/]{0,200}$/;
// //server/share
const SHARE_RE = /^\/\/[A-Za-z0-9._-]{1,253}\/[A-Za-z0-9._\- /]{1,120}$/;
const USER_RE = /^[A-Za-z0-9._@\\-]{1,64}$/;

class StorageError extends Error {
  constructor(message, { status = 400 } = {}) {
    super(message);
    this.name = 'StorageError';
    this.status = status;
  }
}

/* ------------------------------------------------------ the host escape */

/** The image this dashboard is running, which the helper reuses. */
async function ownImage() {
  const containers = await docker.listContainers();
  const me = containers.find((c) => c.service === 'dashboard' && c.state !== 'stopped');
  if (!me || !me.image) throw new StorageError('cannot tell which image this dashboard runs', { status: 500 });
  return me.image;
}

/**
 * Run one command on the HOST and return its output.
 *
 * argv only — never a shell string — so a value that slipped past the
 * patterns above still cannot become a second command.
 */
async function onHost(argv, { timeout = 120000, onLine = null, env = {} } = {}) {
  const image = await ownImage();
  const run = ['run', '--rm', '--privileged', '--pid=host', '--network=host'];
  for (const [k, v] of Object.entries(env)) run.push('-e', `${k}=${v}`);
  run.push(
    '-v', `${state.ROOT}:${state.ROOT}`,
    '--entrypoint', 'nsenter',
    image,
    '-t', '1', '-m', '-u', '-i', '-n', '-p', '--',
  );
  return composeLib.run('docker', run.concat(argv), { timeout, onLine });
}

/* ---------------------------------------------------------------- probe */

/**
 * Ask an NFS server what it exports, and whether THIS box may have it.
 *
 * Worth doing before anything is written. A host missing from the export ACL
 * is the single most common reason this fails, and what it produces is a
 * mount that hangs and then dies with "access denied by server" — which
 * sounds like a credentials problem and is not one. Far better to say
 * "add 192.168.1.218 on the NAS" while the form is still open.
 */
async function probe({ kind, server }) {
  if (kind !== 'nfs') throw new StorageError('only NFS can be probed — SMB has no equivalent of showmount');
  if (!SERVER_RE.test(String(server || ''))) throw new StorageError('that does not look like a server address');

  let out;
  try {
    out = await onHost(['showmount', '-e', server], { timeout: 25000 });
  } catch (err) {
    throw new StorageError(
      `${server} did not answer an NFS export list. It may not be an NFS server, or it may be firewalled from this box. (${err.message})`,
    );
  }

  // "Export list for X:" then "<path> <client>[,<client>...]" per line.
  const exports = [];
  for (const line of String(out.stdout || '').split('\n').slice(1)) {
    const m = /^(\/\S*)\s+(\S+)\s*$/.exec(line.trim());
    if (m) exports.push({ path: m[1], clients: m[2].split(',') });
  }

  const me = await hostAddresses();
  return {
    server,
    exports: exports.map((e) => ({
      ...e,
      // `*` means everyone; otherwise one of our own addresses has to appear.
      allowed: e.clients.some((c) => c === '*' || me.includes(c)),
    })),
    addresses: me,
  };
}

/** This box's own IPv4 addresses, as the NAS would see them. */
async function hostAddresses() {
  try {
    const out = await onHost(['hostname', '-I'], { timeout: 15000 });
    return String(out.stdout || '').trim().split(/\s+/).filter((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a));
  } catch {
    return [];
  }
}

/* ---------------------------------------------------------------- mount */

/** What HomeBox has mounted, read from the units it wrote. */
async function list() {
  let out;
  try {
    out = await onHost(['findmnt', '-rno', 'TARGET,SOURCE,FSTYPE,SIZE,USED,AVAIL', '-t', 'nfs,nfs4,cifs'], { timeout: 20000 });
  } catch {
    return { mounts: [] };
  }
  const mounts = [];
  for (const line of String(out.stdout || '').split('\n')) {
    const [target, source, fstype, size, used, avail] = line.trim().split(/\s+/);
    if (target && source) mounts.push({ target, source, fstype, size, used, avail });
  }
  return { mounts };
}

function validate(input) {
  const kind = input.kind === 'cifs' ? 'cifs' : 'nfs';
  const mountpoint = String(input.mountpoint || '').trim().replace(/\/+$/, '');
  if (!MOUNTPOINT_RE.test(mountpoint)) {
    throw new StorageError('the mountpoint has to be an absolute path, e.g. /mnt/media_disk');
  }
  // Mounting over something that matters is not a mistake to allow.
  for (const forbidden of ['/', '/etc', '/usr', '/var', '/boot', '/home', '/root', '/opt', '/opt/homebox']) {
    if (mountpoint === forbidden) throw new StorageError(`refusing to mount over ${mountpoint}`);
  }

  let remote;
  if (kind === 'nfs') {
    const server = String(input.server || '').trim();
    const exportPath = String(input.share || '').trim();
    if (!SERVER_RE.test(server)) throw new StorageError('that does not look like a server address');
    if (!EXPORT_RE.test(exportPath)) throw new StorageError('the export path has to start with /');
    remote = `${server}:${exportPath}`;
  } else {
    remote = String(input.share || '').trim();
    if (!SHARE_RE.test(remote)) throw new StorageError('an SMB share looks like //server/share');
    if (!USER_RE.test(String(input.user || ''))) throw new StorageError('that username has characters this cannot pass on safely');
  }
  return { kind, remote, mountpoint, user: String(input.user || '') };
}

/**
 * Attach a share, by running the same script an SSH session would.
 *
 * Streamed, because it installs a package, probes the server, rewrites the
 * mountpoint and reloads systemd — a minute of silence otherwise, which is
 * exactly when someone reloads the page mid-mount.
 */
async function mount(input, { onLine = null } = {}) {
  const { kind, remote, mountpoint, user } = validate(input);
  const script = path.join(state.ROOT, 'scripts', 'mount-remote.sh');
  if (!fs.existsSync(script)) throw new StorageError('scripts/mount-remote.sh is missing from this install', { status: 500 });

  const env = {};
  let passFile = null;
  if (kind === 'cifs' && input.password) {
    // Through a 0600 file, not an argument or an environment variable: one is
    // visible in `ps` on the host and the other in `docker inspect`. The
    // script reads it once and deletes it.
    passFile = path.join(state.ROOT, 'state', `.smb-${crypto.randomBytes(6).toString('hex')}`);
    await fsp.writeFile(passFile, String(input.password), { mode: 0o600 });
    await fsp.chmod(passFile, 0o600);
    env.HB_SMB_PASS_FILE = passFile;
  }

  try {
    const argv = ['bash', script, kind, remote, mountpoint];
    if (kind === 'cifs') argv.push(user);
    await onHost(argv, { timeout: 300000, onLine, env });
  } finally {
    if (passFile) await fsp.rm(passFile, { force: true }).catch(() => {});
  }

  const after = await list();
  const live = after.mounts.find((m) => m.target === mountpoint);
  if (!live) throw new StorageError(`the units were written but ${mountpoint} is not mounted — check systemctl status`, { status: 500 });
  return { mountpoint, ...live };
}

/**
 * Detach a share and remove the units HomeBox wrote for it.
 *
 * The docker.service drop-in goes too. Leaving an ordering dependency on an
 * automount that no longer exists is how a box takes an extra 90 seconds to
 * boot for reasons nobody can find later.
 */
async function unmount({ mountpoint }) {
  const target = String(mountpoint || '').trim().replace(/\/+$/, '');
  if (!MOUNTPOINT_RE.test(target)) throw new StorageError('that is not a mountpoint this manages');

  // The unit name is derived by systemd-escape ON THE HOST, not by a regex
  // here. systemd's path escaping has rules for leading dots, dashes and
  // non-ASCII that a hand-rolled replace() gets subtly wrong, and a wrong
  // unit name here means "stopped nothing, deleted nothing" reported as
  // success. mount-remote.sh derives it the same way, so the two always
  // agree about what a given path is called.
  //
  // $MP is passed through the environment rather than interpolated, so the
  // path never becomes shell syntax even though it has already been matched
  // against MOUNTPOINT_RE.
  // Written as a plain array of lines, NOT a template literal: shell
  // parameter expansion is spelled `${unit%.mount}`, which JavaScript would
  // read as its own interpolation and mangle before bash ever saw it.
  const script = [
    'set -u',
    'unit="$(systemd-escape -p --suffix=mount "$MP")"',
    'auto="${unit%.mount}.automount"',
    'systemctl stop "$auto" "$unit" 2>/dev/null || true',
    'systemctl disable "$auto" 2>/dev/null || true',
    'umount "$MP" 2>/dev/null || true',
    'rm -f "/etc/systemd/system/$unit" "/etc/systemd/system/$auto"',
    'rm -f "/etc/systemd/system/docker.service.d/10-homebox-${auto%.automount}.conf"',
    'chattr -i "$MP" 2>/dev/null || true',
    'systemctl daemon-reload',
    'echo "removed $unit and $auto"',
  ].join('\n');
  await onHost(['bash', '-c', script], { timeout: 60000, env: { MP: target } });

  return { mountpoint: target, removed: true };
}

module.exports = { list, probe, mount, unmount, StorageError };
