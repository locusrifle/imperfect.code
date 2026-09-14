import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { tabLabel, createTabHost, turnActive, firstUserLine } from '../tabs.mjs';

test('turnActive follows a model run, not composer busy from preflight', () => {
  assert.equal(turnActive({ busy: true, streaming: false }), false);
  assert.equal(turnActive({ busy: true, streaming: true }), true);
  assert.equal(turnActive({ busy: false, streaming: false }), false);
  assert.equal(turnActive({ busy: true }), true);
});

function fakeRuntime(initial = {}) {
  const events = new EventEmitter();
  let snap = { sessionId: 'x', sessionFile: '/tmp/x.jsonl', cwd: '/tmp', name: '', messages: [], busy: false, streaming: false, failed: null, ...initial };
  return {
    events,
    snapshot: () => snap,
    set(next) { snap = { ...snap, ...next }; events.emit('change'); },
    async command() {},
    async close() {},
  };
}

test('settled fires when a model turn ends, not when a prompt is merely accepted', async () => {
  const first = fakeRuntime();
  const host = await createTabHost({ createRuntime: () => first });
  const settled = [];
  host.events.on('settled', info => settled.push(info));
  first.set({ busy: true, streaming: false });
  first.set({ busy: false, streaming: false });
  assert.deepEqual(settled, []);
  first.set({ busy: true, streaming: true });
  first.set({ busy: false, streaming: false });
  assert.equal(settled[0].id, 't1');
  assert.equal(settled[0].failed, null);
  first.set({ busy: true, streaming: true, failed: null });
  first.set({ busy: false, streaming: false, failed: 'boom' });
  assert.equal(settled[1].id, 't1');
  assert.equal(settled[1].failed, 'boom');
  assert.equal(settled[1].sessionId, 'x');
  await host.close();
});

test('tab labels prefer a real name, then the first prompt, never the session id', () => {
  assert.equal(tabLabel({ name: 'Refactor auth', sessionId: '01abc', messages: [] }), 'Refactor auth');
  assert.equal(tabLabel({
    name: '',
    sessionId: '01a08407-3233-719e-a1a9-50feac8cee82',
    messages: [{ role: 'user', content: 'can you work on the tab window' }],
  }), 'can you work on the tab window');
  assert.equal(tabLabel({
    name: '01a08407-3233-719e-a1a9-50feac8cee82',
    sessionId: '01a08407-3233-719e-a1a9-50feac8cee82',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'first line\nsecond' }] }],
  }), 'first line');
  assert.equal(tabLabel({
    sessionId: '01abc',
    messages: [
      { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
      { role: 'user', content: '   \n  actual prompt  ' },
    ],
  }), 'actual prompt');
  assert.equal(tabLabel({ sessionId: '01abc', messages: [] }), 'new');
  assert.equal(tabLabel({
    name: 'new',
    sessionId: '01abc',
    messages: [{ role: 'user', content: 'clicked new for this session' }],
  }), 'clicked new for this session');
  assert.equal(firstUserLine({
    messages: [{ role: 'user', content: 'clicked new for this session' }],
  }), 'clicked new for this session');
});

test('tab-new is a different empty session; focusing restores the first', async () => {
  const root = await mkdtemp(join(tmpdir(), 'guey-tab-host-'));
  const cwd = join(root, 'work');
  const agent = join(root, 'agent');
  await mkdir(cwd, { recursive: true });
  await mkdir(agent, { recursive: true });
  const host = await createTabHost({
    cwd, agentDir: agent, stateDir: join(root, 'store'), sessionDir: join(root, 'sessions'), liveSessions: false,
  });
  try {
    const first = host.snapshot();
    await host.command({ type: 'tab-new' });
    const neu = host.snapshot();
    assert.notEqual(neu.sessionId, first.sessionId);
    assert.equal((neu.messages ?? []).length, 0);
    assert.equal(neu.tabs.length, 2);
    assert.equal(neu.tabs.filter(tab => tab.focused).length, 1);
    assert.equal(neu.tabs.find(tab => tab.focused).sessionId, neu.sessionId);
    const previous = neu.tabs.find(tab => !tab.focused);
    await host.command({ type: 'tab-focus', tabId: previous.id });
    assert.equal(host.snapshot().sessionId, first.sessionId);
  } finally {
    await host.close();
    await rm(root, { recursive: true, force: true });
  }
});
