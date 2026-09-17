import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { agentStatus, tabLabel, createTabHost, turnActive, firstUserLine } from '../tabs.mjs';

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

test('Herdr status is derived from runtime facts and unseen settlement', async () => {
  const first = fakeRuntime({ cwd: '/work/imperfect.os', ui: { dialogs: [], }, agent: 'pi' });
  const second = fakeRuntime({ cwd: '/work/imperfect.os', ui: { dialogs: [], }, agent: 'pi' });
  let made = 0;
  const host = await createTabHost({ createRuntime: () => made++ ? second : first });
  try {
    assert.equal(host.snapshot().tabs[0].status, 'idle');
    first.set({ busy: true, streaming: true });
    assert.equal(host.snapshot().tabs[0].status, 'working');
    first.set({ busy: false, streaming: false });
    await host.command({ type: 'tab-new' });
    first.set({ busy: true, streaming: true });
    first.set({ busy: false, streaming: false });
    assert.equal(host.snapshot().tabs.find(tab => tab.id === 't1').status, 'done');
    await host.command({ type: 'tab-focus', tabId: 't1' });
    assert.equal(host.snapshot().tabs.find(tab => tab.id === 't1').status, 'idle');
    second.set({ ui: { dialogs: [{ id: 'permission', method: 'confirm' }] } });
    assert.equal(host.snapshot().tabs.find(tab => tab.id === 't2').status, 'blocked');
    await host.command({ type: 'tab-move', tabId: 't1', delta: 1 });
    assert.deepEqual(host.snapshot().tabs.map(tab => tab.id), ['t2', 't1']);
  } finally {
    await host.close();
  }
});

test('agentStatus does not call a failed runtime idle', () => {
  const tab = { agent: 'pi', unseenSettled: false, runtime: { snapshot: () => ({}) } };
  assert.equal(agentStatus(tab, { failed: 'runtime ended', busy: false, streaming: false }), 'unknown');
  assert.equal(agentStatus(tab, { live: { waiting: { title: 'answer' } }, busy: false }), 'blocked');
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
