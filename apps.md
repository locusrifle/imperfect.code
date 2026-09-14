# Apps

An app is one HTML file the person can open in the interface.

1. Write `apps/<name>.html` in the workspace (`/opt/imperfect/data/workspace/apps/<name>.html`).
2. `<name>` is lowercase letters, digits, and hyphens only.
3. The file is served at `/apps/<name>.html`.
4. It appears in the applications sheet. The person opens it from there.

Keep CSS and JavaScript inside that file. The page runs sandboxed. It cannot talk to the shell, the agent, or other origins.

Do not put apps under `/opt/imperfect/current` or edit `site.js`. That is the product. The sheet lists `apps/*.html` itself.

There is no model tool that opens a window. After writing the file, tell the person to open Applications.
