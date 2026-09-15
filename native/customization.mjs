// User-owned appearance and app registration. Lives under data/, never in a release.
// Invalid files stay on disk; the product falls back to stock UI.
import { readFile, readdir, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { APP_TYPES, listApps as listWorkspaceHtmlApps, resolveAppFile } from './apps.mjs';

export const THEME_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const UI_FILES = Object.freeze(['harness.css', 'desktop.css']);
export const STOCK_THEME = 'garden';

const FORBIDDEN_THEME_KEYS = new Set(['exec', 'command', 'script', 'eval', 'module', 'handler', 'server']);
const CSS_DANGER = /@import|expression\s*\(|javascript\s*:|url\s*\(\s*['"]?\s*(https?:|\/\/|file:|data:)/i;

export function customizationRoots({ agentDir, workspace, uiDir } = {}) {
  const agent = agentDir ? resolve(agentDir) : null;
  const data = agent ? resolve(agent, '..') : null;
  return {
    themes: agent ? join(agent, 'themes') : null,
    ui: uiDir ? resolve(uiDir) : (data ? join(data, 'ui') : null),
    apps: workspace ? join(resolve(workspace), 'apps') : null,
  };
}

export function validateThemeDocument(raw, name) {
  if (name && !THEME_NAME_RE.test(name)) return { ok: false, reason: 'theme name' };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'not an object' };
  for (const key of Object.keys(raw)) {
    if (FORBIDDEN_THEME_KEYS.has(key)) return { ok: false, reason: `forbidden key ${key}` };
  }
  if (!raw.colors || typeof raw.colors !== 'object' || Array.isArray(raw.colors)) {
    return { ok: false, reason: 'missing colors' };
  }
  return { ok: true, theme: raw };
}

export function validateOverlayCss(text) {
  const body = String(text ?? '');
  if (body.length > 200_000) return { ok: false, reason: 'too large' };
  if (CSS_DANGER.test(body)) return { ok: false, reason: 'unsafe css' };
  return { ok: true, css: body };
}

export function resolveUiFile(uiRoot, urlPath) {
  if (!uiRoot || typeof urlPath !== 'string') return null;
  if (urlPath.includes('\0') || urlPath.includes('..') || urlPath.includes('\\')) return null;
  const name = urlPath === '/custom/ui.css' ? null : urlPath.replace(/^\/custom\//, '');
  if (name && !UI_FILES.includes(name)) return null;
  const root = resolve(uiRoot);
  if (name) {
    const full = resolve(root, name);
    if (full !== root && !full.startsWith(root + sep)) return null;
    return { full, name };
  }
  return { full: root, name: null };
}

export async function loadOverlayCss(uiRoot) {
  const root = uiRoot ? resolve(uiRoot) : null;
  if (!root) return { css: '/* stock ui */\n', fallback: true, skipped: [] };
  const parts = [];
  const skipped = [];
  for (const name of UI_FILES) {
    const full = join(root, name);
    let text;
    try { text = await readFile(full, 'utf8'); }
    catch { continue; }
    const check = validateOverlayCss(text);
    if (!check.ok) {
      skipped.push({ name, reason: check.reason, kept: full });
      continue;
    }
    parts.push(`/* ${name} */\n${check.css}`);
  }
  if (!parts.length) return { css: '/* stock ui */\n', fallback: true, skipped };
  return { css: `${parts.join('\n')}\n`, fallback: Boolean(skipped.length), skipped };
}

export async function loadUserTheme(agentDir, name) {
  if (!THEME_NAME_RE.test(name)) return { ok: false, reason: 'theme name' };
  const full = join(resolve(agentDir), 'themes', `${name}.json`);
  let text;
  try { text = await readFile(full, 'utf8'); }
  catch { return { ok: false, reason: 'missing', kept: full }; }
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { return { ok: false, reason: 'invalid json', kept: full }; }
  const check = validateThemeDocument(parsed, name);
  if (!check.ok) return { ...check, kept: full };
  return { ok: true, theme: check.theme, path: full };
}

export function registerAppsFromManifest(raw, workspace) {
  if (raw == null) return { apps: [], skipped: [] };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { apps: [], skipped: [{ reason: 'manifest not an object' }] };
  }
  if (raw.exec || raw.command || raw.server || raw.handler) {
    return { apps: [], skipped: [{ reason: 'server execution is not allowed from app registration' }] };
  }
  const list = Array.isArray(raw.apps) ? raw.apps : [];
  const apps = [];
  const skipped = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') { skipped.push({ reason: 'entry' }); continue; }
    if (item.exec || item.command || item.server || item.handler) {
      skipped.push({ id: item.id, reason: 'server execution is not allowed from app registration' });
      continue;
    }
    const id = String(item.id || '');
    const src = String(item.src || `/apps/${id}.html`);
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(id)) { skipped.push({ id, reason: 'id' }); continue; }
    if (!src.startsWith('/apps/') || src.includes('..') || src.includes('\\')) {
      skipped.push({ id, reason: 'src' }); continue;
    }
    if (!resolveAppFile(workspace, src)) { skipped.push({ id, reason: 'src' }); continue; }
    apps.push({
      id,
      title: typeof item.title === 'string' && item.title.trim() ? item.title.trim().slice(0, 64) : id,
      note: 'on this computer',
      src,
    });
  }
  return { apps, skipped };
}

export async function listRegisteredApps(workspace) {
  const html = await listWorkspaceHtmlApps(workspace);
  const byId = new Map(html.map(app => [app.id, app]));
  const skipped = [];
  const manifestPath = join(resolve(workspace), 'apps', 'apps.json');
  try {
    const parsed = JSON.parse(await readFile(manifestPath, 'utf8'));
    const extra = registerAppsFromManifest(parsed, workspace);
    skipped.push(...extra.skipped);
    for (const app of extra.apps) {
      if (byId.has(app.id)) byId.set(app.id, { ...byId.get(app.id), ...app });
      else {
        try {
          const file = resolveAppFile(workspace, app.src);
          if (file && (await stat(file.full)).isFile()) byId.set(app.id, app);
          else skipped.push({ id: app.id, reason: 'missing file', kept: manifestPath });
        } catch {
          skipped.push({ id: app.id, reason: 'missing file', kept: manifestPath });
        }
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') skipped.push({ reason: 'invalid json', kept: manifestPath });
  }
  return { apps: [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)), skipped };
}

export { APP_TYPES, listWorkspaceHtmlApps, resolveAppFile };

export async function listThemeFileNames(dir) {
  let names;
  try { names = await readdir(dir); }
  catch { return []; }
  return names.filter(name => name.endsWith('.json') && THEME_NAME_RE.test(name.slice(0, -5)));
}
