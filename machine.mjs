// Machine layout and config for a Locus host (vaita or Box).
// Releases and runtime live under prefix; personal data is separate and captured.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_PREFIX = '/opt/imperfect';
export const DEFAULT_USER = 'imperfect';
export const DEFAULT_PORT = 5067;
export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PRODUCT = 'locusrifle';
export const DEFAULT_BRAND = 'Locus';

export const NODE_RUNTIME = {
  version: '22.23.2',
  filename: 'node-v22.23.2-linux-x64.tar.xz',
  url: 'https://nodejs.org/dist/v22.23.2/node-v22.23.2-linux-x64.tar.xz',
  shasumsUrl: 'https://nodejs.org/dist/v22.23.2/SHASUMS256.txt',
  sha256: 'd60acfe00a2932254bb0ad20e01b0d74397a0875595de719654b214f4b03f307',
  minVersion: '22.19.0',
};

export const PI_VERSION = '0.85.1';

export function paths(prefix = DEFAULT_PREFIX) {
  const root = resolve(prefix);
  const data = join(root, 'data');
  return {
    prefix: root,
    releases: join(root, 'releases'),
    current: join(root, 'current'),
    previous: join(root, 'previous'),
    runtime: join(root, 'runtime'),
    node: join(root, 'runtime', 'bin', 'node'),
    npm: join(root, 'runtime', 'bin', 'npm'),
    config: join(root, 'machine.json'),
    data,
    workspace: join(data, 'workspace'),
    state: join(data, 'state'),
    agent: join(data, 'agent'),
    sessions: join(data, 'state', 'sessions'),
    unit: '/etc/systemd/system/imperfect.service',
    ingress: join(root, 'ingress.mjs'),
    ingressEnv: '/etc/imperfect-ingress.env',
    ingressUnit: '/etc/systemd/system/imperfect-ingress.service',
  };
}

export function parseOrigins(value) {
  if (value == null || value === '') return [];
  const list = Array.isArray(value) ? value : String(value).split(',');
  const origins = [];
  for (const raw of list) {
    const text = String(raw).trim();
    if (!text) continue;
    let url;
    try { url = new URL(text); } catch { throw new Error(`origin is not a URL: ${text}`); }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`origin must be http(s): ${text}`);
    origins.push(url.origin);
  }
  return origins;
}

export function parsePort(value, fallback = DEFAULT_PORT) {
  if (value == null || value === '') return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`invalid port: ${value}`);
  return port;
}

export function defaultConfig() {
  return {
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    origins: [],
    product: DEFAULT_PRODUCT,
    brand: DEFAULT_BRAND,
    authentication: true,
    ownArchive: true,
    liveSessions: false,
    // Desktop streaming is not part of this baseline. The shell does not offer it.
    desktop: false,
    person: '',
  };
}

export function normalizeConfig(raw = {}, fallback = defaultConfig()) {
  const next = { ...fallback, ...raw };
  next.host = next.host || DEFAULT_HOST;
  next.port = parsePort(next.port, fallback.port);
  next.origins = parseOrigins(next.origins);
  next.product = next.product === 'stock' ? 'stock' : DEFAULT_PRODUCT;
  next.brand = typeof next.brand === 'string' && next.brand.trim() ? next.brand.trim() : DEFAULT_BRAND;
  next.authentication = next.authentication !== false;
  next.ownArchive = next.ownArchive !== false;
  next.liveSessions = next.liveSessions === true;
  next.desktop = false;
  next.person = typeof next.person === 'string' ? next.person.trim() : '';
  if ('boxApiKey' in next || 'apiKey' in next || 'token' in next) {
    throw new Error('machine.json must not carry fleet secrets');
  }
  return next;
}

export async function readConfig(prefix) {
  const file = paths(prefix).config;
  if (!existsSync(file)) return defaultConfig();
  return normalizeConfig(JSON.parse(await readFile(file, 'utf8')));
}

export async function writeConfig(prefix, config, { mode = 0o644 } = {}) {
  const p = paths(prefix);
  await mkdir(p.prefix, { recursive: true, mode: 0o755 });
  const body = `${JSON.stringify(normalizeConfig(config), null, 2)}\n`;
  await writeFile(p.config, body, { mode });
  return p.config;
}

export async function ensureDataDirs(prefix) {
  const p = paths(prefix);
  for (const dir of [p.workspace, p.state, p.agent, p.sessions]) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  }
  return p;
}

export function resolvePrefix({ env = process.env, startDir = dirname(fileURLToPath(import.meta.url)) } = {}) {
  if (env.IMPERFECT_PREFIX) return resolve(env.IMPERFECT_PREFIX);
  if (env.IMPERFECT_CONFIG) return dirname(resolve(env.IMPERFECT_CONFIG));
  const parent = dirname(startDir);
  if (basename(parent) === 'releases') {
    const prefix = dirname(parent);
    if (existsSync(join(prefix, 'machine.json'))) return prefix;
  }
  if (existsSync(join(startDir, 'machine.json'))) return startDir;
  throw new Error('set IMPERFECT_PREFIX to the machine prefix (default /opt/imperfect)');
}
