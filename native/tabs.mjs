import { EventEmitter } from 'node:events';
import { basename } from 'node:path';
import { createRuntime } from './runtime.mjs';
import { createClaudeRuntime } from './claude-runtime.mjs';
import { answerEvidence } from './public/js/session-logic.js';

function messageText(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n').trim();
}

// Done-pings follow a model turn, not composer busy. Preflight, dialogs and
// auth flip `busy` as soon as a prompt is accepted; `streaming` is the run.
export function turnActive(snap) {
  return Boolean(snap?.streaming ?? snap?.busy);
}

export function firstUserLine(snap) {
  for (const entry of snap?.messages ?? []) {
    if (entry?.role !== 'user') continue;
    const line = messageText(entry.content).split('\n').map(part => part.trim()).find(Boolean);
    if (line) return line;
  }
  return '';
}

export function tabLabel(snap) {
  const named = String(snap?.name ?? '').trim();
  // The rail uses 'new' as an untitled placeholder; a real /name wins, 'new' does not.
  if (named && named !== snap.sessionId && named !== 'new') return named;
  return firstUserLine(snap) || 'new';
}

function summary(tab, focused) {
  const snap = tab.runtime.snapshot();
  return {
    id: tab.id,
    sessionId: snap.sessionId,
    sessionFile: snap.sessionFile,
    name: tabLabel(snap),
    prompt: firstUserLine(snap),
    busy: snap.busy,
    streaming: Boolean(snap.streaming),
    failed: snap.failed ?? null,
    status: agentStatus(tab, snap),
    // Herdr's workspace token is the only real place value this machine has:
    // the runtime's current directory. There is no second workspace layer to
    // manufacture here.
    workspace: workspaceLabel(snap.cwd),
    // The rail is the one place a person can see which agent a tab is, so it
    // travels with every summary rather than being asked for separately.
    agent: tab.agent,
    focused,
  };
}

export function workspaceLabel(cwd) {
  const value = String(cwd ?? '').replace(/[\\/]+$/, '');
  return value ? basename(value) || value : '';
}

// Herdr calls a settled background turn `done`, but only until its tab is seen
// again. The host remembers that one fact; every other state remains a direct
// reading of the runtime rather than a second lifecycle machine.
export function agentStatus(tab, snap = tab.runtime.snapshot()) {
  if (snap?.ui?.dialogs?.length || snap?.live?.waiting) return 'blocked';
  if (snap?.failed || snap?.live?.closed) return 'unknown';
  if (snap?.busy || snap?.streaming || snap?.operation) return 'working';
  if (tab.unseenSettled) return 'done';
  return tab.agent ? 'idle' : 'unknown';
}

export const STATUS_PRIORITY = Object.freeze({ blocked: 0, working: 1, done: 2, unknown: 3, idle: 4 });

// One machine, two harnesses. The choice lives here and nowhere else: both
// runtimes answer the same four members, so every surface above this point —
// the rail, the composer, the dialogs, the themes — is shared between them.
export const AGENTS = ['pi', 'claude'];

export async function createTabHost(options = {}) {
  const events = new EventEmitter();
  const {
    createRuntime: makeRuntime = createRuntime,
    createClaudeRuntime: makeClaudeRuntime = createClaudeRuntime,
    ...shared
  } = options;
  const make = (extra, agent = 'pi') => agent === 'claude'
    ? makeClaudeRuntime({ ...shared, ...extra })
    : makeRuntime({ ...shared, ...extra });
  // The machine still opens on Pi. A person who has never signed in to Claude
  // must not meet a dead tab on their first sight of the console.
  const first = await make({ persistPointer: true });
  let seq = 1;
  const tabs = [{ id: 't1', runtime: first, agent: 'pi', wasTurn: turnActive(first.snapshot()), unseenSettled: false }];
  let focused = 't1';
  const current = () => tabs.find(tab => tab.id === focused) ?? tabs[0];

  function bind(tab) {
    tab.runtime.events.on('change', () => {
      const snap = tab.runtime.snapshot();
      const next = turnActive(snap);
      if (tab.wasTurn && !next) {
        tab.unseenSettled = tab.id !== focused;
        events.emit('settled', {
          id: tab.id,
          sessionId: snap.sessionId ?? null,
          failed: snap.failed ?? null,
          answer: answerEvidence(snap.messages ?? []),
        });
      }
      tab.wasTurn = next;
      events.emit('change');
    });
  }
  bind(tabs[0]);

  function snapshot() {
    const tab = current();
    // The host is the authority on which agent a tab is, not the runtime: a
    // face is chosen from this, so it must be right even for a runtime that
    // never says what it is.
    return { ...tab.runtime.snapshot(), agent: tab.agent, tabs: tabs.map(item => summary(item, item.id === focused)) };
  }

  async function command(c) {
    if (c.type === 'tab-focus') {
      const tab = tabs.find(item => item.id === c.tabId);
      if (!tab) throw new Error('Unknown tab');
      focused = tab.id;
      tab.unseenSettled = false;
      events.emit('change');
      return summary(tab, true);
    }
    if (c.type === 'tab-new') {
      const agent = c.agent === 'claude' ? 'claude' : 'pi';
      // A Claude tab with no key throws before it is ever pushed, so a refused
      // new tab leaves the rail exactly as it was rather than half-open.
      const runtime = await make({ fresh: true, persistPointer: false }, agent);
      const tab = { id: `t${++seq}`, runtime, agent, wasTurn: false, unseenSettled: false };
      tabs.push(tab);
      bind(tab);
      focused = tab.id;
      events.emit('change');
      return summary(tab, true);
    }
    if (c.type === 'tab-open') {
      const path = c.path;
      const already = tabs.find(item => item.runtime.snapshot().sessionFile === path);
      if (already) {
        focused = already.id;
        already.unseenSettled = false;
        events.emit('change');
        return summary(already, true);
      }
      // A session belongs to the agent that wrote it; reopening one in the
      // other harness would hand it a transcript it cannot continue.
      const agent = c.agent === 'claude' ? 'claude' : 'pi';
      const runtime = await make({ sessionPath: path, persistPointer: false }, agent);
      const tab = { id: `t${++seq}`, runtime, agent, wasTurn: turnActive(runtime.snapshot()), unseenSettled: false };
      tabs.push(tab);
      bind(tab);
      focused = tab.id;
      events.emit('change');
      return summary(tab, true);
    }
    if (c.type === 'tab-close') {
      if (tabs.length === 1) throw new Error('The last tab stays open');
      const index = tabs.findIndex(item => item.id === c.tabId);
      if (index < 0) throw new Error('Unknown tab');
      const [tab] = tabs.splice(index, 1);
      if (focused === tab.id) focused = tabs[Math.max(0, index - 1)].id;
      events.emit('change');
      await tab.runtime.close();
      return { ok: true, focused };
    }
    if (c.type === 'tab-move') {
      const index = tabs.findIndex(item => item.id === c.tabId);
      if (index < 0) throw new Error('Unknown tab');
      const delta = c.delta < 0 ? -1 : c.delta > 0 ? 1 : 0;
      const next = Math.max(0, Math.min(tabs.length - 1, index + delta));
      if (next !== index) {
        const [tab] = tabs.splice(index, 1);
        tabs.splice(next, 0, tab);
        events.emit('change');
      }
      return summary(tabs[next], tabs[next].id === focused);
    }
    return current().runtime.command(c);
  }

  return {
    events,
    snapshot,
    command,
    get focused() { return focused; },
    async close() {
      for (const tab of tabs) await tab.runtime.close();
    },
  };
}
