import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTabHost } from '../tabs.mjs';
import { createClaudeRuntime, shareContextFile } from '../claude-runtime.mjs';
import { writeClaudeKey } from '../claude-credentials.mjs';

const wait = async predicate => {
  for (let i = 0; i < 200; i++) { if (await predicate()) return; await new Promise(r => setTimeout(r, 10)); }
  throw new Error('Timed out');
};

// A stand-in for the Agent SDK's query(): it never spawns Claude and never
// spends a token, but it speaks the same frames in the same order.
function fakeQuery(script = []) {
  const sent = [];
  const impl = ({ prompt, options }) => {
    const frames = [
      { type: 'system', subtype: 'init', session_id: 's1', claude_code_version: '2.1.0', model: 'claude-opus-5', tools: ['Read', 'Bash'], slash_commands: ['compact'] },
      ...script,
    ];
    let i = 0;
    const iterator = {
      async next() {
        if (i < frames.length) return { value: frames[i++], done: false };
        // Drain the caller's outbound messages so a prompt is observable.
        const next = await prompt.next();
        if (next.done) return { value: undefined, done: true };
        sent.push(next.value);
        return {
          value: { type: 'assistant', session_id: 's1', message: { content: [{ type: 'text', text: 'pong' }] } },
          done: false,
        };
      },
      async return() { return { value: undefined, done: true }; },
      [Symbol.asyncIterator]() { return this; },
      interrupt: async () => {},
      setModel: async () => {},
      supportedModels: async () => [{ id: 'claude-opus-5', displayName: 'Claude Opus 5' }],
    };
    impl.options = options;
    return iterator;
  };
  impl.sent = sent;
  return impl;
}

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'two-harness-'));
  const agentDir = join(root, 'agent');
  const cwd = join(root, 'workspace');
  await mkdir(agentDir, { recursive: true });
  await mkdir(cwd, { recursive: true });
  writeClaudeKey(agentDir, 'sk-ant-test');
  return { root, agentDir, cwd };
}

test('CLAUDE.md points at AGENTS.md, and never overwrites one somebody wrote', async () => {
  const { root, cwd } = await workspace();
  try {
    assert.equal(shareContextFile(cwd), null, 'no AGENTS.md is nothing to share');

    await writeFile(join(cwd, 'AGENTS.md'), '# the workspace\n');
    assert.equal(shareContextFile(cwd), 'written');
    assert.equal(await readFile(join(cwd, 'CLAUDE.md'), 'utf8'), '@AGENTS.md\n');
    assert.equal(shareContextFile(cwd), 'shared', 'running twice is not a second write');

    await writeFile(join(cwd, 'CLAUDE.md'), '# my own instructions\n');
    assert.equal(shareContextFile(cwd), 'separate', 'an authored CLAUDE.md is left exactly as it is');
    assert.equal(await readFile(join(cwd, 'CLAUDE.md'), 'utf8'), '# my own instructions\n');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a Claude tab renders in Pi’s message shape and shares the dialog channel', async () => {
  const { root, agentDir, cwd } = await workspace();
  await writeFile(join(cwd, 'AGENTS.md'), '# shared\n');
  const queryImpl = fakeQuery([
    { type: 'assistant', session_id: 's1', message: { content: [
      { type: 'thinking', thinking: 'considering' },
      { type: 'text', text: 'hello' },
      { type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/etc/hostname' } },
    ] } },
    { type: 'user', session_id: 's1', message: { content: [
      { type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'text', text: 'a-machine' }] },
    ] } },
    { type: 'result', subtype: 'success', session_id: 's1', usage: { input_tokens: 10, output_tokens: 4 }, total_cost_usd: 0.01 },
  ]);
  const runtime = await createClaudeRuntime({ cwd, agentDir, stateDir: join(root, 'state'), queryImpl, listSessionsImpl: async () => [] });
  try {
    // One assistant message carrying three blocks, then one tool-result row.
    await wait(() => runtime.snapshot().messages.length >= 2 && !runtime.snapshot().streaming);
    const snap = runtime.snapshot();
    assert.equal(snap.agent, 'claude');

    // Anthropic block names are translated into the four the GUI draws.
    const assistant = snap.messages.find(m => m.role === 'assistant');
    assert.deepEqual(assistant.content.map(b => b.type), ['thinking', 'text', 'toolCall']);
    assert.equal(assistant.content[2].name, 'Read');
    assert.deepEqual(assistant.content[2].arguments, { file_path: '/etc/hostname' });

    const result = snap.messages.find(m => m.role === 'toolResult');
    assert.equal(result.toolCallId, 'tu1');
    assert.equal(result.toolName, 'Read', 'the call’s name is carried onto its result');
    assert.equal(result.output, 'a-machine');
    assert.deepEqual(snap.runningTools, [], 'a finished tool stops running');

    assert.equal(snap.model.id, 'claude-opus-5');
    assert.deepEqual(snap.resources.tools, ['Read', 'Bash']);
    assert.equal(snap.stats.tokens.output, 4);
    assert.ok(snap.startup.sections.some(s => s.compact === 'AGENTS.md'), 'the shared context file is named at startup');

    // The key is handed to the subprocess, never to the machine's environment.
    assert.equal(queryImpl.options.env.ANTHROPIC_API_KEY, 'sk-ant-test');
    assert.ok(queryImpl.options.settingSources.includes('project'), 'without project, CLAUDE.md never loads');

    // Verbs that are Pi's are named, not silently ignored.
    await assert.rejects(runtime.command({ type: 'compact' }), /running Claude/);
    await assert.rejects(runtime.command({ type: 'fork' }), /running Claude/);
    assert.deepEqual(await runtime.command({ type: 'live' }), []);

    assert.equal(await runtime.command({ type: 'copy' }), 'hello');
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
});

test('a Claude tab runs on this machine’s own login, and is refused only with no credential at all', async () => {
  const { root, cwd } = await workspace();
  const agentDir = join(root, 'empty-agent');
  await mkdir(agentDir, { recursive: true });
  delete process.env.ANTHROPIC_API_KEY;
  const config = join(root, 'claude-config');
  await mkdir(config, { recursive: true });
  process.env.CLAUDE_CONFIG_DIR = join(root, 'nothing-here');
  try {
    // No key, no login: the tab says so before it can take a prompt, and names
    // both doors rather than insisting on the one this console happens to sell.
    await assert.rejects(
      createClaudeRuntime({ cwd, agentDir, queryImpl: fakeQuery() }),
      /no Claude credential.*API key.*terminal/s,
    );

    // The person signed their own machine in. That is a credential, and a key
    // this console never saw is none of its business — it passes the
    // environment through untouched rather than overriding what Claude finds.
    await writeFile(join(config, '.credentials.json'), '{"claudeAiOauth":{"accessToken":"NOT-READ"}}');
    process.env.CLAUDE_CONFIG_DIR = config;
    const seen = [];
    const spy = options => { seen.push(options); return fakeQuery()(options); };
    const runtime = await createClaudeRuntime({ cwd, agentDir, queryImpl: spy });
    try {
      await runtime.command({ type: 'prompt', text: 'hello' });
      assert.equal('ANTHROPIC_API_KEY' in seen[0].options.env, false, 'nothing overrides the existing login');
      assert.equal(runtime.snapshot().credential, 'login');
      assert.ok(!JSON.stringify(runtime.snapshot()).includes('NOT-READ'));
    } finally { await runtime.close(); }
  } finally {
    delete process.env.CLAUDE_CONFIG_DIR;
    await rm(root, { recursive: true, force: true });
  }
});

test('the tab host runs both harnesses at once and says which is which', async () => {
  const { root, agentDir, cwd } = await workspace();
  await writeFile(join(cwd, 'AGENTS.md'), '# shared\n');
  const queryImpl = fakeQuery();
  // A stand-in Pi runtime: the tab host only ever asks for the four members.
  const fakePi = async () => {
    const events = new (await import('node:events')).EventEmitter();
    let name = '';
    return {
      events,
      snapshot: () => ({ sessionId: 'pi-1', sessionFile: 'pi-1', name, messages: [], busy: false, streaming: false }),
      command: async c => { if (c.type === 'name') name = c.name; return { ok: true }; },
      close: async () => {},
    };
  };
  const host = await createTabHost({
    cwd, agentDir, stateDir: join(root, 'state'),
    createRuntime: fakePi,
    createClaudeRuntime: opts => createClaudeRuntime({ ...opts, queryImpl, listSessionsImpl: async () => [] }),
  });
  try {
    assert.equal(host.snapshot().tabs.length, 1);
    assert.equal(host.snapshot().tabs[0].agent, 'pi', 'the machine still opens on Pi');

    await host.command({ type: 'tab-new', agent: 'claude' });
    const tabs = host.snapshot().tabs;
    assert.equal(tabs.length, 2);
    assert.deepEqual(tabs.map(t => t.agent), ['pi', 'claude']);
    assert.equal(host.snapshot().agent, 'claude', 'the focused tab is the Claude one');

    // Both are live at once: focus moves between them without closing either.
    await host.command({ type: 'tab-focus', tabId: tabs[0].id });
    assert.equal(host.snapshot().sessionId, 'pi-1');
    await host.command({ type: 'tab-focus', tabId: tabs[1].id });
    assert.equal(host.snapshot().agent, 'claude');

    // An unnamed agent is still Pi, so nothing that already called tab-new breaks.
    await host.command({ type: 'tab-new' });
    assert.equal(host.snapshot().tabs[2].agent, 'pi');
  } finally { await host.close(); await rm(root, { recursive: true, force: true }); }
});
