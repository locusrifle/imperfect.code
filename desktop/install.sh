#!/usr/bin/env bash
# Put the machine in a window. Same start.mjs as the hosted computer.
# The Box/root installer is still install/imperfect.mjs — this is not that.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PREFIX="${IMPERFECT_PREFIX:-$HOME/.imperfect}"
PORT="${IMPERFECT_PORT:-5067}"
REPO="${IMPERFECT_REPO:-https://github.com/imperfect/imperfect.computer.git}"

usage() {
  cat <<EOF
Usage: desktop/install.sh

Clones nothing (run this from a checkout). Installs Node deps, writes
$PREFIX/machine.json if missing, and opens the machine in a Tauri window.

  IMPERFECT_PREFIX   data dir (default: ~/.imperfect)
  IMPERFECT_PORT     loopback port (default: 5067)

Need a checkout first?

  git clone $REPO
  cd imperfect.computer
  ./desktop/install.sh

Hosted computers still install with:

  sudo node install/imperfect.mjs install ...
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "need $1 on PATH" >&2
    exit 1
  }
}

need git
need node
need npm
need cargo
need rustc

node_major="$(node -p 'process.versions.node.split(".")[0]')"
if [[ "$node_major" -lt 22 ]]; then
  echo "need Node 22 or newer (have $(node -v))" >&2
  exit 1
fi

if [[ ! -f "$ROOT/start.mjs" || ! -f "$ROOT/desktop/src-tauri/Cargo.toml" ]]; then
  echo "run this from an imperfect.computer checkout" >&2
  exit 1
fi

if [[ ! -d "$ROOT/node_modules" ]]; then
  (cd "$ROOT" && npm ci)
fi

mkdir -p "$PREFIX"
if [[ ! -f "$PREFIX/machine.json" ]]; then
  cat > "$PREFIX/machine.json" <<EOF
{
  "host": "127.0.0.1",
  "port": $PORT,
  "origins": [],
  "product": "imperfect",
  "brand": "imperfect computers",
  "authentication": true,
  "ownArchive": true,
  "liveSessions": false,
  "desktop": false,
  "person": ""
}
EOF
  echo "wrote $PREFIX/machine.json"
fi

export IMPERFECT_PREFIX="$PREFIX"
export IMPERFECT_PORT="$PORT"
cd "$ROOT/desktop/src-tauri"
exec cargo run --release
