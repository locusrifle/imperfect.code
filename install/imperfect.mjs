#!/usr/bin/env node
// Pack, install, update, and roll back a Locus machine. No fleet secrets.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { copyFile, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { finished } from 'node:stream/promises';
import {
  DEFAULT_PREFIX, DEFAULT_USER, NODE_RUNTIME, PI_VERSION,
  defaultConfig, ensureDataDirs, normalizeConfig, parseOrigins, parsePort,
  paths, readConfig, writeConfig,
} from '../machine.mjs';

export { NODE_RUNTIME, PI_VERSION };

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE_ROOT = resolve(HERE, '..');
const SECRET_RE = /(?:box_[A-Za-z0-9_-]{45,}|sk-proj-[A-Za-z0-9_-]{30,}|-----BEGIN (?:OPENSSH |RSA )?PRIVATE KEY-----)/;

export const REQUIRED_PAGES = [
  'native/public/index.html',
  'native/public/stock.html',
  'native/public/files.html',
  'native/public/antiburn.html',
  'native/public/manifest.webmanifest',
  'native/public/sw.js',
  'native/public/js/site.js',
  'native/public/js/stock.js',
  'native/public/js/harness.js',
  'native/public/css/guey.css',
];

const SKIP_PUBLIC = new Set(['antiburn-report.json']);

function run(argv, opts = {}) {
  const result = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', ...opts });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${argv.join(' ')} failed (${result.status}): ${(result.stderr || result.stdout || '').trim()}`);
  }
  return result;
}

async function sha256File(file) {
  const hash = createHash('sha256');
  const stream = createReadStream(file);
  stream.pipe(hash);
  await finished(stream);
  return hash.digest('hex');
}

function listFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, name.name);
    if (name.isDirectory()) out.push(...listFiles(full));
    else if (name.isFile()) out.push(full);
    else if (name.isSymbolicLink()) throw new Error(`symlink refused: ${full}`);
  }
  return out;
}

function normTarName(name) {
  return String(name).replace(/^\.\//, '');
}

export function collectReleaseFiles(root = SOURCE_ROOT) {
  const files = [];
  const add = rel => {
    const full = join(root, rel);
    if (!existsSync(full) || !lstatSync(full).isFile()) throw new Error(`missing ${rel}`);
    files.push(rel);
  };
  for (const name of ['server.mjs', 'start.mjs', 'machine.mjs', 'package.json', 'package-lock.json']) add(name);
  for (const name of readdirSync(join(root, 'native'))) {
    if (name.endsWith('.mjs')) add(join('native', name));
  }
  for (const full of listFiles(join(root, 'native/public'))) {
    if (SKIP_PUBLIC.has(basename(full))) continue;
    files.push(relative(root, full));
  }
  const ext = join(root, 'extensions/guey-live');
  if (existsSync(ext)) for (const full of listFiles(ext)) files.push(relative(root, full));
  const themes = join(root, 'themes');
  if (existsSync(themes)) for (const full of listFiles(themes)) files.push(relative(root, full));
  files.sort();
  const missing = REQUIRED_PAGES.filter(page => !files.includes(page));
  if (missing.length) throw new Error(`release is missing pages the shell opens: ${missing.join(', ')}`);
  return files;
}

async function tarDirectory(staging, out) {
  const dest = resolve(out);
  await mkdir(dirname(dest), { recursive: true });
  if (existsSync(dest)) await rm(dest);
  run(['tar', '-C', staging, '-czf', dest, '.']);
  return dest;
}

export async function packTree({ root, out, required = REQUIRED_PAGES, scanSecrets = true } = {}) {
  const dest = resolve(out);
  const base = resolve(root);
  if (dest === base || dest.startsWith(base + sep)) throw new Error('artifact must be written outside the packed tree');
  const files = listFiles(root).map(full => relative(root, full)).sort();
  if (files.some(rel => rel.split(/[/\\]/).includes('node_modules') || rel.startsWith('data/') || rel.includes(`${sep}workspace${sep}`) || rel === '.env')) {
    throw new Error('refusing to pack workspace, env, or node_modules');
  }
  if (required) {
    const missing = required.filter(page => !files.includes(page));
    if (missing.length) throw new Error(`release is missing pages the shell opens: ${missing.join(', ')}`);
  }
  if (scanSecrets) {
    for (const rel of files) {
      if (!/\.(mjs|js|json|html|css|md)$/.test(rel)) continue;
      if (SECRET_RE.test(await readFile(join(root, rel)))) throw new Error(`secret-like material refused: ${rel}`);
    }
  }
  const artifact = await tarDirectory(root, out);
  const sha256 = await sha256File(artifact);
  let version = '0.0.0';
  if (existsSync(join(root, 'package.json'))) {
    version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version || version;
  }
  return { artifact, id: `${version}-${sha256.slice(0, 12)}`, sha256, files, version };
}

export async function packRelease({ root = SOURCE_ROOT, out } = {}) {
  const files = collectReleaseFiles(root);
  for (const rel of files) {
    if (lstatSync(join(root, rel)).isSymbolicLink()) throw new Error(`symlink refused: ${rel}`);
  }
  const staging = join(root, `.release-pack-${process.pid}`);
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  try {
    for (const rel of files) {
      const dest = join(staging, rel);
      await mkdir(dirname(dest), { recursive: true });
      await copyFile(join(root, rel), dest);
    }
    const packed = await packTree({ root: staging, out: out || join(root, `imperfect-${JSON.parse(await readFile(join(staging, 'package.json'), 'utf8')).version}.tar.gz`) });
    packed.manifest = Object.fromEntries(await Promise.all(files.map(async rel => [rel, await sha256File(join(root, rel))])));
    return packed;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export function listArtifact(artifact) {
  return run(['tar', '-tzf', resolve(artifact)]).stdout
    .split('\n')
    .map(normTarName)
    .filter(line => line && !line.endsWith('/'));
}

export async function verifyRuntimeTarball(file) {
  const sha256 = await sha256File(file);
  if (sha256 !== NODE_RUNTIME.sha256) {
    throw new Error(`runtime tarball sha256 ${sha256} does not match pinned ${NODE_RUNTIME.sha256} (${NODE_RUNTIME.filename})`);
  }
  return sha256;
}

function assertTreeBound(root) {
  const base = resolve(root);
  const walk = dir => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) {
        const target = resolve(dir, readlinkSync(full));
        if (target !== base && !target.startsWith(base + sep)) {
          throw new Error(`symlink escapes ${base}: ${full} -> ${target}`);
        }
      } else if (st.isDirectory()) walk(full);
    }
  };
  walk(base);
  const nodeBin = join(base, 'bin', 'node');
  if (!existsSync(nodeBin)) throw new Error(`runtime missing ${nodeBin}`);
  if (lstatSync(nodeBin).isSymbolicLink()) throw new Error('runtime bin/node must be a real file, not a symlink');
}

export async function installRuntime({ prefix, tarball }) {
  if (!tarball) throw new Error(`pass --runtime-tarball ${NODE_RUNTIME.filename} (official nodejs.org linux-x64)`);
  const archive = resolve(tarball);
  await verifyRuntimeTarball(archive);
  const p = paths(prefix);
  const scratch = join(p.prefix, `.runtime-${process.pid}`);
  await rm(scratch, { recursive: true, force: true });
  await mkdir(scratch, { recursive: true });
  try {
    run(['tar', '-xJf', archive, '-C', scratch]);
    const unpacked = readdirSync(scratch).map(name => join(scratch, name)).find(full => existsSync(join(full, 'bin', 'node')));
    if (!unpacked) throw new Error('official tarball did not contain bin/node');
    await rm(p.runtime, { recursive: true, force: true });
    await mkdir(dirname(p.runtime), { recursive: true });
    run(['cp', '-a', unpacked, p.runtime]);
    assertTreeBound(p.runtime);
    const version = run([p.node, '-e', 'process.stdout.write(process.version)']).stdout;
    if (version !== `v${NODE_RUNTIME.version}`) throw new Error(`runtime reported ${version}, expected v${NODE_RUNTIME.version}`);
    return { node: p.node, version };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export async function fetchRuntimeTarball(destDir) {
  await mkdir(destDir, { recursive: true });
  const dest = join(destDir, NODE_RUNTIME.filename);
  const response = await fetch(NODE_RUNTIME.url);
  if (!response.ok) throw new Error(`download ${NODE_RUNTIME.url} failed: ${response.status}`);
  await writeFile(dest, Buffer.from(await response.arrayBuffer()), { mode: 0o600 });
  await verifyRuntimeTarball(dest);
  return dest;
}

async function unpackRelease(artifact, dest) {
  await mkdir(dest, { recursive: true, mode: 0o755 });
  run(['tar', '-xzf', resolve(artifact), '-C', dest]);
}

async function npmCi(releaseDir, npmBin) {
  const pkg = JSON.parse(await readFile(join(releaseDir, 'package.json'), 'utf8'));
  if (!pkg.dependencies || !Object.keys(pkg.dependencies).length) return;
  if (!npmBin || !existsSync(npmBin)) throw new Error('npm ci needs the official runtime npm (install Node first)');
  const home = join(dirname(releaseDir), '.npm-home');
  await mkdir(home, { recursive: true });
  try {
    run([npmBin, 'ci', '--omit=dev'], { cwd: releaseDir, env: { ...process.env, HOME: home } });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

export async function protectTree(dir) {
  run(['chmod', '-R', 'a-w,a+rX', dir]);
}

export function renderUnit({ prefix, user = DEFAULT_USER }) {
  const p = paths(prefix);
  const template = readFileSync(join(HERE, 'imperfect.service.in'), 'utf8');
  return template
    .replaceAll('{{USER}}', user)
    .replaceAll('{{PREFIX}}', p.prefix)
    .replaceAll('{{WORKSPACE}}', p.workspace)
    .replaceAll('{{DATA}}', p.data)
    .replaceAll('{{AGENT}}', p.agent)
    .replaceAll('{{NODE}}', p.node);
}

export async function writeUnit({ prefix, user = DEFAULT_USER, unitPath }) {
  const dest = unitPath || paths(prefix).unit;
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, renderUnit({ prefix, user }), { mode: 0o644 });
  return dest;
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

export async function checkHealth({ host = '127.0.0.1', port, timeoutMs = 15000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = new Error('health check did not run');
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://${host}:${port}/health`, { headers: { Host: `${host}:${port}` } });
      const text = await response.text();
      if (response.status !== 200) throw new Error(`health status ${response.status}: ${text.slice(0, 200)}`);
      const body = JSON.parse(text);
      if (body.ui !== 'native-gui') throw new Error(`unexpected health ui ${body.ui}`);
      if (body.ok === false) throw new Error('health ok=false');
      return body;
    } catch (error) {
      last = error;
      await sleep(250);
    }
  }
  throw new Error(`health check failed: ${last.message || last}`);
}

export async function atomicLink(linkPath, target) {
  const next = `${linkPath}.next`;
  await rm(next, { force: true });
  await symlink(target, next);
  await rename(next, linkPath);
}

function readLink(path) {
  if (!existsSync(path)) return null;
  return readlinkSync(path);
}

function releaseLink(id) {
  return join('releases', id);
}

export function currentReleaseId(prefix) {
  const linked = readLink(paths(prefix).current);
  return linked ? basename(linked) : null;
}

export async function activateRelease({ prefix, id }) {
  const p = paths(prefix);
  const current = readLink(p.current);
  const next = releaseLink(id);
  if (current && current !== next) await atomicLink(p.previous, current);
  await atomicLink(p.current, next);
  return { current: next, previous: readLink(p.previous) };
}

export async function rollbackRelease({ prefix, runner, config, healthTimeoutMs }) {
  const p = paths(prefix);
  const previous = readLink(p.previous);
  if (!previous) throw new Error('no previous release to restore');
  const current = readLink(p.current);
  await atomicLink(p.current, previous);
  if (current) await atomicLink(p.previous, current);
  if (runner) await runner.restart(prefix);
  const health = await checkHealth({ host: config.host, port: config.port, timeoutMs: healthTimeoutMs });
  return { current: previous, previous: current, health };
}

// The activation sequence, exported so it can be asserted without a real service manager.
//
// `systemctl enable --now` only *starts* a unit that is stopped. On an update the unit is
// already active, so systemd would do nothing: `current` advances to the new release while the
// running process keeps serving the old code from memory, and the health check then passes
// against that old process. The upgrade reports success, never actually upgrades, and never
// trips its own rollback. So the restart is unconditional — it also starts the unit on a
// first install, which is why `--now` is not needed at all.
export function systemdActivation(unit = 'imperfect.service') {
  return [
    ['systemctl', 'daemon-reload'],
    ['systemctl', 'enable', unit],
    ['systemctl', 'restart', unit],
  ];
}

function ensureUser(name, home) {
  const probe = spawnSync('id', ['-u', name], { encoding: 'utf8' });
  if (probe.status === 0) return;
  run(['useradd', '--system', '--home-dir', home, '--create-home', '--shell', '/usr/sbin/nologin', '--comment', 'Locus machine', name]);
}

export function createMockRunner({ nodeBin = process.execPath } = {}) {
  const children = new Map();
  const stop = prefix => new Promise(resolve => {
    const child = children.get(prefix);
    if (!child) return resolve();
    if (child.exitCode !== null || child.signalCode) {
      children.delete(prefix);
      return resolve();
    }
    child.once('exit', () => { children.delete(prefix); resolve(); });
    child.kill('SIGTERM');
    setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } }, 2000);
  });
  return {
    async restart(prefix) {
      await stop(prefix);
      const p = paths(prefix);
      const proc = spawn(nodeBin, [join(p.prefix, 'current', 'start.mjs')], {
        env: { ...process.env, IMPERFECT_PREFIX: p.prefix, HOME: p.data },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      children.set(prefix, proc);
    },
    async stop(prefix) { await stop(prefix); },
  };
}

export async function placeRelease({ prefix, artifact, npmBin, protect = true }) {
  const packed = listArtifact(artifact);
  if (packed.some(name => name.startsWith('data/') || name.includes('/workspace/') || basename(name) === '.env')) {
    throw new Error('artifact contains workspace or env files');
  }
  for (const page of REQUIRED_PAGES) {
    if (!packed.includes(page)) throw new Error(`artifact missing ${page}`);
  }
  const p = paths(prefix);
  await mkdir(p.releases, { recursive: true, mode: 0o755 });
  const dest = join(p.releases, `.unpack-${process.pid}`);
  await rm(dest, { recursive: true, force: true });
  await unpackRelease(artifact, dest);
  const sha256 = await sha256File(artifact);
  const version = JSON.parse(await readFile(join(dest, 'package.json'), 'utf8')).version;
  const id = `${version}-${sha256.slice(0, 12)}`;
  const finalDir = join(p.releases, id);
  if (existsSync(finalDir)) await rm(finalDir, { recursive: true, force: true });
  await npmCi(dest, npmBin);
  await rename(dest, finalDir);
  if (protect) await protectTree(finalDir);
  return { id, dest: finalDir, sha256 };
}

function mergeConfig(existing, opts) {
  const next = { ...existing };
  if (opts.port != null) next.port = parsePort(opts.port, existing.port);
  if (opts.origins != null) next.origins = opts.origins;
  if (opts.product != null) next.product = opts.product;
  if (opts.brand != null) next.brand = opts.brand;
  return normalizeConfig(next);
}

export async function installMachine(opts = {}) {
  const prefix = resolve(opts.prefix || DEFAULT_PREFIX);
  const unprivileged = Boolean(opts.unprivileged);
  const asRoot = typeof process.getuid === 'function' && process.getuid() === 0 && !unprivileged;
  if (!unprivileged && prefix === DEFAULT_PREFIX && !asRoot) {
    throw new Error('installing to /opt/imperfect requires root');
  }
  if (unprivileged && prefix === DEFAULT_PREFIX) {
    throw new Error('unprivileged staging cannot use /opt/imperfect');
  }
  const user = opts.user || DEFAULT_USER;
  const p = paths(prefix);
  await mkdir(p.releases, { recursive: true, mode: 0o755 });
  const existing = existsSync(p.config) ? await readConfig(prefix) : defaultConfig();
  const config = mergeConfig(existing, opts);
  await writeConfig(prefix, config);
  await ensureDataDirs(prefix);

  if (opts.tarball || opts.fetchRuntime) {
    const tarball = opts.tarball || await fetchRuntimeTarball(p.prefix);
    await installRuntime({ prefix, tarball });
    if (asRoot) await protectTree(p.runtime);
  }

  const placed = await placeRelease({
    prefix,
    artifact: opts.artifact,
    npmBin: existsSync(p.npm) ? p.npm : opts.npmBin,
    protect: opts.protect !== false,
  });
  const previousCurrent = readLink(p.current);
  const previousPrevious = readLink(p.previous);
  await activateRelease({ prefix, id: placed.id });

  if (asRoot) {
    ensureUser(user, p.data);
    run(['chown', '-R', `${user}:${user}`, p.data]);
    run(['chmod', '-R', 'u=rwX,go=', p.data]);
    run(['chown', '-R', 'root:root', p.releases]);
    if (existsSync(p.runtime)) run(['chown', '-R', 'root:root', p.runtime]);
    run(['chown', 'root:root', p.config]);
    await writeUnit({ prefix, user, unitPath: opts.unitPath || p.unit });
    for (const argv of systemdActivation()) run(argv);
  } else if (opts.runner) {
    await opts.runner.restart(prefix);
  }

  try {
    const health = await checkHealth({ host: config.host, port: config.port, timeoutMs: opts.healthTimeoutMs });
    return { prefix, id: placed.id, current: readLink(p.current), previous: previousCurrent, config, health, asRoot };
  } catch (error) {
    if (previousCurrent) {
      await atomicLink(p.current, previousCurrent);
      if (previousPrevious) await atomicLink(p.previous, previousPrevious);
      else await rm(p.previous, { force: true });
      if (opts.runner) await opts.runner.restart(prefix);
      else if (asRoot) run(['systemctl', 'restart', 'imperfect.service']);
      try { await checkHealth({ host: config.host, port: config.port, timeoutMs: opts.healthTimeoutMs }); }
      catch { /* original failure is the one to report */ }
    }
    error.rolledBackTo = previousCurrent;
    throw error;
  }
}

export function machineStatus(prefix = DEFAULT_PREFIX) {
  const p = paths(prefix);
  return {
    prefix: p.prefix,
    current: readLink(p.current),
    previous: readLink(p.previous),
    runtime: existsSync(p.node) ? p.node : null,
    config: existsSync(p.config) ? JSON.parse(readFileSync(p.config, 'utf8')) : null,
  };
}

function print(value) {
  process.stdout.write(typeof value === 'string' ? `${value}\n` : `${JSON.stringify(value, null, 2)}\n`);
}

function arg(args, name, fallback) {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  return args[i + 1];
}

function flag(args, name) {
  return args.includes(`--${name}`);
}

async function main(argv) {
  const [command, ...args] = argv;
  if (!command || command === 'help' || command === '-h') {
    print(`imperfect.computer installer
  pack [--out file]
  check
  install --artifact file [--runtime-tarball file | --fetch-runtime] [--prefix dir] [--port N] [--origins url,url] [--user name] [--unprivileged]
  update --artifact file [--prefix dir]
  rollback [--prefix dir]
  status [--prefix dir]
Pinned runtime: Node ${NODE_RUNTIME.version} linux-x64 sha256 ${NODE_RUNTIME.sha256}
Pi ${PI_VERSION}. Default prefix ${DEFAULT_PREFIX}, user ${DEFAULT_USER}, loopback port 5067.`);
    return;
  }
  if (command === 'check') {
    print({ nodeRuntime: NODE_RUNTIME, pi: PI_VERSION, requiredPages: REQUIRED_PAGES, prefix: DEFAULT_PREFIX });
    collectReleaseFiles(SOURCE_ROOT);
    print('source allowlist ok');
    return;
  }
  if (command === 'pack') {
    print(await packRelease({ out: arg(args, 'out') }));
    return;
  }
  const prefix = arg(args, 'prefix', DEFAULT_PREFIX);
  if (command === 'status') {
    print(machineStatus(prefix));
    return;
  }
  if (command === 'rollback') {
    const config = await readConfig(prefix);
    const runner = flag(args, 'unprivileged')
      ? createMockRunner()
      : { async restart() { run(['systemctl', 'restart', 'imperfect.service']); } };
    print(await rollbackRelease({ prefix, config, runner }));
    return;
  }
  if (command === 'install' || command === 'update') {
    const artifact = arg(args, 'artifact');
    if (!artifact) throw new Error('--artifact is required');
    print(await installMachine({
      prefix,
      artifact,
      tarball: arg(args, 'runtime-tarball'),
      fetchRuntime: flag(args, 'fetch-runtime'),
      port: arg(args, 'port'),
      origins: arg(args, 'origins'),
      user: arg(args, 'user'),
      unprivileged: flag(args, 'unprivileged'),
      product: arg(args, 'product'),
      brand: arg(args, 'brand'),
    }));
    return;
  }
  throw new Error(`unknown command: ${command}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write(`${error.message || error}\n`);
    process.exit(1);
  });
}
