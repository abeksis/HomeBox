# get.abeksis.net

A Cloudflare Worker in front of the install script and the release manifest. It serves
them from `main` on GitHub and keeps two anonymous counts:

| What | How it is counted | Kept |
|---|---|---|
| Installs / uninstalls | +1 per day, per script, per country | totals |
| Running boxes | once per day per box: `sha256(SALT \| day \| ip)`, with the version the box sends in `x-homebox-version` | raw rows 2 days, then per-version totals |

No IP address, user agent or other request detail is stored. A box cannot be followed
from one day to the next because the date is inside the hash. Boxes opt out with
`HB_ANONYMOUS_STATS=off` in `.env` (then `dashboard/lib/platform.js` reads GitHub
directly); a Worker outage also falls back to GitHub.

Stats: `https://get.abeksis.net/stats?key=<STATS_TOKEN>` (page) or `/stats.json`.

## Deploy

```bash
cd infra/get-worker
npm install
npx wrangler login
npx wrangler d1 create homebox-stats          # put the id into wrangler.toml
npx wrangler d1 execute homebox-stats --remote --file schema.sql
npx wrangler secret put SALT                  # any long random string
npx wrangler secret put STATS_TOKEN           # the key for /stats
npx wrangler deploy
```

Then in Cloudflare → abeksis.net → Rules → Redirect Rules, **disable** the old
`get.abeksis.net` redirect rules. Redirect rules run before Workers, so while they are
on, the Worker never sees `/install.sh`. The `get` DNS record stays as it is (proxied).

## Local test

```bash
printf 'SALT=dev\nSTATS_TOKEN=dev\n' > .dev.vars
npx wrangler d1 execute homebox-stats --local --file schema.sql
npx wrangler dev --local --test-scheduled   # the rollup also runs on a day's first request
curl -H 'x-homebox-version: 0.4.18' localhost:8787/manifest.json
curl 'localhost:8787/stats.json?key=dev'
curl 'localhost:8787/__scheduled?cron=17+3+*+*+*'   # run the daily rollup
```
