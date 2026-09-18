import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, mkdir, open, unlink, writeFile } from 'node:fs/promises';
import { join, resolve, sep, extname, basename } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { createRuntime } from './native/runtime.mjs';
import { createTabHost, tabLabel, turnActive } from './native/tabs.mjs';
import { applySetting, settingsView } from './native/settings-io.mjs';
import { answerEvidence, staleCommandError, tabCloseBusyError } from './native/public/js/session-logic.js';
import { receiveHttpUpload, filenameFromHeader, MAX_UPLOAD_BYTES, UPLOAD_TIMEOUT_MS, OTHER_POST_TIMEOUT_MS } from './native/uploads.mjs';

export function openHttpUrl(urlString, opener) {
  let url;
  try { url = new URL(String(urlString || '')); } catch { throw new Error('Invalid URL'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only http(s) URLs can be opened');
  const open = opener ?? (href => { spawn('xdg-open', [href], { stdio: 'ignore', detached: true }).unref(); });
  open(url.href);
  return url.href;
}

export function privateHost(host) {
  if (['127.0.0.1', '::1'].includes(host)) return true;
  const parts = host.split('.').map(Number);
  return parts.length === 4 && parts.every(n => Number.isInteger(n) && n >= 0 && n <= 255) && parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
}

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.otf': 'font/otf', '.woff2': 'font/woff2', '.json': 'application/json',
};

function assetPath(publicDir, urlPath) {
  const wanted = urlPath === '/' ? '/index.html' : urlPath;
  if (wanted.includes('\0') || wanted.includes('..')) return null;
  const full = resolve(publicDir, `.${wanted}`);
  if (full !== publicDir && !full.startsWith(publicDir + sep)) return null;
  const type = TYPES[extname(full)];
  return type ? { full, type } : null;
}

export async function createGueyServer(options = {}) {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 5057;
  if (!privateHost(host)) throw new Error('imperfect is a private local console');

  const cwd = resolve(options.cwd ?? process.env.GUEY_CWD ?? process.cwd());
  const stateDir = resolve(options.stateDir ?? process.env.GUEY_STATE_DIR ?? join(homedir(), '.local/state/imperfect'));
  const publicDir = resolve(import.meta.dirname, 'native/public');
  await mkdir(stateDir, { recursive: true, mode: 0o700 });

  const lockPath = join(stateDir, 'owner.pid');
  try {
    const pid = Number(await readFile(lockPath, 'utf8'));
    if (pid > 0) {
      try { process.kill(pid, 0); throw new Error(`state is owned by process ${pid}`); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    await unlink(lockPath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const lock = await open(lockPath, 'wx', 0o600);
  await lock.writeFile(String(process.pid));
  await lock.close();

  let runtime;
  let tabs = null;
  try {
    if (options.runtime) runtime = options.runtime;
    else {
      tabs = await createTabHost({
        cwd,
        stateDir,
        sessionDir: options.sessionDir,
        agentDir: options.agentDir,
        authentication: options.authentication,
        ownArchive: options.ownArchive ?? true,
        serviceOptions: options.serviceOptions,
      });
      runtime = tabs;
    }
  } catch (error) {
    await unlink(lockPath);
    throw error;
  }

  const agentDir = resolve(options.agentDir ?? getAgentDir());
  const uploadMaxBytes = options.uploadMaxBytes ?? MAX_UPLOAD_BYTES;
  const uploadTimeoutMs = options.uploadTimeoutMs ?? UPLOAD_TIMEOUT_MS;
  const extraOrigins = options.origins ?? [];
  const originHosts = extraOrigins.map(origin => new URL(origin));
  const clients = new Set();

  let server;
  const validRequest = req => {
    const expectedHost = `${host.includes(':') ? `[${host}]` : host}:${server.address()?.port ?? port}`;
    const trusted = new Set([expectedHost, ...originHosts.flatMap(url => [url.host, url.hostname])]);
    const bare = req.headers.host?.replace(/:\d+$/, '');
    if (!trusted.has(req.headers.host) && !trusted.has(bare)) return false;
    if (!req.headers.origin) return true;
    return [`http://${expectedHost}`, ...originHosts.map(url => url.origin)].includes(req.headers.origin);
  };

  server = createServer({ requestTimeout: 0, headersTimeout: 60_000 }, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self'; media-src 'self' blob:; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; frame-ancestors 'none'");

    let path;
    try { path = decodeURIComponent(new URL(req.url, 'http://local').pathname); }
    catch { res.writeHead(400).end('Bad path'); return; }
    if (!validRequest(req)) { res.writeHead(403).end('Private local origin required'); return; }

    if (req.method === 'POST' && path !== '/upload') {
      const timer = setTimeout(() => {
        if (!res.headersSent) res.writeHead(408).end('timeout');
        req.destroy();
      }, OTHER_POST_TIMEOUT_MS);
      res.once('close', () => clearTimeout(timer));
      res.once('finish', () => clearTimeout(timer));
    }

    if (path === '/upload' && req.method === 'POST') {
      if (!req.headers.origin) { res.writeHead(403).end('exact origin required'); return; }
      try {
        const saved = await receiveHttpUpload(req, {
          cwd: runtime.snapshot().cwd,
          res,
          filename: filenameFromHeader(req.headers['x-filename']),
          maxBytes: uploadMaxBytes,
          timeoutMs: uploadTimeoutMs,
        });
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify(saved));
      } catch (error) {
        if (!res.headersSent) res.writeHead(Number(error.status) || 500).end(error.message || 'upload failed');
        req.destroy();
      }
      return;
    }

    if (req.method !== 'GET') { res.writeHead(405).end(); return; }
    if (path === '/health') {
      const snapshot = runtime.snapshot();
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: !snapshot.failed, ui: 'native-gui', pid: process.pid, cwd: snapshot.cwd, sessionId: snapshot.sessionId, busy: snapshot.busy }));
      return;
    }

    const asset = assetPath(publicDir, path);
    if (!asset) { res.writeHead(404).end('Not found'); return; }
    try {
      const body = await readFile(asset.full);
      const text = asset.type.startsWith('text/') || asset.type.endsWith('javascript') || asset.type === 'application/json';
      res.setHeader('Content-Type', text ? `${asset.type}; charset=utf-8` : asset.type);
      res.setHeader('Cache-Control', text ? 'no-store' : 'public, max-age=3600');
      res.end(body);
    } catch {
      res.writeHead(404).end('Not found');
    }
  });

  const sockets = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
  const send = (ws, value) => {
    if (ws.readyState === 1) ws.send(JSON.stringify(value));
  };
  const sendSnapshot = (ws, raw) => {
    if (ws.readyState !== 1 || ws.bufferedAmount > 1024 * 1024) return false;
    ws.send(raw);
    return true;
  };
  const withTabs = data => {
    if (data.tabs) {
      return {
        ...data,
        tabs: data.tabs.map(tab => ({
          ...tab,
          name: tab.name || tabLabel({ name: tab.name, sessionId: tab.sessionId, messages: tab.messages }),
          status: tab.status ?? ((tab.focused ? data.busy : tab.busy) ? 'working' : 'idle'),
          workspace: tab.workspace ?? basename(String(tab.cwd ?? data.cwd ?? '').replace(/[\\/]+$/, '')),
        })),
      };
    }
    return {
      ...data,
      tabs: [{
        id: data.sessionId,
        sessionId: data.sessionId,
        name: tabLabel(data),
        busy: data.busy,
        status: data.ui?.dialogs?.length ? 'blocked' : data.busy ? 'working' : 'idle',
        workspace: basename(String(data.cwd ?? '').replace(/[\\/]+$/, '')),
        focused: true,
      }],
    };
  };
  const view = data => withTabs(data);

  let timer;
  let retryTimer;
  let wasTurn = turnActive(runtime.snapshot());
  const flushSnapshots = () => {
    const raw = JSON.stringify({ type: 'snapshot', data: view(runtime.snapshot()) });
    let blocked = false;
    for (const ws of clients) if (!sendSnapshot(ws, raw)) blocked = true;
    if (blocked && !retryTimer) retryTimer = setTimeout(() => { retryTimer = null; flushSnapshots(); }, 80);
  };
  const changed = () => {
    if (timer) return;
    timer = setTimeout(() => { timer = null; flushSnapshots(); }, 40);
  };
  const emitTurn = info => { for (const ws of clients) send(ws, { type: 'turn', ...info }); };
  if (!tabs) {
    runtime.events.on('change', () => {
      const snapshot = runtime.snapshot();
      const active = turnActive(snapshot);
      if (wasTurn && !active) emitTurn({ sessionId: snapshot.sessionId ?? null, failed: snapshot.failed ?? null, answer: answerEvidence(snapshot.messages ?? []) });
      wasTurn = active;
    });
  }
  runtime.events.on('change', changed);
  tabs?.events.on('settled', emitTurn);

  async function readSettings() {
    try { return JSON.parse(await readFile(join(agentDir, 'settings.json'), 'utf8')); }
    catch { return {}; }
  }
  async function handleSettings(command) {
    try { return await runtime.command({ ...command, type: 'settings' }); }
    catch (error) {
      if (!/belongs to the terminal|Unsupported command/.test(error?.message ?? '')) throw error;
    }
    const settings = await readSettings();
    if (!command.key) return settingsView(settings);
    const next = applySetting(settings, command.key, command.value);
    await writeFile(join(agentDir, 'settings.json'), `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    return settingsView(next);
  }

  server.on('upgrade', (req, socket, head) => {
    let url;
    try { url = new URL(req.url, 'http://local'); } catch { socket.destroy(); return; }
    if (!validRequest(req) || url.pathname !== '/pi' || url.search) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    sockets.handleUpgrade(req, socket, head, ws => {
      clients.add(ws);
      send(ws, { type: 'snapshot', data: view(runtime.snapshot()) });
      ws.on('error', () => {});
      ws.on('close', () => { clients.delete(ws); changed(); });
      ws.on('message', async raw => {
        let command;
        try {
          command = JSON.parse(raw.toString());
          if (!command || Array.isArray(command) || typeof command.type !== 'string' || typeof command.id !== 'string') throw new Error('Command requires string id and type');
          if (command.type === 'hello') {
            send(ws, { type: 'response', id: command.id, success: true, data: { kind: 'desktop' } });
            return;
          }
          if (command.type === 'settings') {
            send(ws, { type: 'response', id: command.id, success: true, data: await handleSettings(command) });
            return;
          }
          if (command.type === 'open_url') {
            send(ws, { type: 'response', id: command.id, success: true, data: openHttpUrl(command.url, options.openUrl) });
            return;
          }
          if (command.type === 'guey-restart') {
            send(ws, { type: 'response', id: command.id, success: true, data: { ok: true } });
            setTimeout(() => process.exit(0), 200);
            return;
          }
          if (command.type === 'tab-new' && !tabs && !runtime.snapshot()?.tabs) command = { ...command, type: 'new' };
          if (command.type === 'tab-focus' && !tabs && !runtime.snapshot()?.tabs) {
            send(ws, { type: 'response', id: command.id, success: true, data: { id: runtime.snapshot().sessionId, focused: true } });
            return;
          }
          const snapshot = runtime.snapshot();
          const stale = staleCommandError(command, snapshot) || tabCloseBusyError(command, snapshot);
          if (stale) throw new Error(stale);
          const data = await runtime.command(command);
          send(ws, { type: 'response', id: command.id, success: true, data: command.type === 'snapshot' ? view(data) : data });
          changed();
        } catch (error) {
          send(ws, { type: 'response', id: command?.id, success: false, error: error.message });
        }
      });
    });
  });

  return {
    server,
    runtime,
    stateDir,
    sockets,
    listen: () => new Promise((resolveListen, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => resolveListen(server.address()));
    }),
    async close() {
      clearTimeout(timer);
      clearTimeout(retryTimer);
      runtime.events.off('change', changed);
      for (const ws of sockets.clients) ws.terminate();
      sockets.close();
      await new Promise(done => server.close(done));
      await (tabs ?? runtime).close();
      await unlink(lockPath);
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const app = await createGueyServer({
    host: process.env.IMPERFECT_HOST,
    port: process.env.IMPERFECT_PORT ? Number(process.env.IMPERFECT_PORT) : undefined,
  });
  try {
    const address = await app.listen();
    console.log(`imperfect: http://${address.address}:${address.port}`);
  } catch (error) {
    await app.close();
    throw error;
  }
  let closing = false;
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, async () => {
    if (closing) return;
    closing = true;
    await app.close();
    process.exit(0);
  });
}
