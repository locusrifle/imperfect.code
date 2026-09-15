# Doom app (three-doom)

In-platform page: `native/public/doom/` served at `/doom/index.html`.

## Upstream

- Repository: https://github.com/mrdoob/three-doom
- Revision: `445dbf41f2fcf032c6dfce2a630851e00b9c6634` (2026-08-14)
- Code notice in that tree: GPL v2
- Three.js module vendored beside it: `three@0.184.0` `native/public/js/vendor/three.module.js` (no CDN; CSP is `'self'`)

The port needs shareware `doom1.wad`. **This product does not claim a license to redistribute that WAD.** It is present because the running port needs it, not because redistribution was cleared. Do not describe the copy as approved.

## None of it is in git

`.gitignore` excludes the whole of `native/public/doom/` — the port as well as the WAD.

The port is **GPL v2**, which is copyleft, and this repository carries its own license. Vendoring
copyleft code into a published repository distributes it under terms that are not upstream's to
give. The WAD is worse: there is no redistribution grant for it at all. A private repository was
already uncomfortable; a public one is a distribution.

What stays true: the files are on disk, both machines serve them, and `install/imperfect.mjs pack`
still puts them in a release — packing walks the filesystem, not the index. `native/public/doom.html`,
the launcher we wrote, is ours and stays in git.

**A fresh clone has no Doom.** `pack` does not refuse: `native/public/doom/index.html` was removed
from `REQUIRED_PAGES` so a clone can still build a release, and the launcher simply opens nothing.
To restore it:

```sh
git clone https://github.com/mrdoob/three-doom /tmp/three-doom
git -C /tmp/three-doom checkout 445dbf41f2fcf032c6dfce2a630851e00b9c6634
cp -r /tmp/three-doom/* native/public/doom/
```

Then re-apply the import change under *What we changed* below. A registered IWAD may go in as
`doom.wad` or `doom2.wad` instead — the page probes for those before `doom1.wad`.

## What we changed

The seven renderer files import `/js/vendor/three.module.js` (which loads `three.core.js` beside it) instead of the bare `'three'` specifier or jsDelivr. Chromium here does not honour an import map on this page. `/doom/*` is allowed `style-src 'unsafe-inline'` because the port writes element styles; the rest of the shell is not. Startup probes missing commercial WAD names (404) then loads `doom1.wad`. No other game logic was rewritten. Upstream tests were not copied.

## Close

Alt+W closes the iframe and the window record. There is no separate game process.
