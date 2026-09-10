'use strict';
/**
 * Docker Engine API over the unix socket, using only node builtins.
 *
 * Read side only: every call here is a GET. Anything that changes the box
 * goes through `docker compose` in lib/compose.js instead, so the code that
 * can create and destroy containers is one small file you can read in full
 * rather than scattered through the API layer.
 */

const http = require('http');

const SOCKET = process.env.DOCKER_SOCKET || '/var/run/docker.sock';

function request(path, { raw = false, timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath: SOCKET, path, method: 'GET', headers: { Host: 'docker' } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks);
          if (res.statusCode >= 400) {
            reject(new Error(`docker ${path} → ${res.statusCode}: ${body.toString('utf8').slice(0, 200)}`));
            return;
          }
          if (raw) return resolve(body);
          try {
            resolve(body.length ? JSON.parse(body.toString('utf8')) : null);
          } catch (err) {
            reject(new Error(`docker ${path}: bad JSON (${err.message})`));
          }
        });
      }
    );
    req.setTimeout(timeout, () => req.destroy(new Error(`docker ${path}: timed out`)));
    req.on('error', reject);
    req.end();
  });
}

/**
 * Docker reports health in two different places and neither alone is enough:
 * State.Health.Status exists only when the image declares a HEALTHCHECK, and
 * State.Status is "running" for a container that is running badly. Normalize
 * to one of: healthy | unhealthy | starting | running | stopped | error.
 */
function normalizeState(container) {
  const status = (container.State || '').toLowerCase();
  const raw = container.Status || '';
  if (status !== 'running') {
    if (status === 'restarting') return 'starting';
    if (status === 'exited' || status === 'dead' || status === 'created') return 'stopped';
    return status || 'stopped';
  }
  const health = /\((healthy|unhealthy|health: starting)\)/.exec(raw);
  if (health) {
    if (health[1] === 'healthy') return 'healthy';
    if (health[1] === 'unhealthy') return 'unhealthy';
    return 'starting';
  }
  return 'running';
}

function cleanName(names) {
  const first = Array.isArray(names) ? names[0] : names;
  return String(first || '').replace(/^\//, '');
}

/** Published host ports, deduplicated, lowest first. */
function publishedPorts(ports) {
  const seen = new Set();
  for (const p of ports || []) {
    if (p.PublicPort) seen.add(p.PublicPort);
  }
  return [...seen].sort((a, b) => a - b);
}

async function listContainers() {
  const raw = await request('/v1.43/containers/json?all=1');
  return raw.map((c) => ({
    id: c.Id.slice(0, 12),
    name: cleanName(c.Names),
    image: c.Image,
    // The content id of the image actually running, which is not the same
    // thing as the name above: after a `pull` the name points somewhere new
    // while this container keeps running the old bytes. The update check is
    // exactly that comparison, so it needs both.
    imageId: c.ImageID || null,
    state: normalizeState(c),
    rawState: c.State,
    status: c.Status,
    created: c.Created,
    ports: publishedPorts(c.Ports),
    // Compose's own labels are how a container maps back to the module that
    // owns it. Nothing is hand-maintained, so the mapping cannot go stale.
    project: (c.Labels || {})['com.docker.compose.project'] || null,
    service: (c.Labels || {})['com.docker.compose.service'] || null,
  }));
}

/**
 * The registry digests a local image is known by.
 *
 * An image pulled from a registry carries the digest it came from in
 * RepoDigests; one built here has none, which is how the update check tells
 * "nothing to compare" apart from "up to date".
 */
async function imageDigests(idOrName) {
  try {
    const info = await request(`/v1.43/images/${encodeURIComponent(idOrName)}/json`);
    return Array.isArray(info.RepoDigests) ? info.RepoDigests : [];
  } catch {
    return [];
  }
}

/**
 * Does the daemon still have this image?
 *
 * Worth asking, because a running container is not proof that it does. A
 * container reports the image it was created from, and once that reference is
 * untagged and collected the daemon keeps the LAYERS alive for the running
 * process but drops the image record. `/containers/json` then degrades the
 * Image field from a tag to a bare `sha256:...`, and `docker run` on that id
 * answers "No such image" — while the container using it is up and healthy.
 *
 * Seen on a real box: the dashboard was running a
 * `homebox-dashboard:0.4.3` that a later rebuild of the same tag had orphaned.
 */
async function imageExists(idOrName) {
  try {
    await request(`/v1.43/images/${encodeURIComponent(idOrName)}/json`);
    return true;
  } catch {
    return false;
  }
}

/** Every image the daemon holds, with the tags it answers to. */
async function listImages() {
  const raw = await request('/v1.43/images/json');
  return raw.map((i) => ({
    id: i.Id,
    tags: Array.isArray(i.RepoTags) ? i.RepoTags.filter((t) => t && t !== '<none>:<none>') : [],
    created: i.Created || 0,
  }));
}

async function logs(name, tail = 200) {
  const path = `/v1.43/containers/${encodeURIComponent(name)}/logs?stdout=1&stderr=1&timestamps=0&tail=${tail}`;
  const body = await request(path, { raw: true });
  return stripAnsi(demultiplex(body));
}

/**
 * Strip ANSI colour and cursor sequences.
 *
 * Plenty of images colour their startup output, and those bytes reach a
 * browser as literal "[1;34m" noise wrapped around every line. Rendering
 * the colours would mean parsing them into spans; dropping them costs one
 * regex and makes the log readable, which is the whole point of the page.
 */
function stripAnsi(text) {
  const ESC = String.fromCharCode(27);
  // An escaped "[" built from char codes: written literally, the bracket
  // would open a character class instead of matching the CSI introducer.
  const OPEN_BRACKET = String.fromCharCode(92, 91);
  const pattern = new RegExp(ESC + OPEN_BRACKET + "[0-9;?]*[ -/]*[@-~]", "g");
  return text.replace(pattern, "");
}

/**
 * A container without a TTY returns its logs in Docker's stream format: an
 * 8-byte header per frame (stream type, 3 reserved bytes, 4-byte big-endian
 * length) followed by the payload. A TTY container returns plain bytes. Sniff
 * the first header rather than asking the API twice.
 */
function demultiplex(buf) {
  if (buf.length < 8) return buf.toString('utf8');
  const looksFramed = buf[0] <= 2 && buf[1] === 0 && buf[2] === 0 && buf[3] === 0;
  if (!looksFramed) return buf.toString('utf8');
  const out = [];
  let offset = 0;
  while (offset + 8 <= buf.length) {
    const len = buf.readUInt32BE(offset + 4);
    const start = offset + 8;
    const end = Math.min(start + len, buf.length);
    out.push(buf.slice(start, end).toString('utf8'));
    offset = end;
    if (len === 0 && end === start) break;
  }
  return out.join('');
}

/** Network names Docker knows about, for the connectivity card. */
async function listNetworks() {
  try {
    const raw = await request('/v1.43/networks');
    return raw.map((n) => n.Name);
  } catch {
    return [];
  }
}

async function version() {
  try {
    const v = await request('/v1.43/version');
    return { version: v.Version, apiVersion: v.ApiVersion, os: v.Os, arch: v.Arch };
  } catch {
    return null;
  }
}

/** True when the socket is present and answering. */
async function reachable() {
  try {
    await request('/v1.43/_ping', { raw: true, timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  listContainers, listNetworks, logs, version, reachable, normalizeState, imageDigests,
  imageExists, listImages,
};
