'use strict';
/**
 * "I am locked out of one of my own apps."
 *
 * It happens, and the way out is never obvious: every app stores its account
 * somewhere different, and the fix is usually a config file edit that you can
 * only find by reading a forum thread. Sonarr's is a single attribute in
 * config.xml; qBittorrent's is a PBKDF2 hash it regenerates on every boot if
 * you let it.
 *
 * WHAT THIS DOES NOT DO
 *
 * It does not reveal or recover a password. HomeBox does not know an account
 * you created inside an app, and it should not — that would mean the
 * dashboard holding the credentials of everything it runs. What it does is
 * open a door: put the app back into a state where you can set a NEW password
 * yourself.
 *
 * WHY THE STRATEGIES ARE A FIXED SET
 *
 * The obvious design is to let each module declare the command to run. That
 * would be a hole: Settings → App Store lets anyone create a module, so a
 * declared command is arbitrary root execution on the host, authored from a
 * web form. Instead a module names one of the strategies IMPLEMENTED HERE,
 * and an unknown name simply does not appear in the UI. Adding an app is a
 * commit to this file, which is the point.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const composeLib = require('./compose');
const modulesLib = require('./modules');
const state = require('./state-store');

class ResetError extends Error {
  constructor(message, { status = 400 } = {}) {
    super(message);
    this.name = 'ResetError';
    this.status = status;
  }
}

const configPath = (moduleId, service, file) =>
  path.join(state.ROOT, 'modules', moduleId, 'config', service, file);

/* ---------------------------------------------------------- strategies */

const STRATEGIES = {
  /**
   * Sonarr, Radarr, Prowlarr and the rest of the *arr family.
   *
   * They share one config.xml with an AuthenticationMethod attribute. Setting
   * it to `External` tells the app that something in front of it handles
   * authentication, so it stops presenting its own login — the door opens
   * without touching the account or the database.
   *
   * Deliberately NOT deleting the user row: that is a write into the app's
   * live SQLite file, and getting it wrong costs the library rather than the
   * password.
   */
  'arr-config': {
    label: 'Turn the login off, then set a new one inside the app',
    async detail(moduleId, service) {
      const file = configPath(moduleId, service, 'config.xml');
      if (!fs.existsSync(file)) return { available: false, why: 'it has not written its config yet — start it once first' };
      const xml = await fsp.readFile(file, 'utf8');
      const current = /<AuthenticationMethod>([^<]*)</.exec(xml);
      const method = current ? current[1] : 'unknown';
      return {
        available: method !== 'External',
        why: method === 'External' ? 'its login is already turned off' : null,
        state: `authentication: ${method}`,
      };
    },
    async run(moduleId, service, { onLine }) {
      const file = configPath(moduleId, service, 'config.xml');
      if (!fs.existsSync(file)) throw new ResetError(`${service} has not written a config.xml yet`);

      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '');
      const backup = `${file}.bak-reset-${stamp}`;
      await fsp.copyFile(file, backup);
      onLine(`==> Backed up config.xml to ${path.basename(backup)}`);

      const xml = await fsp.readFile(file, 'utf8');
      if (!/<AuthenticationMethod>/.test(xml)) throw new ResetError('that config.xml has no AuthenticationMethod to change');
      const next = xml.replace(/<AuthenticationMethod>[^<]*<\/AuthenticationMethod>/, '<AuthenticationMethod>External</AuthenticationMethod>');
      await fsp.writeFile(file, next, 'utf8');
      onLine('==> Login turned off (AuthenticationMethod: External)');

      onLine(`==> Restarting ${service}`);
      await composeLib.upService(moduleId, service, { onLine });

      return {
        next: `Open ${service} and go to Settings → General → Security. Set Authentication back to `
          + '"Forms" and choose a new username and password. Until you do, anyone who can reach '
          + 'that port can use the app without signing in.',
      };
    },
  },

  /**
   * qBittorrent, which is a different problem: it has no reset at all.
   *
   * Left without a stored password it invents a temporary one on every boot
   * and prints it to its log. HomeBox already generates one and seeds the
   * bcrypt hash into qBittorrent.conf at install — so a reset here is simply
   * running that seeding again, which the module's setup.sh already does
   * correctly and idempotently.
   *
   * The container has to be STOPPED for it: qBittorrent rewrites its config
   * from memory when it shuts down, so anything written underneath a running
   * instance is erased three seconds later.
   */
  qbittorrent: {
    label: 'Write the password HomeBox generated back into qBittorrent',
    async detail(moduleId, service) {
      const file = configPath(moduleId, service, 'qBittorrent/qBittorrent.conf');
      return {
        available: true,
        state: fs.existsSync(file) ? 'has a saved config' : 'no config yet',
      };
    },
    async run(moduleId, service, { onLine }) {
      const file = configPath(moduleId, service, 'qBittorrent/qBittorrent.conf');

      onLine(`==> Stopping ${service} so it cannot overwrite its own config on the way out`);
      await composeLib.stopService(moduleId, service, { onLine });

      if (fs.existsSync(file)) {
        // The seeder leaves an existing password alone by design, which is
        // right on install and wrong here — the whole point is to replace one
        // that no longer works.
        const conf = await fsp.readFile(file, 'utf8');
        const stripped = conf.split(/\r?\n/).filter((l) => !/^WebUI\\Password_PBKDF2=/.test(l)).join('\n');
        await fsp.writeFile(file, stripped, 'utf8');
        onLine('==> Cleared the stored password so the seeder will write a fresh one');
      }

      onLine('==> Re-seeding from .env');
      await composeLib.runSetup(moduleId, { onLine });

      onLine(`==> Starting ${service}`);
      await composeLib.upService(moduleId, service, { onLine });

      return { next: 'Sign in with the credentials under Settings → Passwords (module: media).' };
    },
  },
};

/* --------------------------------------------------------------- the api */

/** Every installed service that declares a strategy this build implements. */
async function list(containers) {
  const { modules } = await modulesLib.loadAll();
  const running = new Set(
    containers.filter((c) => c.project && c.project.startsWith('homebox-')).map((c) => `${c.project.slice(8)}/${c.service}`),
  );

  const out = [];
  for (const mod of modules) {
    for (const svc of mod.services) {
      const name = svc.reset_login;
      const strategy = name && STRATEGIES[name];
      // An unknown strategy name is silently absent rather than an error: a
      // module from a newer HomeBox should not break an older dashboard.
      if (!strategy) continue;
      if (!running.has(`${mod.id}/${svc.name}`)) continue;

      let detail = { available: true };
      try {
        detail = await strategy.detail(mod.id, svc.name);
      } catch (err) {
        detail = { available: false, why: err.message };
      }

      out.push({
        module: mod.id,
        moduleTitle: mod.title,
        service: svc.name,
        title: svc.friendly_name,
        icon: svc.icon || (mod.theme && mod.theme.emoji) || null,
        strategy: name,
        label: strategy.label,
        ...detail,
      });
    }
  }
  return out.sort((a, b) => a.title.localeCompare(b.title));
}

async function run({ module: moduleId, service }, { onLine = () => {} } = {}) {
  const { modules } = await modulesLib.loadAll();
  const mod = modules.find((m) => m.id === moduleId);
  if (!mod) throw new ResetError(`no such module: ${moduleId}`, { status: 404 });
  const svc = mod.services.find((s) => s.name === service);
  if (!svc) throw new ResetError(`${moduleId} has no service called ${service}`, { status: 404 });

  const strategy = STRATEGIES[svc.reset_login];
  if (!strategy) throw new ResetError(`${svc.friendly_name} does not declare a login reset this build knows how to do`);

  onLine(`==> Resetting the login for ${svc.friendly_name}`);
  const result = await strategy.run(moduleId, service, { onLine });
  onLine(`==> ${result.next}`);
  return { ok: true, ...result, title: svc.friendly_name };
}

module.exports = { list, run, ResetError, STRATEGIES };
