import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { createGueyServer } from '../../server.mjs';
import { listApps, resolveAppFile } from '../apps.mjs';

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

test('listApps only takes safe html names under apps/', async () => {
  const root = await mkdtemp(join(tmpdir(), 'locus-apps-'));
  await mkdir(join(root, 'apps'));
  await writeFile(join(root, 'apps', 'notes.html'), '<h1>notes</h1>');
  await writeFile(join(root, 'apps', 'NOPE.html'), '<h1>no</h1>');
  await writeFile(join(root, 'apps', 'secret.txt'), 'no');
  const listed = await listApps(root);
  assert.deepEqual(listed, [{ id: 'notes', title: 'notes', note: 'on this computer', src: '/apps/notes.html' }]);
  assert.equal(resolveAppFile(root, '/apps/notes.html')?.type, 'text/html');
  assert.equal(resolveAppFile(root, '/apps/../machine.json'), null);
  assert.equal(resolveAppFile(root, '/apps/secret.txt'), null);
  await rm(root, { recursive: true, force: true });
});

test('personal shell serves workspace apps; stock does not', async () => {
  const root = await mkdtemp(join(tmpdir(), 'locus-apps-http-'));
  await mkdir(join(root, 'workspace', 'apps'), { recursive: true });
  await writeFile(join(root, 'workspace', 'apps', 'notes.html'), '<h1>notes</h1>');
  const personal = await createGueyServer({
    port: 0, host: '127.0.0.1', stateDir: join(root, 'p'), runtime: stubRuntime(root),
    product: 'locusrifle', cwd: join(root, 'workspace'), filesRoot: join(root, 'workspace'),
  });
  const stock = await createGueyServer({
    port: 0, host: '127.0.0.1', stateDir: join(root, 's'), runtime: stubRuntime(root),
    product: 'stock', cwd: join(root, 'workspace'), filesRoot: join(root, 'workspace'),
  });
  try {
    const p = await personal.listen();
    const s = await stock.listen();
    const listed = await (await fetch(`http://127.0.0.1:${p.port}/apps/list`)).json();
    assert.equal(listed[0].src, '/apps/notes.html');
    const page = await fetch(`http://127.0.0.1:${p.port}/apps/notes.html`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /notes/);
    const escape = await fetch(`http://127.0.0.1:${p.port}/apps/../package.json`);
    assert.equal(escape.status, 404);
    const stockList = await fetch(`http://127.0.0.1:${s.port}/apps/list`);
    assert.equal(stockList.status, 404);
  } finally {
    await personal.close();
    await stock.close();
    await rm(root, { recursive: true, force: true });
  }
});
