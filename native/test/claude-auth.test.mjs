import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { createAuth } from '../auth.mjs';
import {
  CLAUDE_PROVIDER_ID, ClaudeKeyRejected, claudeCliLogin, claudeKeyPath, readClaudeKey,
  resolveClaudeAuth, resolveClaudeKey, verifyClaudeKey, writeClaudeKey,
} from '../claude-credentials.mjs';

const wait = async predicate => {
  for (let i = 0; i < 200; i++) { if (await predicate()) return; await new Promise(r => setTimeout(r, 10)); }
  throw new Error('Timed out waiting for auth state');
};

async function fixture(root) {
  // This machine's own Claude login is a real credential now, so a test that
  // means "nothing is configured" has to say where Claude's config lives.
  process.env.CLAUDE_CONFIG_DIR = join(root, 'no-claude-config');
  const agentDir = join(root, 'agent');
  await mkdir(agentDir, { recursive: true });
  const models = await ModelRuntime.create({
    authPath: join(agentDir, 'auth.json'), modelsPath: null,
    modelsStorePath: join(root, 'models-store.json'),
  });
  const calls = [];
  const verifyClaude = async (key, options) => {
    calls.push(key);
    if (key === 'sk-ant-bad') throw new ClaudeKeyRejected('Anthropic rejected that API key. Check the key and try again.');
    if (key === 'sk-ant-offline') return { ok: true, checked: false };
    return { ok: true, checked: true };
  };
  const auth = createAuth({ models: () => models, changed: () => {}, assertIdle: () => {}, agentDir, verifyClaude });
  const answer = async value => {
    await wait(() => auth.snapshot().prompt);
    auth.answer(auth.snapshot().prompt.id, value);
  };
  const settle = () => wait(() => !auth.snapshot().busy);
  return { agentDir, models, auth, calls, answer, settle };
}

test('the merged panel routes Claude to its own store and leaves Pi alone', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claude-auth-'));
  delete process.env.ANTHROPIC_API_KEY;
  const f = await fixture(root);
  try {
    const providers = f.auth.providers();
    const claude = providers.find(p => p.id === CLAUDE_PROVIDER_ID);
    assert.ok(claude, 'Claude is one row in the one provider list');
    assert.equal(claude.configured, false);
    assert.ok(providers.length > 1, 'Pi’s providers are still listed beside it');
    assert.ok(providers.some(p => p.id === 'anthropic'), 'Pi keeps its own Anthropic provider');

    // Anthropic does not permit a third party to offer claude.ai login. The
    // subscription is not filtered downstream; it is never constructed.
    assert.deepEqual(claude.methods.map(m => m.type), ['api_key']);
    assert.equal(claude.methods.some(m => m.type === 'oauth'), false);
    await assert.rejects(async () => f.auth.login(CLAUDE_PROVIDER_ID, 'oauth'), /Unsupported/);

    // A key Anthropic rejects is named, never stored, and never quoted back.
    f.auth.login(CLAUDE_PROVIDER_ID, 'api_key');
    await f.answer('sk-ant-bad');
    await f.settle();
    assert.equal(f.auth.snapshot().status, 'error');
    assert.match(f.auth.snapshot().message, /rejected that API key/);
    assert.equal(readClaudeKey(f.agentDir), null, 'a rejected key is not saved');
    assert.ok(!JSON.stringify(f.auth.snapshot()).includes('sk-ant-bad'));

    // A good key is stored, 0600, and still never enters the snapshot.
    f.auth.login(CLAUDE_PROVIDER_ID, 'api_key');
    await f.answer('sk-ant-good-SECRET');
    await f.settle();
    assert.equal(f.auth.snapshot().status, 'success');
    assert.equal(readClaudeKey(f.agentDir), 'sk-ant-good-SECRET');
    assert.equal((await stat(claudeKeyPath(f.agentDir))).mode & 0o077, 0);
    assert.ok(!JSON.stringify(f.auth.snapshot()).includes('sk-ant-good-SECRET'));
    assert.equal(f.auth.providers().find(p => p.id === CLAUDE_PROVIDER_ID).configured, true);

    // Signing Claude in says nothing about Pi: the welcome panel still asks.
    assert.equal(f.auth.snapshot().configured, false, 'a Pi tab still needs a Pi provider');
    assert.equal(f.auth.snapshot().claude, true);
    assert.deepEqual(await f.models.listCredentials(), [], 'nothing was written into Pi’s store');

    const accounts = await f.auth.accounts();
    assert.deepEqual(accounts, [{ id: CLAUDE_PROVIDER_ID, name: 'Claude Agent', type: 'api_key' }]);

    await f.auth.logout(CLAUDE_PROVIDER_ID);
    await f.settle();
    assert.equal(readClaudeKey(f.agentDir), null);
    assert.deepEqual(await f.auth.accounts(), []);
    await assert.rejects(f.auth.logout(CLAUDE_PROVIDER_ID), /No stored/);

    // Anthropic unreachable is not the same as a bad key: the key is kept and
    // the message says the check did not happen.
    f.auth.login(CLAUDE_PROVIDER_ID, 'api_key');
    await f.answer('sk-ant-offline');
    await f.settle();
    assert.equal(f.auth.snapshot().status, 'success');
    assert.match(f.auth.snapshot().message, /could not be reached/);
    assert.equal(readClaudeKey(f.agentDir), 'sk-ant-offline');
  } finally {
    delete process.env.CLAUDE_CONFIG_DIR;
    await rm(root, { recursive: true, force: true });
  }
});

test('a machine already signed in to Claude needs nothing from this panel', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claude-login-'));
  delete process.env.ANTHROPIC_API_KEY;
  const f = await fixture(root);
  try {
    assert.equal(claudeCliLogin(), null, 'no login where no config dir exists');
    assert.equal(f.auth.providers().find(p => p.id === CLAUDE_PROVIDER_ID).configured, false);

    // The person signed their own machine in with Claude's own CLI. Nothing
    // here put it there and nothing here reads it — only its existence counts.
    const config = join(root, 'signed-in');
    await mkdir(config, { recursive: true });
    await writeFile(join(config, '.credentials.json'), '{"claudeAiOauth":{"accessToken":"NOT-READ"}}');
    process.env.CLAUDE_CONFIG_DIR = config;

    assert.equal(claudeCliLogin(), 'login');
    assert.deepEqual(resolveClaudeAuth(f.agentDir), { key: null, source: 'login' });
    const claude = f.auth.providers().find(p => p.id === CLAUDE_PROVIDER_ID);
    assert.equal(claude.configured, true, 'this machine can run a Claude tab');
    assert.equal(claude.credential, 'login');
    assert.equal(f.auth.snapshot().claude, true);

    // It is still not an account this console holds: it cannot be removed here.
    assert.deepEqual(await f.auth.accounts(), []);
    await assert.rejects(f.auth.logout(CLAUDE_PROVIDER_ID), /No stored/);
    assert.ok(!JSON.stringify(f.auth.snapshot()).includes('NOT-READ'));

    // A key stored here still wins, because someone who typed one meant it.
    writeClaudeKey(f.agentDir, 'sk-ant-explicit');
    assert.deepEqual(resolveClaudeAuth(f.agentDir), { key: 'sk-ant-explicit', source: 'stored' });
  } finally {
    delete process.env.CLAUDE_CONFIG_DIR;
    await rm(root, { recursive: true, force: true });
  }
});

test('an ambient key is honoured but is not this console’s account', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claude-ambient-'));
  process.env.ANTHROPIC_API_KEY = 'sk-ant-from-the-environment';
  const f = await fixture(root);
  try {
    const claude = f.auth.providers().find(p => p.id === CLAUDE_PROVIDER_ID);
    assert.equal(claude.configured, true, 'a machine configured outside the console already runs');
    assert.equal(claude.methods[0].ambient, true);
    // Pi refuses a GUI login over an ambient credential; so does this.
    await assert.rejects(async () => f.auth.login(CLAUDE_PROVIDER_ID, 'api_key'), /ambient/);
    assert.deepEqual(await f.auth.accounts(), [], 'nothing here put it there, and logout could not remove it');
    await assert.rejects(f.auth.logout(CLAUDE_PROVIDER_ID), /No stored/);
    assert.equal(resolveClaudeKey(f.agentDir), 'sk-ant-from-the-environment');

    // A key this console stored takes precedence and becomes an account again.
    writeClaudeKey(f.agentDir, 'sk-ant-stored');
    assert.equal(resolveClaudeKey(f.agentDir), 'sk-ant-stored');
    assert.equal(f.auth.providers().find(p => p.id === CLAUDE_PROVIDER_ID).methods[0].ambient, false);
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_CONFIG_DIR;
    await rm(root, { recursive: true, force: true });
  }
});

test('the key file refuses malformed input and the check spends no tokens', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claude-store-'));
  const agentDir = join(root, 'agent');
  await mkdir(agentDir, { recursive: true });
  try {
    assert.throws(() => writeClaudeKey(agentDir, '   '), /required/);
    assert.throws(() => writeClaudeKey(agentDir, 'sk-ant key'), /no spaces/);
    writeClaudeKey(agentDir, '  sk-ant-padded  ');
    assert.equal(readClaudeKey(agentDir), 'sk-ant-padded', 'a pasted key is trimmed, not rejected');
    assert.equal((await stat(join(agentDir, 'claude'))).mode & 0o077, 0);
    assert.equal(await readFile(claudeKeyPath(agentDir), 'utf8'), 'sk-ant-padded');

    // Metadata only: a models listing, never a message. 401 is the one fatal answer.
    const seen = [];
    const fetchImpl = async (url, init) => {
      seen.push({ url, method: init?.method ?? 'GET', headers: init.headers });
      return { ok: false, status: 401 };
    };
    await assert.rejects(verifyClaudeKey('sk-ant-x', { fetchImpl }), ClaudeKeyRejected);
    assert.match(seen[0].url, /\/v1\/models/);
    assert.equal(seen[0].method, 'GET');
    assert.equal(seen[0].headers['x-api-key'], 'sk-ant-x');

    // A 500 or a dead network says nothing about the key.
    assert.deepEqual(await verifyClaudeKey('sk-ant-x', { fetchImpl: async () => ({ ok: false, status: 500 }) }), { ok: true, checked: false });
    assert.deepEqual(await verifyClaudeKey('sk-ant-x', { fetchImpl: async () => { throw new Error('offline'); } }), { ok: true, checked: false });
    assert.deepEqual(await verifyClaudeKey('sk-ant-x', { fetchImpl: async () => ({ ok: true, status: 200 }) }), { ok: true, checked: true });
  } finally { await rm(root, { recursive: true, force: true }); }
});
