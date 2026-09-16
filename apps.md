# Apps

Shipped in the drawer: antiburn, Doom (`/doom/index.html`, vendored [mrdoob/three-doom](https://github.com/mrdoob/three-doom) at `445dbf41`; see [docs/doom.md](docs/doom.md)), files, and **Image Lab** (`/image-lab.html`, see [docs/image-lab.md](docs/image-lab.md)). Closing one removes the window record and the iframe; there is no separate backend process to kill.

Image Lab is the first shipped app with a backend of its own: it answers on `/lab/*` and keeps pictures in the workspace. It is still one page and one window, and closing it still kills nothing.

Further apps are pages the person asks for.

An app is one HTML file the person can open in the interface.

1. Write `apps/<name>.html` in the workspace (`/opt/imperfect/data/workspace/apps/<name>.html`).
2. `<name>` is lowercase letters, digits, and hyphens only.
3. The file is served at `/apps/<name>.html`.
4. It appears in the applications sheet. The person opens it from there.

Keep CSS and JavaScript inside that file. The page runs sandboxed. It cannot talk to the shell, the agent, or other origins.

Do not put apps under `/opt/imperfect/current` or edit `site.js`. That is the product. The sheet lists `apps/*.html` itself.

There is no model tool that opens a window. After writing the file, tell the person to open Applications.

Optional titles: `apps/apps.json` with `{ "apps": [ { "id": "notes", "title": "Notes", "src": "/apps/notes.html" } ] }`. That file cannot run server code. A bad manifest is skipped; the html files stay listed. See [[customization]].
