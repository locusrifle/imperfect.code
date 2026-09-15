# Doom app (three-doom)

In-platform page: `native/public/doom/` served at `/doom/index.html`.

## Upstream

- Repository: https://github.com/mrdoob/three-doom
- Revision: `445dbf41f2fcf032c6dfce2a630851e00b9c6634` (2026-08-14)
- Code notice in that tree: GPL v2
- Three.js module vendored beside it: `three@0.184.0` `native/public/js/vendor/three.module.js` (no CDN; CSP is `'self'`)

The port needs shareware `doom1.wad`. **This product does not claim a license to redistribute that WAD.** It is present because the running port needs it, not because redistribution was cleared. Do not describe the copy as approved.

So it is **not in git** — `.gitignore` excludes `native/public/doom/doom1.wad`, because a hosted repository is a distribution. It is still on the machines that have it, and `install/imperfect.mjs pack` still puts it in a release, because packing walks the filesystem rather than the index.

**A fresh clone therefore has no WAD, and Doom will load without its data.** `pack` does not refuse — the WAD is deliberately not a required page. To restore it, put a `doom1.wad` at `native/public/doom/doom1.wad` from upstream (`https://github.com/mrdoob/three-doom`, revision above) or from a copy of Doom you own; the page also probes for `doom.wad` and `doom2.wad` first, so a registered IWAD can go there instead.

## What we changed

The seven renderer files import `/js/vendor/three.module.js` (which loads `three.core.js` beside it) instead of the bare `'three'` specifier or jsDelivr. Chromium here does not honour an import map on this page. `/doom/*` is allowed `style-src 'unsafe-inline'` because the port writes element styles; the rest of the shell is not. Startup probes missing commercial WAD names (404) then loads `doom1.wad`. No other game logic was rewritten. Upstream tests were not copied.

## Close

Alt+W closes the iframe and the window record. There is no separate game process.
