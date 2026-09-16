import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { createGueyServer } from '../../server.mjs';
import { createImageLab } from '../image-lab.mjs';
import { createPinterest } from '../pinterest.mjs';
import { createLabRoutes } from '../lab-routes.mjs';
import { describeToken, CodexSignedOut } from '../codex-images.mjs';

// A one-pixel PNG. Small enough to inline, real enough that anything
// inspecting the bytes sees a picture.
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da6364f8cf000001010100' + '18dd8db00000000049454e44ae426082', 'hex');

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

async function scratch(name) {
  return mkdtemp(join(tmpdir(), `imperfect-lab-${name}-`));
}

test('a picture is saved as a file, listed, filed, and deleted', async () => {
  const root = await scratch('store');
  const lab = createImageLab({ root });
  try {
    const saved = await lab.savePicture({ image: PNG, prompt: 'a wren' });
    assert.match(saved.src, /^\/lab\/picture\?id=/);

    let listed = await lab.library();
    assert.equal(listed.pictures.length, 1);
    assert.equal(listed.pictures[0].prompt, 'a wren');

    // The picture is a real file on disk, not only a row. This is the promise
    // that the person can leave with their own work.
    const onDisk = await readdir(join(root, 'pictures'));
    assert.equal(onDisk.length, 1);

    const folder = await lab.createFolder('Birds');
    await lab.movePicture(saved.id, folder.id);
    listed = await lab.library();
    assert.equal(listed.pictures[0].folder, folder.id);

    // Deleting a folder keeps its pictures; they return to the top level.
    await lab.deleteFolder(folder.id);
    listed = await lab.library();
    assert.equal(listed.pictures.length, 1);
    assert.equal(listed.pictures[0].folder, '');

    await lab.deletePicture(saved.id);
    assert.equal((await lab.library()).pictures.length, 0);
    assert.equal((await readdir(join(root, 'pictures'))).length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the directory is the truth: an orphan is adopted, a ghost is dropped', async () => {
  const root = await scratch('reconcile');
  const lab = createImageLab({ root });
  try {
    const saved = await lab.savePicture({ image: PNG, prompt: 'kept' });
    // A picture removed from under the index -- by the files app, a shell, a
    // restore -- must not keep appearing in the lab.
    await rm(join(root, 'pictures', `${saved.id}.png`));
    // And one that appeared without the index hearing about it must show up.
    await writeFile(join(root, 'pictures', 'aaaaaaaa-1111-2222-3333-444444444444.png'), PNG);

    const listed = await lab.library();
    const ids = listed.pictures.map(p => p.id);
    assert.equal(ids.includes(saved.id), false, 'a picture with no file was still listed');
    assert.equal(ids.includes('aaaaaaaa-1111-2222-3333-444444444444'), true, 'a file with no entry was hidden');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an id that is a path is refused rather than sanitised', async () => {
  const root = await scratch('ids');
  const lab = createImageLab({ root });
  try {
    for (const bad of ['../../etc/passwd', 'a/b', '', '.', 'A'.repeat(200)]) {
      await assert.rejects(() => lab.readPicture(bad), e => e.status === 400 || e.status === 404);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the same pin saved twice on one board is one pin', async () => {
  const root = await scratch('pins');
  const lab = createImageLab({ root });
  try {
    const board = await lab.createBoard({ name: 'Mood' });
    const first = await lab.savePin({ image: PNG, type: 'image/png', board });
    const again = await lab.savePin({ image: PNG, type: 'image/png', board: board.id });
    const once = await lab.savePin({ image: PNG, type: 'image/png', board: board.id });
    assert.equal(again.id, once.id, 'the same bytes made two pins');
    assert.ok(first);
    assert.equal((await lab.library()).pins.length, 2, 'expected the unbound pin and the board pin');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('references resolve to paths on disk, and an unknown one is refused', async () => {
  const root = await scratch('refs');
  const lab = createImageLab({ root });
  try {
    const picture = await lab.savePicture({ image: PNG, prompt: 'one' });
    const board = await lab.createBoard({ name: 'Mood' });
    const pin = await lab.savePin({ image: PNG, type: 'image/png', board: board.id });
    // A picture and a pin are both valid references: the person selecting
    // them does not distinguish, and neither should this.
    const paths = await lab.referencePaths([picture.id, pin.id]);
    assert.equal(paths.length, 2);
    assert.ok(paths[0].endsWith(`${picture.id}.png`));
    await assert.rejects(() => lab.referencePaths(['bbbbbbbb-1111-2222-3333-444444444444']), e => e.status === 404);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('generate streams frames and files the finished picture', async () => {
  const root = await scratch('generate');
  const lab = createImageLab({ root });
  const pinterest = createPinterest({ root, redirectUri: '' });
  const handle = createLabRoutes({
    lab,
    pinterest,
    agentDir: root,
    token: async () => ({ access: 'x', accountId: 'a', plan: 'plus' }),
    generate: async ({ prompt, references, onPartial }) => {
      assert.equal(prompt, 'a wren on a twig');
      assert.equal(references.length, 0);
      onPartial(PNG.toString('base64'));
      return { image: PNG, revisedPrompt: 'a small brown wren', note: '' };
    },
  });

  const { createServer } = await import('node:http');
  const server = createServer((req, res) => {
    handle(req, res, new URL(req.url, 'http://local').pathname).then(taken => {
      if (!taken) res.writeHead(404).end();
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(`${base}/lab/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base },
      body: JSON.stringify({ prompt: 'a wren on a twig' }),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /event-stream/);
    const body = await response.text();
    const frames = body.split('\n\n').filter(Boolean).map(block => JSON.parse(block.replace(/^data: /, '')));
    const types = frames.map(f => f.type);
    assert.deepEqual(types, ['started', 'partial', 'saved']);
    assert.equal(frames[2].revisedPrompt, 'a small brown wren');

    // The picture reached the library and is servable.
    const state = await (await fetch(`${base}/lab/state`)).json();
    assert.equal(state.pictures.length, 1);
    assert.equal(state.codex.signedIn, true);
    const picture = await fetch(`${base}${state.pictures[0].src}`);
    assert.equal(picture.status, 200);
    assert.equal(picture.headers.get('content-type'), 'image/png');
  } finally {
    server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a failure inside the stream is reported in the stream, not as a status', async () => {
  const root = await scratch('fail');
  const lab = createImageLab({ root });
  const pinterest = createPinterest({ root, redirectUri: '' });
  const handle = createLabRoutes({
    lab,
    pinterest,
    agentDir: root,
    token: async () => { throw new CodexSignedOut(); },
    generate: async () => { throw new CodexSignedOut(); },
  });
  const { createServer } = await import('node:http');
  const server = createServer((req, res) => {
    handle(req, res, new URL(req.url, 'http://local').pathname).then(taken => { if (!taken) res.writeHead(404).end(); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(`${base}/lab/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base },
      body: JSON.stringify({ prompt: 'anything' }),
    });
    // The headers left as soon as the stream opened, so the status cannot
    // carry the failure and the page must read it from a frame.
    assert.equal(response.status, 200);
    const frames = (await response.text()).split('\n\n').filter(Boolean).map(b => JSON.parse(b.replace(/^data: /, '')));
    const failure = frames.find(f => f.type === 'error');
    assert.ok(failure, 'no error frame was sent');
    assert.equal(failure.signedOut, true);

    // Signed out is drawn as an invitation, so the state route must say so
    // rather than simply failing.
    const state = await (await fetch(`${base}/lab/state`)).json();
    assert.equal(state.codex.signedIn, false);
  } finally {
    server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('lab POSTs require an origin, and the lab is absent from a stock machine', async () => {
  const root = await scratch('http');
  await mkdir(join(root, 'workspace'), { recursive: true });
  const personal = await createGueyServer({
    port: 0, host: '127.0.0.1', stateDir: join(root, 'p'), runtime: stubRuntime(root),
    product: 'imperfect', cwd: join(root, 'workspace'), filesRoot: join(root, 'workspace'),
    labRoot: join(root, 'lab'),
  });
  const stock = await createGueyServer({
    port: 0, host: '127.0.0.1', stateDir: join(root, 's'), runtime: stubRuntime(root),
    product: 'stock', cwd: join(root, 'workspace'), filesRoot: join(root, 'workspace'),
    labRoot: join(root, 'lab2'),
  });
  try {
    const p = await personal.listen();
    const s = await stock.listen();

    // A form on somebody else's page must not be able to drive verbs that
    // delete things.
    const noOrigin = await fetch(`http://127.0.0.1:${p.port}/lab/folder/create`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'x' }),
    });
    assert.equal(noOrigin.status, 403);

    const withOrigin = await fetch(`http://127.0.0.1:${p.port}/lab/folder/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${p.port}` },
      body: JSON.stringify({ name: 'Birds' }),
    });
    assert.equal(withOrigin.status, 200);
    assert.equal((await withOrigin.json()).name, 'Birds');

    // The lab is the machine's own application, not part of a stock desktop.
    assert.equal((await fetch(`http://127.0.0.1:${s.port}/lab/state`)).status, 404);
  } finally {
    await personal.close();
    await stock.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('the token describes itself without the sign-in store being opened', () => {
  const claims = Buffer.from(JSON.stringify({
    'https://api.openai.com/auth': { chatgpt_account_id: 'acct-1', chatgpt_plan_type: 'plus' },
  })).toString('base64url');
  assert.deepEqual(describeToken(`a.${claims}.c`), { accountId: 'acct-1', plan: 'plus' });
  // A token that is not a token is not a crash.
  assert.deepEqual(describeToken('nonsense'), { accountId: '', plan: '' });
});

test('only Pinterest hosts are fetched for pin images', async () => {
  const root = await scratch('pinterest');
  const pinterest = createPinterest({
    root,
    redirectUri: 'https://example.invalid/lab/pinterest/callback',
    fetchImpl: async () => new Response(PNG, { headers: { 'Content-Type': 'image/png' } }),
  });
  try {
    // This process sits inside the machine, so a fetch it makes is the
    // machine's own reach. The host is checked rather than trusted.
    await assert.rejects(() => pinterest.fetchPinImage('https://evil.invalid/x.png'), e => e.status === 400);
    await assert.rejects(() => pinterest.fetchPinImage('http://i.pinimg.com/x.png'), e => e.status === 400);
    const kept = await pinterest.fetchPinImage('https://i.pinimg.com/originals/x.png');
    assert.equal(kept.type, 'image/png');

    // Nothing is configured yet, so the lab must say that rather than fail.
    const status = await pinterest.status();
    assert.equal(status.configured, false);
    assert.equal(status.connected, false);
    await assert.rejects(() => pinterest.boards(), e => e.notConfigured);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an unsolicited Pinterest callback is refused', async () => {
  const root = await scratch('pinterest-state');
  const pinterest = createPinterest({
    root,
    redirectUri: 'https://example.invalid/lab/pinterest/callback',
    fetchImpl: async () => new Response(JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_in: 3600 }), { headers: { 'Content-Type': 'application/json' } }),
  });
  try {
    await pinterest.configure({ appId: '1', appSecret: '2' });
    // Without this, a link somebody else crafted attaches their Pinterest
    // account to this person's lab.
    await assert.rejects(() => pinterest.connect({ code: 'c', state: 'not-ours' }), e => e.status === 400);
    const url = new URL(await pinterest.authorizeUrl());
    const state = url.searchParams.get('state');
    assert.equal(url.searchParams.get('scope'), 'boards:read,pins:read');
    const after = await pinterest.connect({ code: 'c', state });
    assert.equal(after.connected, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the redirect comes from the request, because a machine has no public name of its own', async () => {
  const root = await scratch('redirect');
  // Every real installation has origins: [] -- the public name belongs to the
  // door's proxy, not the loopback app. A redirect built from configuration
  // alone is the empty string on exactly the machines that matter, and the
  // Pinterest connection dies at the moment somebody first tries to use it.
  const pinterest = createPinterest({
    root,
    redirectUri: '',
    fetchImpl: async () => new Response(JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_in: 3600 }), { headers: { 'Content-Type': 'application/json' } }),
  });
  try {
    await pinterest.configure({ appId: '1', appSecret: '2' });
    await assert.rejects(() => pinterest.authorizeUrl(''), e => e.status === 500);

    const url = new URL(await pinterest.authorizeUrl('https://noah.imperfect.computer'));
    assert.equal(url.searchParams.get('redirect_uri'), 'https://noah.imperfect.computer/lab/pinterest/callback');
    assert.equal((await pinterest.status('https://noah.imperfect.computer')).redirectUri,
      'https://noah.imperfect.computer/lab/pinterest/callback');

    // Pinterest compares the token exchange's redirect against the one the
    // authorization carried, and the callback request need not resemble the
    // request that started it -- so the value is kept, not recomputed.
    let sent = null;
    const pinned = createPinterest({
      root,
      redirectUri: '',
      fetchImpl: async (_u, options) => {
        sent = new URLSearchParams(options.body).get('redirect_uri');
        return new Response(JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_in: 3600 }), { headers: { 'Content-Type': 'application/json' } });
      },
    });
    const next = new URL(await pinned.authorizeUrl('https://noah.imperfect.computer'));
    await pinned.connect({ code: 'c', state: next.searchParams.get('state') });
    assert.equal(sent, 'https://noah.imperfect.computer/lab/pinterest/callback');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the lab reports the redirect a machine with no configured origin would use', async () => {
  const root = await scratch('origin-route');
  const lab = createImageLab({ root });
  const pinterest = createPinterest({ root, redirectUri: '' });
  const handle = createLabRoutes({ lab, pinterest, agentDir: root, token: async () => ({ access: 'x', accountId: 'a', plan: 'plus' }) });
  const { createServer } = await import('node:http');
  const server = createServer((req, res) => {
    handle(req, res, new URL(req.url, 'http://local').pathname).then(taken => { if (!taken) res.writeHead(404).end(); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    // What the door's proxy actually sends.
    const state = await (await fetch(`${base}/lab/state`, {
      headers: { 'X-Forwarded-Host': 'noah.imperfect.computer', 'X-Forwarded-Proto': 'https' },
    })).json();
    assert.equal(state.pinterest.redirectUri, 'https://noah.imperfect.computer/lab/pinterest/callback');
  } finally {
    server.close();
    await rm(root, { recursive: true, force: true });
  }
});
