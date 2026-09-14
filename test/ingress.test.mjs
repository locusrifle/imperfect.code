import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { createIngressServer } from '../install/ingress.mjs';

function freePort() {
  return new Promise(resolve => {
    const server = createNetServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function backend() {
  const port = await freePort();
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({ url: req.url, host: req.headers.host, origin: req.headers.origin, authorization: req.headers.authorization || null });
    if ((req.url || '').split('?')[0] === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, ui: 'native-gui' }));
    }
    res.writeHead(200); res.end('ok');
  });
  await new Promise(done => server.listen(port, '127.0.0.1', done));
  return { port, seen, close: () => new Promise(done => server.close(done)) };
}

test('ingress refuses an empty password', () => {
  assert.throws(() => createIngressServer({ password: '' }), /password is required/);
});

test('ingress requires the password, strips it, and rewrites Host to the loopback app', async () => {
  const app = await backend();
  const listenPort = await freePort();
  const ingress = createIngressServer({
    listenHost: '127.0.0.1',
    listenPort,
    backendHost: '127.0.0.1',
    backendPort: app.port,
    user: 'locus',
    password: 'secret-gate',
  });
  await ingress.listen();
  try {
    const bare = await fetch(`http://127.0.0.1:${listenPort}/health`);
    assert.equal(bare.status, 401);
    assert.match(bare.headers.get('www-authenticate') || '', /Basic/);

    const wrong = await fetch(`http://127.0.0.1:${listenPort}/health`, {
      headers: { authorization: 'Basic ' + Buffer.from('locus:nope').toString('base64') },
    });
    assert.equal(wrong.status, 401);

    const ok = await fetch(`http://127.0.0.1:${listenPort}/health`, {
      headers: {
        authorization: 'Basic ' + Buffer.from('locus:secret-gate').toString('base64'),
        origin: 'https://evil.invalid',
      },
    });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).ui, 'native-gui');
    assert.equal(app.seen.at(-1).authorization, null, 'app must not see the ingress password');
    assert.equal(app.seen.at(-1).host, `127.0.0.1:${app.port}`);
    assert.equal(app.seen.at(-1).origin, `http://127.0.0.1:${app.port}`);
  } finally {
    await ingress.close();
    await app.close();
  }
});
