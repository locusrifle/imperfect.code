import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import {
  validateThemeDocument, validateOverlayCss, loadOverlayCss, loadUserTheme,
  registerAppsFromManifest, listRegisteredApps, resolveUiFile, STOCK_THEME,
} from '../customization.mjs';
import { tuiThemeCss } from '../tui-theme.mjs';
import { createGueyServer } from '../../server.mjs';

function stubRuntime(cwd) {
  return {
    events: new EventEmitter(),
    snapshot: () => ({
      sessionId: 'x', sessionFile: join(cwd, 's.jsonl'), cwd, busy: false, failed: null,
      messages: [], commands: [], ui: { dialogs: [], widgets: {}, statuses: {}, notifications: [], editor: null },
    }),
    async command() { return {}; },
    async close() {},
  };
}

test('malformed theme is refused and the file is kept', async () => {
  assert.equal(validateThemeDocument({ colors: { text: '#111' } }).ok, true);
  assert.equal(validateThemeDocument({ exec: 'rm -rf /', colors: {} }).ok, false);
  const root = await mkdtemp(join(tmpdir(), 'ic-theme-'));
  const agent = join(root, 'agent');
  await mkdir(join(agent, 'themes'), { recursive: true });
  const bad = join(agent, 'themes', 'broken.json');
  await writeFile(bad, '{not json');
  const loaded = await loadUserTheme(agent, 'broken');
  assert.equal(loaded.ok, false);
  assert.equal(await readFile(bad, 'utf8'), '{not json');
  await rm(root, { recursive: true, force: true });
});

test('unsafe overlay css falls back to stock without deleting', async () => {
  assert.equal(validateOverlayCss('.x { color: red }').ok, true);
  assert.equal(validateOverlayCss('@import url(https://evil.test/x.css)').ok, false);
  assert.equal(validateOverlayCss('body { background: url(https://evil.test/x.png) }').ok, false);
  const ui = await mkdtemp(join(tmpdir(), 'ic-ui-'));
  const file = join(ui, 'harness.css');
  await writeFile(file, '@import "https://evil.test/x.css";');
  const overlay = await loadOverlayCss(ui);
  assert.equal(overlay.fallback, true);
  assert.match(overlay.css, /stock ui/);
  assert.equal(await readFile(file, 'utf8'), '@import "https://evil.test/x.css";');
  assert.equal(resolveUiFile(ui, '/custom/../agent/settings.json'), null);
  await rm(ui, { recursive: true, force: true });
});

test('app registration cannot run server code or traverse', () => {
  const ws = '/tmp/workspace';
  const bad = registerAppsFromManifest({
    exec: 'node server.mjs',
    apps: [{ id: 'x', src: '/apps/../etc/passwd', command: 'id' }],
  }, ws);
  assert.equal(bad.apps.length, 0);
  assert.ok(bad.skipped.length);
  const escape = registerAppsFromManifest({
    apps: [{ id: 'ok', src: '/apps/../../machine.json' }],
  }, ws);
  assert.equal(escape.apps.length, 0);
});

test('malformed apps.json still lists html apps and keeps the file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ic-apps-'));
  await mkdir(join(root, 'apps'));
  await writeFile(join(root, 'apps', 'notes.html'), '<h1>n</h1>');
  const manifest = join(root, 'apps', 'apps.json');
  await writeFile(manifest, '{nope');
  const listed = await listRegisteredApps(root);
  assert.equal(listed.apps[0].id, 'notes');
  assert.equal(await readFile(manifest, 'utf8'), '{nope');
  await rm(root, { recursive: true, force: true });
});

test('personal theme.css never follows the OS and falls back when custom is broken', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ic-theme-http-'));
  const agent = join(root, 'agent');
  const ui = join(root, 'ui');
  await mkdir(join(agent, 'themes'), { recursive: true });
  await mkdir(ui);
  await writeFile(join(agent, 'themes', 'broken.json'), '{"exec":"yes"}');
  await writeFile(join(ui, 'harness.css'), '#entry-terminal { opacity: 1 }');
  const app = await createGueyServer({
    port: 0, host: '127.0.0.1', stateDir: join(root, 'state'), runtime: stubRuntime(root),
    product: 'imperfect', cwd: root, filesRoot: root, agentDir: agent, uiDir: ui,
  });
  try {
    const { port } = await app.listen();
    const css = await (await fetch(`http://127.0.0.1:${port}/theme.css`)).text();
    assert.doesNotMatch(css, /prefers-color-scheme/);
    assert.match(css, /--tui-text:/);
    const overlay = await fetch(`http://127.0.0.1:${port}/custom/ui.css`);
    assert.equal(overlay.status, 200);
    assert.match(await overlay.text(), /entry-terminal/);
    const escape = await fetch(`http://127.0.0.1:${port}/custom/../server.mjs`);
    assert.equal(escape.status, 404);
    const pair = await tuiThemeCss('light/dark', agent);
    assert.doesNotMatch(pair, /prefers-color-scheme/);
    assert.equal(STOCK_THEME, 'garden');
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
