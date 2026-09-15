import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { createGueyServer } from '../../server.mjs';
import { createRuntime } from '../runtime.mjs';
import { resolveProduct, resolveBrand } from '../product.mjs';

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

test('product resolution: explicit stock vs live imperfect default', () => {
  assert.equal(resolveProduct({ product: 'stock' }), 'stock');
  assert.equal(resolveProduct({ product: 'imperfect' }), 'imperfect');
});

test('a deployment may wear its own name, and only a plain one', async () => {
  assert.equal(resolveBrand({}), 'Guey');
  // A composition that is sold under its own name must never greet its owner as the foundation.
  assert.equal(resolveBrand({ product: 'imperfect' }), 'imperfect computers');
  assert.equal(resolveBrand({ brand: 'imperfect computers' }), 'imperfect computers');
  assert.equal(resolveBrand({ brand: '  imperfect computers  ' }), 'imperfect computers');
  // The name reaches a script and a document title, so markup must not survive.
  assert.equal(resolveBrand({ brand: '</script><script>x' }), 'Guey');
  assert.equal(resolveBrand({ brand: 'x'.repeat(33) }), 'Guey');

  const root = await mkdtemp(join(tmpdir(), 'guey-brand-'));
  const app = await createGueyServer({ port: 0, host: '127.0.0.1', stateDir: root, runtime: stubRuntime(root), product: 'stock', brand: 'imperfect computers' });
  try {
    const { port } = await app.listen();
    const base = `http://127.0.0.1:${port}`;
    const script = await (await fetch(base + '/brand.js')).text();
    assert.match(script, /window\.GUEY_BRAND="imperfect computers"/);
    // This console's CSP refuses inline script, so the name must be applied from here.
    assert.match(script, /document\.title=window\.GUEY_BRAND/);
    const page = await (await fetch(base + '/')).text();
    assert.doesNotMatch(page, /<script>[^<]/, 'no inline script: CSP would silently drop it');
    const html = await (await fetch(base + '/')).text();
    assert.match(html, /src="\/brand\.js"/);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('stock shell has no upload control; imperfect index keeps it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'guey-product-html-'));
  const runtime = stubRuntime(root);
  const stock = await createGueyServer({ port: 0, host: '127.0.0.1', stateDir: join(root, 'stock'), runtime, product: 'stock' });
  const personal = await createGueyServer({ port: 0, host: '127.0.0.1', stateDir: join(root, 'personal'), runtime, product: 'imperfect' });
  try {
    const sAddr = await stock.listen();
    const pAddr = await personal.listen();
    const sBase = `http://127.0.0.1:${sAddr.port}`;
    const pBase = `http://127.0.0.1:${pAddr.port}`;
    const sHealth = await (await fetch(sBase + '/health')).json();
    const pHealth = await (await fetch(pBase + '/health')).json();
    assert.equal(sHealth.product, 'stock');
    assert.equal(pHealth.product, 'imperfect');
    const sHtml = await (await fetch(sBase + '/')).text();
    const pHtml = await (await fetch(pBase + '/')).text();
    assert.match(sHtml, /guey-stock/);
    assert.match(sHtml, /stock\.js/);
    assert.doesNotMatch(sHtml, /entry-files/);
    assert.doesNotMatch(sHtml, /site\.js/);
    // The custom key sheet was removed on 2026-09-14: both compositions now type on the OS
    // keyboard, so neither page may grow one back.
    assert.doesNotMatch(sHtml, /grid-keys/);
    assert.doesNotMatch(pHtml, /grid-keys/);
    assert.match(pHtml, /entry-files/);
    // The dialog reads the name off the window before its module runs, so the personal page
    // must carry brand.js and that script must name this composition, not the foundation.
    assert.match(pHtml, /src="\/brand\.js"/);
    assert.match(await (await fetch(pBase + '/brand.js')).text(), /window\.GUEY_BRAND="imperfect computers"/);
    assert.match(pHtml, /accept="audio\/\*,image\/\*,\.m4a/);
    const manifest = await (await fetch(pBase + '/manifest.webmanifest')).json();
    assert.equal(manifest.share_target.action, '/share-target');
    assert.equal(manifest.share_target.method, 'POST');
    assert.equal(manifest.share_target.enctype, 'multipart/form-data');
    assert.equal(manifest.share_target.params.files[0].name, 'recordings');
    assert.ok(manifest.share_target.params.files[0].accept.includes('audio/*'));
    assert.ok(manifest.share_target.params.files[0].accept.includes('.m4a'));
    const sw = await (await fetch(pBase + '/sw.js')).text();
    assert.match(sw, /share-target/);
    assert.match(sw, /guey-share-target/);
    assert.doesNotMatch(sHtml, /share_target/);
    assert.doesNotMatch(sHtml, /manifest\.webmanifest/);
    assert.doesNotMatch(sHtml, /\.m4a/);
    assert.match(pHtml, /site\.js/);
    assert.equal((await fetch(sBase + '/transcribe', { method: 'POST', body: Buffer.alloc(0) })).status, 404);
    assert.equal((await fetch(sBase + '/upload', { method: 'POST', headers: { Origin: sBase, 'X-Filename': 'a.txt' }, body: 'x' })).status, 404);
    // Realtime voice was removed on 2026-09-14. Neither composition may grow it back, and the
    // route must not answer for anybody.
    assert.notEqual((await fetch(sBase + '/voice/connect', { method: 'POST', headers: { 'Content-Type': 'application/sdp' }, body: 'v=0' })).status, 200);
    assert.doesNotMatch(sHtml, /voice-talk/);
    assert.doesNotMatch(pHtml, /voice-talk/);
    assert.doesNotMatch(sHtml, /realtime\.js/);
    assert.doesNotMatch(pHtml, /realtime\.js/);
    const stockJs = await (await fetch(sBase + '/js/stock.js')).text();
    const siteJs = await (await fetch(pBase + '/js/site.js')).text();
    assert.doesNotMatch(sHtml, /imperfect-scene|scene\.js/);
    assert.doesNotMatch(stockJs, /scene\.js|realtime\.js/);
    assert.doesNotMatch(siteJs, /scene\.js/);
    assert.doesNotMatch(siteJs, /realtime\.js/);
    assert.doesNotMatch(pHtml, /imperfect-scene/);
    const personalCss = await (await fetch(pBase + '/css/imperfect.css')).text();
    assert.doesNotMatch(personalCss, /#imperfect-scene/);
    // Omarchy's theme, wallpaper and bar arrangement were removed on 2026-09-14: they only ever
    // existed on one laptop, and a hosted machine has none of those files. The routes are gone.
    for (const path of ['/omarchy.css', '/omarchy/bar', '/omarchy/background']) {
      assert.equal((await fetch(pBase + path)).status, 404, `${path} must be gone`);
      assert.equal((await fetch(sBase + path)).status, 404, `${path} must be gone for stock too`);
    }
    // The files application reads its given root and never escapes it.
    const home = await (await fetch(pBase + '/files/list?path=')).json();
    assert.equal(home.name, '~');
    assert.equal(home.parent, null);
    assert.ok(Array.isArray(home.entries));
    assert.equal((await fetch(pBase + '/files/list?path=../..')).status, 403);
    assert.equal((await fetch(sBase + '/files/list?path=')).status, 404, 'stock has no files app');
    const sceneFrame = await fetch(pBase + '/media/scene/frame-001.png');
    assert.equal(sceneFrame.status, 200);
    assert.equal(sceneFrame.headers.get('content-type'), 'image/png');
    // Five stills is megabytes on a phone: a reload revalidates instead.
    const stamp = sceneFrame.headers.get('last-modified');
    assert.ok(stamp, 'binary assets carry a validator');
    assert.equal(sceneFrame.headers.get('cache-control'), 'no-cache');
    const again = await fetch(pBase + '/media/scene/frame-001.png', { headers: { 'If-Modified-Since': stamp } });
    assert.equal(again.status, 304);
    const changed = await fetch(pBase + '/media/scene/frame-001.png', { headers: { 'If-Modified-Since': 'Thu, 01 Jan 1970 00:00:00 GMT' } });
    assert.equal(changed.status, 200);
    assert.equal((await fetch(pBase + '/js/site.js')).headers.get('cache-control'), 'no-store');
    const stockCss = await (await fetch(sBase + '/css/guey.css')).text();
    assert.doesNotMatch(stockCss, /imperfect-scene/);
    // Screen-off push went with realtime voice on 2026-09-14; neither composition serves it, and
    // the browser no longer talks to a provider directly.
    assert.equal((await fetch(sBase + '/push/vapid')).status, 404);
    assert.equal((await fetch(pBase + '/push/vapid')).status, 404);
    const personalCsp = (await fetch(pBase + '/')).headers.get('content-security-policy') ?? '';
    assert.doesNotMatch(personalCsp, /openai/);
    assert.match(personalCsp, /img-src[^;]*blob:/);
    // The drawer already asks the authenticated door for a fresh desktop URL. The shell must
    // permit that short-lived per-Box supplier origin to be framed or the tile opens a blank page.
    assert.match(personalCsp, /frame-src 'self' https:\/\/\*\.on\.ascii\.dev/);
    const homeJs = await (await fetch(pBase + '/js/imperfect-home.js')).text();
    assert.match(homeJs, /id: "desktop"/);
    assert.match(homeJs, /remote: "\/__desktop"/);
    assert.match(homeJs, /!can\.desktop/);
    assert.doesNotMatch((await fetch(sBase + '/')).headers.get('content-security-policy') ?? '', /openai/);
    assert.doesNotMatch((await fetch(sBase + '/')).headers.get('content-security-policy') ?? '', /blob:/);
    assert.doesNotMatch((await fetch(sBase + '/')).headers.get('content-security-policy') ?? '', /\*/);
  } finally {
    await stock.close(); await personal.close(); await rm(root, { recursive: true, force: true });
  }
});

test('ownArchive does not auto-resume the shared Pi session tree', async () => {
  const root = await mkdtemp(join(tmpdir(), 'guey-own-archive-'));
  const agent = join(root, 'agent');
  const cwd = join(root, 'work');
  const stateDir = join(root, 'store');
  const sessionDir = join(stateDir, 'sessions');
  await mkdir(cwd, { recursive: true });
  const foreign = SessionManager.create(cwd, join(agent, 'sessions'));
  foreign.appendMessage({ role: 'user', content: 'imperfect transcript', timestamp: Date.now() });
  foreign.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'saved answer' }], timestamp: Date.now(), stopReason: 'stop', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  const runtime = await createRuntime({
    cwd, agentDir: agent, stateDir, sessionDir, liveSessions: false, ownArchive: true,
  });
  try {
    const snap = runtime.snapshot();
    assert.ok(snap.sessionFile.startsWith(sessionDir + '/'), snap.sessionFile);
    assert.notEqual(snap.sessionFile, foreign.getSessionFile());
    const listed = await runtime.command({ type: 'sessions' });
    const shared = listed.find(s => s.path === foreign.getSessionFile());
    assert.ok(shared, 'shared Pi sessions stay visible in /resume');
    assert.equal(shared.copyOnResume, true);
    await runtime.command({ type: 'resume', path: foreign.getSessionFile() });
    const after = runtime.snapshot();
    assert.ok(after.sessionFile.startsWith(sessionDir + '/'), after.sessionFile);
    assert.notEqual(after.sessionFile, foreign.getSessionFile());
    assert.ok(after.messages.some(m => m.content === 'imperfect transcript' || m.content?.[0]?.text === 'imperfect transcript' || m.content?.[0]?.text === 'saved answer'));
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a snapshot larger than 8MB does not close the websocket', async () => {
  const root = await mkdtemp(join(tmpdir(), 'guey-big-snap-'));
  const blob = 'x'.repeat(60000);
  const data = {
    sessionId: 'big', sessionFile: join(root, 's.jsonl'), cwd: root, busy: true, failed: null,
    messages: Array.from({ length: 180 }, (_, i) => ({ role: 'assistant', content: blob + i })),
    commands: [], ui: { dialogs: [], widgets: {}, statuses: {}, notifications: [], editor: null },
  };
  const events = new EventEmitter();
  const runtime = {
    events,
    snapshot: () => data,
    async command() { return {}; },
    async close() {},
  };
  const app = await createGueyServer({ port: 0, host: '127.0.0.1', stateDir: join(root, 'store'), runtime, product: 'stock' });
  try {
    const addr = await app.listen();
    const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/pi`, { origin: `http://127.0.0.1:${addr.port}` });
    const closed = [];
    ws.on('close', (code, reason) => closed.push({ code, reason: String(reason) }));
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('no snapshot')), 15000);
      ws.on('message', raw => {
        const msg = JSON.parse(raw);
        if (msg.type === 'snapshot') { clearTimeout(t); resolve(); }
      });
      ws.on('error', reject);
    });
    assert.ok(JSON.stringify(data).length > 8 * 1024 * 1024);
    events.emit('change');
    events.emit('change');
    await new Promise(r => setTimeout(r, 400));
    assert.equal(ws.readyState, WebSocket.OPEN);
    assert.equal(closed.length, 0, `socket closed ${JSON.stringify(closed)}`);
    ws.close();
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a workspace reached through a symlink is still the workspace', async () => {
  // Noah's own machine points its workspace at a directory that was already his, so the prefix
  // holds a symlink where a customer's Box holds a real directory. The confinement check compares
  // real paths, so a root spelled as a symlink used to fail every one of them: the files
  // application answered 403 for the root itself and for every file under it.
  const dir = await mkdtemp(join(tmpdir(), 'guey-symlink-root-'));
  const real = join(dir, 'real-workspace');
  const link = join(dir, 'workspace');
  await mkdir(join(real, 'notes'), { recursive: true });
  await writeFile(join(real, 'hello.md'), '# hello\n');
  await symlink(real, link);

  const state = await mkdtemp(join(tmpdir(), 'guey-symlink-state-'));
  const app = await createGueyServer({
    port: 0, host: '127.0.0.1', stateDir: state, runtime: stubRuntime(link),
    product: 'imperfect', filesRoot: link, knowledgeRoot: link,
  });
  try {
    const { port } = await app.listen();
    const base = `http://127.0.0.1:${port}`;
    const home = await (await fetch(base + '/files/list?path=')).json();
    assert.equal(home.name, '~');
    assert.deepEqual(home.entries.map(entry => entry.name).sort(), ['hello.md', 'notes']);
    const read = await fetch(base + '/files/text?path=hello.md');
    assert.equal(read.status, 200);
    assert.match((await read.json()).text, /hello/);

    // And the escape it was protecting against is still refused.
    assert.equal((await fetch(base + '/files/list?path=../..')).status, 403);
    await symlink(dir, join(real, 'escape'));
    assert.equal((await fetch(base + '/files/list?path=escape')).status, 403);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
    await rm(state, { recursive: true, force: true });
  }
});
