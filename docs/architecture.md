# Architecture and readiness

## What this is

A Pi/Guey-backed personal computer, reached through the existing imperfect.computer door and authenticated proxy. Users can rearrange UI and add apps later; this migration does not redesign memory or the shell.

Brand and domain are imperfect computers / imperfect.computer. The source repository is imperfect.computer.

## Layout on a machine

Box snapshots capture `/opt`, `/etc`, and `/home/user`. They do not capture arbitrary `/var/lib`, and `/home/imperfect` is not a safe assumption. Everything persistent lives under `/opt/imperfect`:

```text
/opt/imperfect/
  runtime/                 root-owned official Node 22.23.2 (real binaries)
  releases/<id>/           root-owned, not writable by the runtime user
  current -> <id>
  previous -> <id>
  machine.json             port, origins, product, brand — no secrets
  data/workspace           runtime-user owned personal files
  data/state               sessions and GUI store
  data/agent               Pi profile (auth, settings, extensions, custom themes)
  data/ui                  harness/desktop CSS overlays (survive upgrades)
/etc/systemd/system/imperfect.service
```

The unit runs as `imperfect` without sudo. ExecStart uses `/opt/imperfect/runtime/bin/node /opt/imperfect/current/start.mjs`. A PATH or nvm symlink is the restore bug this avoids.

The same layout serves a machine somebody already owns. On vaita the prefix is `/home/dacre/imperfect`, the unit is Noah's own `imperfect-machine.service`, and `data/workspace`, `data/state` and `data/agent` are symlinks onto the directories that machine was already using — so moving it onto releases moved no user data and created no second copy. `--user-unit --unit <name>` is the only difference the installer needs; a machine on this host was previously updated by editing a tree in place, which is why it had no release identity and no rollback.

## Build identity

`machine.mjs` `buildIdentity()` reads the directory the running module is in. Under `<prefix>/releases/<id>` that directory name *is* the release id, and `/health` reports it as `release` alongside `version`. A checkout reports `release: null` rather than inventing one.

This is what makes activation verifiable. `systemctl enable --now` does nothing to an already-running unit, so `current` can advance while the old process keeps answering `/health` — an upgrade that reports success, never happened, and never trips its own rollback. `activate` now fails and rolls back if the process does not name the release just activated.

## Stage, then activate

`stage --artifact` unpacks, runs `npm ci` and protects the tree without touching what is serving; it is safe while the agent is mid-turn. `activate --id` moves the symlink, restarts, verifies identity and health, and rolls back on failure. `install` and `update` are still both halves in one gesture, for a machine nobody is using yet.

The split exists so activation can wait for idle. Who decides that, and how both machines are updated together, is the door's `fleet.mjs` — see its `docs/fleet.md`.

## Launcher

`start.mjs` always binds loopback, names workspace as files/knowledge roots, uses its own session archive, enables provider setup, and disables terminal discovery. Ingress remains the existing proxy. Desktop streaming is **pending** and off.

## Ready here

- Allowlisted release pack that cannot omit `index.html` / `files.html` / `antiburn.html` / `stock.html`
- Official Node tarball digest pin; laptop Node is not copied
- Atomic `current` symlink; activation always **restarts** the unit (not `enable --now`); health check; rollback that does not touch `data/`
- Release identity through `/health`, asserted end to end: staging does not change what is serving, activating does, an unstaged id is refused, and a symlink that advanced without the process being replaced is caught and rolled back
- Both real machines on `0.3.0-dc5b49d9e362` as of 2026-09-15, each verified through its own route; rollback and re-activation exercised on the live Box with its session file intact
- Unprivileged tests with a fake service runner, plus a unit test that refuses `enable --now`
- Real `start.mjs` subprocess health and origin refusals
- Live Box root install on `bx_mu5ts46y`: isolation, phone and desktop browser, restart, upgrade, failed-upgrade rollback, snapshot stop/resume. Details and limits: [verification.md](verification.md)

## Not ready here

- Dedicated-user isolation on vaita (no root). Noah's own machine there runs as `dacre` under his user systemd; the release tree is read-only to him rather than owned by root.
- Schema-aware data migrations. Rollback keeps `data/` because releases so far only read it; a release that changes its shape has nothing here to help it.
- Release pruning and more than one `previous`. The Box holds five releases and one step of history.
- Ingress password gate and a durable fronting proxy (loopback is not reachable from the Box edge)
- Product backup command (data is restorable by ordinary tar; that is not a feature)
- Desktop capability, billing, fleet-key rotation, a real model-authenticated customer journey
- Browser-test failures inherited from the imported shell (not fixed in this pass)
