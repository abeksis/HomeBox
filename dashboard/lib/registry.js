'use strict';
/**
 * "Is the image this container is running still the newest build of its tag?"
 *
 * Answering that needs the registry, and the registry needs a token — so this
 * is a small Registry V2 client over node's https, same no-dependency rule as
 * the rest of the server.
 *
 * Why a digest comparison and not a version comparison:
 *
 *   Every module here pins an exact tag (pihole/pihole:2026.07.2,
 *   jc21/nginx-proxy-manager:2.15.1, ...). A pinned tag is not frozen — the
 *   publisher re-pushes it when a base layer gets a CVE fix, so the SAME tag
 *   points at a NEW digest. That rebuild is the update this file finds, and
 *   `docker compose pull` on its own will happily report "up to date" while
 *   the local copy is months of security patches behind, because compose only
 *   compares tags.
 *
 *   Moving a module from 2026.07.2 to some future 2026.09.x is a different
 *   thing entirely: it is a change to a file in git, it may need a config
 *   migration, and it arrives with a HomeBox release. That is deliberately
 *   NOT something a dashboard button does behind your back.
 *
 * The source (SparkBox) draws exactly the same line — its Updates tab calls
 * these "optional security rebuilds of apps you already have".
 */

const https = require('https');

const DOCKER_HUB = 'registry-1.docker.io';

// Ask for every manifest media type in use. Multi-arch images answer with an
// index; single-arch ones with a plain manifest. Requesting only one of them
// gets a 404 from half the registries in the catalog.
const ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

/**
 * Split an image reference into the three things a registry request needs.
 *
 * Docker's own shorthand is the awkward part: `redis:7-alpine` means
 * `registry-1.docker.io/library/redis:7-alpine`, and `pihole/pihole` means
 * `registry-1.docker.io/pihole/pihole`. The rule for telling a registry
 * hostname from a Docker Hub namespace is the one Docker itself uses — a
 * first segment containing a dot or a colon is a host, anything else is not.
 */
function parseRef(ref) {
  const image = String(ref || '').trim();
  if (!image) return null;

  // Already pinned to a digest: there is nothing newer to find, by definition.
  if (image.includes('@sha256:')) return null;

  let rest = image;
  let registry = DOCKER_HUB;

  const slash = rest.indexOf('/');
  if (slash > 0) {
    const head = rest.slice(0, slash);
    if (head === 'localhost' || head.includes('.') || head.includes(':')) {
      registry = head === 'docker.io' || head === 'index.docker.io' ? DOCKER_HUB : head;
      rest = rest.slice(slash + 1);
    }
  }

  // The tag is after the LAST colon, but only if that colon comes after the
  // last slash — otherwise it is a port in the registry host we just removed.
  let tag = 'latest';
  const colon = rest.lastIndexOf(':');
  if (colon > rest.lastIndexOf('/')) {
    tag = rest.slice(colon + 1);
    rest = rest.slice(0, colon);
  }

  if (registry === DOCKER_HUB && !rest.includes('/')) rest = `library/${rest}`;
  if (!rest) return null;

  return { registry, repo: rest, tag, image };
}

function request(url, { headers = {}, method = 'GET', timeout = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method, headers, timeout }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.setTimeout(timeout, () => req.destroy(new Error('registry request timed out')));
    req.on('error', reject);
    req.end();
  });
}

/**
 * Parse a `WWW-Authenticate: Bearer realm="...",service="...",scope="..."`
 * challenge into the query the token endpoint wants.
 */
function parseChallenge(header) {
  const value = String(header || '');
  if (!/^bearer /i.test(value)) return null;
  const params = {};
  const re = /([a-z]+)="([^"]*)"/gi;
  let match;
  while ((match = re.exec(value))) params[match[1].toLowerCase()] = match[2];
  return params.realm ? params : null;
}

const tokens = new Map(); // "registry|repo" -> { token, expires }

async function tokenFor(ref, challenge) {
  const key = `${ref.registry}|${ref.repo}`;
  const cached = tokens.get(key);
  if (cached && cached.expires > Date.now()) return cached.token;

  const url = new URL(challenge.realm);
  if (challenge.service) url.searchParams.set('service', challenge.service);
  // Some registries omit the scope from the challenge; the pull scope for
  // this repository is the only thing we ever want, so send it either way.
  url.searchParams.set('scope', challenge.scope || `repository:${ref.repo}:pull`);

  const res = await request(url.toString());
  if (res.status !== 200) throw new Error(`token request failed (${res.status})`);
  const body = JSON.parse(res.body);
  const token = body.token || body.access_token;
  if (!token) throw new Error('registry returned no token');

  const ttl = Number(body.expires_in) || 300;
  // Expire our copy early: a token that dies mid-check is a confusing
  // "registry-unavailable" on a box that is perfectly fine.
  tokens.set(key, { token, expires: Date.now() + (ttl - 30) * 1000 });
  return token;
}

/**
 * The digest the registry currently serves for this exact tag.
 *
 * Returns null rather than throwing for "we could not find out" — a rate
 * limit or a registry outage must show up as "not checked", never as an
 * update that does not exist.
 */
async function remoteDigest(ref) {
  if (!ref) return null;
  const url = `https://${ref.registry}/v2/${ref.repo}/manifests/${encodeURIComponent(ref.tag)}`;
  const headers = { accept: ACCEPT, 'user-agent': 'homebox-updates/1' };

  let res = await request(url, { headers });
  if (res.status === 401) {
    const challenge = parseChallenge(res.headers['www-authenticate']);
    if (!challenge) throw new Error('registry requires auth we cannot satisfy');
    const token = await tokenFor(ref, challenge);
    res = await request(url, { headers: { ...headers, authorization: `Bearer ${token}` } });
  }

  if (res.status === 404) throw new Error(`tag ${ref.tag} is not in the registry any more`);
  if (res.status === 429) throw new Error('registry rate limit — try again later');
  if (res.status !== 200) throw new Error(`registry answered ${res.status}`);

  const digest = res.headers['docker-content-digest'];
  if (digest) return String(digest);

  // A registry that does not send the header still sent the manifest, and the
  // digest of a manifest is the sha256 of its bytes exactly as received.
  const crypto = require('crypto');
  return `sha256:${crypto.createHash('sha256').update(res.body, 'utf8').digest('hex')}`;
}

/**
 * Every tag a repository publishes.
 *
 * The digest check above answers "was this exact version rebuilt". It cannot
 * answer "is there a NEWER version", because a new release is a different
 * tag and nothing about the pinned one changes when it appears. Pinning buys
 * control and costs that notice; this is how the notice is bought back.
 *
 * Paginated, and the pages are NOT newest-first — the registry returns them
 * in its own order, so the whole list has to be walked and sorted here. The
 * page cap is a deliberate stop: a repository with tens of thousands of tags
 * is not worth hanging an update check on.
 */
async function listTags(ref, { maxPages = 12, pageSize = 200 } = {}) {
  if (!ref) return [];
  const headers = { accept: 'application/json', 'user-agent': 'homebox-updates/1' };
  let token = null;
  let path = `/v2/${ref.repo}/tags/list?n=${pageSize}`;
  const tags = [];

  for (let page = 0; page < maxPages && path; page += 1) {
    const auth = token ? { ...headers, authorization: `Bearer ${token}` } : headers;
    let res = await request(`https://${ref.registry}${path}`, { headers: auth });

    if (res.status === 401 && !token) {
      const challenge = parseChallenge(res.headers['www-authenticate']);
      if (!challenge) throw new Error('registry requires auth we cannot satisfy');
      token = await tokenFor(ref, challenge);
      res = await request(`https://${ref.registry}${path}`, { headers: { ...headers, authorization: `Bearer ${token}` } });
    }
    if (res.status !== 200) throw new Error(`registry answered ${res.status} listing tags`);

    let body;
    try {
      body = JSON.parse(res.body);
    } catch {
      throw new Error('registry returned a tag list that is not JSON');
    }
    tags.push(...(body.tags || []));

    // RFC 5988 `Link: </v2/...>; rel="next"`. Absent on the last page.
    const link = res.headers.link;
    const next = link && /<([^>]+)>\s*;\s*rel="next"/.exec(link);
    path = next ? next[1] : null;
  }
  return tags;
}

module.exports = { parseRef, remoteDigest, listTags, DOCKER_HUB };
