import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STOCK_THEME, validateThemeDocument } from './customization.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const builtin = join(here, '../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme');
const packaged = join(here, '../themes');

function ansi256(n) {
  if (n < 16) {
    return ['#000000', '#aa0000', '#00aa00', '#aa5500', '#0000aa', '#aa00aa', '#00aaaa', '#aaaaaa',
      '#555555', '#ff5555', '#55ff55', '#ffff55', '#5555ff', '#ff55ff', '#55ffff', '#ffffff'][n];
  }
  if (n >= 232) {
    const v = (8 + (n - 232) * 10).toString(16).padStart(2, '0');
    return `#${v}${v}${v}`;
  }
  const x = n - 16;
  const conv = c => (c ? (55 + c * 40).toString(16).padStart(2, '0') : '00');
  return `#${conv(Math.floor(x / 36))}${conv(Math.floor((x % 36) / 6))}${conv(x % 6)}`;
}

function paint(value, vars, seen = new Set()) {
  if (value === '' || value == null) return paint(vars.text, vars, seen) || '#d4d4d4';
  if (typeof value === 'number') return ansi256(value);
  if (typeof value === 'string' && vars[value] && !seen.has(value)) {
    seen.add(value);
    return paint(vars[value], vars, seen);
  }
  return String(value);
}

async function loadTheme(name, agentDir) {
  const wanted = String(name || '').includes('/') ? STOCK_THEME : (name || STOCK_THEME);
  const paths = [
    join(agentDir, 'themes', `${wanted}.json`),
    join(packaged, `${wanted}.json`),
    join(packaged, `${STOCK_THEME}.json`),
    join(builtin, `${wanted}.json`),
    join(builtin, 'dark.json'),
  ];
  for (const path of paths) {
    try {
      const theme = JSON.parse(await readFile(path, 'utf8'));
      if (!validateThemeDocument(theme, wanted.endsWith('.json') ? wanted.slice(0, -5) : undefined).ok) continue;
      if (theme?.colors) return theme;
    } catch {}
  }
  throw new Error('no TUI theme');
}

function darkPage(hex) {
  const n = Number.parseInt(String(hex).replace('#', ''), 16);
  if (!Number.isFinite(n)) return true;
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return (r * 299 + g * 587 + b * 114) / 1000 < 140;
}

function rootBlock(theme) {
  const vars = theme.vars ?? {};
  const extra = theme.export ?? {};
  const pageBg = extra.pageBg ?? '#18181e';
  const lines = [':root {'];
  lines.push(`  color-scheme: ${darkPage(pageBg) ? 'dark' : 'light'};`);
  for (const [key, value] of Object.entries(theme.colors)) {
    lines.push(`  --tui-${key}: ${paint(value, vars)};`);
  }
  lines.push(`  --tui-pageBg: ${pageBg};`);
  lines.push(`  --tui-cardBg: ${extra.cardBg ?? extra.pageBg ?? '#1e1e24'};`);
  lines.push('}');
  return lines.join('\n');
}

export async function tuiThemeCss(themeName = STOCK_THEME, agentDir = join(homedir(), '.pi/agent')) {
  const raw = String(themeName || STOCK_THEME);
  // Explicit names only. A light/dark pair would follow the OS; this product does not.
  const name = raw.includes('/') ? STOCK_THEME : raw;
  return rootBlock(await loadTheme(name, agentDir));
}
