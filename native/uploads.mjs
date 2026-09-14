import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
import { mkdir, unlink, link } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { finished } from 'node:stream/promises';

// A phone has no filesystem the agent can reach. An attachment that is not an
// image therefore lands on disk first and enters the turn as a path, because a
// path is a thing every tool already knows how to open. `uploads/` sits in the
// session's own cwd for the same reason.
//
// Shared by both front doors: the native runtime owns its session and the live
// client watches a terminal's, but a file from the phone arrives the same way
// on either, and a second copy of this would drift.
export function absorbUploads(text, files, cwd) {
  if (!Array.isArray(files) || !files.length) return text;
  const dir = join(cwd, 'uploads');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let out = text;
  for (const file of files.slice(0, 8)) {
    if (!file?.name || typeof file.data !== 'string') continue;
    const name = String(file.name).replace(/^.*[/\\]/, '').replace(/[^\w.+-]+/g, '_') || 'file';
    const dest = join(dir, name);
    writeFileSync(dest, Buffer.from(file.data, 'base64'));
    out = `${out.trim()}\n\n[uploaded file: ${dest}]`.trim();
  }
  return out;
}

export const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;
// 1 GiB on a slow phone can outlast Node's 300s requestTimeout. Upload time is
// owned here; other routes keep a 300s body deadline of their own.
export const UPLOAD_TIMEOUT_MS = 30 * 60 * 1000;
export const OTHER_POST_TIMEOUT_MS = 300_000;

export function sanitizeUploadName(name) {
  const base = String(name ?? '').replace(/^.*[/\\]/, '').replace(/[^\w.+-]+/g, '_') || 'file';
  return base.slice(0, 180) || 'file';
}

export function filenameFromHeader(raw) {
  if (raw == null || raw === '') return 'file';
  const text = String(Array.isArray(raw) ? raw[0] : raw).replace(/[\r\n]/g, '');
  try { return decodeURIComponent(text); }
  catch { return text; }
}

export function uniqueUploadName(originalName, id = randomUUID()) {
  const safe = sanitizeUploadName(originalName);
  const ext = extname(safe);
  const stem = basename(safe, ext) || 'file';
  return `${stem}-${id}${ext}`;
}

function statusError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function createPartStream(path) {
  const stream = createWriteStream(path, { flags: 'wx', mode: 0o600 });
  let failed = null;
  let rejectFailure = () => {};
  const failure = new Promise((_, reject) => {
    rejectFailure = (error) => {
      if (failed) return;
      failed = error;
      reject(error);
    };
  });
  failure.catch(() => {});
  stream.on('error', rejectFailure);
  return {
    stream,
    failure,
    error: () => failed,
    async waitOpen() {
      await Promise.race([once(stream, 'open'), failure]);
      if (failed) throw failed;
    },
    async write(chunk) {
      if (failed) throw failed;
      if (!stream.write(chunk)) await Promise.race([once(stream, 'drain'), failure]);
      if (failed) throw failed;
    },
    async end() {
      if (failed) throw failed;
      stream.end();
      await Promise.race([finished(stream), failure]);
      if (failed) throw failed;
    },
    destroy() {
      stream.destroy();
    },
  };
}

export async function receiveHttpUpload(req, options = {}) {
  const cwd = options.cwd;
  const filename = options.filename ?? filenameFromHeader(req.headers?.['x-filename']);
  const maxBytes = options.maxBytes ?? MAX_UPLOAD_BYTES;
  const timeoutMs = options.timeoutMs ?? UPLOAD_TIMEOUT_MS;
  const declared = Number(req.headers?.['content-length']);
  if (Number.isFinite(declared) && declared > maxBytes) throw statusError(413, 'file too large');

  const dir = join(cwd, 'uploads');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const part = join(dir, `.upload-${randomUUID()}.part`);

  const res = options.res;
  let timedOut = false;
  let clientGone = false;
  const ac = new AbortController();
  const timer = setTimeout(() => {
    timedOut = true;
    ac.abort();
    if (res && !res.headersSent) res.writeHead(408).end('timeout');
    req.destroy?.();
  }, timeoutMs);
  const onAbort = () => { clientGone = true; ac.abort(); };
  req.once?.('aborted', onAbort);

  const out = createPartStream(part);
  try {
    await out.waitOpen();
    let written = 0;
    for await (const chunk of req) {
      if (ac.signal.aborted) break;
      if (out.error()) throw out.error();
      written += chunk.length;
      if (written > maxBytes) throw statusError(413, 'file too large');
      await out.write(chunk);
    }
    if (ac.signal.aborted) {
      throw timedOut ? statusError(408, 'timeout') : statusError(499, 'aborted');
    }
    if (out.error()) throw out.error();
    if (Number.isFinite(declared) && written !== declared) throw statusError(400, 'incomplete upload');
    await out.end();

    let lastExist = null;
    for (let attempt = 0; attempt < 8; attempt++) {
      const name = (attempt === 0 && options.uniqueName) ? options.uniqueName : uniqueUploadName(filename);
      const dest = join(dir, name);
      try {
        await link(part, dest);
        await unlink(part).catch(() => {});
        return { path: dest, name, originalName: sanitizeUploadName(filename), size: written };
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        lastExist = error;
      }
    }
    throw lastExist ?? statusError(500, 'upload name collision');
  } catch (error) {
    out.destroy();
    await unlink(part).catch(() => {});
    if (error.status) throw error;
    if (timedOut) throw statusError(408, 'timeout');
    if (clientGone || req.aborted || error.name === 'AbortError') throw statusError(499, 'aborted');
    throw error;
  } finally {
    clearTimeout(timer);
    req.off?.('aborted', onAbort);
  }
}
