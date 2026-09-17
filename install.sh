#!/usr/bin/env bash
# Easy clone → window. Hosted Box install is install/imperfect.mjs, not this.
set -euo pipefail

REPO="${IMPERFECT_REPO:-https://github.com/locusrifle/imperfect.os.git}"
DEST="${IMPERFECT_HOME:-$HOME/imperfect.os}"

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  cat <<EOF
Usage: ./install.sh

Clone the machine (if needed) and open it in a Tauri window.

  git clone $REPO && ./desktop/install.sh

  IMPERFECT_HOME     checkout path (default: ~/imperfect.os)
  IMPERFECT_PREFIX   data dir (default: ~/.imperfect)
  IMPERFECT_REPO     git URL
EOF
  exit 0
fi

here="$(cd "$(dirname "$0")" 2>/dev/null && pwd || true)"
if [[ -n "${here}" && -f "$here/start.mjs" && -f "$here/desktop/install.sh" ]]; then
  exec bash "$here/desktop/install.sh" "$@"
fi

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "need $1 on PATH" >&2
    exit 1
  }
}
need git

if [[ ! -f "$DEST/start.mjs" ]]; then
  git clone "$REPO" "$DEST"
fi
exec bash "$DEST/desktop/install.sh" "$@"
