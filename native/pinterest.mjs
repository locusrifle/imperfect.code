// Pinterest boards as the lab's inspiration shelf.
//
// Two things about this are not obvious and shape the whole file.
//
// First, the product's own policy is `default-src 'self'`. A pin's image URL
// cannot be drawn in the page, ever. So every board this pulls is copied onto
// the machine as files; nothing here hands a remote address to a browser.
// That is not a workaround, it is the right answer anyway -- a board of other
// people's URLs stops being a board the day those URLs rot.
//
// Second, the app credentials belong to whoever installed this machine, and
// the access token belongs to the person using it. Neither is ours and neither
// goes in the repository. Both live in the lab's own directory under the
// workspace, mode 600, beside the pictures they fetched.

import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

const AUTH_URL = 'https://www.pinterest.com/oauth/';
const API = 'https://api.pinterest.com/v5';
const STORE = 'pinterest.json';
// Reading boards and the pins on them. Nothing here writes to the person's
// Pinterest account, and asking for a scope that could would be asking for
// authority the lab has no use for.
const SCOPES = 'boards:read,pins:read';

// A pin image is fetched from Pinterest's CDN, not from the API, so a runaway
// response has to be bounded here rather than trusted.
const MAX_PIN_BYTES = 12 * 1024 * 1024;
const PIN_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

function bad(status, message) {
  return Object.assign(new Error(message), { status });
}

export class PinterestNotConfigured extends Error {
  constructor(message = 'no Pinterest app is configured on this machine') {
    super(message);
    this.name = 'PinterestNotConfigured';
    this.status = 503;
    this.notConfigured = true;
  }
}

export class PinterestSignedOut extends Error {
  constructor(message = 'Pinterest is not connected on this machine') {
    super(message);
    this.name = 'PinterestSignedOut';
    this.status = 503;
    this.signedOut = true;
  }
}

/**
 * Pinterest for one machine.
 *
 * `redirectUri` must match the one registered on the Pinterest app exactly,
 * including scheme and trailing path. Pinterest rejects a mismatch with an
 * error that does not say which half is wrong, so the lab shows the value it
 * used and lets the person compare.
 */
export function createPinterest({ root, redirectUri = '', fetchImpl = fetch }) {
  const storePath = join(root, STORE);

  // A machine does not know its own public address. `origins` is empty on a
  // real installation -- the public name belongs to the door's proxy, not to
  // the loopback app -- so a redirect derived from configuration alone is the
  // empty string on every machine that matters. The browser pressing Connect
  // *is* at the public address, so that request is the one thing that knows.
  // A configured value still wins when there is one, and a caller that offers
  // nothing falls back to it.
  function redirectFor(origin) {
    const from = String(origin || '').trim().replace(/\/$/, '');
    if (from) return `${from}/lab/pinterest/callback`;
    return redirectUri;
  }

  async function readStore() {
    try { return JSON.parse(await readFile(storePath, 'utf8')); } catch { return {}; }
  }

  async function writeStore(data) {
    const temporary = `${storePath}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(data, null, 2), { mode: 0o600 });
    await rename(temporary, storePath);
  }

  /** What the lab shows about the connection, with no secret in it. */
  async function status(origin = '') {
    const store = await readStore();
    return {
      configured: Boolean(store.appId && store.appSecret),
      connected: Boolean(store.access),
      // Shown so a person debugging a redirect mismatch can see both halves.
      // This is the value that would actually be sent, not a stored guess.
      redirectUri: redirectFor(origin),
      expires: store.expires || 0,
    };
  }

  /** Record the app credentials. Replaces any previous app outright. */
  async function configure({ appId, appSecret }) {
    const id = String(appId ?? '').trim();
    const secret = String(appSecret ?? '').trim();
    if (!id || !secret) throw bad(400, 'a Pinterest app id and secret are both required');
    // Connecting a different app invalidates any token minted by the old one,
    // so the token goes rather than lingering as a confusing half-state.
    await writeStore({ appId: id, appSecret: secret });
    return status();
  }

  async function disconnect() {
    await rm(storePath, { force: true });
    return status();
  }

  async function credentials() {
    const store = await readStore();
    if (!store.appId || !store.appSecret) throw new PinterestNotConfigured();
    return store;
  }

  /** Where to send the person to approve the connection. */
  async function authorizeUrl(origin = '') {
    const store = await credentials();
    const redirect = redirectFor(origin);
    if (!redirect) throw bad(500, 'this machine has no address to return to after Pinterest');
    // Kept so the callback can prove the code came back from the request this
    // machine started, rather than from somebody else's page. The redirect is
    // kept with it because Pinterest requires the token exchange to repeat the
    // exact value the authorization used, and by then the request that knew it
    // is long gone.
    const state = crypto.randomUUID();
    await writeStore({ ...store, state, redirect });
    const url = new URL(AUTH_URL);
    url.searchParams.set('client_id', store.appId);
    url.searchParams.set('redirect_uri', redirect);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', SCOPES);
    url.searchParams.set('state', state);
    return url.toString();
  }

  function basicAuth(store) {
    return `Basic ${Buffer.from(`${store.appId}:${store.appSecret}`).toString('base64')}`;
  }

  async function tokenRequest(store, body) {
    const response = await fetchImpl(`${API}/oauth/token`, {
      method: 'POST',
      headers: { Authorization: basicAuth(store), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw bad(502, `Pinterest refused the token request (${response.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`);
    }
    const json = await response.json();
    if (!json?.access_token) throw bad(502, 'Pinterest returned no access token');
    return {
      access: json.access_token,
      refresh: json.refresh_token || store.refresh || '',
      expires: Date.now() + (Number(json.expires_in) || 0) * 1000,
    };
  }

  /** Finish the approval Pinterest sent back. */
  async function connect({ code, state }) {
    const store = await credentials();
    if (!code) throw bad(400, 'Pinterest sent no code back');
    // An unsolicited callback is refused. Without this, a link somebody else
    // crafted could attach their Pinterest account to this person's lab.
    if (!store.state || state !== store.state) throw bad(400, 'that Pinterest approval did not come from this machine');
    const tokens = await tokenRequest(store, {
      grant_type: 'authorization_code',
      code,
      // The same value the authorization carried, not one recomputed now:
      // Pinterest compares them and the callback request may not look like the
      // one that started this.
      redirect_uri: store.redirect || redirectUri,
    });
    await writeStore({ ...store, ...tokens, state: undefined, redirect: undefined });
    return status();
  }

  // Refreshed a minute early, for the same reason the Codex token is: a token
  // that expires between the check and the call fails work already underway.
  async function accessToken() {
    const store = await credentials();
    if (!store.access && !store.refresh) throw new PinterestSignedOut();
    if (store.access && Number(store.expires || 0) > Date.now() + 60_000) return store.access;
    if (!store.refresh) throw new PinterestSignedOut('the Pinterest connection expired; connect it again');
    let tokens;
    try {
      tokens = await tokenRequest(store, { grant_type: 'refresh_token', refresh_token: store.refresh });
    } catch (error) {
      if (error.status === 502) throw new PinterestSignedOut('the Pinterest connection expired; connect it again');
      throw error;
    }
    await writeStore({ ...store, ...tokens });
    return tokens.access;
  }

  async function call(path, params = {}) {
    const token = await accessToken();
    const url = new URL(`${API}${path}`);
    for (const [key, value] of Object.entries(params)) if (value) url.searchParams.set(key, value);
    const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } });
    if (response.status === 401) throw new PinterestSignedOut('Pinterest refused the connection; connect it again');
    if (response.status === 429) throw bad(429, 'Pinterest is rate limiting this machine; try again shortly');
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw bad(502, `Pinterest refused the request (${response.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`);
    }
    return response.json();
  }

  /** The person's boards, newest first as Pinterest returns them. */
  async function boards({ cursor = '', pageSize = 25 } = {}) {
    const json = await call('/boards', { bookmark: cursor, page_size: String(pageSize) });
    return {
      boards: (json.items || []).map(item => ({
        remoteId: String(item.id),
        name: item.name || 'Board',
        description: item.description || '',
        pinCount: Number(item.pin_count || 0),
      })),
      cursor: json.bookmark || '',
    };
  }

  // Pinterest offers each pin at several sizes. The largest is wanted: this is
  // a reference image for generation, and an upscaled thumbnail carries less
  // for the model to work from.
  function bestImage(pin) {
    const images = pin?.media?.images || {};
    let best = null;
    for (const [name, image] of Object.entries(images)) {
      if (!image?.url) continue;
      const width = Number(image.width) || Number(String(name).split('x')[0]) || 0;
      if (!best || width > best.width) best = { url: image.url, width };
    }
    return best;
  }

  /** The pins on one board, as addresses to fetch. */
  async function pins({ remoteId, cursor = '', pageSize = 25 }) {
    if (!remoteId) throw bad(400, 'no board named');
    const json = await call(`/boards/${encodeURIComponent(remoteId)}/pins`, { bookmark: cursor, page_size: String(pageSize) });
    const items = [];
    for (const pin of json.items || []) {
      const image = bestImage(pin);
      if (!image) continue;
      items.push({
        remoteId: String(pin.id),
        url: image.url,
        note: pin.title || pin.alt_text || '',
        link: pin.link || '',
      });
    }
    return { pins: items, cursor: json.bookmark || '' };
  }

  /**
   * Fetch one pin's bytes.
   *
   * Only Pinterest's own image hosts are followed. The URL comes from an API
   * response rather than from a person, but this process sits inside the
   * machine and a fetch it performs is the machine's own reach -- so the host
   * is checked rather than assumed.
   */
  async function fetchPinImage(url) {
    let parsed;
    try { parsed = new URL(url); } catch { throw bad(400, 'not a pin address'); }
    if (parsed.protocol !== 'https:') throw bad(400, 'a pin must come over https');
    if (!/(^|\.)pinimg\.com$/.test(parsed.hostname) && !/(^|\.)pinterest\.com$/.test(parsed.hostname)) {
      throw bad(400, 'that address is not Pinterest');
    }
    const response = await fetchImpl(parsed, { redirect: 'follow' });
    if (!response.ok) throw bad(502, `could not fetch that pin (${response.status})`);
    const type = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!PIN_TYPES.has(type)) throw bad(415, 'that pin is not an image this can keep');
    const declared = Number(response.headers.get('content-length') || 0);
    if (declared > MAX_PIN_BYTES) throw bad(413, 'that pin is too large to keep');
    const body = Buffer.from(await response.arrayBuffer());
    // Checked again after reading: content-length is a claim, not a promise.
    if (body.byteLength > MAX_PIN_BYTES) throw bad(413, 'that pin is too large to keep');
    return { image: body, type };
  }

  return { status, configure, disconnect, authorizeUrl, connect, boards, pins, fetchPinImage };
}
