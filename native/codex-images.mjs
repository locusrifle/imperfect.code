// Image generation on the person's own ChatGPT subscription.
//
// Pi already ships "ChatGPT Plus/Pro (Codex)" as a login provider, and OpenAI
// endorses third-party harnesses using it. So the credential this needs is one
// the machine already has, put there by `/login` and refreshed by Pi: there is
// no API key to ask for, no key of ours to ship, and nothing here to keep
// secret. A machine whose person never signed in has no token, and this module
// says so plainly rather than inventing a fallback.
//
// The Codex CLI is deliberately NOT in this path. Shelling out to it would add
// a binary to install on every machine, a second login to keep alive, and a
// PNG on disk to go hunting for. The endpoint Codex itself calls is the same
// one reachable from here with the token Pi is already holding.
//
// Images arrive in pieces. The endpoint emits partial frames while the picture
// is still being drawn, and `onPartial` forwards them, because the alternative
// is a surface that shows nothing for a minute -- which this product has
// already learned once, in the app drawer, reads as broken rather than busy.

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROVIDER = 'openai-codex';
const RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';

// The subscription endpoint refuses coding-model names outright ("not
// supported when using Codex with a ChatGPT account"), so the default here is
// one a ChatGPT account actually answers for. Overridable, because the
// catalogue moves faster than this file does.
export const DEFAULT_MODEL = 'gpt-6-astra';

// A reference image goes up inline. Anything bigger than this is refused
// rather than sent, because the failure mode of an oversized request is a
// timeout that looks like a hang.
const MAX_REFERENCE_BYTES = 8 * 1024 * 1024;
const MAX_REFERENCES = 8;
// How many times the picture resolves on the way in. Three is the endpoint's
// ceiling; each one is a full-size frame, so this is bandwidth spent on
// letting somebody watch their idea arrive.
const PARTIAL_FRAMES = 3;
const REFERENCE_TYPES = new Map([
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'], ['.gif', 'image/gif'],
]);

export class CodexImageError extends Error {
  constructor(message, { status = 502, cause } = {}) {
    super(message);
    this.name = 'CodexImageError';
    this.status = status;
    if (cause) this.cause = cause;
  }
}

// Signed out is a different answer from broken, and the lab draws it
// differently: boards still work, the prompt box explains itself. Callers
// check `signedOut` rather than matching on message text.
export class CodexSignedOut extends CodexImageError {
  constructor(message = 'no ChatGPT subscription is signed in on this machine') {
    super(message, { status: 503 });
    this.name = 'CodexSignedOut';
    this.signedOut = true;
  }
}

// The token is fetched by asking Pi for it, not by reading auth.json.
//
// `pi auth print-bearer-token` refreshes an expired token itself, under the
// same file lock Pi's own turns take. That is the whole reason this is a
// subprocess rather than three lines of fetch: a refresh token is single-use,
// and a second writer racing Pi would eventually spend one twice and sign the
// person out of their own machine. Nothing here writes to the sign-in store.
//
// The CLI is resolved through the dependency rather than PATH, because the
// machine runs this as its own system user and `pi` is not on that PATH.
const PI_CLI = fileURLToPath(new URL('../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js', import.meta.url));
const TOKEN_TIMEOUT_MS = 60_000;

function runPi(args, { agentDir, signal }) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1' };
    if (agentDir) env.PI_CODING_AGENT_DIR = agentDir;
    execFile(process.execPath, [PI_CLI, ...args], { env, signal, timeout: TOKEN_TIMEOUT_MS, maxBuffer: 1 << 20 }, (error, stdout, stderr) => {
      if (error) {
        error.stderr = String(stderr || '');
        reject(error);
        return;
      }
      resolve(String(stdout || '').trim());
    });
  });
}

// A JWT's claims are readable by anyone holding it and carry no extra
// authority. Reading them here saves opening the sign-in store at all: the
// account id the endpoint wants, and the plan name worth showing a person who
// is wondering whether they are signed in, are both already in the token.
export function describeToken(access) {
  try {
    const claims = JSON.parse(Buffer.from(String(access).split('.')[1], 'base64url').toString('utf8'));
    const auth = claims['https://api.openai.com/auth'] || {};
    return { accountId: auth.chatgpt_account_id || '', plan: auth.chatgpt_plan_type || '' };
  } catch {
    return { accountId: '', plan: '' };
  }
}

/**
 * The machine's ChatGPT bearer token, refreshed if it had expired.
 *
 * Throws CodexSignedOut when nobody has signed in, which callers draw
 * differently from a failure.
 */
export async function codexToken({ agentDir, signal } = {}) {
  let access;
  try {
    access = await runPi(['auth', 'print-bearer-token', '--provider', PROVIDER], { agentDir, signal });
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    const said = `${error.stderr || ''} ${error.message || ''}`.toLowerCase();
    // Not signed in, and an expired refresh token that Pi could not renew,
    // both land here. They are the same instruction to the person.
    if (said.includes('not authenticated') || said.includes('no credential') || said.includes('not logged in') || said.includes('login')) {
      throw new CodexSignedOut();
    }
    throw new CodexImageError(`could not read the machine's ChatGPT sign-in: ${error.message}`, { cause: error });
  }
  if (!access || access.split('.').length !== 3) throw new CodexSignedOut();
  const { accountId, plan } = describeToken(access);
  if (!accountId) throw new CodexSignedOut('the stored ChatGPT sign-in names no account; sign in again with pi');
  return { access, accountId, plan };
}

async function referencePart(path) {
  const type = REFERENCE_TYPES.get(extname(path).toLowerCase());
  if (!type) throw new CodexImageError(`${basename(path)} is not an image this can combine`, { status: 400 });
  let body;
  try {
    body = await readFile(path);
  } catch (error) {
    throw new CodexImageError(`could not read ${basename(path)}`, { status: 400, cause: error });
  }
  if (body.byteLength > MAX_REFERENCE_BYTES) {
    throw new CodexImageError(`${basename(path)} is too large to send as a reference`, { status: 400 });
  }
  return { type: 'input_image', image_url: `data:${type};base64,${body.toString('base64')}`, detail: 'auto' };
}

// Server-sent events, but only the fields this needs. A frame that does not
// parse is skipped rather than thrown: the stream is long, one malformed line
// is not worth losing a finished picture over.
function* sseEvents(buffer) {
  let rest = buffer;
  let index;
  while ((index = rest.indexOf('\n')) >= 0) {
    const line = rest.slice(0, index).trimEnd();
    rest = rest.slice(index + 1);
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try { yield JSON.parse(payload); } catch { /* skip a torn frame */ }
  }
  return rest;
}

/**
 * Draw one picture.
 *
 * `references` are absolute paths to images already on this machine -- the
 * pins the person tapped. They are sent as inputs to the same turn, which is
 * what makes "combine these" a single request rather than a pipeline.
 *
 * Resolves to { image, revisedPrompt, note }. `image` is a PNG Buffer.
 */
export async function generateImage({
  prompt,
  references = [],
  model = DEFAULT_MODEL,
  agentDir,
  signal,
  onPartial,
} = {}) {
  const text = String(prompt ?? '').trim();
  if (!text) throw new CodexImageError('a picture needs a prompt', { status: 400 });
  if (references.length > MAX_REFERENCES) {
    throw new CodexImageError(`combine at most ${MAX_REFERENCES} images at once`, { status: 400 });
  }

  const { access, accountId } = await codexToken({ agentDir, signal });
  const content = [{ type: 'input_text', text }];
  for (const path of references) content.push(await referencePart(path));

  let response;
  try {
    response = await fetch(RESPONSES_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${access}`,
        'chatgpt-account-id': accountId,
        'Content-Type': 'application/json',
        'OpenAI-Beta': 'responses=experimental',
        originator: 'codex_cli_rs',
        session_id: crypto.randomUUID(),
      },
      body: JSON.stringify({
        model,
        stream: true,
        // Nothing is kept on OpenAI's side. The person's pictures live on their
        // own machine; a copy retained upstream is not ours to create.
        store: false,
        instructions: 'You make images. Call the image_generation tool exactly once for the request, and do not ask clarifying questions.',
        input: [{ type: 'message', role: 'user', content }],
        // Partial frames are opt-in. Without this the endpoint sends one
        // finished picture after a silent minute, which is the surface this
        // product already learned reads as broken rather than busy.
        tools: [{ type: 'image_generation', partial_images: PARTIAL_FRAMES }],
        tool_choice: 'auto',
      }),
      signal,
    });
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new CodexImageError(`could not reach OpenAI: ${error.message}`, { cause: error });
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    if (response.status === 401 || response.status === 403) {
      throw new CodexSignedOut('OpenAI refused the ChatGPT sign-in on this machine; sign in again with pi');
    }
    if (response.status === 429) {
      throw new CodexImageError('the ChatGPT subscription is rate limited right now; try again shortly', { status: 429 });
    }
    // The upstream body can name the real problem -- an unsupported model is
    // the common one -- and it carries no credential, so it is worth showing.
    let said = '';
    try { said = JSON.parse(detail)?.detail || ''; } catch { said = detail.slice(0, 200); }
    throw new CodexImageError(said ? `OpenAI refused the request: ${said}` : `OpenAI refused the request (${response.status})`, { status: 502 });
  }

  let buffer = '';
  let best = '';
  let revisedPrompt = '';
  let note = '';
  let failure = '';

  for await (const chunk of response.body) {
    buffer += Buffer.from(chunk).toString('utf8');
    const iterator = sseEvents(buffer);
    let step = iterator.next();
    while (!step.done) {
      const event = step.value;
      const item = event.item;
      // Partial frames and the finished image arrive under different names.
      // Longest-wins rather than last-wins: the frames grow as the picture
      // resolves, and a late small frame must not replace a finished one.
      const b64 = event.partial_image_b64 || (item?.type === 'image_generation_call' ? item.result : '') || '';
      if (b64 && b64.length > best.length) {
        best = b64;
        if (event.partial_image_b64 && typeof onPartial === 'function') {
          try { onPartial(b64); } catch { /* a viewer that fell over must not stop the drawing */ }
        }
      }
      if (item?.revised_prompt) revisedPrompt = item.revised_prompt;
      if (event.type === 'response.output_text.done' && event.text) note = String(event.text).trim();
      if (event.type === 'response.failed') failure = event.response?.error?.message || 'the drawing failed';
      step = iterator.next();
    }
    buffer = step.value;
  }

  if (failure) throw new CodexImageError(failure);
  if (!best) {
    // A turn that answered in words and drew nothing is usually a refusal, and
    // its own sentence explains it better than anything this file could say.
    throw new CodexImageError(note || 'OpenAI returned no image for that prompt');
  }
  return { image: Buffer.from(best, 'base64'), revisedPrompt, note };
}
