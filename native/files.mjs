// The files app: a machine's filesystem as one of the phone's applications.
//
// Read-only on purpose. This process runs as the machine's own user, so a write
// path here is machine authority handed to a tap; browsing and opening is the
// whole need the phone actually has.
//
// The root is given by the caller rather than assumed to be home. On a laptop
// the two are the same thing. On a hosted machine they are emphatically not:
// that home directory can hold the control plane's secrets, and a file browser
// rooted there would hand them to anyone who reached the app. A caller that
// says nothing gets the narrower answer, because the failure that matters is
// the one where somebody forgets.

import { readdir, stat, readFile, realpath } from 'node:fs/promises';
import { join, resolve, sep, basename, extname } from 'node:path';

const MAX_ENTRIES = 2000;
const MAX_TEXT = 512 * 1024;

const TYPES = new Map([
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'], ['.webp', 'image/webp'], ['.avif', 'image/avif'],
  ['.svg', 'image/svg+xml'], ['.mp4', 'video/mp4'], ['.webm', 'video/webm'],
  ['.mov', 'video/quicktime'], ['.m4v', 'video/mp4'], ['.mp3', 'audio/mpeg'],
  ['.m4a', 'audio/mp4'], ['.ogg', 'audio/ogg'], ['.opus', 'audio/ogg'],
  ['.wav', 'audio/wav'], ['.flac', 'audio/flac'], ['.pdf', 'application/pdf'],
]);

function bad(status, message) {
  return Object.assign(new Error(message), { status });
}

export function fileKind(name) {
  const type = TYPES.get(extname(name).toLowerCase()) ?? '';
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('audio/')) return 'audio';
  if (type === 'application/pdf') return 'pdf';
  if (/\.(txt|md|json|jsonl|csv|log|xml|ya?ml|toml|ini|conf|mjs|cjs|js|ts|tsx|jsx|css|html|sh|py|lua|rs|go|c|h|sql)$/i.test(name)) return 'text';
  return 'other';
}

export function contentType(name) {
  return TYPES.get(extname(name).toLowerCase()) ?? (fileKind(name) === 'text' ? 'text/plain' : 'application/octet-stream');
}

export function createFiles({ root }) {
  const ROOT = resolve(root);

  // A request path is always relative to the root and never escapes it, symlinks
  // included: the real path is checked after resolution, not the spelling.
  async function resolveInside(relative) {
  const wanted = String(relative ?? '').replace(/^\/+/, '');
  const full = resolve(ROOT, wanted);
  if (full !== ROOT && !full.startsWith(ROOT + sep)) throw bad(403, 'outside the root');
  let real;
  try { real = await realpath(full); }
  catch { throw bad(404, 'not found'); }
  if (real !== ROOT && !real.startsWith(ROOT + sep)) throw bad(403, 'outside the root');
  return real;
}

  function toRelative(full) {
  if (full === ROOT) return '';
  return full.slice(ROOT.length + 1);
}

  async function listDirectory(relative) {
  const full = await resolveInside(relative);
  const info = await stat(full);
  if (!info.isDirectory()) throw bad(400, 'not a directory');
  const raw = await readdir(full, { withFileTypes: true });
  const entries = [];
  for (const item of raw.slice(0, MAX_ENTRIES)) {
    const name = item.name;
    let directory = item.isDirectory();
    let size = null;
    let modified = null;
    try {
      const child = await stat(join(full, name));
      directory = child.isDirectory();
      size = directory ? null : child.size;
      modified = child.mtime.toISOString();
    } catch { continue; }
    entries.push({
      name,
      path: toRelative(join(full, name)),
      directory,
      hidden: name.startsWith('.'),
      size,
      modified,
      kind: directory ? 'directory' : fileKind(name),
    });
  }
  // Everything ordinary first, directories ahead of files within each group, and
  // dotfiles last. Sorting directories first overall buried a home directory's
  // actual files under thirty hidden config directories.
  entries.sort((a, b) => (
    Number(a.hidden) - Number(b.hidden)
    || Number(b.directory) - Number(a.directory)
    || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
  ));
  return {
    path: toRelative(full),
    name: full === ROOT ? '~' : basename(full),
    parent: full === ROOT ? null : toRelative(resolve(full, '..')),
    truncated: raw.length > MAX_ENTRIES,
    entries,
  };
}

  async function readTextFile(relative) {
  const full = await resolveInside(relative);
  const info = await stat(full);
  if (info.isDirectory()) throw bad(400, 'not a file');
  if (info.size > MAX_TEXT) throw bad(413, 'too large to read');
  return { path: toRelative(full), name: basename(full), text: await readFile(full, 'utf8') };
}

  async function openFile(relative) {
  const full = await resolveInside(relative);
  const info = await stat(full);
  if (info.isDirectory()) throw bad(400, 'not a file');
  return { full, name: basename(full), size: info.size, mtime: info.mtime, type: contentType(full) };
}

  return { root: ROOT, resolveInside, toRelative, listDirectory, readTextFile, openFile };
}
