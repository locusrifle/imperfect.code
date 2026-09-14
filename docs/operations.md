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

## Update

```sh
node install/imperfect.mjs pack --out /tmp/imperfect-release.tar.gz
sudo node install/imperfect.mjs update --artifact /tmp/imperfect-release.tar.gz --prefix /opt/imperfect
```

Workspace, sessions, and the Pi profile are left in `/opt/imperfect/data`. A failed health check restores `current` to the previous release and restarts it. There is no destructive data restore.

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

The live Pi profile is `~/.pi/locus` with real provider auth. Do not reset it. When root is available, copy that profile into `/opt/imperfect/data/agent` as user `imperfect`, then point the unit at it. Parent cannot do that activation yet.

Desktop streaming is pending; leave it off.
