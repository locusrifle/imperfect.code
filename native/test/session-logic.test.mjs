// Session and transcript helpers the harness and the server share. Realtime voice was removed
// on 2026-09-14; what is left here is the part that was never about voice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { createGueyServer } from '../../server.mjs';
import {
  answerEvidence, answerFromTurn, assistantBaseline, assistantFingerprint, assistantTextFromMessage,
  canCreateResponse, composerBlockReason, focusChanged, formatHarnessNow, latestReadyAssistant,
  formatPiResult, tabTarget, exchangeGroups, itemIdsToDelete, micConflict, parseToolArguments, rememberCall, routeVoiceRequest, spokenWorkResult,
  staleCommandError, tabCloseBusyError, turnActive, validateToolCall,
} from '../public/js/session-logic.js';

function stubRuntime(cwd) {
  return {
    events: new EventEmitter(),
    snapshot: () => ({
      sessionId: 'x', sessionFile: join(cwd, 's.jsonl'), cwd, busy: false, failed: null,
      messages: [], commands: [], ui: { dialogs: [], widgets: {}, statuses: {}, notifications: [], editor: null },
    }),
    async command() { return {}; },
    async close() {},
  };
}

test('busy tab-close without closeConfirmed is rejected at the server', async () => {
  const root = await mkdtemp(join(tmpdir(), 'guey-voice-busy-close-'));
  let ran = 0;
  const events = new EventEmitter();
  const runtime = {
    events,
    snapshot: () => ({ sessionId: 'here', tabs: [{ id: 't1', focused: true, sessionId: 'here', busy: false }, { id: 't2', sessionId: 'other', busy: true }], messages: [], busy: false, streaming: false, failed: null }),
    async command() { ran += 1; return { ok: true }; },
    async close() {},
  };
  const app = await createGueyServer({ port: 0, host: '127.0.0.1', stateDir: root, runtime, product: 'locusrifle' });
  try {
    const addr = await app.listen();
    const { WebSocket } = await import('ws');
    const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/pi`);
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const reply = () => new Promise(resolve => {
      const on = raw => {
        const msg = JSON.parse(raw);
        if (msg.type === 'response') { ws.off('message', on); resolve(msg); }
      };
      ws.on('message', on);
    });
    const wait = reply();
    ws.send(JSON.stringify({ id: 'c1', type: 'tab-close', tabId: 't2', expectedTabId: 't2', expectedSessionId: 'other' }));
    const denied = await wait;
    assert.equal(denied.success, false);
    assert.match(denied.error, /busy/);
    assert.equal(ran, 0);
    const wait2 = reply();
    ws.send(JSON.stringify({ id: 'c2', type: 'tab-close', tabId: 't2', expectedTabId: 't2', expectedSessionId: 'other', closeConfirmed: true }));
    const ok = await wait2;
    assert.equal(ok.success, true);
    assert.equal(ran, 1);
    ws.close();
  } finally {
    await app.close(); await rm(root, { recursive: true, force: true });
  }
});

test('session-logic occupancy, answers, tools, tabs', () => {
  assert.equal(composerBlockReason({ draft: 'keep' }), 'composer has a draft');
  assert.equal(composerBlockReason({ attachments: 1 }), 'composer has attachments');
  assert.equal(composerBlockReason({ slashOpen: true }), 'slash picker is open');
  assert.equal(composerBlockReason({ busy: true, streaming: false }), 'Pi is still working in this tab');
  assert.equal(composerBlockReason({ busy: false, streaming: true }), null);
  assert.equal(micConflict({ live: false, pending: true }), true);
  assert.equal(composerBlockReason({ draft: '  ' }), null);

  const commentary = { role: 'assistant', content: [{ type: 'text', text: 'calling bash' }] };
  const done = { role: 'assistant', content: [{ type: 'thinking', thinking: 'secret' }, { type: 'text', text: 'shown' }], stopReason: 'stop' };
  assert.equal(latestReadyAssistant([commentary, done]).text, 'shown');
  assert.equal(latestReadyAssistant([commentary]), null);
  assert.equal(latestReadyAssistant([commentary], { idle: true }).text, 'calling bash');
  assert.equal(assistantTextFromMessage(done), 'shown');
  assert.equal(assistantFingerprint([done]), '0:shown');
  assert.equal(turnActive({ busy: true, streaming: false }), false);
  assert.equal(turnActive({ streaming: true }), true);
  assert.equal(focusChanged({ sessionId: 'a', tabId: 't1' }, { sessionId: 'b', tabId: 't1' }), true);

  const seen = new Set();
  assert.equal(rememberCall(seen, 'c1'), true);
  assert.equal(rememberCall(seen, 'c1'), false);
  assert.equal(parseToolArguments('{').ok, false);
  assert.equal(validateToolCall('send_to_pi', { text: 1 }).error, 'text must be a string');
  assert.equal(validateToolCall('manage_tabs', { action: 'close', tab_id: 't2', confirm: 'false' }).error, 'confirm must be boolean');
  assert.equal(validateToolCall('send_to_pi', { text: 'ok' }).ok, true);
  assert.equal(routeVoiceRequest('').error, 'nothing heard');
  assert.equal(routeVoiceRequest('check the emails').name, 'send_to_pi');
  assert.equal(routeVoiceRequest('check the emails').value.text, 'check the emails');
  assert.deepEqual(routeVoiceRequest('open the desktop').value, { target: 'desktop', action: 'open' });
  assert.equal(routeVoiceRequest('read the full answer').value.full, true);
  assert.match(spokenWorkResult({ text: 'done later' }), /done later/);
  assert.equal(canCreateResponse({ needResponse: true, responseActive: false, responsePending: true }), false);
  assert.equal(canCreateResponse({ needResponse: true, userSpeaking: true }), false);
  assert.equal(canCreateResponse({ needResponse: true, toolTasks: 1 }), false);
  assert.equal(canCreateResponse({ needResponse: true }), true);
  assert.equal(staleCommandError({ type: 'prompt', expectedSessionId: 'a' }, { sessionId: 'b' }), 'session changed');
  assert.equal(staleCommandError({ type: 'prompt', expectedSessionId: 'a', expectedTabId: 't1' }, { sessionId: 'a', tabs: [{ id: 't1', focused: true }] }), null);
  assert.equal(staleCommandError({ type: 'tab-close', tabId: 't2', expectedTabId: 't1' }, {}), 'session changed');
  assert.equal(staleCommandError({ type: 'tab-focus', tabId: 't2', expectedTabId: 't2', expectedSessionId: 'old' }, { tabs: [{ id: 't2', sessionId: 'new' }] }), 'session changed');
  assert.equal(tabCloseBusyError({ type: 'tab-close', tabId: 't2' }, { tabs: [{ id: 't2', busy: true }] }), 'tab is busy');
  assert.equal(tabCloseBusyError({ type: 'tab-close', tabId: 't2', closeConfirmed: true }, { tabs: [{ id: 't2', busy: true }] }), null);
  const long = 'x'.repeat(9000);
  const ev = answerEvidence([{ role: 'assistant', content: long, stopReason: 'stop', id: 'm1' }]);
  assert.equal(ev.truncated, true);
  assert.equal(ev.index, 0);
  assert.notEqual(ev.text, long);
  assert.equal(answerFromTurn({ answer: ev }, { index: 0, id: 'm1' }).error, 'Pi finished without a completed answer');
  assert.equal(answerFromTurn({ answer: { text: 'new', index: 1, id: 'm2' } }, { index: 0, id: 'm1' }).text, 'new');
  assert.equal(answerFromTurn({ answer: null }, { index: 0 }).error, 'Pi finished without a completed answer');
  const now = formatHarnessNow({
    busy: true,
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'check the emails' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'three unread' }], stopReason: 'stop' },
    ],
  });
  assert.match(now, /\[harness-now\]/);
  assert.match(now, /busy: work is in flight/);
  assert.match(now, /last Noah: check the emails/);
  assert.match(now, /last you: three unread/);
  assert.match(now, /Do not greet/);
  assert.match(formatHarnessNow({ busy: false }), /\bidle\b/);
  assert.match(formatPiResult({ tabId: 't1', sessionId: 's', text: 'done later' }), /\[pi-result tab=t1 session=s\]/);
  assert.match(formatPiResult({ tabId: 't1', sessionId: 's', text: 'done later' }), /done later/);
  assert.equal(assistantBaseline([{ role: 'assistant', content: long, stopReason: 'stop', id: 'm1' }]).index, 0);

  const items = [];
  for (let i = 0; i < 6; i++) {
    items.push({ id: `u${i}`, type: 'message', role: 'user', status: 'completed' });
    items.push({ id: `a${i}`, type: 'message', role: 'assistant', status: 'completed' });
  }
  items.push({ id: 'pending-u', type: 'message', role: 'user', status: 'completed' });
  items.push({ id: 'call', type: 'function_call', call_id: 'z', status: 'completed' });
  assert.deepEqual(itemIdsToDelete(items), ['u0', 'a0', 'u1', 'a1']);
  assert.equal(exchangeGroups(items).at(-1).pending, true);
  assert.equal(tabTarget([{ id: 't2' }], 't9').error, 'Unknown tab');
});

test('stale expected session rejects prompt without dispatch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'guey-voice-stale-'));
  let ran = 0;
  const events = new EventEmitter();
  const runtime = {
    events,
    snapshot: () => ({ sessionId: 'here', tabs: [{ id: 't1', focused: true, sessionId: 'here' }], messages: [], busy: false, streaming: false, failed: null }),
    async command() { ran += 1; return { accepted: true }; },
    async close() {},
  };
  const app = await createGueyServer({ port: 0, host: '127.0.0.1', stateDir: root, runtime, product: 'locusrifle' });
  try {
    const addr = await app.listen();
    const { WebSocket } = await import('ws');
    const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/pi`);
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const reply = await new Promise(resolve => {
      ws.on('message', raw => {
        const msg = JSON.parse(raw);
        if (msg.type === 'response' && msg.id === '1') resolve(msg);
      });
      ws.send(JSON.stringify({ id: '1', type: 'prompt', text: 'hi', expectedSessionId: 'elsewhere', expectedTabId: 't1' }));
    });
    assert.equal(reply.success, false);
    assert.match(reply.error, /session changed/);
    assert.equal(ran, 0);
    ws.close();
  } finally {
    await app.close(); await rm(root, { recursive: true, force: true });
  }
});
