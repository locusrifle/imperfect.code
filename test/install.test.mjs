import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { get } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, readlinkSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REQUIRED_PAGES, createMockRunner, installMachine, listArtifact,
  packRelease, packTree, renderUnit, rollbackRelease, verifyRuntimeTarball,
} from '../install/imperfect.mjs';
import { NODE_RUNTIME, paths, readConfig } from '../machine.mjs';

const SOURCE = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));

function freePort() {
  return new Promise(resolve => {
    const server = createNetServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function chmodWrite(dir) {
  if (existsSync(dir)) spawnSync('chmod', ['-R', 'u+w', dir]);
}

const FIXTURE_START = `import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const prefix = process.env.IMPERFECT_PREFIX;
const config = JSON.parse(readFileSync(join(prefix, 'machine.json'), 'utf8'));
const host = config.host || '127.0.0.1';
const port = Number(config.port);
const origins = new Set(config.origins || []);
const release = process.env.IMPERFECT_MARK || 'ok';
const server = createServer((req, res) => {
  const expected = host + ':' + port;
  const originOk = !req.headers.origin || req.headers.origin === 'http://' + expected || origins.has(req.headers.origin);
  if (req.headers.host !== expected && req.headers.host !== host || !originOk) {
    res.writeHead(403); res.end('Private origin required'); return;
  }
  if ((req.url || '').split('?')[0] === '/health') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, ui: 'native-gui', product: config.product, mark: release }));
    return;
  }
  res.writeHead(404); res.end('Not found');
});
server.listen(port, host);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
`;

const FAIL_START = `console.error('deliberate failed release'); process.exit(1);\n`;

async function writeFixture(root, startSource = FIXTURE_START, mark = '') {
  for (const page of REQUIRED_PAGES) {
    await mkdir(dirname(join(root, page)), { recursive: true });
    await writeFile(join(root, page), `<!-- ${page} -->\n`);
  }
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'imperfect-fixture', version: '0.0.1', private: true, type: 'module' }, null, 2));
  let start = startSource;
  if (mark) start = start.replace("process.env.IMPERFECT_MARK || 'ok'", JSON.stringify(mark));
  await writeFile(join(root, 'start.mjs'), start);
}

async function packFixture(startSource, mark) {
  const root = await mkdtemp(join(tmpdir(), 'imperfect-fixture-'));
  const outDir = await mkdtemp(join(tmpdir(), 'imperfect-artifact-'));
  await writeFixture(root, startSource, mark);
  const packed = await packTree({ root, out: join(outDir, 'release.tar.gz') });
  return { root, outDir, packed };
}

test('product pack includes every shell page and no workspace files', async () => {
  const out = join(await mkdtemp(join(tmpdir(), 'imperfect-pack-')), 'imperfect.tar.gz');
  const packed = await packRelease({ root: SOURCE, out });
  const names = listArtifact(packed.artifact);
  for (const page of REQUIRED_PAGES) assert.ok(names.includes(page), `missing ${page}`);
  assert.ok(names.includes('start.mjs'));
  assert.ok(names.includes('machine.mjs'));
  assert.ok(names.includes('package-lock.json'));
  assert.equal(names.some(name => name.startsWith('data/') || name.includes('/workspace/') || name.includes('node_modules/') || name === '.env'), false);
  await rm(dirname(out), { recursive: true, force: true });
});

test('pack refuses a tree that omits files.html', async () => {
  const root = await mkdtemp(join(tmpdir(), 'imperfect-missing-page-'));
  await writeFixture(root);
  await rm(join(root, 'native/public/files.html'));
  const out = join(await mkdtemp(join(tmpdir(), 'imperfect-missing-out-')), 'x.tar.gz');
  await assert.rejects(packTree({ root, out }), /files\.html/);
  await rm(root, { recursive: true, force: true });
  await rm(dirname(out), { recursive: true, force: true });
});

test('official runtime digest is pinned and a wrong tarball is refused', async () => {
  assert.equal(NODE_RUNTIME.version, '22.23.2');
  assert.equal(NODE_RUNTIME.sha256, 'd60acfe00a2932254bb0ad20e01b0d74397a0875595de719654b214f4b03f307');
  const dir = await mkdtemp(join(tmpdir(), 'imperfect-bad-node-'));
  const fake = join(dir, 'node-v22.23.2-linux-x64.tar.xz');
  await writeFile(fake, 'not-an-official-tarball');
  await assert.rejects(verifyRuntimeTarball(fake), /does not match pinned/);
  const hash = createHash('sha256').update('not-an-official-tarball').digest('hex');
  assert.notEqual(hash, NODE_RUNTIME.sha256);
  await rm(dir, { recursive: true, force: true });
});

test('unit file runs the /opt runtime binary, not a PATH or nvm symlink', () => {
  const text = renderUnit({ prefix: '/opt/imperfect', user: 'imperfect' });
  assert.match(text, /ExecStart=\/opt\/imperfect\/runtime\/bin\/node \/opt\/imperfect\/current\/start.mjs/);
  assert.doesNotMatch(text, /\/usr\/local\/bin\/node/);
  assert.doesNotMatch(text, /nvm/);
  assert.match(text, /User=imperfect/);
  assert.match(text, /PI_CODING_AGENT_DIR=\/opt\/imperfect\/data\/agent/);
});

test('clean fixture install, wrong origin/host, sentinel survives update, failed update rolls back', async () => {
  const prefix = mkdtempSync(join(tmpdir(), 'imperfect-prefix-'));
  const runner = createMockRunner();
  const port = await freePort();
  const good = await packFixture(FIXTURE_START, 'one');
  try {
    const first = await installMachine({
      prefix, artifact: good.packed.artifact, port, origins: ['https://app.example.test'],
      unprivileged: true, runner, protect: true, healthTimeoutMs: 8000,
    });
    assert.equal(first.health.ui, 'native-gui');
    assert.equal(first.health.mark, 'one');
    const p = paths(prefix);
    assert.equal(readlinkSync(p.current), `releases/${first.id}`);
    const sentinel = join(p.workspace, 'SENTINEL');
    await writeFile(sentinel, 'keep-me\n', { mode: 0o600 });

    const evil = await fetch(`http://127.0.0.1:${port}/health`, { headers: { Origin: 'https://evil.example' } });
    assert.equal(evil.status, 403);
    const badHost = await new Promise(resolve => get({
      host: '127.0.0.1', port, path: '/health', headers: { Host: 'evil.example' },
    }, res => { res.resume(); resolve(res.statusCode); }));
    assert.equal(badHost, 403);
    const via = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { Host: `127.0.0.1:${port}`, Origin: 'https://app.example.test' },
    });
    assert.equal(via.status, 200);

    const next = await packFixture(FIXTURE_START, 'two');
    const updated = await installMachine({
      prefix, artifact: next.packed.artifact, unprivileged: true, runner, protect: true, healthTimeoutMs: 8000,
    });
    assert.equal(updated.health.mark, 'two');
    assert.equal(readFileSync(sentinel, 'utf8'), 'keep-me\n');
    assert.equal((await readConfig(prefix)).origins.includes('https://app.example.test'), true);
    await rm(next.root, { recursive: true, force: true });
    await rm(next.outDir, { recursive: true, force: true });

    const broken = await packFixture(FAIL_START);
    await assert.rejects(installMachine({
      prefix, artifact: broken.packed.artifact, unprivileged: true, runner, protect: true, healthTimeoutMs: 4000,
    }), /health/);
    assert.equal(readlinkSync(p.current), `releases/${updated.id}`);
    const health = await fetch(`http://127.0.0.1:${port}/health`, { headers: { Host: `127.0.0.1:${port}` } });
    assert.equal(health.status, 200);
    assert.equal((await health.json()).mark, 'two');
    assert.equal(readFileSync(sentinel, 'utf8'), 'keep-me\n');
    await rm(broken.root, { recursive: true, force: true });
    await rm(broken.outDir, { recursive: true, force: true });

    const rolled = await rollbackRelease({
      prefix, runner, config: await readConfig(prefix), healthTimeoutMs: 8000,
    });
    assert.equal(rolled.health.mark, 'one');
    assert.equal(readFileSync(sentinel, 'utf8'), 'keep-me\n');
  } finally {
    await runner.stop(prefix);
    chmodWrite(prefix);
    await rm(prefix, { recursive: true, force: true });
    await rm(good.root, { recursive: true, force: true });
    await rm(good.outDir, { recursive: true, force: true });
  }
});
