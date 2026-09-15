import { createServer } from 'node:http';
import { watch } from 'node:fs';
import { readFile, mkdir, open, readFile as read, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { join, resolve, sep, extname } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { createRuntime } from './native/runtime.mjs';
import { createTabHost, tabLabel, turnActive } from './native/tabs.mjs';
import { transcribeAudio } from './native/transcribe.mjs';
import { CONTROLS } from './native/controls.mjs';
import { tuiThemeCss } from './native/tui-theme.mjs';
import { resolveProduct, resolveBrand, PERSONAL_CONTROL_IDS } from './native/product.mjs';
import { applySetting, settingsView } from './native/settings-io.mjs';
import { walkKnowledgeGraph, readKnowledgePage } from './native/graph.mjs';
import { answerEvidence, staleCommandError, tabCloseBusyError } from './native/public/js/session-logic.js';
import { receiveHttpUpload, filenameFromHeader, MAX_UPLOAD_BYTES, UPLOAD_TIMEOUT_MS, OTHER_POST_TIMEOUT_MS } from './native/uploads.mjs';
import { applyWorldWindow, closeWorldWindow, sanitizeWorldWindow } from './native/world-windows.mjs';
import { createFiles } from './native/files.mjs';
import { resolveAppFile } from './native/apps.mjs';
import { listRegisteredApps, loadOverlayCss } from './native/customization.mjs';
import { buildIdentity } from './machine.mjs';

export function privateHost(host) {
  if (['127.0.0.1', '::1'].includes(host)) return true;
  const parts = host.split('.').map(Number);
  return parts.length === 4 && parts.every(n => Number.isInteger(n) && n >= 0 && n <= 255) && parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
}
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.otf': 'font/otf', '.woff2': 'font/woff2', '.mp3': 'audio/mpeg', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.wad': 'application/octet-stream' };
// Read once at start: the answer cannot change without a new process, and a verification that
// re-derived it per request would be reporting the filesystem rather than the running code.
const BUILD = buildIdentity();
export const LAUNCH_THEMES = Object.freeze(['garden', 'night']);

export function launchThemeFromCookie(header) {
  const raw = String(header || '');
  const part = raw.split(';').map(s => s.trim()).find(s => s.startsWith('ic-theme='));
  if (!part) return '';
  try {
    const name = decodeURIComponent(part.slice('ic-theme='.length));
    return LAUNCH_THEMES.includes(name) ? name : '';
  } catch { return ''; }
}
// Served from a directory, so the stylesheets and fonts of the design system
// come across whole. Only what resolves inside native/public is readable, and
// only these types: a traversal or an unknown extension is a 404, not a file.
function assetPath(publicDir, urlPath) {
  const wanted = urlPath === '/' ? '/index.html' : urlPath;
  if (wanted.includes('\0') || wanted.includes('..')) return null;
  const full = resolve(publicDir, `.${wanted}`);
  if (full !== publicDir && !full.startsWith(publicDir + sep)) return null;
  const type = TYPES[extname(full)];
  return type ? { full, type } : null;
}

export async function createGueyServer(options = {}) {
  // Bind comes from the caller. The live unit passes IMPERFECT_* at the
  // entrypoint; tests and agent probes must not inherit that address, or
  // `port: 0` listens on the tailnet and a fetch to 127.0.0.1 never returns.
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 5057;
  if (!privateHost(host)) throw new Error('GUEY is a private console: bind a loopback or tailnet IP');
  const cwd = resolve(options.cwd ?? process.env.GUEY_CWD ?? process.cwd());
  const product = resolveProduct(options);
  const personal = product === 'imperfect';
  const brand = resolveBrand(options);
  const knowledgeRoot = resolve(options.knowledgeRoot ?? process.env.GUEY_KNOWLEDGE_ROOT ?? (personal ? homedir() : cwd));
  // What the files app is allowed to see. On a laptop this is home and always has been. On a
  // machine imperfect computers hosts, home is where the control plane keeps its secrets, so that deployment
  // passes the workspace instead -- and must, because a browser is not a shell and the person
  // reading it may not be the person who owns the host.
  const files = createFiles({ root: resolve(options.filesRoot ?? process.env.GUEY_FILES_ROOT ?? (personal ? homedir() : cwd)) });
  const controls = personal ? CONTROLS : CONTROLS.filter(c => !PERSONAL_CONTROL_IDS.has(c.id));
  const stateDir = resolve(options.stateDir ?? process.env.GUEY_STATE_DIR ?? join(homedir(), personal ? '.local/state/guey-pi' : '.local/state/guey-desktop'));
  const publicDir = resolve(import.meta.dirname, 'native/public');
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  // One owner per GUEY store. Never share this store with another GUEY instance.
  const lockPath = join(stateDir, 'owner.pid');
  try {
    const pid = Number(await read(lockPath, 'utf8'));
    if (pid > 0) { try { process.kill(pid, 0); throw new Error(`GUEY store is owned by process ${pid}`); } catch (e) { if (e.code !== 'ESRCH') throw e; } }
    await unlink(lockPath);
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const lock = await open(lockPath, 'wx', 0o600); await lock.writeFile(String(process.pid)); await lock.close();
  let runtime;
  let tabs = null;
  // Same agentDir as the laptop TUI: sessions, extensions, skills, settings.
  // Desktop passes noExtensions itself. Tests pass an injected runtime.
  try {
    if (options.runtime) runtime = options.runtime;
    else {
      const shared = {
        cwd, stateDir, sessionDir: options.sessionDir, agentDir: options.agentDir,
        runtimeDir: options.runtimeDir, liveSessions: options.liveSessions,
        authentication: options.authentication, ownArchive: options.ownArchive ?? !personal,
        serviceOptions: options.serviceOptions,
      };
      tabs = await createTabHost(shared);
      runtime = tabs;
    }
  }
  catch (e) { await unlink(lockPath); throw e; }
  const clients = new Set();
  const agentDir = resolve(options.agentDir ?? getAgentDir());
  const uiDir = resolve(options.uiDir ?? process.env.GUEY_UI_DIR ?? join(resolve(agentDir, '..'), 'ui'));
  let themeName = personal ? 'garden' : 'light/dark';
  let themeRev = 0;
  const uploadMaxBytes = options.uploadMaxBytes ?? MAX_UPLOAD_BYTES;
  const uploadTimeoutMs = options.uploadTimeoutMs ?? UPLOAD_TIMEOUT_MS;
  const extraOrigins = options.origins ?? (process.env.GUEY_ORIGINS ?? '').split(',').filter(Boolean);
  // Host/Origin pinning stops a hostile page in a browser on the tailnet from
  // scripting this console. A reverse proxy (tailscale serve) forwards its own
  // name, so each configured origin is trusted with and without its port —
  // reaching the same process through https://<tailnet name>/ must still work.
  const originHosts = extraOrigins.map(o => new URL(o));
  const validRequest = req => {
    const expectedHost = `${host.includes(':') ? `[${host}]` : host}:${server.address()?.port ?? port}`;
    const trustedHosts = new Set([expectedHost, ...originHosts.flatMap(u => [u.host, u.hostname])]);
    // A proxy may or may not append the scheme's default port to its own name.
    // Stripping it only ever matches a configured hostname, never a stray port
    // on the bind address: `<bind ip>:9999` still fails.
    const bare = req.headers.host?.replace(/:\d+$/, '');
    if (!trustedHosts.has(req.headers.host) && !trustedHosts.has(bare)) return false;
    if (!req.headers.origin) return true;
    return [`http://${expectedHost}`, ...originHosts.map(u => u.origin)].includes(req.headers.origin);
  };
  // Node's requestTimeout (300s) covers the whole body. A 1 GiB phone upload
  // can outlast that. Disable it and bound bodies per route: uploads get a
  // longer cap, every other POST keeps 300s. headersTimeout stays 60s.
  const server = createServer({ requestTimeout: 0, headersTimeout: 60_000 }, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // frame-ancestors 'self': the shell's `page` window frames this application's
    // own pages, which is how another web project is manifested without a new
    // window kind. A foreign site still cannot frame this console, and
    // default-src 'self' still refuses a foreign page inside one.
    // A deployment may need to frame exactly one foreign thing: the machine's own desktop stream,
    // which the supplier serves from its own host. It is named in full rather than wildcarded --
    // other customers' machines live on that domain too, and `*.on.ascii.dev` would say this page
    // may frame any of them. Unset, nothing foreign can be framed at all.
    const frameSrc = String(process.env.GUEY_FRAME_SRC || '').trim();
    let path;
    try { path = decodeURIComponent(new URL(req.url, 'http://local').pathname); } catch { res.writeHead(400).end('Bad path'); return; }
    // three-doom writes element styles. Scope the extra keyword to that tree, not the shell.
    const doomStyles = path === '/doom/index.html' || path.startsWith('/doom/');
    res.setHeader('Content-Security-Policy', personal
      ? `default-src 'self'; connect-src 'self'; media-src 'self' blob:; img-src 'self' data: blob:; style-src 'self'${doomStyles ? " 'unsafe-inline'" : ''}; script-src 'self'; frame-ancestors 'self'`
      : `default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-src ${frameSrc || "'none'"}; frame-ancestors 'none'`);
    if (!validRequest(req)) { res.writeHead(403).end(`Private origin required. This console answers to its own bind, plus GUEY_ORIGINS. Rejected Host: ${req.headers.host ?? '(none)'}${req.headers.origin ? `, Origin: ${req.headers.origin}` : ''}`); return; }
    if (req.method === 'POST' && path !== '/upload') {
      const timer = setTimeout(() => {
        if (!res.headersSent) res.writeHead(408).end('timeout');
        req.destroy();
      }, OTHER_POST_TIMEOUT_MS);
      res.once('close', () => clearTimeout(timer));
      res.once('finish', () => clearTimeout(timer));
    }
    if (path === '/upload' && req.method === 'POST') {
      if (!personal) { res.writeHead(404).end('Not found'); return; }
      if (!req.headers.origin) { res.writeHead(403).end('exact origin required'); return; }
      const cwd = runtime.snapshot().cwd;
      try {
        const saved = await receiveHttpUpload(req, {
          cwd,
          res,
          filename: filenameFromHeader(req.headers['x-filename']),
          maxBytes: uploadMaxBytes,
          timeoutMs: uploadTimeoutMs,
        });
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify(saved));
      } catch (error) {
        const status = Number(error.status) || 500;
        if (!res.headersSent) res.writeHead(status).end(error.message || 'upload failed');
        req.destroy();
      }
      return;
    }
            if (path === '/transcribe' && req.method === 'POST') {
      if (!personal) { res.writeHead(404).end('Not found'); return; }
      const chunks = [];
      let n = 0;
      try {
        for await (const chunk of req) {
          n += chunk.length;
          if (n > 8 * 1024 * 1024) { res.writeHead(413).end('clip too large'); return; }
          chunks.push(chunk);
        }
        const mime = (req.headers['content-type'] || 'audio/webm').split(';')[0];
        const text = await transcribeAudio(Buffer.concat(chunks), mime);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ text }));
      } catch (error) {
        const missing = error.code === 'ENOENT';
        res.writeHead(missing ? 503 : 502).end(missing ? 'no openai key' : 'transcribe failed');
      }
      return;
    }
    if (req.method !== 'GET') { res.writeHead(405).end(); return; }
                if (path === '/files/list' || path === '/files/text' || path === '/files/open') {
      if (!personal) { res.writeHead(404).end('Not found'); return; }
      const wantedPath = new URL(req.url, 'http://local').searchParams.get('path') ?? '';
      try {
        if (path === '/files/list') {
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.setHeader('Cache-Control', 'no-store');
          res.end(JSON.stringify(await files.listDirectory(wantedPath)));
          return;
        }
        if (path === '/files/text') {
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.setHeader('Cache-Control', 'no-store');
          res.end(JSON.stringify(await files.readTextFile(wantedPath)));
          return;
        }
        const file = await files.openFile(wantedPath);
        const stamp = file.mtime.toUTCString();
        res.setHeader('Content-Type', file.type);
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Last-Modified', stamp);
        if (req.headers['if-modified-since'] === stamp) { res.writeHead(304).end(); return; }
        res.end(await readFile(file.full));
      } catch (error) {
        res.writeHead(error.status ?? 500).end(error.message || 'files failed');
      }
      return;
    }
    if (personal && path === '/apps/list') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify((await listRegisteredApps(files.root)).apps));
      return;
    }
    if (personal && path === '/custom/ui.css') {
      try {
        const overlay = await loadOverlayCss(uiDir);
        res.setHeader('Content-Type', 'text/css; charset=utf-8');
        if (overlay.fallback) res.setHeader('X-Imperfect-UI', 'stock');
        res.end(overlay.css);
      } catch { res.writeHead(500).end('ui failed'); }
      return;
    }
    if (personal && path.startsWith('/apps/')) {
      const asset = resolveAppFile(files.root, path);
      if (!asset) { res.writeHead(404).end('Not found'); return; }
      try {
        const body = await readFile(asset.full);
        const text = asset.type.startsWith('text/') || asset.type.endsWith('javascript');
        res.setHeader('Content-Type', text ? `${asset.type}; charset=utf-8` : asset.type);
        res.setHeader('Cache-Control', 'no-store');
        res.end(body);
      } catch { res.writeHead(404).end('Not found'); }
      return;
    }
    if (path === '/theme.css') {
      try {
        const fromDoor = launchThemeFromCookie(req.headers.cookie);
        if (fromDoor) {
          const settings = await readSettingsFile();
          if (!settings.theme) await applyTheme(fromDoor, true);
        }
        const css = await tuiThemeCss(themeName, agentDir);
        res.setHeader('Content-Type', 'text/css; charset=utf-8');
        res.end(css);
      } catch (error) { res.writeHead(500).end('theme failed'); }
      return;
    }
        if (path === '/health') {
      const s = runtime.snapshot();
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: !s.failed, ui: 'native-gui', product, runtime: 'pi-sdk',
        release: BUILD.release, version: BUILD.version, pid: process.pid, clients: clients.size, cwd: s.cwd, sessionId: s.sessionId, sessionFile: s.sessionFile, busy: s.busy })); return;
    }
    if (path === '/graph.json' || path === '/graph/page') {
      if (!personal) { res.writeHead(404).end('Not found'); return; }
      try {
        const graph = await walkKnowledgeGraph({ root: knowledgeRoot });
        if (path === '/graph.json') {
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({
            root: graph.root,
            truncated: graph.truncated,
            nodes: graph.nodes,
            edges: graph.edges.map(e => [e.from, e.to, e.alias, e.heading]),
          }));
          return;
        }
        const id = new URL(req.url, 'http://local').searchParams.get('id') || graph.root;
        const page = await readKnowledgePage({ graph, id });
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify(page));
      } catch (error) {
        const code = error.code === 'UNKNOWN' || error.code === 'ESCAPE' ? 404 : 500;
        res.writeHead(code).end(error.code === 'ESCAPE' ? 'Not found' : (error.message || 'graph failed'));
      }
      return;
    }
    if (path === '/brand.css') {
      // A named deployment may bring a palette with it. Stock gets an empty sheet rather than a
      // 404, so the page does not report a missing asset it was never meant to have.
      res.setHeader('Content-Type', 'text/css; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      if (brand === 'Guey') { res.end('/* stock */\n'); return; }
      // assetPath returns { full, type }, not a path: reading the object silently yielded an
      // empty sheet, which looks exactly like a deployment that simply has no theme.
      const sheet = assetPath(publicDir, `/css/${brand.toLowerCase()}.css`);
      if (!sheet) { res.end('/* no sheet for this brand */\n'); return; }
      try { res.end(await readFile(sheet.full, 'utf8')); }
      catch { res.end('/* no sheet for this brand */\n'); }
      return;
    }
    if (path === '/brand.js') {
      // The page needs the deployment's name before the first snapshot arrives.
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      // Inline script is refused by this console's CSP, so the name is applied here.
      res.end(`window.GUEY_BRAND=${JSON.stringify(brand)};\ndocument.title=window.GUEY_BRAND;\n`);
      return;
    }
    const wanted = (path === '/' || path === '/index.html') && product === 'stock' ? '/stock.html' : path;
    const asset = assetPath(publicDir, wanted);
    if (!asset) { res.writeHead(404).end('Not found'); return; }
    try {
      const text = asset.type.startsWith('text/') || asset.type.endsWith('javascript') || asset.type === 'application/json';
      res.setHeader('Content-Type', text ? `${asset.type}; charset=utf-8` : asset.type);
      if (text) {
        res.setHeader('Cache-Control', 'no-store');
      } else {
        // Images and fonts are megabytes over the tailnet, and the scene alone
        // is five stills. Revalidate rather than refetch: a changed file still
        // wins, a phone reload costs a 304.
        const stamp = (await stat(asset.full)).mtime.toUTCString();
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Last-Modified', stamp);
        if (req.headers['if-modified-since'] === stamp) { res.writeHead(304).end(); return; }
      }
      res.end(await readFile(asset.full));
    } catch { res.writeHead(404).end(); }
  });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
  const send = (ws, value) => {
    if (ws.readyState !== 1) return;
    ws.send(JSON.stringify(value));
  };
  // Snapshots of a watched TUI are routinely >8MB. Closing at that size made
  // the GUI reconnect forever (1013). Keep the socket; send the latest when
  // the previous frame has drained.
  const sendSnapshot = (ws, raw) => {
    if (ws.readyState !== 1) return false;
    if (ws.bufferedAmount > 1024 * 1024) return false;
    ws.send(raw);
    return true;
  };
  const listed = () => [...clients].filter(ws => ws.readyState === 1).map(ws => ({
    kind: ws.meta?.kind ?? 'unknown', width: ws.meta?.width, height: ws.meta?.height, dpr: ws.meta?.dpr, visible: ws.meta?.visible,
  }));
  // The laptop screen is one canvas, not one tab. Screenshots still name a
  // device because those pixels differ; the overlay does not.
  let worldWindows = [];
  const withTabs = data => {
    if (data.tabs) {
      return {
        ...data,
        tabs: data.tabs.map(tab => ({
          ...tab,
          name: tab.name || tabLabel({ name: tab.name, sessionId: tab.sessionId, messages: tab.messages }),
        })),
      };
    }
    return {
      ...data,
      tabs: [{ id: data.sessionId, sessionId: data.sessionId, name: tabLabel(data), busy: data.busy, focused: true }],
    };
  };
  const view = data => ({ ...withTabs(data), product, brand, controls, clients: listed(), theme: themeName, themeRev, windows: personal ? worldWindows : [] });
  const waiting = new Map();
  const views = () => [...clients].filter(ws => ws.readyState === 1 && (ws.meta?.kind === 'phone' || ws.meta?.kind === 'desktop'));
  const clientTargets = (client) => {
    const want = client === 'all' ? null : client;
    const targets = [...clients].filter(ws => {
      if (ws.readyState !== 1) return false;
      if (!want) return true;
      return (ws.meta?.kind ?? 'unknown') === want;
    });
    if (want && !targets.length) throw new Error(`no ${want} client connected`);
    if (!targets.length) throw new Error('no browser connected');
    if (!want && targets.length > 1 && new Set(targets.map(ws => ws.meta?.kind)).size > 1) {
      throw new Error('phone and desktop are both connected; say which');
    }
    return targets;
  };
  const askClient = (ws, name, extra = {}) => new Promise((resolve, reject) => {
    const id = `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`${name} timed out`)); }, 12000);
    waiting.set(id, message => { clearTimeout(timer); waiting.delete(id); resolve(message); });
    send(ws, { type: 'control', id, name, ...extra });
  });
  const capture = async (c) => {
    const targets = clientTargets(c.client);
    const files = [];
    for (const ws of targets) {
      const result = await askClient(ws, 'capture');
      if (result.error) throw new Error(result.error);
      if (result.mime !== 'image/png' || typeof result.data !== 'string') throw new Error('capture returned no png');
      const kind = ws.meta?.kind ?? 'view';
      const path = join(stateDir, targets.length === 1 ? 'view.png' : `view-${kind}.png`);
      await writeFile(path, Buffer.from(result.data, 'base64'), { mode: 0o600 });
      files.push({ kind, path, width: result.width, height: result.height });
    }
    return { files };
  };
  const windowControl = async (c, name) => {
    if (name === 'window-open') {
      const spec = sanitizeWorldWindow(c.window ?? { kind: c.kind, title: c.title, src: c.src, text: c.text, id: c.windowId });
      worldWindows = applyWorldWindow(worldWindows, spec);
      changed();
      for (const ws of views()) {
        try {
          const result = await askClient(ws, 'window-open', { window: spec });
          if (result?.error) throw new Error(result.error);
        } catch {
          throw new Error('a view could not open the window');
        }
      }
      return { ok: true, windows: worldWindows };
    }
    const id = c.windowId ?? c.window?.id;
    worldWindows = closeWorldWindow(worldWindows, id);
    changed();
    for (const ws of views()) {
      try { await askClient(ws, 'window-close', { windowId: id }); }
      catch { /* a closed view is the outcome */ }
    }
    return { ok: true, windows: worldWindows };
  };
  let timer;
  let retryTimer;
  let wasTurn = turnActive(runtime.snapshot());
  const flushSnapshots = () => {
    const snap = runtime.snapshot();
    const raw = JSON.stringify({ type: 'snapshot', data: view(snap) });
    let blocked = false;
    for (const ws of clients) {
      if (!sendSnapshot(ws, raw)) blocked = true;
    }
    if (blocked && !retryTimer) {
      retryTimer = setTimeout(() => { retryTimer = null; flushSnapshots(); }, 80);
    }
  };
  const emitTurn = info => {
    for (const ws of clients) send(ws, { type: 'turn', ...info });
  };
  const turnPayload = (snap, id) => ({
    id: id ?? (snap.tabs ?? []).find(tab => tab.focused)?.id ?? null,
    sessionId: snap.sessionId ?? null,
    failed: snap.failed ?? null,
    answer: answerEvidence(snap.messages ?? []),
  });
  if (!tabs) {
    runtime.events.on('change', () => {
      const snap = runtime.snapshot();
      const next = turnActive(snap);
      if (wasTurn && !next) emitTurn(turnPayload(snap));
      wasTurn = next;
    });
  }
  const changed = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      flushSnapshots();
    }, 40);
  };
  runtime.events.on('change', changed);
  tabs?.events.on('settled', info => emitTurn(info));
  let themeTimer;
  const refreshTheme = async () => {
    themeName = await savedThemeName();
    themeRev++;
    changed();
  };
  const watchers = [];
  for (const path of [join(agentDir, 'settings.json'), join(agentDir, 'themes')]) {
    try { watchers.push(watch(path, () => { clearTimeout(themeTimer); themeTimer = setTimeout(refreshTheme, 80); })); } catch {}
  }
  async function listThemeNames() {
    const names = new Set(['dark', 'light']);
    for (const dir of [join(agentDir, 'themes'), join(import.meta.dirname, 'themes')]) {
      try { for (const file of await readdir(dir)) if (file.endsWith('.json')) names.add(file.slice(0, -5)); } catch {}
    }
    try { for (const theme of runtime.session?.resourceLoader?.getThemes()?.themes ?? []) if (theme.name) names.add(theme.name); } catch {}
    const list = [...names].sort();
    // Automatic light/dark follows the device. This product does not: garden and night are chosen.
    if (!personal && names.has('light') && names.has('dark')) list.push('light/dark');
    return list;
  }
  async function savedThemeName() {
    try { const from = runtime.session?.settingsManager?.getThemeSetting?.(); if (from) return String(from); } catch {}
    try {
      const settings = JSON.parse(await readFile(join(agentDir, 'settings.json'), 'utf8'));
      if (settings.theme) {
        const named = String(settings.theme);
        if (personal && named.includes('/')) return 'garden';
        return named;
      }
    } catch {}
    return personal ? 'garden' : 'dark';
  }
  async function persistTheme(name) {
    const sm = runtime.session?.settingsManager;
    if (sm?.setTheme) { sm.setTheme(name); await sm.flush(); return; }
    let settings = {};
    try { settings = JSON.parse(await readFile(join(agentDir, 'settings.json'), 'utf8')); } catch {}
    settings.theme = name;
    await writeFile(join(agentDir, 'settings.json'), `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  }
  async function readSettingsFile() {
    try { return JSON.parse(await readFile(join(agentDir, 'settings.json'), 'utf8')); } catch { return {}; }
  }
  async function handleSettings(c) {
    try {
      return await runtime.command({ ...c, type: 'settings' });
    } catch (error) {
      const msg = error?.message ?? '';
      if (!/belongs to the terminal|Unsupported command/.test(msg)) throw error;
    }
    const settings = await readSettingsFile();
    if (!c.key) return { ...settingsView(settings), theme: settings.theme ?? themeName };
    const next = applySetting(settings, c.key, c.value);
    await writeFile(join(agentDir, 'settings.json'), `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    return { ...settingsView(next), theme: next.theme ?? themeName };
  }
  async function applyTheme(name, persist) {
    if (personal && String(name).includes('/')) throw new Error('Theme must be an explicit name');
    const names = await listThemeNames();
    if (!names.includes(name)) throw new Error(`Unknown theme: ${name}`);
    themeName = name;
    if (persist) await persistTheme(name);
    themeRev++;
    changed();
    return { theme: themeName, themeRev, saved: persist ? themeName : await savedThemeName() };
  }
  try { themeName = await savedThemeName(); } catch {}
  server.on('upgrade', (req, socket, head) => {
    let url;
    try { url = new URL(req.url, 'http://local'); } catch { socket.destroy(); return; }
    if (!validRequest(req) || url.search) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    if (url.pathname !== '/pi') { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    sockets.handleUpgrade(req, socket, head, ws => {
      clients.add(ws); send(ws, { type: 'snapshot', data: view(runtime.snapshot()) });
      ws.on('error', () => {});
      ws.on('close', () => { clients.delete(ws); changed(); }); // detach does NOT abort or dispose Pi
      ws.on('message', async raw => {
        let c;
        try {
          c = JSON.parse(raw.toString());
          if (!c || Array.isArray(c) || typeof c.type !== 'string' || typeof c.id !== 'string') throw new Error('Command requires string id and type');
          if (c.type === 'control-result') { waiting.get(c.id)?.(c); return; }
          if (c.type === 'hello') {
            ws.meta = {
              kind: c.kind === 'phone' ? 'phone' : 'desktop',
              width: Number(c.width) || 0, height: Number(c.height) || 0, dpr: Number(c.dpr) || 1,
              visible: c.visible === true,
              seen: Date.now(),
            };
            send(ws, { type: 'response', id: c.id, success: true, data: ws.meta }); changed(); return;
          }
          if (c.type === 'capture' || c.type === 'window-open' || c.type === 'window-close') {
            if (!personal) throw new Error('Not available in stock Guey');
            if (c.type === 'capture') {
              send(ws, { type: 'response', id: c.id, success: true, data: await capture(c) }); return;
            }
            send(ws, { type: 'response', id: c.id, success: true, data: await windowControl(c, c.type) }); return;
          }
          if (c.type === 'themes') {
            send(ws, { type: 'response', id: c.id, success: true, data: { names: await listThemeNames(), current: themeName, saved: await savedThemeName() } }); return;
          }
          if (c.type === 'theme') {
            if (typeof c.name !== 'string') throw new Error('Theme name must be text');
            send(ws, { type: 'response', id: c.id, success: true, data: await applyTheme(c.name, Boolean(c.persist)) }); return;
          }
          if (c.type === 'settings') {
            send(ws, { type: 'response', id: c.id, success: true, data: await handleSettings(c) }); return;
          }
          if (c.type === 'guey-restart') {
            send(ws, { type: 'response', id: c.id, success: true, data: { ok: true } });
            // systemd Restart=always respawns ExecStart from current/. Do not spawn
            // a laptop unit or a PATH node; those are the restore failures this product avoids.
            setTimeout(() => process.exit(0), 200);
            return;
          }
          if (c.type === 'tab-new' && !tabs && !runtime.snapshot()?.tabs) c = { ...c, type: 'new' };
          if (c.type === 'tab-focus' && !tabs && !runtime.snapshot()?.tabs) {
            send(ws, { type: 'response', id: c.id, success: true, data: { id: runtime.snapshot().sessionId, focused: true } }); return;
          }
          const snap = runtime.snapshot();
          const stale = staleCommandError(c, snap) || tabCloseBusyError(c, snap);
          if (stale) throw new Error(stale);
          const data = await runtime.command(c);
          send(ws, { type: 'response', id: c.id, success: true, data: c.type === 'snapshot' ? view(data) : data }); changed();
        } catch (e) { send(ws, { type: 'response', id: c?.id, success: false, error: e.message }); }
      });
    });
  });
  return {
    server, runtime, stateDir, sockets,
    listen: () => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => resolve(server.address())); }),
    async close() {
      clearTimeout(timer); clearTimeout(themeTimer); runtime.events.off('change', changed);
      for (const watcher of watchers) watcher.close();
      for (const ws of sockets.clients) ws.terminate();
      sockets.close();
      await new Promise(r => server.close(r));
      await (tabs ?? runtime).close(); await unlink(lockPath);
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const app = await createGueyServer({
    host: process.env.IMPERFECT_HOST,
    port: process.env.IMPERFECT_PORT ? Number(process.env.IMPERFECT_PORT) : undefined,
  });
  try { const address = await app.listen(); console.log(`GUEY native GUI: http://${address.address}:${address.port} (${app.stateDir})`); }
  catch (error) { await app.close(); throw error; }
  let closing = false;
  for (const signal of ['SIGTERM','SIGINT']) process.on(signal, async () => { if (closing) return; closing = true; await app.close(); process.exit(0); });
}
