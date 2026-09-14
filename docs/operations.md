# Operations

Pinned runtime: **Node 22.23.2 linux-x64** from nodejs.org, sha256 `d60acfe00a2932254bb0ad20e01b0d74397a0875595de719654b214f4b03f307`. Pi **0.85.1**. Same versions on vaita and Box.

Do not copy a Node binary from the laptop. Arch Node 26 will not be the Ubuntu runtime.

## Requirements

- Ubuntu 24.04 x86_64 (Box/vaita)
- root for `/opt/imperfect` and the `imperfect` system user
- Official `node-v22.23.2-linux-x64.tar.xz` (or `--fetch-runtime` on a networked host)
- This source tree (or a packed artifact from `node install/imperfect.mjs pack`)
- Loopback app; put public origins on `--origins` (the proxy hostname). Never put Box API keys or account tokens in machine.json

## Install (root, Box)

From this repository:

```sh
node install/imperfect.mjs check
node install/imperfect.mjs pack --out /tmp/imperfect-release.tar.gz

# verify the official tarball yourself, or let the installer fetch it
curl -fsSLO https://nodejs.org/dist/v22.23.2/node-v22.23.2-linux-x64.tar.xz
curl -fsSLO https://nodejs.org/dist/v22.23.2/SHASUMS256.txt
grep node-v22.23.2-linux-x64.tar.xz SHASUMS256.txt
sha256sum node-v22.23.2-linux-x64.tar.xz

sudo node install/imperfect.mjs install \
  --artifact /tmp/imperfect-release.tar.gz \
  --runtime-tarball ./node-v22.23.2-linux-x64.tar.xz \
  --prefix /opt/imperfect \
  --port 5067 \
  --origins https://HANDLE.locus.garden \
  --user imperfect
```

`--fetch-runtime` may replace `--runtime-tarball` when the host can reach nodejs.org. The installer still checks the pinned digest.

The unit listens on `127.0.0.1:5067`. Health: `curl -sS --header 'Host: 127.0.0.1:5067' http://127.0.0.1:5067/health`.

Box also publishes the raw machine port. Pass `--ingress-password` so the installer puts a Basic-auth gate on `:8080` (Caddy is not required; it is a small Node proxy under `/opt`, same resume rule as the app). The password lives in `/etc/imperfect-ingress.env` (mode 600), never in `machine.json`. The door already holds that password and strips it before the person sees the shell.

## Update

```sh
node install/imperfect.mjs pack --out /tmp/imperfect-release.tar.gz
sudo node install/imperfect.mjs update --artifact /tmp/imperfect-release.tar.gz --prefix /opt/imperfect
```

Workspace, sessions, and the Pi profile are left in `/opt/imperfect/data`. Activation **restarts** the unit; `enable --now` is not used, because it would leave a running process serving the old release. A failed health check restores `current` to the previous release and restarts it. There is no destructive data restore.

## Rollback

```sh
sudo node install/imperfect.mjs rollback --prefix /opt/imperfect
sudo node install/imperfect.mjs status --prefix /opt/imperfect
```

## Unprivileged staging (no root)

```sh
node install/imperfect.mjs install \
  --artifact /tmp/imperfect-release.tar.gz \
  --prefix /tmp/imperfect-stage \
  --port 5067 \
  --unprivileged
```

This does not create the `imperfect` user or a system unit. It is not OS isolation.

## Preserve on vaita

The live Pi profile is `~/.pi/locus` with real provider auth. Do not reset it. Do not copy it into a customer template.

A reviewed migration bundle is staged, not activated:

```text
vaita:/home/dacre/imperfect-staging/20260914T025517Z/
  imperfect-migration.tar.gz     sha256 39972f0c73aab531151d0310737db3b4d1ffa6627e5ee27f4144e5893062467f
  ADMIN-RUN-AS-ROOT.sh           written, not run
  before.txt                     workshop health at staging time
```

An administrator with real root runs `sudo bash ADMIN-RUN-AS-ROOT.sh`. That installs on **port 5068** so the existing `locus-machine` user unit on 5067 is left running. There is no cutover in that script. Root's `PATH` must include a Node binary new enough to run the installer (vaita's dacre Node is v22.22.0). The installer then fetches and pins official Node 22.23.2 under `/opt/imperfect/runtime`.

When root is available and a cutover is intended, copy `~/.pi/locus` into `/opt/imperfect/data/agent` as user `imperfect` as a deliberate step, then point the unit at it. A same-uid user service is not isolation and is not a substitute.

Desktop streaming is pending; leave it off.
