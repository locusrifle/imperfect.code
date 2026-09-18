# imperfect.os

Source for the imperfect computer — the machine a person is given. People reach
the company as **imperfect computers** at **imperfect.computer**; that domain,
and the private door repository, are not this tree.

This checkout is the local window: Pi 0.85.1 under one graphical harness, one
wallpaper, one style. It binds loopback only.

## Run from a checkout

```sh
npm ci
IMPERFECT_PREFIX=/tmp/imperfect-dev node start.mjs
```

Write `machine.json` in that prefix first, or copy the defaults from
`machine.mjs`.

## Window

Same machine, no browser chrome. Needs Node 22+ and Rust.

```sh
git clone https://github.com/locusrifle/imperfect.os.git
cd imperfect.os
./desktop/install.sh
```

That writes `~/.imperfect/machine.json` if missing and opens a Tauri window
around loopback.

## Tests

```sh
npm test
```

## Docs

- [docs/upstream.md](docs/upstream.md) — Guey/Pi relation

## Licence

Copyright © 2026 Noah Fleming. **[GNU AGPL v3](LICENSE)** (`AGPL-3.0-only`).

Files by other authors travel under their own terms, listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

`"private": true` in `package.json` only means this is not published to npm.
