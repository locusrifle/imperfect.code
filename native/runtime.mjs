import { EventEmitter } from 'node:events';
import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync, realpathSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { readdir } from 'node:fs/promises';
import {
  createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices,
  SessionManager, getAgentDir, VERSION,
} from '@earendil-works/pi-coding-agent';
import { createExtensionUI } from './extension-ui.mjs';
import { createAuth } from './auth.mjs';
import { absorbUploads } from './uploads.mjs';

// Pi owns context, persistence, discovery, tools, compaction, retries and replacement.
// GUEY owns one runtime, independent of the number/lifetime of browser connections.
//
// Sessions live where Pi puts them, so the laptop TUI and this GUI are two
// front doors onto one archive: `pi --resume` sees what the phone wrote and the
// phone sees what the terminal wrote. Pi does not lock session files, so the
// single-writer rule is ours to keep — see `owner()` below. Leaving `sessionDir`
// unset makes service handoff work; desktop and tests use an isolated archive.
function messageLine(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n').trim();
}

function viewMessages(session) {
  const entries = session?.sessionManager?.getEntries?.();
  const live = session?.messages ?? [];
  if (!Array.isArray(entries) || !entries.length) return live;
  const messages = [];
  for (const entry of entries) {
    if (entry?.type === 'message' && entry.message) messages.push(entry.message);
    else if (entry?.type === 'custom_message') {
      messages.push({
        role: 'custom', customType: entry.customType, content: entry.content,
        display: entry.display, details: entry.details, timestamp: entry.timestamp,
      });
    } else if (entry?.type === 'compaction') {
      messages.push({
        role: 'compactionSummary', summary: entry.summary,
        tokensBefore: entry.tokensBefore, timestamp: entry.timestamp,
      });
    } else if (entry?.type === 'branch_summary') {
      messages.push({
        role: 'branchSummary', summary: entry.summary, fromId: entry.fromId, timestamp: entry.timestamp,
      });
    }
  }
  if (!messages.length) return live;
  // Persist waits for message_end. A live user prompt should still name the tab.
  const seen = new Set(messages.filter(m => m.role === 'user').map(m => messageLine(m.content)));
  for (const msg of live) {
    if (msg?.role !== 'user') continue;
    const line = messageLine(msg.content);
    if (!line || seen.has(line)) continue;
    messages.push(msg);
    seen.add(line);
  }
  return messages;
}

function tildePath(p) {
  const home = homedir();
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

function cwdRelative(p, cwd) {
  const abs = isAbsolute(p) ? resolve(p) : resolve(cwd, p);
  const rel = relative(resolve(cwd), abs);
  if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return rel;
  if (!rel) return '.';
  return tildePath(abs);
}

function compactPathLabel(p) {
  const parts = String(p ?? '').replace(/\\/g, '/').split('/').filter(Boolean);
  if (!parts.length) return p;
  const last = parts[parts.length - 1];
  if ((last === 'index.ts' || last === 'index.js') && parts.length > 1) return parts[parts.length - 2];
  return last;
}

function joinCompact(items) {
  return [...items].sort((a, b) => a.localeCompare(b)).join(', ');
}

function isNewerVersion(candidate, current) {
  const parts = v => String(v).split(/[.-]/).map(x => Number.parseInt(x, 10) || 0);
  const a = parts(candidate), b = parts(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d) return d > 0;
  }
  return false;
}

function startupFromLoader(loader, session, cwd) {
  const sections = [];
  const add = (name, compact, expanded) => {
    if (!compact) return;
    sections.push({ name, compact, expanded: expanded || compact });
  };
  const contextFiles = [
    ...(loader.getSystemPromptSource?.() ? [loader.getSystemPromptSource()] : []),
    ...(loader.getAppendSystemPromptSources?.() ?? []),
    ...(loader.getAgentsFiles?.().agentsFiles ?? []),
  ];
  if (contextFiles.length) {
    add('Context', contextFiles.map(f => cwdRelative(f.path, cwd)).join(', '), contextFiles.map(f => tildePath(f.path)).join('\n'));
  }
  const skills = loader.getSkills?.().skills ?? [];
  if (skills.length) {
    add('Skills', joinCompact(skills.map(s => s.name)), skills.map(s => tildePath(s.filePath ?? s.name)).join('\n'));
  }
  const templates = session.promptTemplates ?? loader.getPrompts?.().prompts ?? [];
  if (templates.length) {
    add('Prompts', joinCompact(templates.map(t => `/${t.name}`)), templates.map(t => `/${t.name}`).join('\n'));
  }
  const extensions = (loader.getExtensions?.().extensions ?? []).filter(e => !e.hidden);
  if (extensions.length) {
    add('Extensions', joinCompact(extensions.map(e => compactPathLabel(e.path))), extensions.map(e => tildePath(e.path.replace(/\/index\.(ts|js)$/, ''))).join('\n'));
  }
  const customThemes = (loader.getThemes?.().themes ?? []).filter(t => t.sourcePath);
  if (customThemes.length) {
    add('Themes', joinCompact(customThemes.map(t => t.name ?? compactPathLabel(t.sourcePath))), customThemes.map(t => tildePath(t.sourcePath)).join('\n'));
  }
  return {
    version: VERSION,
    quiet: Boolean(session.settingsManager?.getQuietStartup?.()),
    sections,
  };
}

export async function createRuntime({ cwd = process.cwd(), agentDir = getAgentDir(), stateDir, sessionDir, authentication = false, ownArchive = false, serviceOptions = {}, sessionPath = null, fresh = false, persistPointer = true } = {}) {
  const events = new EventEmitter();
  if (sessionDir) mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  const roots = ownArchive && sessionDir
    ? [resolve(sessionDir)]
    : [join(agentDir, 'sessions'), ...(sessionDir ? [resolve(sessionDir)] : [])];
  const pointer = join(stateDir, 'active-session');
  let runtime, unsubscribe, partial = null, runningTools = {}, operation = null, failed = null, preflights = 0;
  let updateRelease = null;
  const versionCheck = new AbortController();
  const changed = () => events.emit('change');
  const adapter = createExtensionUI(changed);
  const inside = path => roots.some(root => { try { return realpathSync(path).startsWith(realpathSync(root) + sep); } catch { return false; } });
  // A local imperfect session archive is the only automatic resume source.
  let sm = SessionManager.create(cwd, sessionDir);
  if (sessionPath) sm = SessionManager.open(sessionPath, sessionDir);
  else if (!fresh) try {
    const root = join(agentDir, 'sessions');
    const dirs = [];
    if (ownArchive && sessionDir) dirs.push(resolve(sessionDir));
    else {
      dirs.push(root, ...(sessionDir ? [resolve(sessionDir)] : []));
      const listing = await readdir(root, { withFileTypes: true }).catch(e => { if (e.code === 'ENOENT') return []; throw e; });
      for (const d of listing) if (d.isDirectory()) dirs.push(join(root, d.name));
    }
    const rows = (await Promise.all(dirs.map(dir => SessionManager.listAll(dir).catch(() => [])))).flat();
    const newest = rows
      .filter(s => s.cwd === cwd && s.path && inside(s.path) && existsSync(s.path))
      .sort((a, b) => new Date(b.modified) - new Date(a.modified))[0];
    if (newest) sm = SessionManager.open(newest.path, sessionDir);
  } catch {}
  if (persistPointer) try { unlinkSync(pointer); } catch {}
  const factory = async ({ cwd, sessionManager, sessionStartEvent }) => {
    const services = await createAgentSessionServices({ ...serviceOptions, cwd, agentDir });
    return { ...await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent }), services, diagnostics: services.diagnostics };
  };
  runtime = await createAgentSessionRuntime(factory, { cwd, agentDir, sessionManager: sm });
  const savePointer = () => {
    if (!persistPointer) return;
    const file = runtime.session.sessionFile;
    if (!file || !existsSync(file)) return;
    writeFileSync(pointer + '.tmp', file, { mode: 0o600 }); renameSync(pointer + '.tmp', pointer);
  };
  const assertIdle = () => {
    if (failed) throw new Error(`Runtime replacement failed; restart GUEY: ${failed}`);
    if (auth?.busy || operation || preflights || adapter.state.dialogs.length || !runtime.session.isIdle) throw new Error('Agent is busy; abort or wait before changing session/model');
  };
  const auth = authentication ? createAuth({ models: () => runtime.services.modelRuntime, changed, assertIdle, agentDir }) : null;
  const replace = async fn => {
    assertIdle(); operation = 'switching'; changed();
    try { return await fn(); }
    catch (error) { failed = error.message; throw error; }
    finally { operation = null; savePointer(); changed(); }
  };
  const listSessions = async () => {
    const own = sessionDir ? await SessionManager.listAll(sessionDir) : [];
    const root = join(agentDir, 'sessions');
    const dirs = await readdir(root, { withFileTypes: true }).catch(e => { if (e.code === 'ENOENT') return []; throw e; });
    const shared = (await Promise.all([root, ...dirs.filter(d => d.isDirectory()).map(d => join(root, d.name))].map(dir => SessionManager.listAll(dir).catch(() => [])))).flat();
    const files = [...own, ...shared.filter(s => !own.some(o => o.path === s.path))];
    return files.map(s => ({
      id: s.id, path: s.path, cwd: s.cwd, name: s.name, firstMessage: s.firstMessage,
      modified: s.modified, messageCount: s.messageCount,
      copyOnResume: Boolean(ownArchive && sessionDir && !inside(s.path)),
    }));
  };
  async function resume(path) {
    assertIdle();
    const item = (await listSessions()).find(s => s.path === path);
    if (!item) throw new Error('Unknown session; choose a listed session');
    // A session no live TUI holds is resumed in place: that is the handoff.
    // One a TUI still holds, or a shared Pi file under ownArchive, is forked.
    const target = item.copyOnResume ? SessionManager.forkFrom(item.path, item.cwd, sessionDir).getSessionFile() : item.path;
    const result = await replace(() => runtime.switchSession(target));
    if (result?.cancelled) throw new Error('Resume was cancelled');
    return result;
  }
  async function bind(session = runtime.session) {
    unsubscribe?.(); adapter.reset(); partial = null; runningTools = {};
    unsubscribe = session.subscribe(event => {
      if (event.type === 'message_update') partial = event.message ?? event.assistantMessageEvent?.partial ?? partial;
      if (event.type === 'message_start' && event.message.role === 'assistant') partial = event.message;
      if (event.type === 'message_end' && event.message.role === 'assistant') partial = null;
      if (event.type === 'tool_execution_start') runningTools[event.toolCallId] = { ...event, status: 'running' };
      if (event.type === 'tool_execution_update' && runningTools[event.toolCallId]) runningTools[event.toolCallId].result = event.partialResult;
      if (event.type === 'tool_execution_end') delete runningTools[event.toolCallId];
      if (event.type === 'agent_settled') { partial = null; runningTools = {}; savePointer(); }
      if (event.type === 'auto_retry_start') adapter.notify(event.errorMessage, 'warning');
      if (event.type === 'compaction_end' && event.errorMessage) adapter.notify(event.errorMessage, 'error');
      events.emit('event', event); changed();
    });
    await session.bindExtensions({
      mode: 'rpc', // Pi's supported headless-with-dialogs capability contract
      uiContext: adapter.ui,
      onError: e => adapter.notify(`${e.extensionPath}: ${e.error}`, 'error'),
      commandContextActions: {
        waitForIdle: () => runtime.session.waitForIdle(),
        newSession: options => runtime.newSession(options),
        switchSession: path => resume(path),
        fork: (id, options) => runtime.fork(id, options),
        navigateTree: (id, options) => runtime.session.navigateTree(id, options),
        reload: () => runtime.session.reload(),
      },
      shutdownHandler: () => adapter.notify('Extension requested shutdown. Stop the GUEY process when idle.', 'warning'),
    });
    changed();
  }
  runtime.setRebindSession(bind);
  await bind();
  if (!process.env.PI_OFFLINE && !process.env.PI_SKIP_VERSION_CHECK && !process.env.NODE_TEST_CONTEXT) {
    const timeout = AbortSignal.timeout(8000);
    const signal = AbortSignal.any([versionCheck.signal, timeout]);
    fetch('https://pi.dev/api/latest-version', { headers: { accept: 'application/json' }, signal })
      .then(async res => {
        if (!res.ok) return null;
        const data = await res.json();
        if (typeof data?.version !== 'string' || !data.version.trim()) return null;
        if (!isNewerVersion(data.version.trim(), VERSION)) return null;
        return { version: data.version.trim(), ...(typeof data.note === 'string' && data.note.trim() ? { note: data.note.trim() } : {}) };
      })
      .then(release => { if (release) { updateRelease = release; changed(); } })
      .catch(() => {});
  }
  function decorateStats(session, stats = {}) {
    let cacheHitRate = stats.cacheHitRate;
    for (const entry of session?.sessionManager?.getEntries?.() ?? []) {
      if (entry?.type !== 'message' || entry.message?.role !== 'assistant') continue;
      const usage = entry.message.usage ?? {};
      const prompt = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
      if (prompt > 0) cacheHitRate = ((usage.cacheRead ?? 0) / prompt) * 100;
    }
    const provider = session?.model?.provider;
    const usingSubscription = provider === 'kimi-coding' || Boolean(runtime.services.modelRuntime?.isUsingSubscription?.(provider));
    return { ...stats, cacheHitRate, usingSubscription };
  }
  function snapshot() {
    const s = runtime.session;
    const loader = runtime.services.resourceLoader;
    return {
      sessionId: s.sessionId, sessionFile: s.sessionFile, cwd: runtime.cwd,
      name: s.sessionManager.getSessionName(), model: s.model ? { id: s.model.id, provider: s.model.provider, name: s.model.name, contextWindow: s.model.contextWindow } : null, thinkingLevel: s.thinkingLevel,
      busy: !s.isIdle || Boolean(s.isCompacting) || Boolean(operation) || preflights > 0 || adapter.state.dialogs.length > 0 || Boolean(auth?.busy),
      // Model/compaction work only. Prompt preflight, dialogs and auth also set
      // busy so the composer waits, but they are not a finished model turn.
      streaming: !s.isIdle || Boolean(s.isCompacting),
      operation: s.isCompacting ? 'compacting' : operation, failed,
      ...(auth ? { auth: auth.snapshot() } : {}),
      commands: [...(s.extensionRunner?.getRegisteredCommands() ?? []).map(c => ({ name: c.invocationName, description: c.description })), ...s.promptTemplates.map(p => ({ name: p.name, description: p.description })), ...loader.getSkills().skills.map(s => ({ name: `skill:${s.name}`, description: s.description }))],
      messages: viewMessages(s), partial, runningTools: Object.values(runningTools),
      queue: { steering: s.getSteeringMessages(), followUp: s.getFollowUpMessages() },
      stats: decorateStats(s, s.getSessionStats()), ui: adapter.state,
      resources: { skills: loader.getSkills().skills.map(s => s.name), extensions: loader.getExtensions().extensions.map(e => e.path), tools: s.getAllTools().map(t => t.name) },
      startup: { ...startupFromLoader(loader, s, runtime.cwd), update: updateRelease },
      diagnostics: [...runtime.diagnostics, ...(runtime.modelFallbackMessage ? [{ type: 'warning', message: runtime.modelFallbackMessage }] : [])],
    };
  }
  async function command(c) {
    if (c.type === 'resume') {
      await resume(c.path);
      return;
    }
    const s = runtime.session;
    switch (c.type) {
      case 'snapshot': return snapshot();
      case 'sessions': return listSessions();
      case 'auth_providers': if (!auth) throw new Error('GUI login is not enabled for this service'); return auth.providers();
      case 'auth_accounts': if (!auth) throw new Error('GUI login is not enabled for this service'); return auth.accounts();
      case 'auth_login': if (!auth) throw new Error('GUI login is not enabled for this service'); return auth.login(c.provider, c.method);
      case 'auth_logout': if (!auth) throw new Error('GUI login is not enabled for this service'); return auth.logout(c.provider);
      case 'auth_answer': if (!auth) throw new Error('GUI login is not enabled for this service'); auth.answer(c.promptId, c.value); return;
      case 'auth_cancel': await auth?.cancel(); return;
      case 'auth_dismiss': auth?.dismiss(); return;
      case 'models': return (await runtime.services.modelRuntime.getAvailable()).map(m => ({ provider: m.provider, id: m.id, name: m.name }));
      case 'dialog': adapter.respond({ ...c, id: c.dialogId }); return;
      case 'abort': { await auth?.cancel(); const queue = s.clearQueue(); adapter.reset(); await s.abort(); changed(); return queue; }
      case 'dequeue': { const queue = s.clearQueue(); changed(); return queue; }
      case 'prompt': {
        if (auth?.busy) throw new Error('Finish or cancel sign-in before sending a prompt');
        if (failed || operation) throw new Error('Runtime unavailable');
        if (preflights) throw new Error('Another prompt is awaiting acceptance; wait or abort');
        const images = Array.isArray(c.images) ? c.images.filter(img => img && img.type === 'image' && typeof img.data === 'string' && typeof img.mimeType === 'string').slice(0, 8) : [];
        const text = absorbUploads(typeof c.text === 'string' ? c.text : '', c.files, runtime.cwd);
        if ((!text.trim() && !images.length) || text.length > 200000) throw new Error('Prompt must be 1–200000 characters, or include an image');
        if (c.behavior && !['steer','followUp'].includes(c.behavior)) throw new Error('Unknown queue behavior');
        // SDK prompt resolves on completion; acknowledge only its preflight boundary.
        return new Promise((resolve, reject) => {
          let accepted = false, pending = true;
          preflights++; changed();
          const finishPreflight = () => { if (pending) { pending = false; preflights--; changed(); } };
          s.prompt(text.trim() || 'See attached.', { source: 'rpc', streamingBehavior: c.behavior, ...(images.length ? { images } : {}), preflightResult: ok => { finishPreflight(); if (ok) { accepted = true; resolve({ accepted: true }); } } })
            .then(() => { finishPreflight(); if (!accepted) reject(new Error('Prompt was not accepted')); savePointer(); changed(); })
            .catch(error => { finishPreflight(); if (!accepted) reject(error); else adapter.notify(error.message, 'error'); changed(); });
        });
      }
      case 'new': return replace(() => runtime.newSession());
      case 'model': {
        assertIdle();
        const model = (await runtime.services.modelRuntime.getAvailable()).find(m => m.provider === c.provider && m.id === c.modelId);
        if (!model) throw new Error('Unknown or unauthenticated model');
        assertIdle(); await s.setModel(model, auth ? { persist: true } : undefined); changed(); return;
      }
      case 'name': assertIdle(); if (typeof c.name !== 'string') throw new Error('Name must be text'); s.setSessionName(c.name.slice(0,200)); changed(); return;
      case 'reload': assertIdle(); await s.reload(); changed(); return;
      case 'compact': assertIdle(); return s.compact(typeof c.text === 'string' ? c.text : undefined);
      case 'thinking': {
        if (c.level) { assertIdle(); s.setThinkingLevel(c.level); changed(); return s.thinkingLevel; }
        return { current: s.thinkingLevel, available: s.getAvailableThinkingLevels() };
      }
      case 'session': return {
        sessionId: s.sessionId, sessionFile: s.sessionFile, cwd: runtime.cwd,
        name: s.sessionManager.getSessionName(), thinkingLevel: s.thinkingLevel,
        model: s.model ? { id: s.model.id, provider: s.model.provider } : null,
        stats: s.getSessionStats(),
      };
      case 'copy': return s.getLastAssistantText() ?? '';
      case 'forks': return s.getUserMessagesForForking();
      case 'fork': return replace(() => runtime.fork(c.entryId, { position: c.position }));
      case 'tree': assertIdle(); return s.navigateTree(c.entryId);
      case 'settings': {
        const sm = s.settingsManager;
        if (!sm) throw new Error('Settings are unavailable');
        const read = () => ({
          defaultProvider: sm.getDefaultProvider(), defaultModel: sm.getDefaultModel(),
          defaultThinkingLevel: sm.getDefaultThinkingLevel(), hideThinkingBlock: sm.getHideThinkingBlock(),
          compaction: sm.getCompactionEnabled(), retry: sm.getRetryEnabled(),
          steeringMode: sm.getSteeringMode(), followUpMode: sm.getFollowUpMode(),
          defaultProjectTrust: sm.getDefaultProjectTrust(),
        });
        if (!c.key) return read();
        assertIdle();
        if (c.key === 'hideThinkingBlock') sm.setHideThinkingBlock(Boolean(c.value));
        else if (c.key === 'compaction') sm.setCompactionEnabled(Boolean(c.value));
        else if (c.key === 'retry') sm.setRetryEnabled(Boolean(c.value));
        else if (c.key === 'steeringMode') sm.setSteeringMode(c.value);
        else if (c.key === 'followUpMode') sm.setFollowUpMode(c.value);
        else if (c.key === 'defaultThinkingLevel') sm.setDefaultThinkingLevel(c.value);
        else if (c.key === 'defaultProjectTrust') sm.setDefaultProjectTrust(c.value);
        else throw new Error(`Unknown setting: ${c.key}`);
        await sm.flush(); changed(); return read();
      }
      default: throw new Error(`Unsupported command: ${c.type}`);
    }
  }
  return { events, snapshot, command, session: () => runtime.session, async close() { versionCheck.abort(); await auth?.cancel(); adapter.reset(); await runtime.session.abort(); savePointer(); unsubscribe?.(); await runtime.dispose(); } };
}
