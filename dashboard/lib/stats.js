'use strict';
/**
 * Per-container CPU and memory, sampled in the background.
 *
 * Docker's /stats endpoint is deliberately slow: with `stream=false` it waits
 * for a second sample before answering, because a CPU percentage is a delta
 * between two reads and there is no honest way to produce one from a single
 * snapshot. That is ~1s per container, so it cannot sit in the request path —
 * a page load would take as long as the container count. Instead this keeps a
 * cache refreshed on a timer, and the API serves whatever the last sweep saw.
 */

const http = require('http');

const SOCKET = process.env.DOCKER_SOCKET || '/var/run/docker.sock';

const cache = new Map(); // name -> { cpu, memory, memoryLimit, at }
let timer = null;
let sweeping = false;

function fetchStats(name) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        socketPath: SOCKET,
        path: `/v1.43/containers/${encodeURIComponent(name)}/stats?stream=false`,
        method: 'GET',
        headers: { Host: 'docker' },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          if (res.statusCode !== 200) return resolve(null);
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch {
            resolve(null);
          }
        });
      }
    );
    // A stopped container answers instantly with zeros; a wedged one answers
    // never, and must not hold the sweep open.
    req.setTimeout(8000, () => req.destroy());
    req.on('error', () => resolve(null));
    req.end();
  });
}

/**
 * Docker reports CPU as cumulative nanoseconds. The percentage is the
 * container's delta over the system's delta, scaled by the number of CPUs —
 * the same arithmetic `docker stats` does, which is why a busy single-thread
 * container on a 4-core box reads ~25% and not 100%.
 */
function cpuPercent(s) {
  try {
    const cpu = s.cpu_stats;
    const pre = s.precpu_stats;
    const cpuDelta = cpu.cpu_usage.total_usage - pre.cpu_usage.total_usage;
    const sysDelta = cpu.system_cpu_usage - pre.system_cpu_usage;
    // An idle container has a cpuDelta of exactly 0, which is a real answer —
    // 0%, not "unknown". Only a missing or non-advancing system clock means
    // we genuinely cannot tell.
    if (!(sysDelta > 0) || !(cpuDelta >= 0)) return null;
    const cores = cpu.online_cpus
      || (cpu.cpu_usage.percpu_usage ? cpu.cpu_usage.percpu_usage.length : 1);
    return Math.round((cpuDelta / sysDelta) * cores * 1000) / 10;
  } catch {
    return null;
  }
}

/**
 * `usage` counts page cache, which makes an idle container look like it is
 * holding hundreds of megabytes. Subtract the reclaimable part, as the docker
 * CLI does, or every row lies.
 */
function memoryBytes(s) {
  try {
    const mem = s.memory_stats;
    if (!mem || !mem.usage) return null;
    const stats = mem.stats || {};
    const cache = stats.inactive_file != null ? stats.inactive_file
      : stats.total_inactive_file != null ? stats.total_inactive_file
        : stats.cache || 0;
    return { used: Math.max(0, mem.usage - cache), limit: mem.limit || null };
  } catch {
    return null;
  }
}

async function sweep(names) {
  if (sweeping) return;
  sweeping = true;
  try {
    // Sequential on purpose: each read holds a socket open for a second, and
    // thirty at once is a burst the daemon does not need from a dashboard.
    for (const name of names) {
      const raw = await fetchStats(name);
      if (!raw) {
        cache.delete(name);
        continue;
      }
      const mem = memoryBytes(raw);
      cache.set(name, {
        cpu: cpuPercent(raw),
        memory: mem ? mem.used : null,
        memoryLimit: mem ? mem.limit : null,
        at: Date.now(),
      });
    }
    // Forget containers that no longer exist, so the cache cannot grow
    // without bound across installs and removals.
    for (const name of [...cache.keys()]) {
      if (!names.includes(name)) cache.delete(name);
    }
  } finally {
    sweeping = false;
  }
}

/** Last known figures for one container, or nulls. */
function get(name) {
  return cache.get(name) || { cpu: null, memory: null, memoryLimit: null, at: null };
}

/** Everything the last sweep saw, keyed by container name. */
function all() {
  return Object.fromEntries(cache);
}

/**
 * Start sampling. `listNames` is called each round so the sweep follows
 * whatever is running now rather than a list captured at boot.
 */
function start(listNames, intervalMs = 15000) {
  const tick = () => {
    Promise.resolve()
      .then(listNames)
      .then((names) => sweep(names.filter(Boolean)))
      .catch(() => {});
  };
  tick();
  timer = setInterval(tick, intervalMs);
  timer.unref();
  return timer;
}

module.exports = { start, get, all, sweep };
