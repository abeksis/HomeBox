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

/**
 * The *arr apps keep their accounts in a `Users` table in their own SQLite.
 *
 * node:sqlite is built into node 22, so reading and writing it costs no
 * dependency in a server that deliberately has none — and no sqlite3 binary,
 * which is in neither this image nor the apps'.
 */
function openDb(file) {
  // Required lazily: it is behind an experimental flag on some builds, and a
  // module that cannot load must not take the whole dashboard down at boot.
  const { DatabaseSync } = require('node:sqlite');
  return new DatabaseSync(file);
}

function countUsers(file) {
  const db = openDb(file);
  try {
    return db.prepare('select count(*) as c from Users').get().c;
  } finally {
    db.close();
  }
}

function clearUsers(file) {
  const db = openDb(file);
  try {
    const before = db.prepare('select count(*) as c from Users').get().c;
    db.prepare('delete from Users').run();
    return before;
  } finally {
    db.close();
  }
}

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
    label: 'Forget the saved account, so the app asks you to create a new one',
    async detail(moduleId, service) {
      const db = configPath(moduleId, service, `${service}.db`);
      if (!fs.existsSync(db)) return { available: false, why: 'it has not built its database yet — start it once first' };
      try {
        const users = countUsers(db);
        return {
          available: users > 0,
          why: users === 0 ? 'it has no saved account to forget' : null,
          state: users === 1 ? '1 account' : `${users} accounts`,
        };
      } catch (err) {
        return { available: false, why: `could not read its database (${err.message})` };
      }
    },
    async run(moduleId, service, { onLine }) {
      const db = configPath(moduleId, service, `${service}.db`);
      const cfg = configPath(moduleId, service, 'config.xml');
      if (!fs.existsSync(db)) throw new ResetError(`${service} has not built its database yet`);

      // Config alone cannot do this, and the first attempt at it was wrong.
      //
      // `AuthenticationMethod: External` means "something in FRONT of me
      // authenticates" -- the page loads but every API call still answers
      // 401, so the app draws its login screen anyway and the reset looks
      // like it did nothing. `DisabledForLocalAddresses` did not help either;
      // measured from another LAN machine, still 401.
      //
      // The account is a row in the app's own SQLite. Remove it and the app
      // presents its create-account screen on next start, which is the only
      // state that actually lets someone back in.
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '');

      onLine(`==> Stopping ${service} — its database must not be open while this is written`);
      await composeLib.stopService(moduleId, service, { onLine });

      await fsp.copyFile(db, `${db}.bak-reset-${stamp}`);
      onLine(`==> Backed up ${path.basename(db)}`);

      const removed = clearUsers(db);
      onLine(`==> Forgot ${removed} saved account${removed === 1 ? '' : 's'}`);

      // Put authentication back to a state that ASKS. A reset that leaves the
      // app wide open is not a fix, it is a different problem.
      if (fs.existsSync(cfg)) {
        await fsp.copyFile(cfg, `${cfg}.bak-reset-${stamp}`);
        let xml = await fsp.readFile(cfg, 'utf8');
        xml = xml.replace(/<AuthenticationMethod>[^<]*<\/AuthenticationMethod>/, '<AuthenticationMethod>Forms</AuthenticationMethod>');
        xml = xml.replace(/<AuthenticationRequired>[^<]*<\/AuthenticationRequired>/, '<AuthenticationRequired>Enabled</AuthenticationRequired>');
        await fsp.writeFile(cfg, xml, 'utf8');
        onLine('==> Authentication set back to Forms');
      }

      onLine(`==> Starting ${service}`);
      await composeLib.upService(moduleId, service, { onLine });

      return {
        next: `Open ${service} — it will ask you to create a new username and password. `
          + 'Nothing else was touched: your library, indexers and settings are all still there.',
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
