# imperfect.os

Source for the imperfect computer machine app — the computer a person is given. People reach it as **imperfect computers** at **imperfect.computer**; that domain, and the repository of the same name, are the account door and the business around this machine. This is not that door (`locusrifle/imperfect.computer`, private, checked out at `vaita:/home/dacre/imperfect-door`).

Pi 0.85.1 under a graphical Guey shell. Users can later rearrange UI and add apps; this tree does not redesign that today.

## Run from a checkout

```sh
npm ci
IMPERFECT_PREFIX=/tmp/imperfect-dev node start.mjs
```

Write `machine.json` in that prefix first, or copy the defaults from `machine.mjs`. The process binds loopback only.

## Window (self-host)

Same machine, no browser chrome. Needs Node 22+ and Rust.

```sh
git clone https://github.com/locusrifle/imperfect.os.git
cd imperfect.os
./desktop/install.sh
```

That writes `~/.imperfect/machine.json` if missing and opens a Tauri window around loopback. Hosted Box install is still `install/imperfect.mjs` — do not mix the two.

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

## Licence

Copyright © 2026 Noah Fleming. **[GNU AGPL v3](LICENSE)** (`AGPL-3.0-only`).

Open because the promise is that you can leave. Hosting at imperfect.computer is a convenience you
pay for; the computer itself is not a thing you rent. Once you move your environment onto hardware
you own, you owe nothing further — and that is only true if the source is here.

The Affero clause is the part that matters for a hosted product: run a modified version as a
service for other people, and you owe them your modifications. Run it for yourself, change
anything, owe nobody.

Every machine offers its own source at **`/source`**, naming the exact release it is serving — AGPL
section 13 asks that network users be offered the corresponding source, not merely allowed to ask
for it. A release carries `LICENSE`, `THIRD_PARTY_NOTICES.md` and `licenses/` on disk.

Files by other authors travel under their own terms, listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The Doom app is deliberately **not** in this
repository: it is GPL v2, which the AGPL cannot absorb, and its WAD carries no redistribution grant
at all. See [docs/doom.md](docs/doom.md).

`"private": true` in `package.json` only means this is not published to npm.
