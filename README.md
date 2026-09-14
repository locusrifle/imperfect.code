# imperfect.computer

Private source for the Locus machine app. People still reach it as **Locus** at **locus.garden**. This is not the account door (`vaita:/home/dacre/locus-garden`) and not Noah's laptop console.

Pi 0.85.1 under a graphical Guey shell. Users can later rearrange UI and add apps; this tree does not redesign that today.

## Run from a checkout

```sh
npm ci
IMPERFECT_PREFIX=/tmp/locus-dev node start.mjs
```

Write `machine.json` in that prefix first, or copy the defaults from `machine.mjs`. The process binds loopback only.

## Install on a host

Exact commands, Node pin, update, and rollback: [docs/operations.md](docs/operations.md).

Customer runtime is official **Node 22.23.2 linux-x64**, digest-pinned. Do not copy laptop Node.

## Tests

```sh
npm test            # runtime, product, installer, subprocess
npm run test:auth   # provider setup with fake providers
npm run test:browser  # Chromium; a skip is not a pass
```

`npm run test:install` is the suite that covers the installer, and it is green (7/7). `npm test`
inherits 15 failures from upstream `82cbd4b` — the identical set fails in a pristine export of
that commit, so they are pre-existing, not installer bugs. They are listed in
[docs/verification.md](docs/verification.md); do not treat them as a reason to call the suite
green, and do not blame them on the install path.

## Docs

- [docs/operations.md](docs/operations.md) — install, update, rollback
- [docs/architecture.md](docs/architecture.md) — layout and readiness
- [docs/upstream.md](docs/upstream.md) — Guey/Pi relation
- [docs/verification.md](docs/verification.md) — **what is actually proved on a real machine, and what is not**
- [docs/provenance.md](docs/provenance.md) — import hashes

## Maintenance and release, in one place

```sh
node install/imperfect.mjs check                      # allowlist + pin sanity
node install/imperfect.mjs pack --out /tmp/rel.tar.gz  # build a release artifact
sudo node install/imperfect.mjs install --artifact /tmp/rel.tar.gz \
  --runtime-tarball node-v22.23.2-linux-x64.tar.xz --prefix /opt/imperfect
sudo node install/imperfect.mjs update  --artifact /tmp/rel.tar.gz --prefix /opt/imperfect
sudo node install/imperfect.mjs rollback --prefix /opt/imperfect
sudo node install/imperfect.mjs status   --prefix /opt/imperfect
```

Releases are root-owned and read-only under `/opt/imperfect/releases/<version>-<sha12>`;
`current` and `previous` are symlinks, so activation and rollback are atomic. Personal data
lives entirely under `/opt/imperfect/data` and is never touched by an update. A failed update
restores the previous release automatically and is health-checked before it is believed.

**Verified live** on a clean Box: root install, isolation boundary, phone and desktop browser,
restart, upgrade, failed-upgrade rollback, and snapshot stop/resume. The limits of that proof —
including the missing ingress password gate and the absent backup command — are stated plainly
in [docs/verification.md](docs/verification.md).
