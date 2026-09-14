// Workspace pages the shell can frame. Product pages stay in native/public;
// a person's apps live under <workspace>/apps and are served at /apps/.
import { readdir, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';

export const APP_TYPES = Object.freeze({
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
});

const ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function resolveAppFile(workspace, urlPath) {
  if (typeof urlPath !== 'string' || !urlPath.startsWith('/apps/')) return null;
  if (urlPath.includes('\0') || urlPath.includes('\\') || urlPath.includes('..')) return null;
  const type = APP_TYPES[extname(urlPath).toLowerCase()];
  if (!type) return null;
  const root = resolve(workspace, 'apps');
  const full = resolve(workspace, urlPath.slice(1));
  if (full !== root && !full.startsWith(root + sep)) return null;
  return { full, type };
}

export async function listApps(workspace) {
  const dir = join(resolve(workspace), 'apps');
  let names;
  try { names = await readdir(dir); }
  catch { return []; }
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.html')) continue;
    const id = name.slice(0, -5);
    if (!ID_RE.test(id)) continue;
    try {
      if (!(await stat(join(dir, name))).isFile()) continue;
    } catch { continue; }
    out.push({ id, title: id, note: 'on this computer', src: `/apps/${name}` });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}
