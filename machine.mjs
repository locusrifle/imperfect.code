import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_PREFIX = '/opt/imperfect';
export const DEFAULT_PORT = 5067;

export function paths(prefix = DEFAULT_PREFIX) {
  const root = resolve(prefix);
  const data = join(root, 'data');
  return {
    prefix: root,
    config: join(root, 'machine.json'),
    data,
    workspace: join(data, 'workspace'),
    state: join(data, 'state'),
    agent: join(data, 'agent'),
    sessions: join(data, 'state', 'sessions'),
  };
}

export function parseOrigins(value) {
  if (value == null || value === '') return [];
  const list = Array.isArray(value) ? value : String(value).split(',');
  return list.filter(Boolean).map(raw => {
    const url = new URL(String(raw).trim());
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`origin must be http(s): ${raw}`);
    return url.origin;
  });
}

export function parsePort(value, fallback = DEFAULT_PORT) {
  if (value == null || value === '') return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`invalid port: ${value}`);
  return port;
}

export function defaultConfig() {
  return {
    host: '127.0.0.1',
    port: DEFAULT_PORT,
    origins: [],
    authentication: true,
    ownArchive: true,
    person: '',
  };
}

export function normalizeConfig(raw = {}) {
  const next = { ...defaultConfig(), ...raw };
  next.host = '127.0.0.1';
  next.port = parsePort(next.port);
  next.origins = parseOrigins(next.origins);
  next.authentication = next.authentication !== false;
  next.ownArchive = true;
  next.person = typeof next.person === 'string' ? next.person.trim() : '';
  return next;
}

export async function readConfig(prefix) {
  const file = paths(prefix).config;
  if (!existsSync(file)) return defaultConfig();
  return normalizeConfig(JSON.parse(await readFile(file, 'utf8')));
}

export async function writeConfig(prefix, config, { mode = 0o600 } = {}) {
  const target = paths(prefix);
  await mkdir(target.prefix, { recursive: true, mode: 0o700 });
  await writeFile(target.config, `${JSON.stringify(normalizeConfig(config), null, 2)}\n`, { mode });
  return target.config;
}

export async function ensureDataDirs(prefix) {
  const target = paths(prefix);
  for (const dir of [target.workspace, target.state, target.agent, target.sessions]) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  }
  return target;
}

export function resolvePrefix({ env = process.env, startDir = dirname(fileURLToPath(import.meta.url)) } = {}) {
  if (env.IMPERFECT_PREFIX) return resolve(env.IMPERFECT_PREFIX);
  if (env.IMPERFECT_CONFIG) return dirname(resolve(env.IMPERFECT_CONFIG));
  if (existsSync(join(startDir, 'machine.json'))) return startDir;
  throw new Error('set IMPERFECT_PREFIX to the local data directory');
}
