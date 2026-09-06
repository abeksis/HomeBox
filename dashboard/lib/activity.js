'use strict';
/**
 * Rolling container activity feed, fed by the Docker events stream.
 *
 * Docker emits a lot of noise (exec_create/exec_start on every healthcheck,
 * for instance). Only lifecycle events a person would care about are kept,
 * and the tail is persisted so a dashboard restart does not wipe the history
 * of what happened while you were away.
 */

const http = require('http');
const state = require('./state-store');

const SOCKET = process.env.DOCKER_SOCKET || '/var/run/docker.sock';
const FILE = 'activity.json';
const MAX = 200;

// die/stop/kill are the ones that matter when something breaks; start/restart
// tell you it came back. Everything else — exec_*, health_status on a healthy
// container, attach, resize — would bury those in noise.
const INTERESTING = new Set(['start', 'stop', 'die', 'kill', 'restart', 'create', 'destroy', 'oom', 'pause', 'unpause']);

class Activity {
  constructor() {
    this.entries = [];
    this.listeners = new Set();
    this.connected = false;
    this.retry = null;
  }

  async load() {
    const saved = await state.readJson(FILE, []);
    if (Array.isArray(saved)) this.entries = saved.slice(-MAX);
  }

  list(limit = 50) {
    return this.entries.slice(-limit).reverse();
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  push(entry) {
    this.entries.push(entry);
    if (this.entries.length > MAX) this.entries = this.entries.slice(-MAX);
    for (const fn of this.listeners) {
      try {
        fn(entry);
      } catch {
        /* a broken SSE client must not take down the feed */
      }
    }
    // Fire-and-forget: losing one line of history on a write error is not
    // worth failing an event handler over.
    state.writeJson(FILE, this.entries).catch(() => {});
  }

  /**
   * Record something HomeBox itself did (installing a module, say). Docker's
   * event stream reports the containers that appear as a result, but not the
   * intent behind them, and "you installed Monitoring" is the line a person
   * actually wants to read afterwards.
   */
  note({ name, action, level = 'info' }) {
    this.push({ time: Date.now(), action, name, image: null, exitCode: null, level, source: 'homebox' });
  }

  handleRaw(event) {
    if (event.Type !== 'container') return;
    const action = String(event.Action || '').split(':')[0];
    if (!INTERESTING.has(action)) return;
    const attrs = event.Actor && event.Actor.Attributes ? event.Actor.Attributes : {};
    const raw = attrs.name || (event.Actor && event.Actor.ID ? event.Actor.ID.slice(0, 12) : 'unknown');
    // During a recreate, compose briefly renames the old container to
    // <hash>_<name>. Those events are noise: the same container is about to
    // be reported again under its real name.
    if (/^[0-9a-f]{12}_/.test(raw)) return;
    const name = raw;
    const exitCode = attrs.exitCode != null ? Number(attrs.exitCode) : null;
    this.push({
      time: event.timeNano ? Math.floor(event.timeNano / 1e6) : (event.time || 0) * 1000,
      action,
      name,
      image: attrs.image || null,
      exitCode,
      // A container that exits 0 was asked to stop; anything else fell over.
      level: action === 'die' && exitCode ? 'error' : action === 'oom' ? 'error' : 'info',
    });
  }

  start() {
    const filters = encodeURIComponent(JSON.stringify({ type: ['container'] }));
    const req = http.request(
      { socketPath: SOCKET, path: `/v1.43/events?filters=${filters}`, method: 'GET', headers: { Host: 'docker' } },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          this.reconnect();
          return;
        }
        this.connected = true;
        let buffer = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          buffer += chunk;
          // The stream is newline-delimited JSON; a chunk can split a line.
          let nl;
          while ((nl = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (!line) continue;
            try {
              this.handleRaw(JSON.parse(line));
            } catch {
              /* partial or unexpected frame — skip it */
            }
          }
        });
        res.on('end', () => this.reconnect());
        res.on('error', () => this.reconnect());
      }
    );
    req.on('error', () => this.reconnect());
    req.end();
    this.request = req;
  }

  reconnect() {
    if (this.retry) return;
    this.connected = false;
    this.retry = setTimeout(() => {
      this.retry = null;
      this.start();
    }, 5000);
    this.retry.unref();
  }
}

module.exports = new Activity();
