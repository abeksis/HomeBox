# HomeBox

A self-hosted app platform for one box. It installs and runs the apps itself —
you pick something from a catalog, it pulls the images, creates the
containers, and tells you where to log in.

The dashboard runs on port **8443**.

## Install

On a clean Debian or Ubuntu box:

```bash
curl -fsSL https://raw.githubusercontent.com/abeksis/HomeBox/main/scripts/bootstrap.sh | sudo bash
```

It downloads this repository, unpacks it to `/opt/homebox`, then runs
`install.sh` — Docker, Node, the tree, this machine's own generated secrets,
the networks, and core + dashboard. About three minutes on a fresh VM.

It refuses to run over an existing install rather than half-upgrading one.

That command pipes a script from the internet into a root shell, which is
worth being deliberate about. To read it first:

```bash
curl -fsSL https://raw.githubusercontent.com/abeksis/HomeBox/main/scripts/bootstrap.sh -o hb.sh
less hb.sh && sudo bash hb.sh
```

`HB_FETCH_ONLY=1` stops after unpacking. `HB_REF=some-branch` installs a
branch or tag. `HB_TARBALL=<url>` installs from anywhere else, for a network
with no route to GitHub.

### Updating

```bash
cd /opt/homebox && git pull && sudo bash install.sh
```

`install.sh` is idempotent: it repairs what is missing and never regenerates a
secret that already exists.

That command updates HomeBox itself — the dashboard, the CLI, and the pinned
image versions in the compose files.

#### App image updates (the Updates tab)

Separately, the dashboard's **Updates** tab handles a case a pinned version
does not protect you from. Every module here pins an exact tag on purpose
(`pihole/pihole:2026.07.2`, `jc21/nginx-proxy-manager:2.15.1`, …) so that
nothing jumps a major version unattended — but a pinned tag is not frozen
bytes. Publishers re-push the same tag when a base layer gets a CVE fix, so
the tag you pinned points at a new digest, and `docker compose pull` will
report "up to date" while your copy is months of security patches behind,
because compose only compares tags.

The Updates tab compares the **digest** of every running image against what
its registry serves for that same tag, and lists the differences. Nothing is
applied until you press the button. When you do, one service at a time:

1. archive that module's `config/` directory,
2. record the image id currently running — this is the rollback,
3. `pull`, then `up -d --no-deps` for that one service,
4. wait for it to report healthy; if it does not, re-tag the recorded image,
   recreate, and record the failure in the page's history.

Moving an app to a genuinely newer *version* is not something this button
does. That is a change to a compose file in this repo, and it arrives with a
HomeBox release, via the `git pull` above.

### Uninstalling

```bash
sudo bash /opt/homebox/scripts/uninstall.sh
```

It prints an inventory of exactly what will go — containers, networks, images
built here, and the size of each thing under `/opt/homebox` — then asks you to
type `remove`. Options:

| | |
|---|---|
| `--yes` | skip the confirmation, for scripts |
| `--keep-data` | delete everything except `data/` and `backups/` |
| `--keep-images` | leave the images built here in place |

If the tree is already gone, run it straight from here:

```bash
curl -fsSL https://raw.githubusercontent.com/abeksis/HomeBox/main/scripts/uninstall.sh | sudo bash -s -- --yes
```

**Docker is left installed.** It was probably wanted anyway, and removing it
would take any other containers on the machine with it.

**Storage that is not under `/opt/homebox` is never touched.** If `HB_DATA_DIR`
or `HB_MEDIA_ROOT` points somewhere else — a NAS mount, say — the script says
so and leaves it completely alone. Uninstalling the dashboard must not mean
deleting the media. For the same reason the systemd mount units written by
`scripts/mount-remote.sh` are left in place; the script tells you where they
are if you want them gone.

### What is NOT in this repository

`.env`, `state/`, `backups/`, `data/` and every `modules/*/config/` — the
generated passwords, the app databases and the media. They are produced on
each machine and belong to it. `docs/HOST-CHANGES.md` is also excluded: it
records what was done to one particular box, which is exactly the thing that
should not follow the code around.

```
/opt/homebox
├── install.sh                  # clean Debian → running HomeBox
├── homebox                     # the CLI
├── .env                        # generated secrets, mode 600
├── modules/
│   ├── core/
│   │   ├── docker-compose.yml      # services + x-homebox metadata
│   │   └── config/{npm,portainer}   # this module's app config, in the module
│   ├── media/
│   │   ├── docker-compose.yml
│   │   ├── setup.sh                # optional: seed files an image won't create
│   │   └── config/{radarr,sonarr,…}
│   └── …                           # one directory per module
├── dashboard/                  # the web UI (node, no npm dependencies)
├── data/                       # the shared pool: media, photos, books, downloads
├── scripts/
├── state/                      # enabled list, activity log, UI prefs
└── docs/
```

## One folder per app

A module is a directory. The compose file inside it carries both the services
and, in a top-level `x-homebox:` block, everything a person or the dashboard
needs to know about them:

```yaml
x-homebox:
  id: monitoring
  title: "Monitoring"
  tagline: "Know before your family tells you"
  category: "system"
  ram: "~180MB"
  theme: { emoji: "📊", color: "#30d158" }
  tips: [ "Start with a monitor for the dashboard itself…" ]
  services:
    uptime-kuma:
      friendly_name: "Uptime Kuma"
      color: "#5cdd8b"
      port_map: 3001
      first_login: "Create the admin account on the first visit."

services:
  uptime-kuma:
    image: louislam/uptime-kuma:2.5.3
    container_name: uptime-kuma
    …
```

Compose ignores top-level `x-` keys, so the same file is both the deployment
unit and the catalog entry. There is nothing to keep in sync, and the app's
config directory lives in the module too — `modules/<id>/config/<app>`. Copy
the folder and you have copied the app.

## Installing apps

```bash
homebox list                    # everything available, and what is running
homebox install monitoring      # seed, pull, start, mark enabled
homebox info monitoring         # what it is, where it is, how to log in
homebox secrets core            # the generated passwords for one module
homebox status                  # every container HomeBox runs
homebox remove git --yes        # stop and delete containers, keep the data
homebox remove git --yes --purge  # ...and delete the data too
```

Or click **Install** — and **Uninstall** — on the Apps page. Same code path — the dashboard shells
out to `docker compose`, so the CLI and the UI can never disagree about what
is installed.

## Available modules

| Module | App | Default |
|---|---|---|
| `core` | Nginx Proxy Manager, Portainer | required |
| `dashboard` | HomeBox itself | required |
| `files` | File Browser | on |
| `monitoring` | Uptime Kuma | on |
| `dns` | AdGuard Home | on |
| `vpn` | WireGuard (wg-easy) | on |
| `cloud` | Nextcloud | on |
| `media` | Radarr, Sonarr, Prowlarr, Bazarr, qBittorrent, FlareSolverr | off |
| `jellyfin` | Jellyfin | off |
| `photos` | Immich | off |
| `passwords` | Vaultwarden | off |
| `bookmarks` | Linkding | off |
| `git` | Gitea | off |
| `automation` | n8n | off |

Adding another is a directory and a compose file — no registry, no rebuild,
no restart. `homebox validate` checks it; the dashboard picks it up on its
next refresh.

## How it hangs together

- **One compose project per module** (`homebox-<id>`). A broken module can be
  rebuilt without touching anything else, and Docker's own project label is
  what maps a running container back to its module. Nothing is hand-maintained.
- **Containers are named after the app** — `portainer`, `gitea`, `uptime-kuma`. No prefix: this box runs nothing but HomeBox, and the module that owns a container comes from its compose project label, not from its name.
- **Secrets are generated once** by `install.sh` into `.env` (mode 600) and
  never regenerated — an encryption key that changes is data you cannot read.
- **Routing is Nginx Proxy Manager's job**, configured in its own UI on port
  81 — the same choice the original makes. Until you add a domain there, every
  app is reachable directly by port.
- **The dashboard has no npm dependencies.** Node builtins only, so the image
  builds without registry access and there is no dependency tree to audit for
  a process that holds a Docker socket.
