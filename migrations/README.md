# migrations/

A migration carries an **existing** box from one release to the next. It exists for
exactly the things `install.sh` structurally cannot do.

`install.sh` is idempotent because `set_env` **never overwrites**. That rule is right and
must stay — it is what stops a re-run from regenerating a key an app has already
encrypted data with. But it also means a release that must *change* a value has no route
through `install.sh` at all. That route is here.

```
migrations/
  0.2.0/up.sh
  0.3.0/up.sh
```

One directory per release, named exactly as the version. `scripts/self-update.sh` runs
them in version order (`sort -V`) and records each in `state/migrations-done.json`.

## The three rules

**1. A fresh install runs none of them.**

`install.sh` marks every migration in the tree as done, without running it, when it
creates a box. A box born at 0.9.0 has nothing to carry forward — its tree is already
in the final shape. Replaying thirty historical migrations against it is the classic
way a migration system destroys a working install on its first day.

**2. They must be safe to re-run anyway.**

The bookkeeping normally prevents a second run, but a power cut mid-update means the
resume re-runs whatever was in flight. So every migration opens by testing for its own
end state and exiting 0 if it is already there. Write the test first; it is the part
that makes the migration correct rather than merely working.

**3. A failure aborts the update and rolls back.**

There is no "continue anyway". A half-migrated box that then rebuilds its dashboard is
the worst outcome available, and it is worse than not updating.

## Bash, not JavaScript

They run while the dashboard is **down** — that is when an update happens. Anything that
needs the dashboard's libraries cannot be a migration.

## Changing a value in .env

`install.sh` defines `env_force` for values HomeBox owns outright. A migration that needs
to change something a *person* might have customised should not use it: check the value
is still the shipped default first, and leave a deliberate customisation alone.

Getting that backwards means a release silently reverting somebody's setting, and they
will not find out until the thing it controlled behaves differently.

## No down migrations

Forward only. A down-migration on somebody's home server is a large amount of
rarely-exercised code guarding a case that the pre-update backup and the code rollback
already cover between them — `git checkout <previous sha>` restores every tracked file,
and `state/platform-backups/` holds `state/` and `.env` as they were.

## What each one is handed

| | |
|---|---|
| `HB_ROOT` | The install root, always |
| `$HB_ROOT/.env` | Present and writable |
| Working directory | `$HB_ROOT` |
| Runs as | root, on the host |

Exit 0 for success or "already done". Any other exit rolls the update back.
