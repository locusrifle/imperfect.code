import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { get } from 'node:http';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeConfig, ensureDataDirs } from '../machine.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const START = join(ROOT, 'start.mjs');

function waitHealth(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const req = get({ host: '127.0.0.1', port, path: '/health', headers: { Host: `127.0.0.1:${port}` } }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          if (res.statusCode === 200) {
            try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
            catch (error) { reject(error); }
            return;
          }
          if (Date.now() > deadline) reject(new Error(`health ${res.statusCode}`));
          else setTimeout(tryOnce, 200);
        });
      });
      req.on('error', () => {
        if (Date.now() > deadline) reject(new Error('health timeout'));
        else setTimeout(tryOnce, 200);
      });
    };
    tryOnce();
  });
}

function request(port, headers = {}) {
  return new Promise(resolve => {
    const req = get({ host: '127.0.0.1', port, path: '/health', headers: { Host: `127.0.0.1:${port}`, ...headers } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', error => resolve({ status: 0, body: String(error) }));
  });
}

test('real start.mjs subprocess: healthy loopback, wrong origin and host refused', async () => {
  const prefix = await mkdtemp(join(tmpdir(), 'imperfect-live-'));
  const { createServer } = await import('node:net');
  const port = await new Promise(resolve => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const n = server.address().port;
      server.close(() => resolve(n));
    });
  });
  await writeConfig(prefix, {
    host: '127.0.0.1',
    port,
    origins: ['https://proxy.example.test'],
    product: 'imperfect',
    brand: 'imperfect computers',
  });
  const p = await ensureDataDirs(prefix);
  await writeFile(join(p.workspace, 'AGENTS.md'), '# fixture\n');

  const child = spawn(process.execPath, [START], {
    cwd: ROOT,
    env: { ...process.env, IMPERFECT_PREFIX: prefix, HOME: p.data },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  try {
    const health = await waitHealth(port);
    assert.equal(health.ui, 'native-gui');
    assert.equal(health.ok, true);
    assert.equal(health.product, 'imperfect');
    assert.equal(health.cwd, p.workspace);
    // Started from the checkout, so there is no release to name. Saying so is the point: a
    // verification that accepted a version string here could not tell a release from a tree.
    assert.equal(health.release, null);
    assert.equal(health.version, JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version);

    const evil = await request(port, { Origin: 'https://evil.example' });
    assert.equal(evil.status, 403);
    const badHost = await request(port, { Host: 'evil.example' });
    assert.equal(badHost.status, 403);
    const via = await request(port, { Host: `127.0.0.1:${port}`, Origin: 'https://proxy.example.test' });
    assert.equal(via.status, 200);
  } catch (error) {
    error.message += `\nstderr: ${stderr}`;
    throw error;
  } finally {
    child.kill('SIGTERM');
    await new Promise(resolve => child.once('exit', resolve));
    await rm(prefix, { recursive: true, force: true });
  }
});
