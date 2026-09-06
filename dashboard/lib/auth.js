'use strict';
/**
 * Who is allowed to use this dashboard.
 *
 * Until now there was no answer: anything that could reach port 8443 could
 * install, stop and delete containers, read every generated password and
 * download an encrypted backup of the whole box. On a flat home LAN that is
 * every phone, TV and guest laptop.
 *
 * The shape is the source's: a first run where you "claim" the box with a
 * one-time token the installer printed, and a password from then on.
 *
 * Everything here uses node's own crypto — no dependencies, same rule as the
 * rest of this server.
 *
 *   password   scrypt(N=16384, r=8, p=1) → 32 bytes, per-account 16-byte salt
 *   session    32 random bytes, stored server-side, HttpOnly cookie
 *   compare    timingSafeEqual, always, for both password and token
 *
 * NOT here on purpose:
 *
 *   - `Secure` on the cookie. The box is reached over plain HTTP on a LAN, so
 *     a Secure cookie would simply never be sent and nobody could log in. It
 *     is set automatically when the request arrives over HTTPS through the
 *     proxy, which is the case where it means something.
 *   - Users. There is one account, because there is one box and one admin.
 *     Adding names before anyone needs them is how you end up maintaining a
 *     user table nobody uses.
 */

const crypto = require('crypto');
const state = require('./state-store');

const FILE = 'auth.json';
const COOKIE = 'hb_session';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;   // 30 days; a home dashboard is not a bank
const MIN_PASSWORD = 8;

// A brute force against one password over a LAN is entirely practical, so
// failures cost time. Per-IP, in memory: a restart clearing it is fine, since
// restarting is not something an attacker can do from the login form.
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const FAIL_MAX = 8;
const failures = new Map();

/* ------------------------------------------------------------------ store */

async function read() {
  const raw = await state.readJson(FILE, {});
  return {
    password: raw && typeof raw.password === 'object' ? raw.password : null,
    bootstrapToken: typeof raw.bootstrapToken === 'string' ? raw.bootstrapToken : null,
    sessions: raw && typeof raw.sessions === 'object' && raw.sessions ? raw.sessions : {},
    claimedAt: raw.claimedAt || null,
  };
}

const write = (data) => state.writeJson(FILE, data);

/* --------------------------------------------------------------- password */

function hash(password, salt = crypto.randomBytes(16)) {
  const key = crypto.scryptSync(password, salt, SCRYPT.keylen, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p,
    // scrypt with N=16384 needs ~16MB; node's default cap is lower.
    maxmem: 64 * 1024 * 1024,
  });
  return { salt: salt.toString('hex'), key: key.toString('hex'), algo: 'scrypt' };
}

function passwordMatches(stored, attempt) {
  if (!stored || !stored.salt || !stored.key) return false;
  try {
    const got = crypto.scryptSync(attempt, Buffer.from(stored.salt, 'hex'), SCRYPT.keylen, {
      N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 64 * 1024 * 1024,
    });
    const want = Buffer.from(stored.key, 'hex');
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  } catch {
    return false;
  }
}

/* -------------------------------------------------------- bootstrap token */

/**
 * The one-time token that proves you are the person who installed this box.
 *
 * Generated on demand rather than only by install.sh, so a machine that was
 * running before there was a login can still be claimed without reinstalling.
 */
async function bootstrapToken() {
  const data = await read();
  if (data.password) return null;            // already claimed; the token is spent
  if (!data.bootstrapToken) {
    data.bootstrapToken = crypto.randomBytes(24).toString('base64url');
    await write(data);
  }
  return data.bootstrapToken;
}

function tokenMatches(stored, attempt) {
  if (!stored || typeof attempt !== 'string') return false;
  const a = Buffer.from(stored);
  const b = Buffer.from(attempt.trim());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* --------------------------------------------------------------- sessions */

function pruneSessions(sessions) {
  const now = Date.now();
  for (const [id, s] of Object.entries(sessions)) {
    if (!s || typeof s.expires !== 'number' || s.expires < now) delete sessions[id];
  }
  return sessions;
}

async function createSession(data) {
  const id = crypto.randomBytes(32).toString('base64url');
  pruneSessions(data.sessions);
  data.sessions[id] = { created: Date.now(), expires: Date.now() + SESSION_MS };
  await write(data);
  return id;
}

function cookieFrom(req) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === COOKIE) return decodeURIComponent(rest.join('='));
  }
  return null;
}

/** The Set-Cookie value for a session, or for clearing one. */
function sessionCookie(id, req) {
  const https = /^https$/i.test(req.headers['x-forwarded-proto'] || '');
  const bits = [
    `${COOKIE}=${id || ''}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    id ? `Max-Age=${Math.floor(SESSION_MS / 1000)}` : 'Max-Age=0',
  ];
  if (https) bits.push('Secure');
  return bits.join('; ');
}

/* ------------------------------------------------------------------- api */

async function status(req) {
  const data = await read();
  return {
    authenticated: await isAuthenticated(req, data),
    firstRun: !data.password,
    minPassword: MIN_PASSWORD,
  };
}

async function isAuthenticated(req, preloaded) {
  const data = preloaded || (await read());
  if (!data.password) return false;
  const id = cookieFrom(req);
  if (!id) return false;
  const session = data.sessions[id];
  return !!(session && typeof session.expires === 'number' && session.expires > Date.now());
}

function rateLimit(ip) {
  const now = Date.now();
  const entry = failures.get(ip) || { count: 0, first: now };
  if (now - entry.first > FAIL_WINDOW_MS) { entry.count = 0; entry.first = now; }
  if (entry.count >= FAIL_MAX) {
    const mins = Math.ceil((FAIL_WINDOW_MS - (now - entry.first)) / 60000);
    throw Object.assign(new Error(`too many attempts — wait ${mins} minute${mins === 1 ? '' : 's'}`), { status: 429 });
  }
  return entry;
}

function noteFailure(ip, entry) {
  entry.count += 1;
  failures.set(ip, entry);
}

/** First run: prove you have the installer's token, then set the password. */
async function claim(req, { token, password }) {
  const ip = clientIp(req);
  const entry = rateLimit(ip);
  const data = await read();

  if (data.password) throw Object.assign(new Error('this box has already been claimed'), { status: 409 });
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
    throw Object.assign(new Error(`the password needs at least ${MIN_PASSWORD} characters`), { status: 400 });
  }
  if (!tokenMatches(data.bootstrapToken, token)) {
    noteFailure(ip, entry);
    throw Object.assign(new Error('that bootstrap token is not right — run `homebox bootstrap-token` on the server to see it again'), { status: 401 });
  }

  data.password = hash(password);
  data.bootstrapToken = null;      // one-time, and it is now spent
  data.claimedAt = new Date().toISOString();
  failures.delete(ip);
  const id = await createSession(data);
  return { cookie: sessionCookie(id, req) };
}

async function login(req, { password }) {
  const ip = clientIp(req);
  const entry = rateLimit(ip);
  const data = await read();
  if (!data.password) throw Object.assign(new Error('this box has not been claimed yet'), { status: 409 });

  if (!passwordMatches(data.password, String(password || ''))) {
    noteFailure(ip, entry);
    throw Object.assign(new Error('wrong password'), { status: 401 });
  }
  failures.delete(ip);
  const id = await createSession(data);
  return { cookie: sessionCookie(id, req) };
}

async function logout(req) {
  const data = await read();
  const id = cookieFrom(req);
  if (id && data.sessions[id]) {
    delete data.sessions[id];
    await write(data);
  }
  return { cookie: sessionCookie(null, req) };
}

/** Change the password, and drop every other session while doing it. */
async function changePassword(req, { current, next }) {
  const data = await read();
  if (!passwordMatches(data.password, String(current || ''))) {
    throw Object.assign(new Error('the current password is not right'), { status: 401 });
  }
  if (typeof next !== 'string' || next.length < MIN_PASSWORD) {
    throw Object.assign(new Error(`the new password needs at least ${MIN_PASSWORD} characters`), { status: 400 });
  }
  data.password = hash(next);
  // Everything signed in with the old password is signed out. That is the
  // point of changing it.
  data.sessions = {};
  const id = await createSession(data);
  return { cookie: sessionCookie(id, req) };
}

/**
 * The address a request came from, for rate limiting only. `x-forwarded-for`
 * is trusted because the only proxy in front of this is the box's own, and a
 * wrong value here costs an attacker nothing but their own rate limit.
 */
function clientIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req.socket.remoteAddress || 'unknown';
}

module.exports = {
  status, isAuthenticated, claim, login, logout, changePassword,
  bootstrapToken, sessionCookie, COOKIE, MIN_PASSWORD,
};
