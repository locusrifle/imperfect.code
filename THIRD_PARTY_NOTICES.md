# Third-party notices

Files by other authors that this repository carries. Each is here under its own
terms. The AGPL on our own code does not relicense any of them.

| file(s) | project | licence |
|---|---|---|
| `native/public/fonts/CommitMono-400-Regular.otf` | [Commit Mono](https://commitmono.com) | MIT — [licenses/CommitMono-MIT.txt](licenses/CommitMono-MIT.txt) |
| `native/public/fonts/DepartureMono-Regular.woff2` | [Departure Mono](https://departuremono.com) | MIT — [licenses/DepartureMono-MIT.txt](licenses/DepartureMono-MIT.txt) |

Vendored rather than fetched because the shell's CSP is `'self'`.

## Installed, not redistributed

Runtime dependencies in `package.json` — the Pi agent and `ws` — are installed
by `npm ci`. They are not committed here.
