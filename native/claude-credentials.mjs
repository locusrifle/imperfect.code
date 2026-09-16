import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// The second harness keeps its own credential. Pi's ModelRuntime owns every
// provider in its catalog, including `anthropic` — but that is Pi calling the
// Anthropic model API. The Claude harness is a different agent with a different
// account, and storing its key in Pi's auth.json would make one account look
// like two, or two like one. It lives beside Pi's profile, never inside it.
//
// Only an API key. Anthropic's terms do not permit a third party to offer
// claude.ai login or subscription limits in its own product, so there is no
// oauth shape here to accidentally expose — the same line the provider list
// already draws for Pi's `anthropic` subscription.
export const CLAUDE_PROVIDER_ID = 'claude-agent';
export const CLAUDE_PROVIDER_NAME = 'Claude Agent';

const VERSION = '2023-06-01';

export function claudeKeyPath(agentDir) {
  return join(agentDir, 'claude', 'api-key');
}

// A key present in the environment belongs to whoever started the process, not
// to this console. Pi calls that ambient and refuses to overwrite it from the
// GUI; the same rule keeps a machine-wide key from being silently shadowed.
export function ambientClaudeKey() {
  const key = process.env.ANTHROPIC_API_KEY;
  return typeof key === 'string' && key.trim() ? key.trim() : null;
}

export function readClaudeKey(agentDir) {
  if (!agentDir) return null;
  try {
    const key = readFileSync(claudeKeyPath(agentDir), 'utf8').trim();
    return key || null;
  } catch { return null; }
}

// Stored key wins for a tab this console started; ambient is the fallback so a
// machine configured outside the console still runs without a second sign-in.
export function resolveClaudeKey(agentDir) {
  return readClaudeKey(agentDir) ?? ambientClaudeKey();
}

export function claudeConfigured(agentDir) {
  return Boolean(resolveClaudeKey(agentDir));
}

// A key is a secret, so it never lands in a world-readable file and never goes
// through a path where a crash could leave half of one behind.
export function writeClaudeKey(agentDir, key) {
  const clean = String(key ?? '').trim();
  if (!clean) throw new Error('An API key is required');
  if (/\s/.test(clean)) throw new Error('An API key contains no spaces; check for a stray line break');
  const path = claudeKeyPath(agentDir);
  mkdirSync(join(agentDir, 'claude'), { recursive: true, mode: 0o700 });
  writeFileSync(`${path}.tmp`, clean, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
  return path;
}

export function removeClaudeKey(agentDir) {
  const path = claudeKeyPath(agentDir);
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}

export class ClaudeKeyRejected extends Error {}

// The same shape as Pi's post-login catalog refresh: metadata only, never a
// model turn, so checking a key costs nothing. Only an explicit rejection is
// fatal — a network that is down says nothing about whether the key is good,
// and refusing to save on that would strand a machine that is merely offline.
export async function verifyClaudeKey(key, { signal, fetchImpl = fetch } = {}) {
  let response;
  try {
    response = await fetchImpl('https://api.anthropic.com/v1/models?limit=1', {
      headers: { 'x-api-key': key, 'anthropic-version': VERSION },
      signal,
    });
  } catch {
    return { ok: true, checked: false };
  }
  if (response.status === 401 || response.status === 403) {
    throw new ClaudeKeyRejected('Anthropic rejected that API key. Check the key and try again.');
  }
  if (!response.ok) return { ok: true, checked: false };
  return { ok: true, checked: true };
}
