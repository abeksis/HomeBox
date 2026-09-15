# Credits

HomeBox is an installer and a dashboard. It does not include the code of the apps it runs: each app is pulled as a container image from its own publisher when you install it, and stays under that project's own licence. The images each module uses are listed below; follow the image name to the project for its source and licence.

HomeBox's own code is under the MIT licence (see [LICENSE](LICENSE)).

## Icons

App icons in `dashboard/public/icons` come from [homarr-labs/dashboard-icons](https://github.com/homarr-labs/dashboard-icons) (fetched with `scripts/fetch-icons.sh`), apart from the HomeBox logo itself. The marks belong to their respective projects.

## Apps

| Module | Container images |
|---|---|
| Actual Budget | `actualbudget/actual-server` |
| AdGuard Home | `adguard/adguardhome` |
| Audiobookshelf | `ghcr.io/advplyr/audiobookshelf` |
| Authelia | `authelia/authelia` |
| Beszel | `henrygd/beszel`, `henrygd/beszel-agent` |
| BookStack | `linuxserver/bookstack`, `linuxserver/mariadb` |
| Change Detection | `ghcr.io/dgtlmoon/changedetection.io`, `dgtlmoon/sockpuppetbrowser` |
| ClamAV | `clamav/clamav` |
| Cloudflare Tunnel | `cloudflare/cloudflared` |
| CoolerControl | `coolercontrol/coolercontrold` |
| Core Infrastructure | `jc21/nginx-proxy-manager`, `portainer/portainer-ce` |
| Crafty Controller | `arcadiatechnology/crafty-4` |
| Duplicati | `linuxserver/duplicati` |
| Ebooks | `linuxserver/calibre-web`, `jvmilazz0/kavita` |
| Emby | `emby/embyserver` |
| ErsatzTV | `jasongdove/ersatztv` |
| Factorio | `factoriotools/factorio` |
| File Browser | `gtstef/filebrowser` |
| FreshRSS | `freshrss/freshrss` |
| Frigate | `ghcr.io/blakeblackshear/frigate` |
| Ghost | `ghost`, `mysql` |
| Gitea | `gitea/gitea` |
| Gotify | `gotify/server` |
| Headscale | `headscale/headscale`, `ghcr.io/gurucomputing/headscale-ui`, `nginx` |
| Home Assistant | `homeassistant/home-assistant` |
| HomeBox Dashboard | `homebox-dashboard` |
| Immich | `ghcr.io/immich-app/immich-server`, `ghcr.io/immich-app/immich-machine-learning`, `docker.io/valkey/valkey`, `ghcr.io/immich-app/postgres` |
| Jellyfin | `lscr.io/linuxserver/jellyfin` |
| Jellystat | `cyfershepard/jellystat`, `postgres` |
| Kiwix | `ghcr.io/kiwix/kiwix-serve` |
| Linkding | `sissbruecker/linkding` |
| Local AI | `ghcr.io/open-webui/open-webui`, `ollama/ollama` |
| Matrix | `matrixdotorg/synapse`, `vectorim/element-web`, `postgres` |
| Mealie | `ghcr.io/mealie-recipes/mealie` |
| Media Stack | `lscr.io/linuxserver/qbittorrent`, `lscr.io/linuxserver/radarr`, `lscr.io/linuxserver/sonarr`, `lscr.io/linuxserver/prowlarr`, `lscr.io/linuxserver/bazarr`, `ghcr.io/flaresolverr/flaresolverr` |
| Minecraft (Bedrock) | `itzg/minecraft-bedrock-server` |
| Monitoring | `louislam/uptime-kuma` |
| n8n | `docker.n8n.io/n8nio/n8n` |
| Navidrome | `deluan/navidrome` |
| Nextcloud | `lscr.io/linuxserver/nextcloud`, `mariadb`, `redis` |
| Paperless-ngx | `ghcr.io/paperless-ngx/paperless-ngx`, `postgres`, `redis` |
| Password Vault | `vaultwarden/server` |
| PhotoPrism | `photoprism/photoprism`, `mariadb` |
| Pi-hole | `pihole/pihole` |
| Pinchflat | `ghcr.io/kieraneglin/pinchflat` |
| Plex | `lscr.io/linuxserver/plex` |
| Project Zomboid | `renegademaster/zomboid-dedicated-server` |
| SearXNG | `searxng/searxng` |
| Shelfarr | `ghcr.io/pedro-revez-silva/shelfarr` |
| Speedtest Tracker | `lscr.io/linuxserver/speedtest-tracker` |
| Stable Diffusion | `ghcr.io/ashleykleynhans/stable-diffusion-webui` |
| Static Site | `nginx` |
| Stirling PDF | `stirlingtools/stirling-pdf` |
| Syncthing | `lscr.io/linuxserver/syncthing` |
| Tailscale | `tailscale/tailscale` |
| Tdarr | `ghcr.io/haveagitgat/tdarr` |
| Terraria | `ryshe/terraria` |
| Tunarr | `chrisbenincasa/tunarr` |
| Unpackerr | `golift/unpackerr` |
| Valheim | `lloesche/valheim-server` |
| VPN | `ghcr.io/wg-easy/wg-easy` |
| Wizarr | `ghcr.io/wizarrrr/wizarr` |
| WordPress | `wordpress`, `mariadb` |
