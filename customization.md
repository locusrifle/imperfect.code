# Customization

Parent: [[environment]]. Related: [[apps]].

The product tree under `/opt/imperfect/current` is the release. A person's look and extra pages live under `/opt/imperfect/data` and survive upgrade and rollback.

## What a person (or their agent) may change

- **Theme:** `/opt/imperfect/data/agent/themes/<name>.json` — Pi theme JSON with a `colors` object. Pick it with `/theme`. Names are lowercase letters, digits, hyphens. Garden and night ship in the release. Choice is explicit; the OS light/dark setting is not followed.
- **Harness and desk:** `/opt/imperfect/data/ui/harness.css` and `desktop.css`. Served together at `/custom/ui.css` after stock sheets. No `@import`, no remote `url()`, no `javascript:` or `expression()`.
- **Apps:** `apps/<name>.html` in the workspace, optional `apps/apps.json` for titles. Served at `/apps/…`. Pages run sandboxed. Registration cannot name a server command.

Auth, lifecycle, updater, and recovery stay in the product.

## When it is wrong

Broken JSON or unsafe CSS is left on disk. The machine uses garden / stock chrome instead. Nothing in data/ is deleted to recover.

## What this is not

Not a plugin SDK. Not a way to replace `server.mjs`. Not a way for a theme file to execute on the host.
