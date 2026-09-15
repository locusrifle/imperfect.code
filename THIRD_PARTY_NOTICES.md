# Third-party notices

Files by other authors that this repository carries and a release therefore distributes. Each is
here under its own terms, and those terms travel with the file — which is the whole reason this
page exists. The AGPL on our own code does not relicense any of them.

| file(s) | project | licence |
|---|---|---|
| `native/public/js/vendor/three.module.js`, `three.core.js` | [three.js](https://github.com/mrdoob/three.js) 0.184.0 | MIT — [licenses/three-MIT.txt](licenses/three-MIT.txt) |
| `native/public/fonts/CommitMono-400-Regular.otf` | [Commit Mono](https://commitmono.com) | MIT — [licenses/CommitMono-MIT.txt](licenses/CommitMono-MIT.txt) |
| `native/public/fonts/DepartureMono-Regular.woff2` | [Departure Mono](https://departuremono.com) | MIT — [licenses/DepartureMono-MIT.txt](licenses/DepartureMono-MIT.txt) |

Vendored rather than fetched because the shell's CSP is `'self'`: no CDN may serve code or fonts
into it. Three.js is pinned to one revision for the same reason a release is pinned — so what is
running can be named.

## Not in this repository, but on the machines

The Doom app is a vendored copy of [three-doom](https://github.com/mrdoob/three-doom), whose code
is **GPL v2**, beside the shareware `doom1.wad`, which carries no redistribution grant. Neither is
in git: `native/public/doom/` is ignored. GPL v2 is also not compatible with the AGPL v3 on our own
code, so it must stay out. The files remain on disk, are served, and are packed into a release.
[docs/doom.md](docs/doom.md) says how to fetch them into a fresh clone.

## Installed, not redistributed

Runtime dependencies in `package.json` — the Pi agent and server, `ws`, `html2canvas` — are
installed by `npm ci` on the machine during a release install. They are not committed here and not
inside the release artifact, which carries only `package.json` and `package-lock.json`.
