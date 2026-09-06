# Security notes

## The dashboard can create and destroy containers, and has no authentication

This is the thing to understand before anything else. Installing an app means
creating containers, so the `dashboard` container mounts `/var/run/docker.sock`
**read-write**. Write access to the Docker socket is root on this box: it can
start a privileged container that mounts the host filesystem.

There is no login. Anyone who can reach the dashboard on port 8443 can install,
stop and remove apps, and read every container's logs.

That is an acceptable trade on a trusted LAN and nothing more. Before putting
it behind a proxy, on a hostname, or anywhere reachable from outside, put a
real auth layer in front of it. **Putting it behind the proxy does not add
authentication** — it only makes the same unauthenticated page easier to find.

Portainer holds the same socket with the same consequences, and it is part of
`core`, so it is always there.

**Nginx Proxy Manager's admin UI on port 81 is the third key to this box.**
Whoever reaches it can point any hostname at anything, including a service
that was never meant to be public. Treat 80 and 443 as the public surface and
81 as strictly internal.

## What is deliberately narrowed

- **Purge is a separate verb from uninstall.** `remove` deletes containers
  and keeps `modules/<id>/config`; `purge` deletes that directory too, and
  the UI makes you type the module name first.
- **Compose runs with argv, never a shell string.** Module ids are validated
  against `^[a-z0-9][a-z0-9-]{0,39}$` before they reach a path or a project
  name, and `spawn` is called with an argument array, so even a bad id cannot
  become shell syntax.
- **Required modules cannot be stopped from the UI.** Stopping the proxy or
  the dashboard from the dashboard is how you lose the page you are clicking
  in, so `core` and `dashboard` reject stop and remove.
- **One operation per module at a time.** Two overlapping `compose up` runs on
  the same project fight over the same containers and leave one half-created.
- **`--purge` is separate from `--yes` in the CLI too**, for the same reason.

## Secrets

`.env` is mode 600, owned by the `homebox` user, and holds every generated
password and encryption key. It is **not** in git — `.gitignore` covers it.

- Modules reference `${NAME}` and never contain a value.
- `x-homebox.env_vars` lists the *names* a module needs. The dashboard shows
  those names; it never reads `.env`.
- `homebox secrets <module>` prints values only when asked, so they do not end
  up in `list` or `info` output that gets pasted into a chat.
- `install.sh` never regenerates a secret that already exists. An encryption
  key that changes (n8n's, for instance) turns every stored credential into
  unreadable bytes.

Read access to the Docker socket also exposes every container's environment
block. Treat anything that can read the socket as holding the same secrets as
`docker inspect`.

## The raw config editor

Settings → Server Config → **Advanced** reads and writes `.env` over an
unauthenticated endpoint. That is the same trust boundary the rest of the
dashboard already has — anything that can install a container can do worse —
but it is worth naming:

- **Only declared keys are writable.** The schema in `lib/config.js` is the
  allowlist; a key not in it is returned read-only and rejected on save.
  "Write any variable name you like into .env" is a far bigger hole than
  "edit these thirty".
- **Values are validated for newlines.** One of them would let a single field
  smuggle in a second variable.
- **The file is edited in place**, line by line. Comments, ordering and keys
  this build does not know about all survive. Rewriting from a parsed object
  is how a config editor quietly eats things.
- **It is written 0600 and chowned back** to whoever owns the tree, because
  the dashboard container runs as root.
- Secrets render as password fields but their values *are* sent to the page.
  That is the difference between this and the Passwords tab: a listing has no
  reason to print a secret, an editor cannot work without one.

## Backups

An archive contains `.env`, which is every generated password on the box. So:

- **There is no unencrypted path.** With `HB_BACKUP_KEY` missing, `create`
  fails and says how to set one. It never falls back to plaintext.
- **AES-256-GCM**, key `scrypt`-derived from `HB_BACKUP_KEY`. On disk:
  `[16-byte IV][ciphertext][16-byte auth tag]`.
- **Every archive is verified before it counts.** It is written to a temp
  path, decrypted and authenticated in full, and only then renamed into
  place. An archive that cannot be decrypted is worse than no archive: it is
  an archive you believe in.
- **Revealing the key is a POST**, not a GET — a secret must not be reachable
  by a link, a prefetch, or anything that lands in browser history. It is
  still an unauthenticated endpoint on an unauthenticated page: whoever can
  open the dashboard can read the key and download the archives.
- **Restore is a shell operation.** It unpacks to a new directory and touches
  nothing live, so a mis-click cannot overwrite a running app's database.
- Archives land on the same filesystem they protect. The UI says so; copying
  them off the box is still a manual job.

## Input handling

- `/api/logs` takes a container **name**, validates it against a strict
  pattern, then checks it against the live container list before use. A name
  that is not on the box is a 404, so nothing user-supplied reaches the
  Docker API path.
- Static file serving resolves the path and verifies the result is still
  inside `public/`, which stops encoded and decoded traversal alike.
- Every POST body is capped at 16KB and its values whitelisted.
- Everything rendered into the DOM goes through `escapeHtml`. Container names,
  image tags and log text are attacker-influenceable in principle and are
  never interpolated raw.

## The proxy

Routing lives in Nginx Proxy Manager's own database, configured through its
UI — there is no generated config file to review in git. Its admin account is
seeded at first boot from `NPM_ADMIN_PASSWORD` so the setup form is never left
open to whoever finds port 81 first.

A real hostname with real TLS is exactly the point at which the authentication
question above stops being optional.
