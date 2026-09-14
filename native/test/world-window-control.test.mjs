import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WebSocket } from 'ws';
import { createGueyServer } from '../../server.mjs';

function stubRuntime(cwd) {
  return {
    events: new EventEmitter(),
    snapshot: () => ({ cwd, busy: false, messages: [], commands: [], ui: { dialogs: [], widgets: {}, statuses: {}, notifications: [] } }),
    command: async () => ({}),
    close: async () => {},
  };
}

async function rpc(appPort, product, fn) {
  const root = await mkdtemp(join(tmpdir(), 'guey-window-rpc-'));
  const app = await createGueyServer({ host: '127.0.0.1', port: 0, stateDir: join(root, product), runtime: stubRuntime(root), product });
  const addr = await app.listen();
  const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/pi`, { headers: { Host: `127.0.0.1:${addr.port}` } });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const pending = new Map();
  ws.on('message', raw => {
    const message = JSON.parse(raw.toString());
    if (message.type === 'control') {
      ws.send(JSON.stringify({ id: message.id, type: 'control-result' }));
      return;
    }
    if (message.type === 'response') pending.get(message.id)?.(message);
  });
  const send = (id, payload) => new Promise(resolve => {
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, ...payload }));
  });
  try {
    return await fn({ send, port: addr.port });
  } finally {
    ws.close();
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
}

function connect(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/pi`, { headers: { Host: `127.0.0.1:${port}` } });
  const pending = new Map();
  const snapshots = [];
  const controls = [];
  const ready = new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  ws.on('message', raw => {
    const message = JSON.parse(raw.toString());
    if (message.type === 'snapshot') snapshots.push(message.data);
    if (message.type === 'control') {
      controls.push(message);
      ws.send(JSON.stringify({ id: message.id, type: 'control-result' }));
    }
    if (message.type === 'response') pending.get(message.id)?.(message);
  });
  const send = (id, payload) => new Promise(resolve => {
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, ...payload }));
  });
  return { ws, ready, send, snapshots, controls };
}

test('personal window-open stores an in-app window; stock refuses; foreign URLs refused', async () => {
  await rpc(0, 'imperfect', async ({ send }) => {
    assert.equal((await send('h', { type: 'hello', kind: 'phone' })).success, true);
    const src = '/content/media/1277046e60949e6f/dafde4200f652cdb';
    const opened = await send('w1', { type: 'window-open', kind: 'video', title: 'Clip', src, windowId: 'clip' });
    assert.equal(opened.success, true);
    assert.equal(opened.data.windows.length, 1);
    assert.equal(opened.data.windows[0].kind, 'video');
    assert.equal(opened.data.windows[0].src, src);
    const bad = await send('w2', { type: 'window-open', kind: 'video', src: 'https://example.com/x.mp4' });
    assert.equal(bad.success, false);
    assert.match(bad.error, /in-app/);
  });
  await rpc(0, 'stock', async ({ send }) => {
    const res = await send('w', { type: 'window-open', kind: 'text', text: 'nope' });
    assert.equal(res.success, false);
  });
});

test('closing a window on one view closes it on the other', async () => {
  const root = await mkdtemp(join(tmpdir(), 'guey-window-share-'));
  const app = await createGueyServer({ host: '127.0.0.1', port: 0, stateDir: join(root, 's'), runtime: stubRuntime(root), product: 'imperfect' });
  const addr = await app.listen();
  const phone = connect(addr.port);
  const laptop = connect(addr.port);
  await phone.ready; await laptop.ready;
  try {
    assert.equal((await phone.send('h', { type: 'hello', kind: 'phone' })).success, true);
    assert.equal((await laptop.send('h', { type: 'hello', kind: 'desktop' })).success, true);
    const opened = await phone.send('w1', { type: 'window-open', kind: 'text', title: 'Note', text: 'hello', windowId: 'note' });
    assert.equal(opened.success, true);
    await new Promise(r => setTimeout(r, 50));
    assert.ok(laptop.snapshots.some(s => s.windows?.some(w => w.id === 'note')));
    const missing = await phone.send('bad', { type: 'window-close' });
    assert.equal(missing.success, false);
    const closed = await phone.send('w2', { type: 'window-close', windowId: 'note' });
    assert.equal(closed.success, true);
    assert.deepEqual(closed.data.windows, []);
    await new Promise(r => setTimeout(r, 50));
    const last = laptop.snapshots.at(-1);
    assert.deepEqual(last.windows, []);
    assert.ok(laptop.controls.some(c => c.name === 'window-close' && c.windowId === 'note'));
  } finally {
    phone.ws.close(); laptop.ws.close();
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
