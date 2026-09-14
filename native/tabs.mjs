import { EventEmitter } from 'node:events';
import { createRuntime } from './runtime.mjs';
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
    focused,
  };
}

export async function createTabHost(options = {}) {
  const events = new EventEmitter();
  const { createRuntime: makeRuntime = createRuntime, ...shared } = options;
  const make = extra => makeRuntime({ ...shared, ...extra });
  const first = await make({ persistPointer: true });
  let seq = 1;
  const tabs = [{ id: 't1', runtime: first, wasTurn: turnActive(first.snapshot()) }];
  let focused = 't1';
  const current = () => tabs.find(tab => tab.id === focused) ?? tabs[0];

  function bind(tab) {
    tab.runtime.events.on('change', () => {
      const snap = tab.runtime.snapshot();
      const next = turnActive(snap);
      if (tab.wasTurn && !next) {
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
    return { ...tab.runtime.snapshot(), tabs: tabs.map(item => summary(item, item.id === focused)) };
  }

  async function command(c) {
    if (c.type === 'tab-focus') {
      const tab = tabs.find(item => item.id === c.tabId);
      if (!tab) throw new Error('Unknown tab');
      focused = tab.id;
      events.emit('change');
      return summary(tab, true);
    }
    if (c.type === 'tab-new') {
      const runtime = await make({ fresh: true, persistPointer: false });
      const tab = { id: `t${++seq}`, runtime, wasTurn: false };
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
        events.emit('change');
        return summary(already, true);
      }
      const runtime = await make({ sessionPath: path, persistPointer: false });
      const tab = { id: `t${++seq}`, runtime, wasTurn: turnActive(runtime.snapshot()) };
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
