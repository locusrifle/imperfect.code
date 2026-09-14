import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { chromium } from 'playwright';
import { WebSocket } from 'ws';
import { createGueyServer } from '../../server.mjs';

function browserPath() {
  const bundled = chromium.executablePath();
  if (existsSync(bundled)) return undefined;
  for (const path of ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable']) if (existsSync(path)) return path;
  return null;
}

function stubRuntime(cwd) {
  const events = new EventEmitter();
  const data = {
    sessionId: 'w', sessionFile: join(cwd, 's.jsonl'), cwd, busy: false, failed: null,
    messages: [], commands: [], model: { id: 'fixture-model', name: 'Fixture' },
    ui: { dialogs: [], widgets: {}, statuses: {}, notifications: [] },
    tabs: [{ id: 'w', sessionId: 'w', name: 'w', busy: false, focused: true }],
  };
  return { events, snapshot: () => data, command: async () => ({}), close: async () => {} };
}

test('closing a canvas window on one browser closes it on the other', async (t) => {
  const executablePath = browserPath();
  if (executablePath === null) return t.skip('No chromium available');
  const root = await mkdtemp(join(tmpdir(), 'guey-window-share-browser-'));
  const app = await createGueyServer({ port: 0, host: '127.0.0.1', stateDir: root, runtime: stubRuntime(root), product: 'imperfect' });
  const address = await app.listen();
  const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
  const pending = new Map();
  const agent = new WebSocket(`ws://127.0.0.1:${address.port}/pi`, { headers: { Host: `127.0.0.1:${address.port}` } });
  agent.on('message', raw => {
    const message = JSON.parse(raw.toString());
    if (message.type === 'response') pending.get(message.id)?.(message);
  });
  const send = (id, payload) => new Promise(resolve => {
    pending.set(id, resolve);
    agent.send(JSON.stringify({ id, ...payload }));
  });
  try {
    await new Promise((resolve, reject) => { agent.once('open', resolve); agent.once('error', reject); });
    const laptop = await browser.newPage();
    const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    await laptop.goto(`http://127.0.0.1:${address.port}`);
    await phone.goto(`http://127.0.0.1:${address.port}`);
    await laptop.waitForSelector('#entry-pi-label');
    await phone.waitForSelector('#entry-pi-label');
    const opened = await send('1', { type: 'window-open', kind: 'text', title: 'Note', text: 'shared', windowId: 'note' });
    assert.equal(opened.success, true);
    await laptop.waitForSelector('#note');
    await phone.waitForSelector('#note');
    await phone.click('#note .review-close');
    await laptop.waitForSelector('#note', { state: 'detached' });
    await phone.waitForSelector('#note', { state: 'detached' });
  } finally {
    agent.close();
    await browser.close();
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
