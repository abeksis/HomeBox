# releases/

`manifest.json` is the control plane for every HomeBox install in existence.

Boxes fetch it from
`https://raw.githubusercontent.com/abeksis/HomeBox/main/releases/manifest.json`
every six hours. It is deliberately a file in `main` rather than a release asset:
**it has to be changeable without cutting a release**, because its most important
job is stopping one.

```json
{
  "schema_version": 1,
  "channels": { "stable": "0.2.0" },
  "freeze": false,
  "freeze_reason": null,
  "min_from_version": "0.1.0",
  "frontend_only": false
}
```

| Field | What it does |
|---|---|
| `channels.stable` | The version boxes offer. A box only sees an update when this is higher than its own `VERSION` |
| `freeze` | **The emergency switch.** `true` and every box stops offering updates, including ones mid-check |
| `freeze_reason` | Shown to the user in place of the button. Say what is wrong, not "please wait" |
| `min_from_version` | A box older than this is told to update manually. Set it when a migration is dropped |
| `frontend_only` | Reserved. Read but not yet acted on — see the note in `docs/RELEASING.md` |

## Throwing the switch

A bad release is a one-line commit:

```json
"freeze": true,
"freeze_reason": "0.2.1 breaks Immich on boxes without a NAS. Fix coming today."
```

Push it. `raw.githubusercontent.com` serves `cache-control: max-age=300`, so every box
in the world stops within five minutes — with no access to any of them, and nothing
for their owners to do.

That five minutes is the honest number, measured rather than assumed. It is the reason
`freeze` exists as a separate field instead of just moving `channels.stable` backwards:
a box that already fetched the manifest and is about to act needs to be told *stop*,
not told a different number.

## What this is not

There is no telemetry. Nothing reports back, so the manifest is one-way: it can stop
an update, and it cannot tell you whether anyone applied one. That is deliberate — a
box in someone else's house is theirs.
