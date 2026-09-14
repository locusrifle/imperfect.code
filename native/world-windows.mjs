export const WINDOW_KINDS = Object.freeze(['video', 'image', 'text', 'page']);
export const MAX_WINDOWS = 8;
export const MAX_TITLE = 80;
export const MAX_TEXT = 8000;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const MEDIA_RE = /^\/content\/media\/[a-f0-9]{16}\/[a-f0-9]{16}$/;
// `page` is the empty container: any page this application serves can be
// manifested in a window, which is how another web project arrives without a
// new window kind. Same-origin in-app paths only, and no traversal.
const PAGE_RE = /^\/[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*\.html$/;

function bad(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

export function sanitizeWorldWindow(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw bad(400, 'window required');
  const kind = String(raw.kind || '').trim();
  if (!WINDOW_KINDS.includes(kind)) throw bad(400, 'window kind must be video, image, text, or page');
  const title = String(raw.title ?? kind).replace(/[\r\n]/g, ' ').slice(0, MAX_TITLE).trim() || kind;
  let id = String(raw.id ?? (kind === 'page' ? 'antiburn' : '')).trim().toLowerCase();
  if (!id) id = `w-${Date.now().toString(16).slice(-8)}`;
  if (!ID_RE.test(id)) throw bad(400, 'invalid window id');
  if (kind === 'text') {
    if (raw.src) throw bad(400, 'text windows have no src');
    const text = String(raw.text ?? '').slice(0, MAX_TEXT);
    return { id, kind, title, text };
  }
  if (kind === 'page') {
    const src = String(raw.src ?? '/antiburn.html').trim();
    if (!PAGE_RE.test(src) || src.includes('..')) throw bad(400, 'page src must be an in-app .html path');
    if (raw.text) throw bad(400, 'page windows have no text');
    return { id, kind, title, src };
  }
  const src = String(raw.src ?? '').trim();
  if (!MEDIA_RE.test(src)) throw bad(400, 'src must be an in-app /content/media asset');
  if (raw.text) throw bad(400, `${kind} windows have no text`);
  return { id, kind, title, src };
}

export function applyWorldWindow(list, spec) {
  const next = sanitizeWorldWindow(spec);
  const without = (Array.isArray(list) ? list : []).filter(item => item.id !== next.id);
  if (without.length >= MAX_WINDOWS) throw bad(400, 'too many windows');
  return [...without, next];
}

export function closeWorldWindow(list, id) {
  const want = String(id ?? '').trim().toLowerCase();
  if (!want || !ID_RE.test(want)) throw bad(400, 'window id required');
  return (Array.isArray(list) ? list : []).filter(item => item.id !== want);
}
