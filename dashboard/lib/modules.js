'use strict';
/**
 * The module tree: modules/<id>/docker-compose.yml, metadata in x-homebox.
 *
 * One directory per module, holding both the compose file and everything the
 * UI knows about it, is the whole point of this layout — a module is a folder
 * you can read, copy or delete, not an app scattered across a compose
 * fragment, a data directory and a catalog entry somewhere else.
 *
 * A module's live state is not declared anywhere: it comes from Docker's own
 * compose labels (project `homebox-<id>`). Nothing to keep in sync.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const yaml = require('./yaml');
const catalog = require('./catalog');
const state = require('./state-store');

const MODULES_DIR = path.join(state.ROOT, 'modules');

const CATEGORIES = [
  { id: 'core', label: 'Core' },
  { id: 'media', label: 'Media' },
  { id: 'photos', label: 'Photos' },
  { id: 'files', label: 'Files' },
  { id: 'security', label: 'Security' },
  { id: 'network', label: 'Network' },
  { id: 'productivity', label: 'Productivity' },
  { id: 'system', label: 'System' },
  { id: 'other', label: 'Other' },
];

function normalizeService(name, raw) {
  const svc = raw && typeof raw === 'object' ? raw : {};
  return {
    name,
    friendly_name: svc.friendly_name || name,
    description: svc.description || '',
    icon: svc.icon || null,
    // The app's own brand colour, which is what a launcher keycap is painted
    // with. Falls back to the module's theme so two apps in one module do not
    // come out identical.
    color: svc.color || null,
    // The host port, which is what a link in the UI has to use.
    port: svc.port_map != null ? svc.port_map : null,
    // What the app listens on inside the container — only the proxy needs it.
    containerPort: svc.container_port != null ? svc.container_port : svc.port_map,
    scheme: svc.url_scheme === 'https' ? 'https' : 'http',
    internal: svc.internal === true,
    tip: svc.tip || null,
    first_login: svc.first_login || null,
  };
}

function normalize(id, meta, dir) {
  const m = meta && typeof meta === 'object' ? meta : {};
  const services = Object.entries(m.services || {}).map(([name, svc]) => normalizeService(name, svc));
  const category = CATEGORIES.some((c) => c.id === m.category) ? m.category : 'other';
  return {
    id: m.id || id,
    dir,
    title: m.title || id,
    tagline: m.tagline || '',
    description: m.description || '',
    icon: m.icon || null,
    category,
    required: m.required === true,
    // Written by the App Store's "Add app" form. Only these may be deleted
    // from the UI: removing a shipped module would come back on upgrade.
    user_created: m.user_created === true,
    default: m.default === true,
    ram: m.ram || null,
    added_at: m.added_at || null,
    hostname: m.hostname || null,
    theme: m.theme || {},
    tips: Array.isArray(m.tips) ? m.tips : [],
    // Names only — what the Passwords tab lists.
    env_vars: m.env_vars && typeof m.env_vars === 'object' ? Object.keys(m.env_vars) : [],
    // The full declaration, for the raw config editor: a module documents its
    // own settings, so a new one brings its fields without a code change.
    envVarDetails: m.env_vars && typeof m.env_vars === 'object'
      ? Object.entries(m.env_vars).map(([name, v]) => ({ name, ...(v && typeof v === 'object' ? v : {}) }))
      : [],
    services,
    hasSetup: fs.existsSync(path.join(dir, 'setup.sh')),
  };
}

/** Read every module directory. Returns { modules, errors }. */
async function loadAll() {
  const modules = [];
  const errors = [];
  let entries = [];
  try {
    entries = await fsp.readdir(MODULES_DIR, { withFileTypes: true });
  } catch (err) {
    return { modules, errors: [{ module: null, error: `cannot read ${MODULES_DIR}: ${err.message}` }] };
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
    const dir = path.join(MODULES_DIR, entry.name);
    const file = path.join(dir, 'docker-compose.yml');
    if (!fs.existsSync(file)) {
      errors.push({ module: entry.name, error: 'no docker-compose.yml' });
      continue;
    }
    try {
      const meta = yaml.extractTopLevel(await fsp.readFile(file, 'utf8'), 'x-homebox');
      if (!meta) {
        errors.push({ module: entry.name, error: 'compose file has no x-homebox block' });
        continue;
      }
      modules.push(normalize(entry.name, meta, dir));
    } catch (err) {
      errors.push({ module: entry.name, error: err.message });
    }
  }
  // Text edited in Settings > App Store contents lives in state/catalog.json
  // rather than in the compose files, so an upgrade cannot silently discard
  // it. Merging here means every caller -- page, API and CLI -- reads the
  // same text, which is the whole point of one metadata source.
  const { overrides } = await catalog.read();
  const merged = catalog.apply(modules, overrides);
  merged.sort((a, b) => a.title.localeCompare(b.title));
  return { modules: merged, errors };
}

/**
 * Fold live container state into each module.
 *
 * status is one of:
 *   available    — defined, never installed
 *   running      — every container up
 *   partial      — some up
 *   stopped      — installed, none up
 *   unhealthy    — a container's healthcheck is failing
 */
function withContainers(modules, containers, hostAddress) {
  const byProject = new Map();
  for (const c of containers) {
    if (!c.project) continue;
    if (!byProject.has(c.project)) byProject.set(c.project, []);
    byProject.get(c.project).push(c);
  }

  const claimed = new Set();
  const out = modules.map((mod) => {
    const live = byProject.get(`homebox-${mod.id}`) || [];
    live.forEach((c) => claimed.add(c.name));

    const running = live.filter((c) => c.state !== 'stopped').length;
    const unhealthy = live.filter((c) => c.state === 'unhealthy').length;

    let status;
    if (live.length === 0) status = 'available';
    else if (unhealthy > 0) status = 'unhealthy';
    else if (running === live.length) status = 'running';
    else if (running === 0) status = 'stopped';
    else status = 'partial';

    // Attach the container that implements each declared service, and the
    // address to open it at. A service with no port is not a link.
    const services = mod.services.map((svc) => {
      const container = live.find((c) => c.service === svc.name) || null;
      const url = !svc.internal && svc.port && hostAddress
        ? `${svc.scheme}://${hostAddress}:${svc.port}`
        : null;
      return { ...svc, url, container: container ? { name: container.name, state: container.state, status: container.status } : null };
    });

    return {
      ...mod,
      services,
      installed: live.length > 0,
      containers: live,
      counts: { total: live.length, running, unhealthy },
      status,
    };
  });

  // Containers on this box that no module owns — someone else's, or left
  // behind by a module that was renamed.
  const unclaimed = containers.filter((c) => !claimed.has(c.name));
  return { modules: out, unclaimed };
}

/**
 * Enabled set. Before state/modules.conf exists, every module marked
 * default:true counts as enabled so a fresh install has a sensible list.
 */
function enabledIds(modules) {
  const fromFile = state.readEnabled();
  if (fromFile) return new Set(fromFile);
  return new Set(modules.filter((m) => m.default || m.required).map((m) => m.id));
}

module.exports = { loadAll, withContainers, enabledIds, CATEGORIES, MODULES_DIR };
