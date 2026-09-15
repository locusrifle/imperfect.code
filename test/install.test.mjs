import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { get } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, readlinkSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REQUIRED_PAGES, activateMachine, createMockRunner, installMachine, listArtifact,
  packRelease, packTree, renderIngressUnit, renderUnit, rollbackRelease, stageMachine,
  systemdActivation, systemdRunner, verifyRuntimeTarball,
} from '../install/imperfect.mjs';
import { NODE_RUNTIME, buildIdentity, paths, readConfig } from '../machine.mjs';

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
import { buildIdentity } from './machine.mjs';
const build = buildIdentity();
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
    res.end(JSON.stringify({ ok: true, ui: 'native-gui', product: config.product, mark: release, release: build.release, version: build.version }));
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
  // The real module, so the fixture reports its build identity the way the product does rather
  // than restating the answer the assertion is looking for.
  await copyFile(join(SOURCE, 'machine.mjs'), join(root, 'machine.mjs'));
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
  assert.ok(names.includes('environment.md'));
  assert.ok(names.includes('apps.md'));
  assert.ok(names.includes('customization.md'));
  assert.ok(names.includes('native/customization.mjs'));
  assert.ok(names.includes('snapshot.md'));
  assert.ok(names.includes('extensions/imperfect-environment/index.ts'));
  assert.ok(names.includes('native/environment-prompt.mjs'));
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
    // Activation is only honest if the running process names the release it is serving. The
    // symlink alone cannot say that: `current` can advance while an old process keeps answering.
    assert.equal(first.health.release, first.id);
    assert.equal(first.health.version, '0.0.1');
    const p = paths(prefix);
    assert.equal(readlinkSync(p.current), `releases/${first.id}`);
    const sentinel = join(p.workspace, 'SENTINEL');
    await writeFile(sentinel, 'keep-me\n', { mode: 0o600 });
    await mkdir(join(p.agent, 'themes'), { recursive: true });
    await mkdir(p.ui, { recursive: true });
    await mkdir(join(p.workspace, 'apps'), { recursive: true });
    await writeFile(join(p.agent, 'themes', 'mine.json'), '{"name":"mine","colors":{"text":"#111"}}\n');
    await writeFile(join(p.ui, 'harness.css'), '#entry-terminal { opacity: 1 }\n');
    await writeFile(join(p.workspace, 'apps', 'notes.html'), '<h1>notes</h1>\n');

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
    assert.equal(updated.health.release, updated.id);
    assert.notEqual(updated.id, first.id);
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
    assert.equal(rolled.health.release, first.id);
    assert.equal(readFileSync(sentinel, 'utf8'), 'keep-me\n');
    assert.match(readFileSync(join(p.agent, 'themes', 'mine.json'), 'utf8'), /mine/);
    assert.match(readFileSync(join(p.ui, 'harness.css'), 'utf8'), /entry-terminal/);
    assert.match(readFileSync(join(p.workspace, 'apps', 'notes.html'), 'utf8'), /notes/);
  } finally {
    await runner.stop(prefix);
    chmodWrite(prefix);
    await rm(prefix, { recursive: true, force: true });
    await rm(good.root, { recursive: true, force: true });
    await rm(good.outDir, { recursive: true, force: true });
  }
});

test('ingress unit uses the /opt runtime and does not store the password in the unit file', () => {
  const text = renderIngressUnit({ prefix: '/opt/imperfect' });
  assert.match(text, /ExecStart=\/opt\/imperfect\/runtime\/bin\/node \/opt\/imperfect\/ingress.mjs/);
  assert.doesNotMatch(text, /PASSWORD/);
  assert.match(text, /EnvironmentFile=-\/etc\/imperfect-ingress.env/);
});

test('root activation restarts the unit, so an update cannot silently keep the old release', () => {
  const argvs = systemdActivation('imperfect.service');
  const words = argvs.map(argv => argv.join(' '));
  assert.deepEqual(words, [
    'systemctl daemon-reload',
    'systemctl enable imperfect.service',
    'systemctl restart imperfect.service',
  ]);
  // `enable --now` is the trap: it only starts a *stopped* unit, so on an update the old
  // process keeps serving while `current` already points at the new release — and the health
  // check passes against the stale process, so the rollback never fires.
  assert.ok(!words.some(w => w.includes('--now')), 'enable --now must not be used');
  assert.ok(words.some(w => w.startsWith('systemctl restart')), 'activation must restart');
});

test('build identity names the release directory, and a checkout admits it has none', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'imperfect-identity-'));
  try {
    const release = join(dir, 'releases', '9.9.9-abcdef012345');
    await mkdir(release, { recursive: true });
    await writeFile(join(release, 'package.json'), JSON.stringify({ version: '9.9.9' }));
    assert.deepEqual(buildIdentity({ startDir: release }), { release: '9.9.9-abcdef012345', version: '9.9.9' });

    // Anywhere that is not <prefix>/releases/<id> is a checkout, whatever it is called.
    const loose = join(dir, 'somewhere', '9.9.9-abcdef012345');
    await mkdir(loose, { recursive: true });
    await writeFile(join(loose, 'package.json'), JSON.stringify({ version: '9.9.9' }));
    assert.deepEqual(buildIdentity({ startDir: loose }), { release: null, version: '9.9.9' });

    // A missing or unreadable package.json is reported as unknown, not crashed over.
    assert.deepEqual(buildIdentity({ startDir: join(dir, 'nothing') }), { release: null, version: null });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a user unit is restarted under the person\'s own systemd, not root\'s', () => {
  assert.deepEqual(systemdActivation('imperfect-machine.service', { user: true }), [
    ['systemctl', '--user', 'daemon-reload'],
    ['systemctl', '--user', 'enable', 'imperfect-machine.service'],
    ['systemctl', '--user', 'restart', 'imperfect-machine.service'],
  ]);
  assert.deepEqual(systemdActivation()[2], ['systemctl', 'restart', 'imperfect.service']);
  assert.equal(typeof systemdRunner({ unit: 'x.service', user: true }).restart, 'function');
});

test('staging does not serve; activating does; a release that does not take hold rolls back', async () => {
  const prefix = mkdtempSync(join(tmpdir(), 'imperfect-stage-'));
  const runner = createMockRunner();
  const port = await freePort();
  const one = await packFixture(FIXTURE_START, 'one');
  const two = await packFixture(FIXTURE_START, 'two');
  const bad = await packFixture(FAIL_START);
  const p = paths(prefix);
  const health = async () => (await fetch(`http://127.0.0.1:${port}/health`, {
    headers: { Host: `127.0.0.1:${port}` },
  })).json();
  try {
    const first = await installMachine({
      prefix, artifact: one.packed.artifact, port, unprivileged: true, runner,
      protect: true, healthTimeoutMs: 8000,
    });
    const sentinel = join(p.workspace, 'SENTINEL');
    await writeFile(sentinel, 'keep-me\n', { mode: 0o600 });

    // The slow half, while the old release keeps serving. This is what makes it safe to stage
    // during a turn: nothing the running process reads has changed.
    const staged = await stageMachine({ prefix, artifact: two.packed.artifact });
    assert.notEqual(staged.id, first.id);
    assert.equal(existsSync(join(p.releases, staged.id)), true);
    assert.equal(readlinkSync(p.current), `releases/${first.id}`);
    assert.equal((await health()).release, first.id);

    const live = await activateMachine({
      prefix, id: staged.id, unprivileged: true, runner, healthTimeoutMs: 8000,
    });
    assert.equal(live.health.release, staged.id);
    assert.equal(live.health.mark, 'two');
    assert.equal(readlinkSync(p.previous), `releases/${first.id}`);

    // Activating something nobody staged is refused rather than left half done.
    await assert.rejects(activateMachine({
      prefix, id: '0.0.0-neverstaged', unprivileged: true, runner, healthTimeoutMs: 2000,
    }), /not staged/);
    assert.equal(readlinkSync(p.current), `releases/${staged.id}`);

    // The trap the release id exists to catch: the symlink advances but the process is never
    // replaced, so the old code answers /health and a naive check calls that success.
    const stagedBad = await stageMachine({ prefix, artifact: bad.packed.artifact });
    const idle = { async restart() { /* deliberately does nothing */ } };
    await assert.rejects(activateMachine({
      prefix, id: stagedBad.id, unprivileged: true, runner: idle, healthTimeoutMs: 3000,
    }), /reports/);
    assert.equal(readlinkSync(p.current), `releases/${staged.id}`);

    // And a release that does replace the process but cannot serve rolls back on its own.
    await assert.rejects(activateMachine({
      prefix, id: stagedBad.id, unprivileged: true, runner, healthTimeoutMs: 4000,
    }), /health/);
    assert.equal(readlinkSync(p.current), `releases/${staged.id}`);
    assert.equal((await health()).release, staged.id);
    assert.equal(readFileSync(sentinel, 'utf8'), 'keep-me\n');
  } finally {
    await runner.stop(prefix);
    chmodWrite(prefix);
    await rm(prefix, { recursive: true, force: true });
    for (const made of [one, two, bad]) {
      await rm(made.root, { recursive: true, force: true });
      await rm(made.outDir, { recursive: true, force: true });
    }
  }
});

test('the same tree packs to the same release id, and a changed byte changes it', async () => {
  // The id is what /health reports and what `fleet status` compares. If packing were not
  // deterministic, the id would identify one artifact and nothing else -- two machines could run
  // byte-identical code under different ids, and no commit could be tied to a running machine.
  const root = await mkdtemp(join(tmpdir(), 'imperfect-repro-'));
  const outDir = await mkdtemp(join(tmpdir(), 'imperfect-repro-out-'));
  try {
    await writeFixture(root, FIXTURE_START, 'one');
    const first = await packTree({ root, out: join(outDir, 'a.tar.gz') });
    const again = await packTree({ root, out: join(outDir, 'b.tar.gz') });
    assert.equal(again.id, first.id);
    assert.equal(again.sha256, first.sha256);

    // Touching a file without changing it must not move the id either: an mtime is not content.
    const page = join(root, REQUIRED_PAGES[0]);
    await writeFile(page, readFileSync(page));
    assert.equal((await packTree({ root, out: join(outDir, 'c.tar.gz') })).id, first.id);

    await writeFile(page, `${readFileSync(page, 'utf8')}<!-- changed -->\n`);
    assert.notEqual((await packTree({ root, out: join(outDir, 'd.tar.gz') })).id, first.id);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outDir, { recursive: true, force: true });
  }
});
