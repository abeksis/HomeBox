'use strict';
/**
 * Everything that changes the box goes through here.
 *
 * The dashboard shells out to `docker compose` rather than reimplementing it
 * over the Engine API: compose already knows how to resolve ${VARS} from
 * .env, order dependencies, and reconcile a running project against a file.
 * Reimplementing a fraction of that is how a dashboard ends up disagreeing
 * with the CLI about what is installed.
 *
 * Because /opt/homebox is mounted at the same path inside this container as
 * on the host, the bind mounts in a module file resolve identically whether
 * compose is run from here or from an SSH session.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const ROOT = process.env.HOMEBOX_ROOT || '/opt/homebox';
const MODULES_DIR = path.join(ROOT, 'modules');
const ENV_FILE = path.join(ROOT, '.env');

// A module id becomes part of a filesystem path and a compose project name.
// Anything outside this set is rejected before it reaches a shell argument.
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;

class ComposeError extends Error {
  constructor(message, { code, stdout, stderr } = {}) {
    super(message);
    this.name = 'ComposeError';
    this.code = code;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

function moduleFile(id) {
  if (!ID_PATTERN.test(id)) throw new ComposeError(`invalid module id: ${id}`);
  const file = path.join(MODULES_DIR, id, 'docker-compose.yml');
  if (!fs.existsSync(file)) throw new ComposeError(`no such module: ${id}`);
  return file;
}

/**
 * Run a command with arguments as an array — never a shell string. A module
 * id is validated above, but keeping argv-style execution means even a bad
 * one cannot become shell syntax.
 */
function run(command, args, { timeout = 600000, cwd = ROOT, onLine = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, HB_ROOT: ROOT } });
    let stdout = '';
    let stderr = '';
    // Pulling images produces a lot of progress output; keep only the tail so
    // one install cannot balloon the response.
    const cap = (buf, chunk) => (buf + chunk).slice(-64000);

    // Line-buffered, because a chunk from a pipe is not a line: compose
    // writes its progress in fragments, and forwarding raw chunks to a
    // watching client puts half-written words on screen.
    const partial = { out: '', err: '' };
    const emit = (which, text) => {
      if (!onLine) return;
      partial[which] += text;
      const lines = partial[which].split('\n');
      partial[which] = lines.pop();
      for (const line of lines) onLine(line, which === 'err');
    };

    child.stdout.on('data', (c) => { const t = c.toString(); stdout = cap(stdout, t); emit('out', t); });
    child.stderr.on('data', (c) => { const t = c.toString(); stderr = cap(stderr, t); emit('err', t); });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new ComposeError(`${command} timed out after ${Math.round(timeout / 1000)}s`, { stdout, stderr }));
    }, timeout);
    timer.unref();

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new ComposeError(`${command} could not be run: ${err.message}`, { stdout, stderr }));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      // A last line with no trailing newline would otherwise never be sent.
      if (onLine) {
        if (partial.out) onLine(partial.out, false);
        if (partial.err) onLine(partial.err, true);
      }
      if (code === 0) return resolve({ stdout, stderr });
      reject(new ComposeError(`${command} exited ${code}`, { code, stdout, stderr }));
    });
  });
}

function composeArgs(id, rest) {
  const args = ['compose', '-p', `homebox-${id}`, '-f', moduleFile(id)];
  if (fs.existsSync(ENV_FILE)) args.push('--env-file', ENV_FILE);
  return args.concat(rest);
}

const compose = (id, rest, options) => run('docker', composeArgs(id, rest), options);

/**
 * A module may ship setup.sh to seed config an image will not create itself
 * (File Browser's config.yaml, the media pool's directory layout). It runs
 * before the first start and must be safe to re-run.
 */
async function runSetup(id, { onLine = null } = {}) {
  const script = path.join(MODULES_DIR, id, 'setup.sh');
  if (!fs.existsSync(script)) return null;
  return run('bash', [script], { timeout: 120000, onLine });
}

/** Full install: seed, pull, start. Returns the combined transcript. */
async function install(id, { onLine = null } = {}) {
  const log = [];
  if (onLine) onLine(`==> Preparing ${id}`, false);
  const setup = await runSetup(id, { onLine });
  if (setup) log.push(`# setup.sh\n${setup.stdout}${setup.stderr}`);

  // A failed pull is not fatal: an image already present locally still
  // starts, and a registry hiccup should not block bringing a module back up.
  try {
    if (onLine) onLine(`==> Pulling images for ${id}`, false);
    const pull = await compose(id, ['pull'], { timeout: 900000, onLine });
    log.push(`# pull\n${pull.stdout}${pull.stderr}`);
  } catch (err) {
    log.push(`# pull (continuing anyway)\n${err.stderr || err.message}`);
    if (onLine) onLine('==> Pull failed — trying with the images already on this box', true);
  }

  // --build matters for any module with a `build:` section — the dashboard is
  // one. `up` alone builds only when the image is MISSING, so once a stale
  // `homebox-dashboard:local` exists it is reused forever and an install
  // silently runs old code. Compose says so in a warning nobody reads:
  // "Some service image(s) must be built from source". Harmless for the
  // image-only modules, which have nothing to build.
  if (onLine) onLine(`==> Building and starting ${id}`, false);
  const up = await compose(id, ['up', '-d', '--build', '--remove-orphans'], { timeout: 900000, onLine });
  log.push(`# up\n${up.stdout}${up.stderr}`);
  return log.join('\n');
}

/**
 * Uninstall: remove the containers but keep modules/<id>/config, so
 * reinstalling brings the app back with its settings and history intact.
 */
const down = (id, { onLine = null } = {}) => compose(id, ['down', '--remove-orphans'], { onLine });

/**
 * Uninstall and erase. Deletes the module's config directory, which is where
 * an app's database and settings live — this is the one operation here that
 * cannot be undone, so it is a separate verb rather than a flag on `down`.
 */
async function purge(id, { onLine = null } = {}) {
  const result = await compose(id, ['down', '--remove-orphans', '--volumes'], { onLine });
  // Recompute the path through moduleFile() so a bad id cannot reach rm.
  const dir = path.join(path.dirname(moduleFile(id)), 'config');
  await fsp.rm(dir, { recursive: true, force: true });
  const trail = [result.stdout, "removed " + dir, ""].join(String.fromCharCode(10));
  return { stdout: trail, stderr: result.stderr };
}

const start = (id, { onLine = null } = {}) => compose(id, ['up', '-d', '--remove-orphans'], { onLine });
const stop = (id, { onLine = null } = {}) => compose(id, ['stop'], { onLine });
const restart = (id, { onLine = null } = {}) => compose(id, ['restart'], { onLine });
const pull = (id, { onLine = null } = {}) => compose(id, ['pull'], { timeout: 900000, onLine });

async function update(id, { onLine = null } = {}) {
  if (onLine) onLine(`==> Pulling newer images for ${id}`, false);
  await pull(id, { onLine });
  if (onLine) onLine(`==> Rebuilding and recreating ${id}`, false);
  // Same reason as install(): without --build, updating a module that builds
  // from source pulls new base layers and then runs the old image anyway.
  return compose(id, ['up', '-d', '--build', '--remove-orphans'], { timeout: 900000, onLine });
}

/**
 * Per-container lifecycle, for the Running list's Logs / Restart / Pause
 * buttons. It goes through the docker CLI rather than the Engine API so that
 * every write on this box lands in one file — and through the same argv-only
 * runner, so a container name can never become shell syntax.
 *
 * "Pause" in the UI is `docker stop`: it keeps the container and its data and
 * is what a person means by pausing an app. Docker's own `pause` (SIGSTOP)
 * leaves a frozen process holding its ports, which is not that.
 */
const CONTAINER_ACTIONS = { restart: 'restart', stop: 'stop', start: 'start' };
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

function containerAction(name, action) {
  if (!NAME_PATTERN.test(name)) throw new ComposeError(`invalid container name: ${name}`);
  const verb = CONTAINER_ACTIONS[action];
  if (!verb) throw new ComposeError(`unknown container action: ${action}`);
  return run('docker', [verb, name], { timeout: 120000 });
}

/** True when `docker compose` is usable from inside this container. */
async function available() {
  try {
    await run('docker', ['compose', 'version'], { timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  install, start, stop, restart, down, purge, update, pull, available, runSetup,
  containerAction, CONTAINER_ACTIONS, ComposeError, ID_PATTERN,
};
