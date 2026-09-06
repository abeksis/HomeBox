# The `x-homebox` block

Every module is `modules/<id>/docker-compose.yml`. Compose ignores top-level
keys starting with `x-`, so the metadata below lives in the same file as the
services it describes.

```yaml
x-homebox:
  id: monitoring            # required — must match the directory name
  title: "Monitoring"       # required — shown everywhere
  tagline: "Know before your family tells you"   # required — one line
  category: "system"        # required — see the list below
  description: "…"          # a paragraph, shown on the app card
  icon: "uptime-kuma.svg"   # file under dashboard/public/icons; falls back to
                            # a coloured monogram when missing
  added_at: "2026-09-05"
  required: false           # required modules cannot be stopped or removed
  default: true             # counts as enabled before state/modules.conf exists
  ram: "~180MB"             # rough, honest estimate — a budgeting aid

  theme:
    emoji: "📊"
    color: "#30d158"
    bg: "rgba(48,209,88,0.12)"

  tips:                     # what you would tell someone who just installed it
    - "Use the box's LAN IP for other apps — localhost means this container"

  env_vars:                 # NAMES only, never values
    FILEBROWSER_ADMIN_PASSWORD:
      label: "Admin password"
      type: "secret"        # text | secret | boolean
      config_editable: false
      dangerous: false      # true when changing it can lose data

  services:                 # keyed by the compose service name
    uptime-kuma:
      friendly_name: "Uptime Kuma"
      color: "#5cdd8b"     # the app's brand colour — paints its launcher keycap
      description: "Uptime monitoring and alerting"
      icon: "uptime-kuma.svg"
      port_map: 3001        # the HOST port — what a link in the UI opens
      container_port: 3001  # what the app listens on inside; defaults to port_map
      url_scheme: "http"    # http | https
      internal: false       # true = infrastructure, keep it out of the launcher
      tip: "…"
      first_login: "Create the admin account on the first visit."
```

Categories: `core`, `media`, `photos`, `files`, `security`, `network`,
`productivity`, `system`, `other`. Anything else falls back to `other`.

## Rules that matter

**`id` must equal the directory name.** `homebox validate` fails otherwise.
Two sources of truth for a module's identity is how a catalog drifts from
what is on disk.

**Nothing declares which containers a module owns.** That comes from Docker's
compose project label (`homebox-<id>`), so the mapping cannot go stale. Name
containers after the app itself — `portainer`, not `homebox-portainer`.

**`port_map` is the host port; `container_port` is the inside port.** They
differ more often than you would think (File Browser publishes 8086 but
listens on 80). The UI links to the first; the second is what a reverse-proxy
entry has to target.

**`color` belongs to the app, not the module.** The launcher paints each
keycap with it, so two apps in one module (Proxy Manager and Portainer in
`core`) come out as different keys. Without it they fall back to the module's
theme colour and look identical.

**`internal: true` keeps a service out of the launcher.** Databases, caches
and proxies have no UI worth opening, and a launcher full of tiles nobody
clicks is how a dashboard stops being read.

**Config belongs inside the module.** `${HB_ROOT}/modules/<id>/config/<app>`,
not a shared appdata tree. The point of the layout is that a module is one
folder you can copy, back up or delete.

**Shared user data belongs in the pool.** `${HB_DATA_DIR}` — media, photos,
books, downloads. Anything several modules read (a film Radarr fetched and
Jellyfin plays) goes here, mounted at the same path in every container so
hardlinks work.

**Secrets are names, never values.** Declare the name in `env_vars`, let
`install.sh` generate it into `.env`, and reference it as `${NAME}` in the
service. `homebox secrets <module>` prints them on request.

## `setup.sh`

Optional, at `modules/<id>/setup.sh`. It runs before the first start (and on
every `install`), so it must be idempotent. Use it only for what an image
cannot do for itself:

- seeding a config file the app requires but will not create (`files`)
- creating the pool directories with the right ownership (`media`)

It gets `HB_ROOT` in the environment and should be safe to re-run.

## Storage on another machine

`HB_MEDIA_*` and `HB_DATA_DIR` are paths **on the Docker host**. A bind mount
cannot point at a network address — there is no `//nas/media` form — so a
library that lives on a NAS has to be mounted on this box first:

```
NAS  --NFS-->  /mnt/media_disk on the host  --bind-->  /data/media/movies
```

`scripts/mount-remote.sh` writes a systemd `.mount` + `.automount` pair for
that, rather than an fstab line, because of one failure mode: an *arr app
started against an **empty** mountpoint concludes its library vanished and
begins "fixing" the difference. An automount establishes the share on first
access, so a broken NAS is an error instead of an empty directory.

Two things decide whether this works well:

- **The export must allow this box.** An NFS server that does not list this
  host in the export ACL makes the mount hang and then fail with something
  unhelpful, so the script checks `showmount -e` first and refuses early.
- **NFS, not SMB, for a media library.** CIFS has no usable hardlink support,
  so every import from the download folder becomes a full copy. Keep
  downloads and library inside the *same* export and hardlinks survive.

## Timezones

Set `TZ=${TZ:-UTC}` on every service. Most images ship a zone database and
that is enough.

A **minimal alpine image usually does not**, and the failure is quiet: with
`TZ` set to a name, musl looks it up in `/usr/share/zoneinfo`, does not find
it, and falls back to UTC — *ignoring* a mounted `/etc/localtime`. Every
timestamp that container prints is then hours off. Lend it the host's copy:

```yaml
    volumes:
      - /usr/share/zoneinfo:/usr/share/zoneinfo:ro
```

Never bind-mount `/etc/timezone`: it does not exist on a systemd host, and
Docker creates a *directory* there rather than failing.

## Resource limits and logging

Every service should carry them. A home box has no autoscaler: one runaway
container is the difference between "an app is slow" and "the box is gone".

```yaml
    deploy:
      resources:
        limits:
          memory: 384M
          cpus: '0.50'
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
```

Without the logging cap a chatty container fills the disk in a month, and a
full disk breaks every other app in ways that look unrelated.

## Only the supported YAML subset

The `x-homebox` block is read by a small parser (`dashboard/lib/yaml.js`), not
a full YAML implementation: maps, lists, quoted and plain scalars, comments.
No anchors, flow collections or multi-line scalars. Anything outside the
subset throws loudly at `homebox validate` rather than silently losing half a
module. The `services:` section below it is read by Compose itself and has no
such limits.
