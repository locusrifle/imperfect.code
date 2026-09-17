import { readdir, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';

export const WALLPAPER_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp']);

function safePart(value) {
  return typeof value === 'string' && value.length > 0 && value !== '.' && value !== '..' && !value.includes('/') && !value.includes('\\');
}

function labelFor(name) {
  return name.replace(/\.[^.]+$/, '').replace(/^\d+[-_]/, '').replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, letter => letter.toUpperCase());
}

export async function listWallpapers(root) {
  const base = resolve(root);
  let themes;
  try { themes = await readdir(base, { withFileTypes: true }); } catch { return []; }
  const rows = [];
  for (const theme of themes.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!safePart(theme.name)) continue;
    const backgrounds = join(base, theme.name, 'backgrounds');
    let files;
    try { files = await readdir(backgrounds, { withFileTypes: true }); } catch { continue; }
    for (const file of files.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!safePart(file.name) || !WALLPAPER_EXTENSIONS.has(extname(file.name).toLowerCase())) continue;
      const full = join(backgrounds, file.name);
      try { if (!(await stat(full)).isFile()) continue; } catch { continue; }
      rows.push({ id: `${theme.name}/${file.name}`, theme: theme.name, name: file.name, label: labelFor(file.name) });
    }
  }
  return rows;
}

export async function resolveWallpaper(root, theme, name) {
  if (!safePart(theme) || !safePart(name) || !WALLPAPER_EXTENSIONS.has(extname(name).toLowerCase())) return null;
  const base = resolve(root);
  const full = resolve(base, theme, 'backgrounds', name);
  const themeRoot = resolve(base, theme, 'backgrounds') + sep;
  if (!full.startsWith(themeRoot)) return null;
  try { return (await stat(full)).isFile() ? full : null; } catch { return null; }
}
