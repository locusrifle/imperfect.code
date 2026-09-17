import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { query as sdkQuery, listSessions as sdkListSessions } from '@anthropic-ai/claude-agent-sdk';
import { createExtensionUI } from './extension-ui.mjs';
import { resolveClaudeAuth } from './claude-credentials.mjs';

// The second harness, behind the same four members the tab host already asks
// for: events, snapshot, command, close. Everything a person sees — the desk,
// the rail, the dialogs, the themes — is shared with Pi and knows nothing about
// which agent is underneath. What differs lives here and nowhere else.
//
// Pi and Claude are two agents in one workspace, so they must be told the same
// things about it. Pi reads AGENTS.md; Claude reads CLAUDE.md. Rather than keep
// two files that drift, the workspace gets a CLAUDE.md that imports AGENTS.md,
// and `settingSources: ['project']` is what makes it load at all.

const CONTEXT_POINTER = '@AGENTS.md\n';

export function shareContextFile(cwd) {
  const agents = join(cwd, 'AGENTS.md');
  const claude = join(cwd, 'CLAUDE.md');
  if (!existsSync(agents)) return null;
  // Never overwrite a CLAUDE.md somebody wrote. A person who has authored one
  // has said what they want Claude to read, and this is not a vote.
  if (existsSync(claude)) {
    const body = readFileSync(claude, 'utf8');
    return body.includes('@AGENTS.md') ? 'shared' : 'separate';
  }
  writeFileSync(claude, CONTEXT_POINTER, { mode: 0o644 });
  return 'written';
}

// The GUI renders Pi's message shape. Claude speaks the Anthropic Messages
// shape. This is the whole of the difference, and it is small: the names of
// four block types and where a tool result lives.
function blocksFromClaude(content) {
  const out = [];
  for (const block of Array.isArray(content) ? content : []) {
    if (block?.type === 'text') out.push({ type: 'text', text: block.text ?? '' });
    else if (block?.type === 'thinking') out.push({ type: 'thinking', thinking: block.thinking ?? '' });
    else if (block?.type === 'tool_use') out.push({ type: 'toolCall', id: block.id, name: block.name, arguments: block.input ?? {} });
    else if (block?.type === 'image') out.push({ type: 'image', ...block });
  }
  return out;
}

function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(b => b?.type === 'text').map(b => b.text).join('\n');
}

function messageLine(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n').trim();
}

export async function createClaudeRuntime({
  cwd = process.cwd(), agentDir = null, stateDir = null, sessionDir = null,
  sessionPath = null, fresh = false, persistPointer = true,
  queryImpl = sdkQuery, listSessionsImpl = sdkListSessions,
} = {}) {
  const events = new EventEmitter();
  const changed = () => events.emit('change');
  const adapter = createExtensionUI(changed);

  // A key is one way in, not the way in. If this machine is already signed in to
  // Claude — the person's own login, in their own home directory — that is the
  // credential, and the SDK finds it without anything from us. We only refuse
  // when there is no credential of any kind.
  const { key, source: credential } = resolveClaudeAuth(agentDir);
  if (!credential) {
    // The same honesty the provider list owes: a tab that cannot run says so
    // before it takes a prompt, naming both things that would fix it.
    throw new Error('This machine has no Claude credential. Sign in to Claude Agent with an API key, or run `claude` in a terminal here and sign in once.');
  }
  const context = shareContextFile(cwd);

  let keySource = null;
  let messages = [];
  let partial = null;
  let runningTools = {};
  const toolNames = new Map();
  let sessionId = sessionPath && !fresh ? sessionPath : null;
  let model = null;
  let claudeVersion = null;
  let availableTools = [];
  let commands = [];
  let streaming = false;
  let failed = null;
  let closed = false;
  let lastResult = null;
  let stats = { tokens: { input: 0, output: 0 }, cost: 0 };
  let sessionName = '';

  const pointer = stateDir ? join(stateDir, 'active-claude-session') : null;
  const savePointer = () => {
    if (!persistPointer || !pointer || !sessionId) return;
    try {
      mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      writeFileSync(`${pointer}.tmp`, sessionId, { mode: 0o600 });
      renameSync(`${pointer}.tmp`, pointer);
    } catch { /* a pointer is a convenience, never the session itself */ }
  };

  // Streaming input mode is what buys interrupt(), setModel() and a session
  // that outlives one prompt — the same shape as Pi's long-lived runtime.
  const inbox = [];
  let wake = null;
  async function* outbound() {
    while (!closed) {
      if (inbox.length) { yield inbox.shift(); continue; }
      await new Promise(resolve => { wake = resolve; });
    }
  }
  const nudge = () => { const w = wake; wake = null; w?.(); };

  const options = {
    cwd,
    // A key is handed to this subprocess only, never set on the machine's own
    // environment. With no key we pass the environment through untouched and
    // let the SDK resolve the existing login itself — setting an empty
    // ANTHROPIC_API_KEY here would override the very credential we mean to use.
    env: key ? { ...process.env, ANTHROPIC_API_KEY: key } : { ...process.env },
    // 'project' is required for CLAUDE.md to load at all, which is what makes
    // the AGENTS.md pointer above mean anything.
    settingSources: ['project', 'user'],
    includePartialMessages: true,
    permissionMode: 'default',
    ...(sessionId && !fresh ? { resume: sessionId } : {}),
    // Pi asks the person before a tool runs, through dialogs the GUI already
    // draws. Claude asks through canUseTool; same dialog, same adapter.
    canUseTool: async (request, { signal }) => {
      const name = request?.tool_name ?? request?.name ?? 'a tool';
      const allowed = await adapter.ui.confirm(`Run ${name}?`, describeToolRequest(request), { signal });
      return allowed
        ? { behavior: 'allow', updatedInput: request?.input ?? request?.tool_input ?? {} }
        : { behavior: 'deny', message: 'The person declined this tool call.' };
    },
  };

  let q = null;
  let pumping = null;

  function describeToolRequest(request) {
    const input = request?.input ?? request?.tool_input ?? {};
    try {
      const text = JSON.stringify(input, null, 2);
      return text.length > 2000 ? `${text.slice(0, 2000)}…` : text;
    } catch { return ''; }
  }

  function absorb(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.session_id && msg.session_id !== sessionId) { sessionId = msg.session_id; savePointer(); }
    switch (msg.type) {
      case 'system':
        if (msg.subtype === 'init') {
          claudeVersion = msg.claude_code_version ?? claudeVersion;
          // Which credential the session actually used, in the SDK's own words.
          // 'none' here is the subscription login, and the tab should be able to
          // say so rather than leaving a person to guess what is being billed.
          if (msg.apiKeySource) keySource = msg.apiKeySource;
          model = msg.model ? { id: msg.model, provider: 'claude-agent', name: msg.model, contextWindow: null } : model;
          availableTools = Array.isArray(msg.tools) ? msg.tools : availableTools;
          if (Array.isArray(msg.slash_commands)) commands = msg.slash_commands.map(name => ({ name: `/${String(name).replace(/^\//, '')}`, description: '' }));
        }
        break;
      case 'stream_event': {
        // Text as it arrives, so the console is never a surface waiting on a
        // round trip before it shows anything.
        const event = msg.event;
        if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
          partial = { ...(partial ?? { content: [] }) };
          partial.text = `${partial.text ?? ''}${event.delta.text ?? ''}`;
          changed();
        } else if (event?.type === 'message_stop') { partial = null; changed(); }
        break;
      }
      case 'assistant': {
        partial = null;
        const content = blocksFromClaude(msg.message?.content);
        for (const block of content) if (block.type === 'toolCall') {
          toolNames.set(block.id, block.name);
          runningTools = { ...runningTools, [block.id]: { id: block.id, name: block.name, arguments: block.arguments } };
        }
        if (content.length) messages = [...messages, { role: 'assistant', content, ...(msg.error ? { errorMessage: String(msg.error.message ?? msg.error) } : {}) }];
        changed();
        break;
      }
      case 'user': {
        // A user frame carrying tool_result blocks is Claude reporting a tool,
        // not a person typing. Only the results become rows.
        const blocks = Array.isArray(msg.message?.content) ? msg.message.content : [];
        const results = blocks.filter(b => b?.type === 'tool_result');
        if (!results.length) break;
        const rows = results.map(r => {
          const { [r.tool_use_id]: _done, ...rest } = runningTools;
          runningTools = rest;
          return {
            role: 'toolResult', toolCallId: r.tool_use_id,
            toolName: toolNames.get(r.tool_use_id) ?? 'tool',
            output: toolResultText(r.content), isError: Boolean(r.is_error),
          };
        });
        messages = [...messages, ...rows];
        changed();
        break;
      }
      case 'result': {
        streaming = false;
        partial = null;
        runningTools = {};
        lastResult = msg.subtype ?? 'success';
        if (msg.subtype && msg.subtype !== 'success') failed = msg.subtype;
        const usage = msg.usage ?? {};
        stats = {
          tokens: { input: usage.input_tokens ?? stats.tokens.input, output: usage.output_tokens ?? stats.tokens.output },
          cost: msg.total_cost_usd ?? stats.cost,
        };
        savePointer();
        changed();
        break;
      }
      default:
        break;
    }
  }

  function start() {
    q = queryImpl({ prompt: outbound(), options });
    pumping = (async () => {
      try { for await (const msg of q) absorb(msg); }
      catch (error) {
        if (!closed) { failed = error?.message ?? String(error); streaming = false; changed(); }
      }
    })();
  }
  start();

  function snapshot() {
    return {
      agent: 'claude',
      credential, keySource,
      sessionId, sessionFile: sessionId, cwd,
      name: sessionName,
      model, thinkingLevel: null,
      busy: streaming || adapter.state.dialogs.length > 0,
      streaming,
      operation: null, failed,
      takenOver: null,
      commands,
      messages, partial, runningTools: Object.values(runningTools),
      queue: { steering: [], followUp: inbox.map(m => messageLine(m.message?.content)).filter(Boolean) },
      stats, ui: adapter.state,
      resources: { skills: [], extensions: [], tools: availableTools },
      startup: {
        version: claudeVersion ? `claude ${claudeVersion}` : 'claude',
        quiet: false,
        sections: contextSections(),
        update: null,
      },
      diagnostics: contextDiagnostics(),
    };
  }

  function contextSections() {
    const sections = [];
    if (context === 'shared' || context === 'written') {
      sections.push({ name: 'Context', compact: 'AGENTS.md', expanded: join(cwd, 'AGENTS.md') });
    }
    if (availableTools.length) sections.push({ name: 'Tools', compact: `${availableTools.length} tools`, expanded: availableTools.join('\n') });
    return sections;
  }

  function contextDiagnostics() {
    const out = [];
    if (context === 'separate') {
      out.push({ type: 'warning', message: 'This workspace has its own CLAUDE.md, so Claude and Pi are reading different instructions. Add @AGENTS.md to share them.' });
    }
    if (failed) out.push({ type: 'error', message: `Claude: ${failed}` });
    return out;
  }

  function submit(text, attachments = []) {
    const blocks = [{ type: 'text', text }];
    for (const file of attachments) if (file?.type === 'image') blocks.push(file);
    inbox.push({ type: 'user', message: { role: 'user', content: blocks }, parent_tool_use_id: null, session_id: sessionId ?? '' });
    messages = [...messages, { role: 'user', content: blocks }];
    if (!sessionName) sessionName = text.split('\n').map(s => s.trim()).find(Boolean)?.slice(0, 200) ?? '';
    streaming = true;
    failed = null;
    nudge();
    changed();
  }

  const unsupported = name => { throw new Error(`${name} is a Pi feature; this tab is running Claude.`); };

  async function command(c) {
    const type = c?.type;
    switch (type) {
      case 'snapshot': return snapshot();
      case 'dialog': adapter.respond({ ...c, id: c.dialogId }); return;
      case 'prompt': {
        if (streaming) throw new Error('Claude is still working; abort or wait');
        const text = typeof c.text === 'string' ? c.text.trim() : '';
        if (!text) throw new Error('A prompt is required');
        submit(text, Array.isArray(c.attachments) ? c.attachments : []);
        return { accepted: true };
      }
      case 'abort': {
        adapter.reset();
        const queued = inbox.splice(0, inbox.length).map(m => messageLine(m.message?.content)).filter(Boolean);
        try { await q?.interrupt?.(); } catch { /* an interrupt on an idle turn is not an error */ }
        streaming = false; partial = null; runningTools = {};
        changed();
        return queued;
      }
      case 'dequeue': {
        const queued = inbox.splice(0, inbox.length).map(m => messageLine(m.message?.content)).filter(Boolean);
        changed();
        return queued;
      }
      case 'models': {
        try { return (await q.supportedModels()).map(m => ({ provider: 'claude-agent', id: m.id ?? m.model, name: m.displayName ?? m.name ?? m.id })); }
        catch { return model ? [{ provider: 'claude-agent', id: model.id, name: model.name }] : []; }
      }
      case 'model': {
        if (streaming) throw new Error('Claude is still working; abort or wait');
        await q.setModel(c.modelId);
        model = { id: c.modelId, provider: 'claude-agent', name: c.modelId, contextWindow: null };
        changed();
        return { id: c.modelId };
      }
      case 'name': {
        if (typeof c.name !== 'string') throw new Error('Name must be text');
        sessionName = c.name.slice(0, 200);
        changed();
        return;
      }
      case 'sessions': {
        const rows = await listSessionsImpl({ cwd }).catch(() => []);
        return rows.map(s => ({
          id: s.sessionId ?? s.id, path: s.sessionId ?? s.id, name: s.title ?? '',
          cwd: s.cwd ?? cwd, modified: s.updatedAt ?? s.modifiedAt ?? null,
          agent: 'claude', live: false, takenOver: null,
        }));
      }
      case 'session': return { id: sessionId, file: sessionId, cwd, agent: 'claude' };
      case 'copy': {
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i].role !== 'assistant') continue;
          const text = messages[i].content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
          if (text) return text;
        }
        return '';
      }
      case 'live': return [];
      case 'detach': return;
      case 'settings': return { settings: [], message: 'Claude reads its settings from .claude/ and ~/.claude/, not from this panel.' };
      // Named rather than silently ignored: a verb that quietly does nothing is
      // indistinguishable from one that is broken.
      case 'attach': return unsupported('Attaching to a terminal session');
      case 'compact': return unsupported('/compact');
      case 'thinking': return unsupported('Thinking levels');
      case 'fork': case 'forks': case 'tree': return unsupported('Session forking');
      case 'reload': return unsupported('/reload');
      default: throw new Error(`Unsupported command: ${type}`);
    }
  }

  return {
    events, snapshot, command,
    session: () => ({ sessionId, cwd }),
    async close() {
      closed = true;
      adapter.reset();
      nudge();
      try { await q?.interrupt?.(); } catch { /* already stopped */ }
      try { q?.return?.(undefined); } catch { /* generator already done */ }
      await pumping?.catch(() => {});
      if (persistPointer && pointer) { try { unlinkSync(pointer); } catch { /* nothing to clear */ } }
    },
  };
}
