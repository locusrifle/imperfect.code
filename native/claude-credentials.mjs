import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// The second harness keeps its own credential. Pi's ModelRuntime owns every
// provider in its catalog, including `anthropic` — but that is Pi calling the
// Anthropic model API. The Claude harness is a different agent with a different
// account, and storing its key in Pi's auth.json would make one account look
// like two, or two like one. It lives beside Pi's profile, never inside it.
//
// Two ways in, and only one of them is ours to offer. This console never asks
// anyone for a claude.ai password and never runs an OAuth flow: Anthropic does
// not permit a third-party product to sign its users into claude.ai accounts,
// so no oauth shape exists here to expose. But a person who has already signed
// their own machine in — `claude /login` in a terminal, their subscription,
// their credential, sitting in their own home directory — is not a third party
// to themselves, and the SDK reads that credential on its own. Refusing to
// start on it would be this console inventing a restriction Anthropic did not
// write. So: we offer the key, and we get out of the way of the login.
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

// Claude Code's own config directory — the same override the CLI reads, which
// is also the knob a test uses to keep the developer's real login out of it.
export function claudeConfigDir() {
  const override = process.env.CLAUDE_CONFIG_DIR;
  return override?.trim() ? override.trim() : join(homedir(), '.claude');
}

// Not read, not parsed, never copied. Whether this machine's own Claude login
// exists is the only question asked; the credential itself is the CLI's, and
// this console has no business opening it.
export function claudeCliLogin() {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim()) return 'token';
  return existsSync(join(claudeConfigDir(), '.credentials.json')) ? 'login' : null;
}

// What this machine would actually run a Claude tab on, in the order the SDK
// resolves it. A `key` of null with a source is the subscription path: there is
// nothing for us to pass, because the credential is already where Claude looks.
export function resolveClaudeAuth(agentDir) {
  const stored = readClaudeKey(agentDir);
  if (stored) return { key: stored, source: 'stored' };
  const ambient = ambientClaudeKey();
  if (ambient) return { key: ambient, source: 'ambient' };
  const cli = claudeCliLogin();
  return { key: null, source: cli };
}

export function claudeConfigured(agentDir) {
  return Boolean(resolveClaudeAuth(agentDir).source);
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
