'use strict';
/**
 * Host CPU / memory / disk / uptime.
 *
 * Read from /proc rather than from os.cpus() and os.totalmem(): inside a
 * container those report the host anyway, but /proc/stat also lets us take a
 * real busy-vs-idle delta between samples instead of the average-since-boot
 * number, which barely moves and makes a live gauge look broken.
 *
 * Disk comes from statfs on /host/root (the host root, bind-mounted read-only)
 * because the container's own / is the image layer and would always read as
 * nearly empty.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');

const HOST_ROOT = process.env.HOMEBOX_HOST_ROOT || (fs.existsSync('/host/root') ? '/host/root' : '/');

let lastCpu = null;

async function readCpuSample() {
  const text = await fsp.readFile('/proc/stat', 'utf8');
  const line = text.split('\n', 1)[0];
  const parts = line.trim().split(/\s+/).slice(1).map(Number);
  // user nice system idle iowait irq softirq steal ...
  const idle = (parts[3] || 0) + (parts[4] || 0);
  const total = parts.reduce((a, b) => a + b, 0);
  return { idle, total };
}

async function cpuPercent() {
  try {
    const now = await readCpuSample();
    const prev = lastCpu;
    lastCpu = now;
    if (!prev) return null; // first call has nothing to diff against
    const totalDelta = now.total - prev.total;
    const idleDelta = now.idle - prev.idle;
    if (totalDelta <= 0) return null;
    return Math.max(0, Math.min(100, Math.round(((totalDelta - idleDelta) / totalDelta) * 100)));
  } catch {
    return null;
  }
}

async function memory() {
  try {
    const text = await fsp.readFile('/proc/meminfo', 'utf8');
    const kb = {};
    for (const line of text.split('\n')) {
      const m = /^(\w+):\s+(\d+)/.exec(line);
      if (m) kb[m[1]] = Number(m[2]);
    }
    const total = kb.MemTotal * 1024;
    // MemAvailable is the kernel's own estimate of what a new process could
    // get; MemFree alone counts cache as used and reports scary numbers on a
    // box that is simply warm.
    const available = (kb.MemAvailable != null ? kb.MemAvailable : kb.MemFree) * 1024;
    const used = total - available;
    return { total, used, available, percent: Math.round((used / total) * 100) };
  } catch {
    const total = os.totalmem();
    const used = total - os.freemem();
    return { total, used, available: os.freemem(), percent: Math.round((used / total) * 100) };
  }
}

async function disk() {
  try {
    const st = await fsp.statfs(HOST_ROOT);
    const total = st.blocks * st.bsize;
    // bavail, not bfree: bfree includes blocks reserved for root, which df
    // also excludes. Using bfree makes HomeBox disagree with df on the box.
    const free = st.bavail * st.bsize;
    const used = total - st.bfree * st.bsize;
    return { total, used, free, percent: total ? Math.round((used / total) * 100) : null, path: HOST_ROOT };
  } catch {
    return { total: null, used: null, free: null, percent: null, path: HOST_ROOT };
  }
}

async function uptimeSeconds() {
  try {
    const text = await fsp.readFile('/proc/uptime', 'utf8');
    return Math.floor(parseFloat(text.split(' ')[0]));
  } catch {
    return Math.floor(os.uptime());
  }
}

/**
 * os.hostname() inside a container returns the container id, which is not
 * what anyone means by "which box is this". The host's /etc/hostname is
 * mounted with the host root, so prefer that.
 */
function hostName() {
  if (process.env.HOMEBOX_HOST_NAME) return process.env.HOMEBOX_HOST_NAME;
  try {
    const name = fs.readFileSync(`${HOST_ROOT}/etc/hostname`, 'utf8').trim();
    if (name) return name;
  } catch {
    /* not mounted, or not readable - fall back to our own */
  }
  return os.hostname();
}

async function snapshot() {
  const [cpu, mem, dsk, up] = await Promise.all([cpuPercent(), memory(), disk(), uptimeSeconds()]);
  return {
    cpu,
    memory: mem,
    disk: dsk,
    uptime: up,
    load: os.loadavg().map((n) => Math.round(n * 100) / 100),
    cores: os.cpus().length,
    hostname: hostName(),
    time: Date.now(),
  };
}

/**
 * Prime the CPU sampler so the first client request already has a delta to
 * report instead of a dash.
 */
function start(intervalMs = 5000) {
  readCpuSample().then((s) => { lastCpu = s; }).catch(() => {});
  const timer = setInterval(() => { cpuPercent().catch(() => {}); }, intervalMs);
  timer.unref();
  return timer;
}

module.exports = { snapshot, start, memory, disk, uptimeSeconds };
