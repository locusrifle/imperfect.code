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

Browser tests imported with the shell are not a release gate for this installer pass.

## Docs

- [docs/operations.md](docs/operations.md) — install, update, rollback
- [docs/architecture.md](docs/architecture.md) — layout and readiness
- [docs/upstream.md](docs/upstream.md) — Guey/Pi relation
- [docs/provenance.md](docs/provenance.md) — import hashes
