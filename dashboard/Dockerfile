# HomeBox dashboard.
#
# The server itself has no npm dependencies — node builtins only — so this
# image builds on a box with no registry access beyond the base image, and
# there is no dependency tree to audit for a process that holds a Docker
# socket. The only additions are the Docker CLI and the compose plugin,
# because installing a module means running `docker compose` against the
# host daemon rather than reimplementing compose over the Engine API.
FROM node:22-alpine

# tzdata: without the zone database alpine ignores TZ and every timestamp
# this process prints is UTC, whatever the host is set to.
RUN apk add --no-cache tini docker-cli docker-cli-compose bash tzdata

WORKDIR /app
COPY package.json ./
COPY server.js ./
COPY lib ./lib
COPY public ./public

ENV NODE_ENV=production \
    PORT=8443 \
    HOMEBOX_ROOT=/opt/homebox

EXPOSE 8443

# Runs as root inside the container so it can open the host's docker socket,
# which is group-owned by `docker` with a gid that differs from box to box.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8443/healthz >/dev/null 2>&1 || exit 1

# tini reaps zombies and forwards SIGTERM, so `docker stop` is a clean exit
# rather than a ten-second kill — and compose spawns real child processes here.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
