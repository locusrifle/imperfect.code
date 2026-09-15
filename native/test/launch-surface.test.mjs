import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { createGueyServer, launchThemeFromCookie } from '../../server.mjs';

function stubRuntime() {
  return {
    events: new EventEmitter(),
    snapshot: () => ({ sessionId: 'x', messages: [], commands: [], ui: { dialogs: [], widgets: {}, statuses: {}, notifications: [], editor: null } }),
    async command() { return {}; },
    async close() {},
  };
}

test('launch cookie names only garden or night', () => {
  assert.equal(launchThemeFromCookie('ic-theme=night'), 'night');
  assert.equal(launchThemeFromCookie('other=1; ic-theme=garden'), 'garden');
  assert.equal(launchThemeFromCookie('ic-theme=dark'), '');
  assert.equal(launchThemeFromCookie(''), '');
});

test('cookie sets startup theme when none is saved; wallpaper and doom serve', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ic-launch-'));
  const agent = join(root, 'agent');
  await mkdir(agent, { recursive: true });
  const app = await createGueyServer({
    port: 0, host: '127.0.0.1', stateDir: join(root, 's'), runtime: stubRuntime(),
    product: 'imperfect', agentDir: agent, cwd: root, filesRoot: root,
  });
  try {
    const { port } = await app.listen();
    const origin = `http://127.0.0.1:${port}`;
    const css = await fetch(`${origin}/theme.css`, { headers: { cookie: 'ic-theme=night' } });
    assert.equal(css.status, 200);
    assert.match(await css.text(), /--tui-pageBg: #1a1410/);
    const saved = JSON.parse(await readFile(join(agent, 'settings.json'), 'utf8'));
    assert.equal(saved.theme, 'night');
    const wall = await fetch(`${origin}/media/ground/temple-wide.webp`);
    assert.equal(wall.status, 200);
    assert.match(wall.headers.get('content-type'), /webp/);
    const doom = await fetch(`${origin}/doom/index.html`);
    assert.equal(doom.status, 200);
    const doomHtml = await doom.text();
    assert.match(doomHtml, /src\/i_main\.js/);
    assert.doesNotMatch(doomHtml, /jsdelivr|cdn\./i);
    const video = await (await fetch(`${origin}/doom/src/i_video.js`)).text();
    assert.match(video, /three\.module\.js/);
    assert.equal((await fetch(`${origin}/doom/src/i_main.js`)).status, 200);
    const wad = await fetch(`${origin}/doom/doom1.wad`);
    assert.equal(wad.status, 200);
    assert.equal(Number(wad.headers.get('content-length') || 0) > 1_000_000, true);
    assert.equal((await fetch(`${origin}/js/vendor/three.module.js`)).status, 200);
    assert.match(await readFile(new URL('../../docs/doom.md', import.meta.url), 'utf8'), /445dbf41/);
    const lab = await fetch(`${origin}/image-lab.html`);
    assert.equal(lab.status, 200);
    const site = await readFile(new URL('../public/js/site.js', import.meta.url), 'utf8');
    assert.match(site, /id: "antiburn"/);
    assert.match(site, /id: "doom"/);
    assert.match(site, /id: "image-lab"/);
    assert.doesNotMatch(site, /id: "files"/);
    const keys = await readFile(new URL('../public/js/pi-card.js', import.meta.url), 'utf8');
    assert.match(keys, /KeyY/);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('personal theme command refuses device automatic palettes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ic-theme-explicit-'));
  const agent = join(root, 'agent');
  await mkdir(agent, { recursive: true });
  const events = new EventEmitter();
  const runtime = stubRuntime();
  runtime.events = events;
  const app = await createGueyServer({
    port: 0, host: '127.0.0.1', stateDir: join(root, 's'), runtime,
    product: 'imperfect', agentDir: agent, cwd: root, filesRoot: root,
  });
  try {
    const { port } = await app.listen();
    const css = await (await fetch(`http://127.0.0.1:${port}/theme.css`)).text();
    assert.doesNotMatch(css, /prefers-color-scheme/);
    assert.match(css, /--tui-pageBg: #f7f0e2/);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('saved theme is not overwritten by a stray cookie', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ic-launch-keep-'));
  const agent = join(root, 'agent');
  await mkdir(agent, { recursive: true });
  await writeFile(join(agent, 'settings.json'), JSON.stringify({ theme: 'garden' }));
  const app = await createGueyServer({
    port: 0, host: '127.0.0.1', stateDir: join(root, 's'), runtime: stubRuntime(),
    product: 'imperfect', agentDir: agent, cwd: root, filesRoot: root,
  });
  try {
    const { port } = await app.listen();
    await fetch(`http://127.0.0.1:${port}/theme.css`, { headers: { cookie: 'ic-theme=night' } });
    const saved = JSON.parse(await readFile(join(agent, 'settings.json'), 'utf8'));
    assert.equal(saved.theme, 'garden');
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
