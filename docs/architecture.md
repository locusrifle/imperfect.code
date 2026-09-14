# Architecture and readiness

## What this is

A Pi/Guey-backed personal computer, reached through the existing locus.garden door and authenticated proxy. Users can rearrange UI and add apps later; this migration does not redesign memory or the shell.

Brand and domain stay Locus / locus.garden. The source repository is imperfect.computer.

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
  data/agent               Pi profile (auth, settings, extensions)
/etc/systemd/system/imperfect.service
```

The unit runs as `imperfect` without sudo. ExecStart uses `/opt/imperfect/runtime/bin/node /opt/imperfect/current/start.mjs`. A PATH or nvm symlink is the restore bug this avoids.

## Launcher

`start.mjs` always binds loopback, names workspace as files/knowledge roots, uses its own session archive, enables provider setup, and disables terminal discovery. Ingress remains the existing proxy. Desktop streaming is **pending** and off.

## Ready here

- Allowlisted release pack that cannot omit `index.html` / `files.html` / `antiburn.html` / `stock.html`
- Official Node tarball digest pin; laptop Node is not copied
- Atomic `current` symlink, health check, rollback that does not touch `data/`
- Unprivileged tests with a fake service runner
- Real `start.mjs` subprocess health and origin refusals

## Not ready here

- Root install on vaita (no sudo). Parent can stage, not activate a dedicated user.
- Live Box install (parent owns `bx_mu5ts46y` after review)
- Desktop capability, billing, key rotation, customer template proof
- Browser-test failures inherited from the imported shell (not fixed in this pass)
