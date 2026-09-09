# Releasing HomeBox

Since HomeBox runs on machines you do not own, a release is a thing that happens to
other people. This is the checklist.

## The model

- **`main` is the development branch.** Nobody installs from it. Push freely.
- **A release is an annotated tag**, `v0.2.0`. Friends' boxes check out tags and sit on
  a detached HEAD, so what they run is a point you chose rather than a moving target.
- **`releases/manifest.json` on `main` decides what is offered.** It is separate from
  the tag on purpose: you must be able to stop a release *after* cutting it.

## Cutting a release

1. **Write the migration first, if the release needs one.** `migrations/<version>/up.sh`
   — see `migrations/README.md`. Anything that changes an existing `.env` value or moves
   a config file needs one, because `install.sh` never overwrites.

2. **Bump `VERSION`.** One line, and it is the single source of truth: `install.sh`
   writes it into `.env` as `HB_VERSION`, which becomes the dashboard's image tag.

3. **Commit and push to `main`.**

4. **Tag it, annotated:**
   ```
   git tag -a v0.2.0 -m "HomeBox 0.2.0"
   git push origin v0.2.0
   ```
   Annotated, not lightweight — an annotated tag carries a date and a message, and is
   what `git describe` reports on a friend's box.

5. **Write the release notes on GitHub.** The Updates card fetches them from
   `api.github.com/repos/abeksis/HomeBox/releases/tags/v0.2.0` and shows them above the
   button. This is the only thing a friend reads before deciding, so write it for them:
   what changed, what they will notice, whether anything needs their attention.

6. **Only then, flip the manifest** on `main`:
   ```json
   "channels": { "stable": "0.2.0" }
   ```
   Boxes see it within five minutes. Do this last — a manifest pointing at a tag that
   does not exist yet is an update that fails on every box that tries.

7. **Take it yourself first.** Update your own box through the button. If it is not good
   enough for your box, it is not good enough for theirs.

## A broken updater cannot ship its own fix

Not hypothetical — it happened on the first real release, twice.

`scripts/self-update.sh` runs from the tree the box is **on**, not the one it is moving
to. So a release that fixes the updater is delivered by the broken updater, and does not
arrive. Both times the box refused or rolled back and stayed exactly where it was, which
is the right failure — but it stayed.

When a release changes `scripts/self-update.sh` in a way that matters, say so in the
notes and expect boxes to need one hop by hand:

```bash
cd /opt/homebox && sudo git fetch --tags && sudo git checkout v0.2.3 && sudo bash install.sh
```

Then raise `min_from_version` past the broken release, so a box below it is told to do
that rather than handed a button that cannot work.

## Stopping a release

One line in `releases/manifest.json`:

```json
"freeze": true,
"freeze_reason": "0.2.1 breaks Immich on boxes without a NAS. Fix coming today."
```

Push it. Every box stops offering the update within five minutes and shows the reason
instead of the button. Boxes that are **mid-update** stop too: `scripts/self-update.sh`
re-reads the manifest from git one step before it writes anything, and refuses.

Say what is actually wrong. `freeze_reason` is shown verbatim to somebody who was about
to press a button, and "please wait" tells them nothing about whether their box is at
risk right now.

Unfreeze by setting it back to `false`. There is no other state to clean up.

## When a release should not be offered to old boxes

```json
"min_from_version": "0.2.0"
```

A box below that is told it needs a manual update instead of being offered the button.
Raise this when you delete a migration — the automated path can only be honest about a
jump it still carries the steps for.

## What a friend's box actually does

1. Every six hours, and on demand, it fetches `releases/manifest.json`.
2. If `freeze` is set, it stops there.
3. If `channels.stable` is newer than its `VERSION`, the Updates tab grows a card.
4. On the button: backup `state/` and `.env`, fetch the tag, **re-check the freeze from
   git**, check out, run pending migrations, run `install.sh`, wait for the dashboard to
   answer.
5. If any of that fails, it checks the previous commit back out, restores the tarball,
   and rebuilds — landing back where it started.

Nothing reports back to you. You will not know who updated, or whether it worked. That
is the deliberate trade for not running a telemetry endpoint, and it is why the freeze
switch matters: it is the only lever you have after a release is out.

## Deferred

- **Signed tags.** `git tag -s` and a published public key, verified in
  `scripts/self-update.sh` where the comment marks the spot. Worth doing before the
  install base is larger than people you know.
- **`frontend_only`.** The manifest field exists and is read. Acting on it — skipping
  the rebuild when only `public/` changed — needs `ASSET_TAG` in `server.js` to stop
  being computed once at startup, or the box would serve the old CSS against the new
  markup.
- **A canary channel.** The manifest carries `channels`; only `stable` is consulted.
