// The image lab's routes.
//
// Kept out of server.mjs because the lab is one application with a dozen small
// verbs, and threading them through the main router would bury the machine's
// own surface under them. This exports one handler that answers a request or
// says it was not for the lab.
//
// Generation answers as a stream. A picture takes the better part of a minute,
// and the endpoint hands back frames while it draws; buffering those into one
// JSON reply at the end would throw away the only thing that makes the wait
// bearable. Everything else is a plain JSON verb.

import { generateImage, codexToken, CodexSignedOut, DEFAULT_MODEL } from './codex-images.mjs';
import { PinterestNotConfigured, PinterestSignedOut } from './pinterest.mjs';

const MAX_BODY = 1 << 20;
const MAX_IMPORT = 100;

const MAX_PIN_UPLOAD = 12 * 1024 * 1024;
const UPLOAD_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

// An image dropped onto the wall arrives as raw bytes with its type in the
// header, not as base64 in JSON: base64 is a third larger, and a 12MB picture
// through a 1MB JSON body is a limit nobody could explain to the person who
// just dragged a photograph in.
async function readImage(req) {
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (!UPLOAD_TYPES.has(type)) throw Object.assign(new Error('that is not an image this can keep'), { status: 415 });
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_PIN_UPLOAD) throw Object.assign(new Error('that image is too large to keep'), { status: 413 });
    chunks.push(chunk);
  }
  if (!size) throw Object.assign(new Error('that image was empty'), { status: 400 });
  return { image: Buffer.concat(chunks), type };
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error('body too large'), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('that was not JSON'), { status: 400 });
  }
}

// The address the person's browser is actually at. Behind the door's proxy the
// machine is loopback and knows nothing of its public name, so the request has
// to say. Origin is preferred because a browser sets it honestly; the
// forwarded headers are what a proxy adds; Host is the last resort.
function publicOrigin(req) {
  const origin = String(req.headers.origin || '').trim();
  if (/^https?:\/\/[^/]+$/.test(origin)) return origin;
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  if (!host) return '';
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim()
    || (req.socket?.encrypted ? 'https' : 'http');
  return `${proto}://${host}`;
}

function sendJson(res, value, status = 200) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

// One shape for every failure, so the page never has to guess. `signedOut` and
// `notConfigured` are carried through as flags rather than folded into the
// message, because the lab draws those two as an invitation and everything
// else as a problem.
function sendError(res, error) {
  const status = Number(error?.status) || 500;
  sendJson(res, {
    error: error?.message || 'something went wrong',
    signedOut: Boolean(error?.signedOut),
    notConfigured: Boolean(error?.notConfigured),
  }, status);
}

function sendImage(res, { body, type }, { immutable = false } = {}) {
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': body.length,
    // A picture's id is minted per picture and its bytes never change, so the
    // browser may keep it. Pins are the same.
    'Cache-Control': immutable ? 'private, max-age=31536000, immutable' : 'no-store',
  });
  res.end(body);
}

/**
 * @param lab        the library, from createImageLab
 * @param pinterest  the boards client, from createPinterest
 * @param agentDir   where Pi keeps the sign-in this borrows
 */
export function createLabRoutes({
  lab,
  pinterest,
  agentDir,
  model = DEFAULT_MODEL,
  // Injected so the routes can be proved without spending a subscription on
  // every test run. Production passes neither and gets the real engine.
  generate: draw = generateImage,
  token = codexToken,
}) {
  // What the prompt box needs to know before anybody types: is there a
  // subscription behind it. Cached briefly because every open of the lab asks,
  // and the answer costs a subprocess.
  let signedIn = null;
  let checkedAt = 0;
  const CHECK_TTL = 30_000;

  async function codexStatus({ force = false } = {}) {
    if (!force && signedIn && Date.now() - checkedAt < CHECK_TTL) return signedIn;
    try {
      const { plan } = await token({ agentDir });
      signedIn = { signedIn: true, plan };
    } catch (error) {
      if (!(error instanceof CodexSignedOut)) {
        // A real failure is not a sign-out and must not be cached as one --
        // a network blip would otherwise tell the person to log in again.
        return { signedIn: false, plan: '', error: error.message };
      }
      signedIn = { signedIn: false, plan: '', reason: error.message };
    }
    checkedAt = Date.now();
    return signedIn;
  }

  // Server-sent events. The page is same-origin and the connection is the
  // person's own machine, so there is no framing beyond what EventSource-style
  // parsing needs.
  function openStream(res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      // Nothing in this product proxies with buffering today, but a stream
      // that a future proxy silently buffers is a hang with no error.
      'X-Accel-Buffering': 'no',
    });
    return frame => {
      if (res.writableEnded) return;
      res.write(`data: ${JSON.stringify(frame)}\n\n`);
    };
  }

  async function generate(req, res) {
    const body = await readJson(req);
    const prompt = String(body.prompt ?? '').trim();
    const combine = Array.isArray(body.combine) ? body.combine.map(String).slice(0, 8) : [];
    const folder = String(body.folder ?? '');
    if (!prompt) { sendError(res, Object.assign(new Error('a picture needs a prompt'), { status: 400 })); return; }

    let references;
    try {
      references = await lab.referencePaths(combine);
    } catch (error) {
      sendError(res, error);
      return;
    }

    // The stream opens before the slow part starts, so the page can show it is
    // working from the first tick rather than after the first frame.
    const send = openStream(res);
    const abort = new AbortController();
    // A person who closes the window has stopped wanting the picture. Without
    // this the request runs to completion against their subscription and
    // writes a file nobody asked for any more.
    res.on('close', () => { if (!res.writableEnded) abort.abort(); });

    send({ type: 'started', combine: combine.length });
    try {
      const { image, revisedPrompt, note } = await draw({
        prompt,
        references,
        model,
        agentDir,
        signal: abort.signal,
        onPartial: b64 => send({ type: 'partial', image: b64 }),
      });
      const saved = await lab.savePicture({ image, prompt, references: combine, folder });
      send({ type: 'saved', picture: saved, revisedPrompt, note });
    } catch (error) {
      if (error.name === 'AbortError') { res.end(); return; }
      // The error travels in the stream, not as a status code: the headers
      // went out the moment the stream opened, so there is no status left to
      // set. The page reads `type` and draws accordingly.
      send({
        type: 'error',
        error: error.message || 'the drawing failed',
        signedOut: Boolean(error.signedOut),
      });
      if (error instanceof CodexSignedOut) { signedIn = null; checkedAt = 0; }
    }
    res.end();
  }

  // Importing a board is many fetches and many writes, so it streams too --
  // for the same reason generation does, and because a board of eighty pins
  // would otherwise be a minute of nothing.
  async function importBoard(req, res) {
    const body = await readJson(req);
    const remoteId = String(body.remoteId ?? '');
    const name = String(body.name ?? 'Board');
    const limit = Math.min(Number(body.limit) || 50, MAX_IMPORT);
    if (!remoteId) { sendError(res, Object.assign(new Error('no board named'), { status: 400 })); return; }

    const send = openStream(res);
    const abort = new AbortController();
    res.on('close', () => { if (!res.writableEnded) abort.abort(); });

    try {
      const board = await lab.createBoard({ name, source: 'pinterest', remoteId });
      send({ type: 'board', board });
      let cursor = '';
      let kept = 0;
      while (kept < limit && !abort.signal.aborted) {
        const page = await pinterest.pins({ remoteId, cursor, pageSize: Math.min(25, limit - kept) });
        if (!page.pins.length) break;
        for (const pin of page.pins) {
          if (kept >= limit || abort.signal.aborted) break;
          try {
            const { image, type } = await pinterest.fetchPinImage(pin.url);
            const saved = await lab.savePin({ image, type, board: board.id, note: pin.note, link: pin.link, remoteId: pin.remoteId });
            kept += 1;
            send({ type: 'pin', pin: saved, kept });
          } catch (error) {
            // One pin that will not come down must not end the import. The
            // board is still worth having without it.
            send({ type: 'skipped', reason: error.message });
          }
        }
        cursor = page.cursor;
        if (!cursor) break;
      }
      send({ type: 'done', kept });
    } catch (error) {
      send({ type: 'error', error: error.message, signedOut: Boolean(error.signedOut), notConfigured: Boolean(error.notConfigured) });
    }
    res.end();
  }

  // Inspiration that did not come from an API: dropped, pasted, or picked
  // from the person's own files. The lab needs this whatever else it grows,
  // because not every reference a person has is on a service.
  async function addPin(req, res) {
    const url = new URL(req.url, 'http://local');
    const { image, type } = await readImage(req);
    let board = url.searchParams.get('board') || '';
    if (!board) {
      // Dropping something before making a board is the normal first act, so
      // the shelf it lands on is made rather than demanded.
      const shelf = await lab.createBoard({ name: 'Dropped in', source: 'local', remoteId: 'local:dropped' });
      board = shelf.id;
    }
    sendJson(res, await lab.savePin({ image, type, board, note: String(url.searchParams.get('note') || '').slice(0, 120) }));
  }

  const posts = new Map([
    ['/lab/pin/add', addPin],
    ['/lab/generate', generate],
    ['/lab/pinterest/import', importBoard],
    ['/lab/folder/create', async (req, res) => sendJson(res, await lab.createFolder((await readJson(req)).name))],
    ['/lab/folder/rename', async (req, res) => { const b = await readJson(req); sendJson(res, await lab.renameFolder(b.id, b.name)); }],
    ['/lab/folder/delete', async (req, res) => sendJson(res, await lab.deleteFolder((await readJson(req)).id))],
    ['/lab/picture/move', async (req, res) => { const b = await readJson(req); sendJson(res, await lab.movePicture(b.id, b.folder)); }],
    ['/lab/picture/delete', async (req, res) => sendJson(res, await lab.deletePicture((await readJson(req)).id))],
    ['/lab/pin/delete', async (req, res) => sendJson(res, await lab.deletePin((await readJson(req)).id))],
    ['/lab/board/delete', async (req, res) => sendJson(res, await lab.deleteBoard((await readJson(req)).id))],
    ['/lab/pinterest/configure', async (req, res) => { const b = await readJson(req); sendJson(res, await pinterest.configure(b)); }],
    ['/lab/pinterest/disconnect', async (_req, res) => sendJson(res, await pinterest.disconnect())],
  ]);

  /**
   * Answer a lab request. Returns false when the path was not the lab's, so
   * the caller keeps looking.
   */
  return async function handleLab(req, res, path) {
    if (!path.startsWith('/lab/')) return false;

    if (req.method === 'POST') {
      const handler = posts.get(path);
      if (!handler) { sendError(res, Object.assign(new Error('no such lab action'), { status: 404 })); return true; }
      // The machine's own pages always send an origin. Requiring one keeps a
      // form on some other site from driving these verbs, which matters more
      // here than elsewhere because several of them delete things.
      if (!req.headers.origin) { sendError(res, Object.assign(new Error('exact origin required'), { status: 403 })); return true; }
      try { await handler(req, res); } catch (error) { if (!res.headersSent) sendError(res, error); else res.end(); }
      return true;
    }

    if (req.method !== 'GET') { sendError(res, Object.assign(new Error('not a lab method'), { status: 405 })); return true; }

    const url = new URL(req.url, 'http://local');
    try {
      if (path === '/lab/state') {
        const [contents, codex, pins] = await Promise.all([
          lab.library(),
          codexStatus(),
          pinterest.status(publicOrigin(req)).catch(() => ({ configured: false, connected: false })),
        ]);
        sendJson(res, { ...contents, codex, pinterest: pins, model });
        return true;
      }
      if (path === '/lab/picture') { sendImage(res, await lab.readPicture(url.searchParams.get('id')), { immutable: true }); return true; }
      if (path === '/lab/pin') { sendImage(res, await lab.readPin(url.searchParams.get('id')), { immutable: true }); return true; }
      if (path === '/lab/pinterest/authorize') { sendJson(res, { url: await pinterest.authorizeUrl(publicOrigin(req)) }); return true; }
      if (path === '/lab/pinterest/boards') { sendJson(res, await pinterest.boards({ cursor: url.searchParams.get('cursor') || '' })); return true; }
      if (path === '/lab/pinterest/callback') {
        // Pinterest returns the person here in their browser, so this answers
        // with a page rather than JSON -- and closes itself, because it opened
        // in a window they did not really want to be looking at.
        let message;
        try {
          await pinterest.connect({ code: url.searchParams.get('code'), state: url.searchParams.get('state') });
          message = 'Pinterest connected. You can close this.';
        } catch (error) {
          message = `Pinterest did not connect: ${error.message}`;
        }
        const safe = message.replace(/[<&>]/g, c => ({ '<': '&lt;', '&': '&amp;', '>': '&gt;' }[c]));
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(`<!doctype html><meta charset="utf-8"><title>Pinterest</title><body style="font:16px system-ui;padding:2rem"><p>${safe}</p><script>setTimeout(()=>window.close(),1500)</script>`);
        return true;
      }
    } catch (error) {
      if (error instanceof PinterestNotConfigured || error instanceof PinterestSignedOut) { sendError(res, error); return true; }
      sendError(res, error);
      return true;
    }

    sendError(res, Object.assign(new Error('no such lab page'), { status: 404 }));
    return true;
  };
}
