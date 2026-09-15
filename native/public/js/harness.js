// The pi conversation, drawn into locus.site's terminal.
//
// site.js owns the ground: the ruling, the drop, the phone keyboard.
// This file owns what is inside the screen, and it talks to a Pi SDK session
// over this origin's websocket — one snapshot of the whole state at a time,
// commands back. Nothing here reimplements Pi; it renders what Pi reports.
//
// Everything is built as nodes, never innerHTML: tool output is whatever the
// agent read off the disk, and it lands in this document.

import { mountAuth } from './auth.js';
import { createDictation, attachHoldSpace } from './dictation.js';
import { capturePng } from './capture.js';
import { mountWorldWindows } from './review-window.js';
import { SETTING_DEFS, displayValue, cycleValue } from './settings-fields.js';
import { assistantTextFromMessage, composerBlockReason, latestCompletedAssistant } from './session-logic.js';
import { postUpload, uploadPercent, MAX_UPLOAD_BYTES } from './uploads.js';
import { takeSharedFiles, clearSharedFiles } from './share-target.js';
import { meterBar, percentLabel, readingAge, resetText } from './usage.js';

const el = (tag, text, className) => {
	const node = document.createElement(tag);
	if (text != null) node.textContent = text;
	if (className) node.className = className;
	return node;
};

function imageSrc(block) {
	const mime = String(block?.mimeType ?? '');
	if (!/^image\/[a-z0-9.+-]+$/i.test(mime) || typeof block.data !== 'string' || !block.data) return null;
	return `data:${mime};base64,${block.data}`;
}

function imageNode(block, alt) {
	const src = imageSrc(block);
	if (!src) return null;
	const img = document.createElement('img');
	img.className = 'entry-image';
	img.alt = alt;
	img.src = src;
	return img;
}

// Enough markdown to read a reply: bold and CommonMark codespans (`` `code` ``),
// matching Pi's marked renderer for those two. Nothing here can carry markup.
function formatInto(node, text) {
	let i = 0;
	while (i < text.length) {
		if (text.startsWith('**', i)) {
			const end = text.indexOf('**', i + 2);
			if (end > i + 2 && !text.slice(i + 2, end).includes('\n\n')) {
				const strong = el('strong');
				formatInto(strong, text.slice(i + 2, end));
				node.append(strong);
				i = end + 2;
				continue;
			}
		}
		if (text[i] === '`') {
			let n = 1;
			while (text[i + n] === '`') n++;
			const fence = '`'.repeat(n);
			const close = text.indexOf(fence, i + n);
			if (close !== -1) {
				let body = text.slice(i + n, close);
				if (!body.includes('\n')) {
					if (body.length > 1 && body.startsWith(' ') && body.endsWith(' ')) body = body.slice(1, -1);
					node.append(el('code', body));
					i = close + n;
					continue;
				}
			}
		}
		const from = i + 1;
		const nextBold = text.indexOf('**', from);
		const nextTick = text.indexOf('`', from);
		let next = text.length;
		if (nextBold !== -1) next = Math.min(next, nextBold);
		if (nextTick !== -1) next = Math.min(next, nextTick);
		if (text.startsWith('**', i) || text[i] === '`') {
			node.append(text[i]);
			i += 1;
		} else {
			node.append(text.slice(i, next));
			i = next;
		}
	}
}

const SPIN = ['·', '✢', '✦', '✳', '✦', '✢'];
const WORK_SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SLASH_VIEW = {
	'/settings': ['settings', 'Open settings menu'],
	'/model': ['model', '<provider/model> – Select model (opens selector UI)'],
	'/tree': ['tree', 'Navigate session tree (switch branches)'],
	'/thinking': ['thinking', '<level> – Set thinking level'],
	'/scoped-models': ['scoped-models', 'Enable/disable models for Ctrl+P cycling'],
	'/export': ['export', 'Export session (HTML default, or specify path: .html/.jsonl)'],
	'/import': ['import', 'Import and resume a session from a JSONL file'],
	'/share': ['share', 'Share session as a secret GitHub gist'],
	'/copy': ['copy', 'Copy last agent message to clipboard'],
	'/name': ['name', 'Set session display name'],
	'/session': ['session', 'Show session info and stats'],
	'/changelog': ['changelog', 'Show changelog entries'],
	'/hotkeys': ['hotkeys', 'Show all keyboard shortcuts'],
	'/fork': ['fork', 'Create a new fork from a previous user message'],
	'/clone': ['clone', 'Duplicate the current session at the current position'],
	'/trust': ['trust', 'Save project trust decision for future sessions'],
	'/login': ['login', '<provider> – Configure provider authentication'],
	'/logout': ['logout', 'Remove provider authentication'],
	'/new': ['new', 'Start a new session'],
	'/compact': ['compact', 'Manually compact the session context'],
	'/resume': ['resume', 'Resume a different session'],
	'/reload': ['reload', 'Reload keybindings, extensions, skills, prompts, themes, and context files'],
	'/quit': ['quit', 'Quit Guey'],
};
const STOCK_SLASH_ORDER = Object.keys(SLASH_VIEW);
const STOCK_SLASH_VISIBLE = 5;
const TOOL_PREVIEW_LINES = 8;
const BASH_PREVIEW_LINES = 5;
const COMPACT_RESOURCE_FILE_NAMES = new Set(['AGENTS.override.md', 'AGENTS.md', 'AGENTS.MD', 'CLAUDE.md', 'CLAUDE.MD']);
const STARTUP_COMPACT_HINTS = [
	['escape', 'interrupt'],
	['ctrl+c/ctrl+d', 'clear/exit'],
	['/', 'commands'],
	['!', 'bash'],
	['ctrl+o', 'more'],
];
const STARTUP_EXPANDED_HINTS = [
	['escape', 'to interrupt'],
	['ctrl+c', 'to clear'],
	['ctrl+c twice', 'to exit'],
	['ctrl+d', 'to exit (empty)'],
	['ctrl+z', 'to suspend'],
	['ctrl+k', 'to delete to end'],
	['shift+tab', 'to cycle thinking level'],
	['ctrl+p/shift+ctrl+p', 'to cycle models'],
	['ctrl+l', 'to select model'],
	['ctrl+o', 'to expand tools'],
	['ctrl+t', 'to expand thinking'],
	['ctrl+g', 'for external editor'],
	['/', 'for commands'],
	['!', 'to run bash'],
	['!!', 'to run bash (no context)'],
	['alt+enter', 'to queue follow-up'],
	['alt+up', 'to edit all queued messages'],
	['ctrl+v', 'to paste image (with text fallback)'],
	['drop files', 'to attach'],
];

function boundText(text, max = TOOL_PREVIEW_LINES, hint = '+ to expand') {
	const raw = String(text ?? '');
	const lines = raw.split('\n');
	if (lines.length <= max) return raw;
	const hidden = lines.length - max;
	return `... (${hidden} earlier lines, ${hint})\n${lines.slice(-max).join('\n')}`;
}

function formatTokens(count) {
	if (!Number.isFinite(count) || count <= 0) return '';
	if (count < 1000) return String(Math.round(count));
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function footerLeft(stats = {}, autoCompact = true) {
	const tokens = stats.tokens ?? {};
	const parts = [];
	if (tokens.input) parts.push(`↑${formatTokens(tokens.input)}`);
	if (tokens.output) parts.push(`↓${formatTokens(tokens.output)}`);
	if (tokens.cacheRead) parts.push(`R${formatTokens(tokens.cacheRead)}`);
	if (tokens.cacheWrite) parts.push(`W${formatTokens(tokens.cacheWrite)}`);
	if ((tokens.cacheRead || tokens.cacheWrite) && stats.cacheHitRate != null) parts.push(`CH${Number(stats.cacheHitRate).toFixed(1)}%`);
	else {
		const prompt = (tokens.input ?? 0) + (tokens.cacheRead ?? 0) + (tokens.cacheWrite ?? 0);
		if (prompt && tokens.cacheRead) parts.push(`CH${((tokens.cacheRead / prompt) * 100).toFixed(1)}%`);
	}
	if (stats.cost || stats.usingSubscription) {
		parts.push(`$${(stats.cost ?? 0).toFixed(3)}${stats.usingSubscription ? ' (sub)' : ''}`);
	} else if (stats.cost != null) {
		parts.push(`$${(stats.cost ?? 0).toFixed(3)}`);
	}
	const usage = stats.contextUsage ?? {};
	const window = usage.contextWindow ?? 0;
	const auto = autoCompact ? ' (auto)' : '';
	const percent = usage.percent == null ? '?' : Number(usage.percent).toFixed(1);
	parts.push(window ? `${percent}%/${formatTokens(window)}${auto}` : '');
	return parts.filter(Boolean).join(' ');
}

function contextChip(stats = {}) {
	const usage = stats.contextUsage ?? {};
	const window = usage.contextWindow ?? 0;
	if (!window) return '';
	const percent = usage.percent == null ? '?' : String(Math.round(Number(usage.percent)));
	return `${percent}%/${formatTokens(window)}`;
}

function boundBody(text, max = TOOL_PREVIEW_LINES, hint) {
	const raw = String(text ?? '');
	if (raw.startsWith('$ ')) {
		const split = raw.indexOf('\n\n');
		if (split === -1) return raw.length > 4000 ? `${raw.slice(0, 4000)}\n...` : raw;
		return `${raw.slice(0, split)}\n\n${boundText(raw.slice(split + 2), max, hint)}`;
	}
	return boundText(raw, max, hint);
}

function parseToolArgs(args) {
	if (args && typeof args === 'object') return args;
	if (typeof args === 'string') {
		try { const parsed = JSON.parse(args); if (parsed && typeof parsed === 'object') return parsed; } catch {}
	}
	return null;
}

function toolCommand(name, args) {
	const parsed = parseToolArgs(args);
	if (parsed) {
		if (typeof parsed.command === 'string') return name === 'bash' ? `$ ${parsed.command}` : parsed.command;
		const first = parsed.path ?? parsed.file_path ?? parsed.file ?? parsed.query;
		if (typeof first === 'string') return first;
	}
	return typeof args === 'string' ? args : JSON.stringify(parsed ?? {}, null, 2);
}

function fileNameOf(path) {
	const raw = String(path ?? '');
	const parts = raw.replace(/\\/g, '/').split('/');
	return parts[parts.length - 1] || raw;
}

function parentNameOf(path) {
	const raw = String(path ?? '').replace(/\\/g, '/').replace(/\/$/, '');
	const parts = raw.split('/');
	return parts.length > 1 ? parts[parts.length - 2] : '';
}

function compactReadKind(path) {
	const file = fileNameOf(path);
	if (file === 'SKILL.md') return { kind: 'skill', label: parentNameOf(path) || file };
	if (file === 'README.md' || /(^|\/)docs\//.test(String(path).replace(/\\/g, '/')) || /(^|\/)examples\//.test(String(path).replace(/\\/g, '/'))) {
		return { kind: 'docs', label: path };
	}
	if (COMPACT_RESOURCE_FILE_NAMES.has(file)) return { kind: 'resource', label: path };
	return null;
}

function readRangeSuffix(args) {
	if (!args || (args.offset === undefined && args.limit === undefined)) return '';
	const startLine = args.offset ?? 1;
	const endLine = args.limit !== undefined ? startLine + args.limit - 1 : '';
	return `:${startLine}${endLine ? `-${endLine}` : ''}`;
}

function toolOutputText(result) {
	if (!result) return '';
	if (typeof result.content === 'string') return result.content;
	const blocks = result.content ?? [];
	const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('\n');
	const extra = result.details?.patch ? `\n${result.details.patch}` : '';
	return text + extra;
}

function toolDurationMs(parts) {
	for (const part of parts) {
		if (!part) continue;
		const details = part.details ?? {};
		if (Number.isFinite(details.durationMs)) return details.durationMs;
		if (Number.isFinite(part.durationMs)) return part.durationMs;
		const start = part.startedAt ?? details.startedAt;
		const end = part.endedAt ?? details.endedAt;
		if (Number.isFinite(start) && Number.isFinite(end) && end >= start) return end - start;
	}
	return null;
}

function collectToolCalls(messages) {
	const ids = new Set();
	for (const entry of messages ?? []) {
		if (entry?.role !== 'assistant') continue;
		for (const block of Array.isArray(entry.content) ? entry.content : []) {
			if (block?.type === 'toolCall' && block.id) ids.add(block.id);
		}
	}
	return ids;
}

function collectToolResults(messages) {
	const map = new Map();
	for (const entry of messages ?? []) {
		if (entry?.role === 'toolResult' && entry.toolCallId) map.set(entry.toolCallId, entry);
	}
	return map;
}

function thinkingText(text) {
	return String(text ?? '').replace(/\*\*/g, '');
}

function compactResourceLabel(path) {
	const parts = String(path ?? '').replace(/\\/g, '/').split('/').filter(Boolean);
	if (!parts.length) return path;
	const last = parts[parts.length - 1];
	if ((last === 'index.ts' || last === 'index.js') && parts.length > 1) return parts[parts.length - 2];
	return last;
}

function derivedStartupSections(resources = {}) {
	const sections = [];
	const skills = resources.skills ?? [];
	if (skills.length) sections.push({ name: 'Skills', compact: [...skills].sort().join(', '), expanded: [...skills].sort().join('\n') });
	const prompts = resources.prompts ?? [];
	if (prompts.length) sections.push({ name: 'Prompts', compact: prompts.map(p => p.startsWith('/') ? p : `/${p}`).join(', '), expanded: prompts.join('\n') });
	const extensions = resources.extensions ?? [];
	if (extensions.length) {
		const labels = extensions.map(compactResourceLabel);
		sections.push({ name: 'Extensions', compact: [...labels].sort().join(', '), expanded: extensions.join('\n') });
	}
	const themes = resources.themes ?? [];
	if (themes.length) sections.push({ name: 'Themes', compact: [...themes].sort().join(', '), expanded: themes.join('\n') });
	return sections;
}

export function mountGueyPi({ elements, hooks = {}, personal = true }) {
	const { output, input, dialog, widgets, slashMenu, modelStatus, modelName, spend, thinking, sessionTitle, sessionSource, sessionCwd, context, screen } = elements;
	let themeRev = 0;
	let socket = null, state = null, serial = 0, lastEditor = null, spin = 0, spinner = null;
	const pending = new Map();
	const guiListeners = new Set();
	const turnListeners = new Set();
	const open = new Set();      // tool slabs the reader expanded, by id
	let expandAll = false;
	let overlay = null;          // a picker we are showing in #entry-dialog
	let slashIndex = 0;
	let lastSlashDraft = '';
	let keptDraft = '';
	const world = personal ? mountWorldWindows({
		host: (id, title) => hooks.slot?.(id, title),
		release: (id) => hooks.release?.(id),
		onClose: (id) => { command('window-close', { windowId: id }).catch(() => {}); },
		onOpen: () => { hooks.onWindowOpen?.(); },
	}) : { spawn: async () => {}, close: () => {}, sync: () => {} };
	const inputZone = input?.closest?.('#entry-input-zone');
	let work = document.getElementById('entry-work');
	if (inputZone && !work) {
		work = el('div', null, 'entry-work');
		work.id = 'entry-work';
		work.hidden = true;
		inputZone.prepend(work);
	}
	let queueBox = document.getElementById('entry-queue');
	if (!queueBox) {
		queueBox = el('div', null, 'entry-queue');
		queueBox.id = 'entry-queue';
		queueBox.hidden = true;
		if (!personal && inputZone) inputZone.before(queueBox);
	}
	let flash = document.getElementById('entry-flash');
	if (inputZone && !flash) {
		flash = el('div', null, 'entry-flash');
		flash.id = 'entry-flash';
		flash.hidden = true;
		inputZone.before(flash);
	}
	let flashTimer = 0;
	const showFlash = text => {
		if (!flash) return;
		const value = String(text ?? '').trim();
		flash.hidden = !value;
		flash.textContent = value;
		clearTimeout(flashTimer);
		if (value) flashTimer = setTimeout(() => showFlash(''), 2500);
	};
	async function restartGuey() {
		showFlash('Restarting Guey…');
		try { await command('guey-restart'); } catch { /* process dies mid-reply */ }
		location.reload();
	}

	/* ------------------------------------------------------------- transport */
	function command(type, fields = {}) {
		if (socket?.readyState !== WebSocket.OPEN) return Promise.reject(new Error('not connected'));
		const id = String(++serial);
		return new Promise((resolve, reject) => {
			pending.set(id, { resolve, reject });
			socket.send(JSON.stringify({ id, type, ...fields }));
		});
	}
	function kind() {
		return matchMedia('(pointer: coarse)').matches || innerWidth < 700 ? 'phone' : 'desktop';
	}
	function hello() {
		command('hello', {
			kind: kind(), width: innerWidth, height: innerHeight, dpr: devicePixelRatio || 1,
			visible: document.visibilityState === 'visible',
		}).catch(() => {});
	}
	let connectGen = 0;
	let reconnectTimer = null;
	const AudioCtx = window.AudioContext || window.webkitAudioContext;
	let doneAudio = null;
	function unlockDoneSound() {
		if (!AudioCtx) return;
		if (!doneAudio) doneAudio = new AudioCtx();
		if (doneAudio.state === 'suspended') void doneAudio.resume();
	}
	function playDoneSound() {
		window.__gueyDoneSounds = (window.__gueyDoneSounds || 0) + 1; // browser test reads this
		try {
			unlockDoneSound();
			if (!doneAudio || doneAudio.state === 'suspended') return;
			const osc = doneAudio.createOscillator();
			const gain = doneAudio.createGain();
			const now = doneAudio.currentTime;
			osc.type = 'sine';
			osc.frequency.value = 880;
			gain.gain.setValueAtTime(0.05, now);
			gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);
			osc.connect(gain);
			gain.connect(doneAudio.destination);
			osc.start(now);
			osc.stop(now + 0.2);
		} catch {}
	}
	function focusedTabId() {
		return (state?.tabs ?? []).find(tab => tab.focused)?.id ?? null;
	}
	function guiSnapshot() {
		return {
			sessionId: state?.sessionId ?? null,
			tabId: focusedTabId(),
			busy: Boolean(state?.busy),
			streaming: Boolean(state?.streaming),
			failed: state?.failed ?? null,
			messages: state?.messages ?? [],
			tabs: state?.tabs ?? [],
			windows: state?.windows ?? [],
		};
	}
	function emitGui() {
		const snap = guiSnapshot();
		for (const fn of guiListeners) {
			try { fn(snap); } catch {}
		}
	}
	function pingDone() {
		const looking = document.visibilityState === 'visible';
		// Phone and desktop both hear the finish while looking. A new AudioContext
		// at settle time is suspended, so we keep one unlocked on input. OS banners
		// only when the page is hidden — looking already has the tone.
		playDoneSound();
		if (looking) return;
		if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
			try { new Notification(personal ? 'imperfect' : 'Guey', { body: 'done', silent: false }); } catch {}
		}
	}
	function connect() {
		if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
		clearTimeout(reconnectTimer);
		const gen = ++connectGen;
		const next = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/pi`);
		socket = next;
		next.onopen = () => { showFlash(''); hello(); };
		next.onmessage = event => {
			const message = JSON.parse(event.data);
			if (message.type === 'turn') {
				const info = {
					sessionId: message.sessionId ?? state?.sessionId ?? null,
					tabId: message.id ?? focusedTabId(),
					failed: message.failed ?? null,
					answer: message.answer ?? null,
				};
				if (info.tabId == null || info.tabId === focusedTabId()) pingDone();
				for (const fn of turnListeners) {
					try { fn(info); } catch {}
				}
			}
			if (message.type === 'snapshot') {
				state = message.data;
				render();
				emitGui();
				if (personal) world.sync(state.windows);
			}
			if (message.type === 'control' && message.name === 'capture') {
				capturePng()
					.then(shot => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ id: message.id, type: 'control-result', ...shot })); })
					.catch(error => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ id: message.id, type: 'control-result', error: error.message })); });
			}
			if (message.type === 'control' && (message.name === 'window-open' || message.name === 'window-close')) {
				const job = message.name === 'window-open'
					? world.spawn(message.window || {})
					: Promise.resolve(world.close(message.windowId));
				job.then(() => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ id: message.id, type: 'control-result' })); })
					.catch(error => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ id: message.id, type: 'control-result', error: error.message })); });
			}
			if (message.type === 'response') {
				const waiter = pending.get(message.id);
				pending.delete(message.id);
				if (waiter) message.success ? waiter.resolve(message.data) : waiter.reject(new Error(message.error));
			}
		};
		next.onclose = () => {
			if (gen !== connectGen) return;
			for (const waiter of pending.values()) waiter.reject(new Error('connection lost'));
			pending.clear();
			if (socket === next) socket = null;
			if (modelStatus) modelStatus.textContent = 'reconnecting';
			reconnectTimer = setTimeout(connect, 1000);
		};
		next.onerror = () => {};
	}
	// The model picker lives inside the drop, and the drop is up when the sign-in dialog closes:
	// pressing "Choose a default model" opened a list nobody could see. Summon the console first.
	const auth = mountAuth({ command, chooseModel: () => { hooks.onReveal?.(); run('/model'); } });
	const fail = error => {
		const text = error.message ?? String(error);
		showFlash(text);
		if (modelStatus) { modelStatus.textContent = text; modelStatus.classList.remove('working'); }
	};

	const terminal = input?.closest?.('#entry-terminal') ?? screen?.closest?.('#entry-terminal');
	let sessionRail = document.getElementById('session-rail');
	if (terminal && !sessionRail) {
		sessionRail = el('aside', null, 'session-rail');
		sessionRail.id = 'session-rail';
		sessionRail.hidden = true;
		sessionRail.setAttribute('aria-label', 'sessions');
		terminal.append(sessionRail);
	}
	function sessionRailOpen() {
		return Boolean(sessionRail && !sessionRail.hidden && sessionRail.classList.contains('open'));
	}
	function closeSessionRail() {
		if (!sessionRail) return;
		sessionRail.classList.remove('open');
		sessionRail.hidden = true;
	}
	const rememberedTitles = new Map();
	function tabTitle(tab) {
		const named = String(tab?.name ?? '').trim();
		// 'new' is the untitled placeholder from tabLabel, not a /name.
		let title = '';
		if (named && named !== tab.sessionId && named !== 'new') title = named;
		if (!title) {
			const prompt = String(tab?.prompt ?? '').trim();
			if (prompt) title = prompt.split('\n').map(part => part.trim()).find(Boolean) || prompt;
		}
		if (!title) {
			const messages = tab.id && tab.sessionId === state?.sessionId && tab.focused ? state.messages : tab.messages;
			for (const entry of messages ?? []) {
				if (entry?.role !== 'user') continue;
				const content = typeof entry.content === 'string' ? entry.content : (entry.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n');
				const line = String(content).split('\n').map(part => part.trim()).find(Boolean);
				if (line) { title = line; break; }
			}
		}
		if (title && title !== 'new') {
			if (tab.id) rememberedTitles.set(tab.id, title);
			if (tab.sessionId) rememberedTitles.set(tab.sessionId, title);
		}
		return title || rememberedTitles.get(tab.id) || rememberedTitles.get(tab.sessionId) || 'new';
	}
	function enterTab(tabId) {
		closeSessionRail();
		return command('tab-focus', { tabId });
	}
	function newTab() {
		closeSessionRail();
		return command('tab-new');
	}
	let railIndex = 0;
	function railChoices() {
		return ['new', ...(state?.tabs ?? []).map(tab => tab.id)];
	}
	function paintSessionRail() {
		if (!sessionRail) return;
		const choices = railChoices();
		railIndex = Math.max(0, Math.min(railIndex, Math.max(choices.length - 1, 0)));
		const heading = el('p', 'tabs', 'session-rail-heading');
		const neu = el('button', '+ new', 'session-rail-new');
		neu.type = 'button';
		neu.classList.toggle('cursor', choices[railIndex] === 'new');
		neu.onclick = () => newTab().catch(fail);
		const list = el('div', null, 'session-rail-list');
		const tabs = state?.tabs ?? [];
		const closable = tabs.length > 1;
		for (const tab of tabs) {
			const row = el('div', null, `session-rail-item${tab.focused ? ' active' : ''}`);
			row.dataset.tabId = tab.id;
			row.classList.toggle('cursor', choices[railIndex] === tab.id);
			const open = el('button', null, 'session-rail-open');
			open.type = 'button';
			open.append(el('span', tabTitle(tab), 'session-rail-title'));
			open.append(el('span', tab.busy ? 'working' : 'idle', 'session-rail-note'));
			open.onclick = () => enterTab(tab.id).catch(fail);
			const close = el('button', 'X', 'session-rail-close');
			close.type = 'button';
			close.setAttribute('aria-label', 'close tab');
			close.disabled = !closable;
			close.onclick = event => {
				event.preventDefault();
				event.stopPropagation();
				if (!closable) return;
				command('tab-close', { tabId: tab.id }).catch(fail);
			};
			row.append(open, close);
			list.append(row);
		}
		sessionRail.replaceChildren(heading, neu, list);
		sessionRail.querySelector('.cursor')?.scrollIntoView({ block: 'nearest' });
	}
	function moveRail(delta) {
		const n = railChoices().length;
		if (!n) return;
		railIndex = (railIndex + delta + n) % n;
		paintSessionRail();
	}
	function activateRail() {
		const id = railChoices()[railIndex];
		if (id === 'new') newTab().catch(fail);
		else if (id) enterTab(id).catch(fail);
	}
	function cycleTab(delta) {
		const tabs = state?.tabs ?? [];
		if (tabs.length < 2) return false;
		const i = Math.max(0, tabs.findIndex(tab => tab.focused));
		const next = tabs[(i + delta + tabs.length) % tabs.length];
		if (!next) return false;
		command('tab-focus', { tabId: next.id }).catch(fail);
		return true;
	}
	function openSessionRail() {
		if (!sessionRail) return;
		const focused = (state?.tabs ?? []).findIndex(tab => tab.focused);
		railIndex = focused >= 0 ? focused + 1 : 0;
		paintSessionRail();
		sessionRail.hidden = false;
		requestAnimationFrame(() => sessionRail.classList.add('open'));
	}

	/* -------------------------------------------------------------- the page */
	function toolSlab(key, title, body, kind = '', startOpen = true, bound = false) {
		const slab = el('div', null, `entry-tool ${kind}`.trim());
		const head = el('button', null, 'entry-tool-title');
		head.type = 'button';
		head.append(el('span', title));
		const toggled = open.has(key);
		const shown = personal ? (toggled ? !startOpen : startOpen) : true;
		const full = body ?? '';
		const text = !personal && bound && !toggled ? boundBody(full) : full;
		const out = el('pre', text, 'entry-tool-output');
		out.hidden = !shown;
		head.append(el('span', shown ? (toggled || !bound || personal ? '−' : '+') : '+', 'entry-tool-summary'));
		head.onclick = () => { open.has(key) ? open.delete(key) : open.add(key); render(); };
		slab.append(head, out);
		return slab;
	}

	function stockTool(into, { id, name, args, result, running, key }) {
		const toolId = id || key;
		const parsed = parseToolArgs(args);
		const done = Boolean(result);
		const failed = Boolean(result?.isError);
		const kind = failed ? 'error' : done ? 'ok' : 'pending';
		const expanded = expandAll || open.has(toolId);
		const slab = el('div', null, `entry-tool ${kind}`.trim());
		slab.dataset.toolId = toolId;
		const head = el('button', null, 'entry-tool-title');
		head.type = 'button';
		const title = el('span', null, 'entry-tool-cmd');
		let hideBodyUntilExpand = false;
		if (name === 'bash' || name === 'shell') {
			const command = parsed && typeof parsed.command === 'string' ? parsed.command : (parsed ? '' : toolCommand(name, args));
			title.append(el('strong', `$ ${command || '...'}`));
			if (parsed?.timeout != null && parsed.timeout !== '') title.append(el('span', ` (timeout ${parsed.timeout}s)`, 'entry-tool-timeout'));
		} else if (name === 'read') {
			const path = parsed?.file_path ?? parsed?.path ?? toolCommand(name, args);
			const compact = !expanded ? compactReadKind(path) : null;
			const range = readRangeSuffix(parsed);
			if (compact?.kind === 'skill') {
				title.append(el('strong', '[skill] ', 'entry-tool-skill'));
				title.append(el('span', `${compact.label}`, 'entry-tool-path'));
			} else if (compact) {
				title.append(el('strong', `read ${compact.kind} `));
				title.append(el('span', compact.label, 'entry-tool-path'));
			} else {
				title.append(el('strong', 'read '));
				title.append(el('span', String(path ?? ''), 'entry-tool-path'));
			}
			if (range) title.append(el('span', range, 'entry-tool-timeout'));
			hideBodyUntilExpand = !failed && !running;
			if (compact && !expanded) {
				title.append(el('span', ' (ctrl+o to expand)', 'entry-tool-timeout'));
				hideBodyUntilExpand = true;
			}
		} else {
			const rest = toolCommand(name, args);
			title.append(el('strong', rest ? `${name} ` : name));
			if (rest) title.append(el('span', rest, 'entry-tool-path'));
		}
		head.append(title);
		const outputRaw = toolOutputText(result) || toolOutputText(running?.result);
		const previewMax = name === 'bash' || name === 'shell' ? BASH_PREVIEW_LINES : TOOL_PREVIEW_LINES;
		const showOutput = Boolean(outputRaw) && !(hideBodyUntilExpand && !expanded && !failed);
		const bound = showOutput && !expanded;
		const outText = bound ? boundText(outputRaw, previewMax, 'ctrl+o to expand') : outputRaw;
		head.append(el('span', expanded || !showOutput ? (showOutput ? '−' : '+') : '+', 'entry-tool-summary'));
		head.onclick = () => { open.has(toolId) ? open.delete(toolId) : open.add(toolId); render(); };
		slab.append(head);
		if (showOutput) {
			const out = el('pre', outText, 'entry-tool-output');
			slab.append(out);
		}
		const ms = toolDurationMs([result, running, parsed]);
		if (ms != null) slab.append(el('div', `${done ? 'Took' : 'Elapsed'} ${(ms / 1000).toFixed(1)}s`, 'entry-tool-meta'));
		into.append(slab);
	}

	function blocks(into, content, key, tools) {
		if (typeof content === 'string') { const line = el('div', null, 'entry-line assistant'); formatInto(line, content); into.append(line); return; }
		for (const [index, block] of (content ?? []).entries()) {
			if (block.type === 'text') { const line = el('div', null, 'entry-line assistant'); formatInto(line, block.text ?? ''); into.append(line); }
			else if (block.type === 'thinking') {
				into.append(el('div', thinkingText(block.thinking), 'entry-line thinking'));
			}
			else if (block.type === 'toolCall') {
				const id = block.id ?? `${key}-call-${index}`;
				const result = tools.results.get(block.id);
				const running = tools.running.get(block.id);
				stockTool(into, { id, name: block.name, args: block.arguments, result, running, key: id });
				tools.seen.add(id);
			}
			else if (block.type === 'image') into.append(imageNode(block, 'image') ?? el('div', '[image]', 'entry-line notice'));
		}
	}

	function message(into, entry, key, tools) {
		if (entry.role === 'user') {
			const line = el('div', null, 'entry-line user');
			const content = typeof entry.content === 'string' ? [{ type: 'text', text: entry.content }] : (entry.content ?? []);
			const text = content.filter(b => b.type === 'text').map(b => b.text).join('\n');
			if (text) formatInto(line, text);
			for (const block of content) {
				if (block.type !== 'image') continue;
				line.append(imageNode(block, 'attached image') ?? el('div', '[image]', 'notice'));
			}
			into.append(line);
			return;
		}
		if (entry.role === 'toolResult') {
			if (tools.calls.has(entry.toolCallId)) return;
			stockTool(into, { id: entry.toolCallId, name: entry.toolName, args: entry.arguments ?? entry.args, result: entry, running: tools.running.get(entry.toolCallId), key: entry.toolCallId });
			tools.seen.add(entry.toolCallId);
			return;
		}
		if (entry.role === 'assistant') { blocks(into, entry.content, key, tools); if (entry.errorMessage) into.append(el('div', entry.errorMessage, 'entry-line notice')); return; }
		if (entry.role === 'compactionSummary' || entry.role === 'compaction') {
			const expanded = expandAll || open.has(key);
			const tokens = Number(entry.tokensBefore);
			const count = Number.isFinite(tokens) ? tokens.toLocaleString() : null;
			const slab = el('div', null, 'entry-compaction');
			const head = el('button', null, 'entry-compaction-label');
			head.type = 'button';
			head.append(el('strong', '[compaction]'));
			const body = el('div', null, 'entry-compaction-body');
			if (expanded) {
				formatInto(body, `**Compacted from ${count ?? 'prior'} tokens**\n\n${entry.summary ?? ''}`);
			} else {
				const line = el('span', count ? `Compacted from ${count} tokens (` : 'Compacted (');
				line.append(el('span', 'ctrl+o to expand', 'entry-tool-timeout'));
				line.append(document.createTextNode(')'));
				body.append(line);
			}
			const toggle = () => { open.has(key) ? open.delete(key) : open.add(key); render(); };
			head.onclick = toggle;
			slab.append(head, body);
			slab.addEventListener('click', event => { if (event.target.closest('button')) return; toggle(); });
			into.append(slab);
			return;
		}
		if (entry.role === 'branchSummary') {
			const expanded = expandAll || open.has(key);
			const slab = el('div', null, 'entry-compaction');
			const head = el('button', null, 'entry-compaction-label');
			head.type = 'button';
			head.append(el('strong', '[branch]'));
			const body = el('div', null, 'entry-compaction-body');
			if (expanded) formatInto(body, `**Branch Summary**\n\n${entry.summary ?? ''}`);
			else {
				const line = el('span', 'Branch summary (');
				line.append(el('span', 'ctrl+o to expand', 'entry-tool-timeout'));
				line.append(document.createTextNode(')'));
				body.append(line);
			}
			head.onclick = () => { open.has(key) ? open.delete(key) : open.add(key); render(); };
			slab.append(head, body);
			into.append(slab);
			return;
		}
		if (entry.role === 'custom' && !entry.display) return;
		into.append(el('div', typeof entry.content === 'string' ? entry.content : (entry.customType ?? entry.role), 'entry-line system'));
	}

	function hintBlock(rows, compact) {
		const box = el('div', null, compact ? 'entry-startup-hints' : 'entry-startup-hints expanded');
		rows.forEach((row, i) => {
			if (compact && i) box.append(el('span', ' · ', 'entry-startup-sep'));
			const line = compact ? box : el('div', null, 'entry-startup-hint');
			line.append(el('span', row[0], 'entry-startup-key'));
			line.append(document.createTextNode(' '));
			line.append(el('span', row[1], 'entry-startup-desc'));
			if (!compact) box.append(line);
		});
		return box;
	}

	function renderStartup(into) {
		const startup = state.startup;
		if (startup?.quiet) return;
		if (!startup && ((state.messages ?? []).length || state.partial)) return;
		const expanded = expandAll;
		const header = el('div', null, 'entry-startup');
		const logo = el('div', null, 'entry-startup-logo');
		logo.append(el('span', 'pi', 'entry-startup-name'));
		const version = startup?.version;
		if (version) logo.append(el('span', ` v${version}`, 'entry-startup-ver'));
		header.append(logo);
		header.append(hintBlock(expanded ? STARTUP_EXPANDED_HINTS : STARTUP_COMPACT_HINTS, !expanded));
		if (!expanded) header.append(el('div', 'Press ctrl+o to show full startup help and loaded resources.', 'entry-startup-note'));
		header.append(el('div', 'Pi can explain its own features and look up its docs. Ask it how to use or extend Pi.', 'entry-startup-note'));
		into.append(header);
		const sections = startup?.sections ?? derivedStartupSections(state.resources);
		for (const section of sections) {
			const block = el('div', null, 'entry-startup-section');
			block.append(el('div', `[${section.name}]`, 'entry-startup-h'));
			block.append(el('div', expanded ? (section.expanded || section.compact) : section.compact, 'entry-startup-list'));
			into.append(block);
		}
	}

	function renderUpdate(into) {
		const update = state.startup?.update;
		if (!update?.version) return;
		const box = el('div', null, 'entry-update');
		box.append(el('div', 'Update Available', 'entry-update-title'));
		const line = el('div', null, 'entry-update-body');
		line.append(el('span', `New version ${update.version} is available. Run `, 'entry-update-muted'));
		line.append(el('span', 'pi update', 'entry-update-cmd'));
		box.append(line);
		if (update.note) box.append(el('div', update.note, 'entry-update-note'));
		const log = el('div', null, 'entry-update-body');
		log.append(el('span', 'Changelog: ', 'entry-update-muted'));
		const link = el('a', 'https://pi.dev/changelog', 'entry-update-cmd');
		link.href = 'https://pi.dev/changelog';
		link.target = '_blank';
		link.rel = 'noreferrer';
		log.append(link);
		box.append(log);
		into.append(box);
	}

	function renderTranscript() {
		const atBottom = output.scrollHeight - output.scrollTop - output.clientHeight < 120;
		const frame = document.createDocumentFragment();
		renderStartup(frame);
		const bag = {
			calls: collectToolCalls([...(state.messages ?? []), state.partial].filter(Boolean)),
			results: collectToolResults(state.messages),
			running: new Map((state.runningTools ?? []).filter(t => t.toolCallId).map(t => [t.toolCallId, t])),
			seen: new Set(),
		};
		state.messages.forEach((entry, index) => message(frame, entry, `${state.sessionId}-${index}`, bag));
		if (state.partial) message(frame, state.partial, 'partial', bag);
		for (const tool of state.runningTools ?? []) {
			if (bag.seen.has(tool.toolCallId)) continue;
			stockTool(frame, { id: tool.toolCallId, name: tool.toolName, args: tool.args, result: null, running: tool, key: tool.toolCallId });
			bag.seen.add(tool.toolCallId);
		}
		renderUpdate(frame);
		output.replaceChildren(frame);
		if (personal && queueBox) output.append(queueBox);
		if (atBottom) output.scrollTop = output.scrollHeight;
	}

	function paintWork() {
		if (!work || !inputZone) return;
		const busy = Boolean(state?.busy);
		const compacting = state?.operation === 'compacting';
		inputZone.classList.toggle('working', busy);
		if (personal) {
			work.hidden = false;
			work.replaceChildren();
			if (compacting) {
				spinner = el('span', WORK_SPIN[spin % WORK_SPIN.length], 'entry-spinner');
				work.append(spinner, el('span', 'Compacting context... (escape to cancel)', 'entry-work-status'));
				return;
			}
			spinner = null;
			if (modelName) {
				modelName.textContent = state?.model?.id ?? 'pi';
				work.append(modelName);
			}
			if (thinking) {
				const level = state?.thinkingLevel;
				thinking.textContent = level && level !== 'off' ? level : '';
				work.append(thinking);
			}
			if (context) {
				context.textContent = contextChip(state?.stats ?? {});
				if (context.textContent) work.append(el('span', '', 'entry-work-gap'));
				work.append(context);
			}
			return;
		}
		work.hidden = !busy;
		work.replaceChildren();
		if (!busy) { spinner = null; return; }
		spinner = el('span', WORK_SPIN[spin % WORK_SPIN.length], 'entry-spinner');
		work.append(spinner, el('span', compacting ? 'Compacting context... (escape to cancel)' : 'Working'));
	}

	function renderStatus() {
		const sheet = document.getElementById('tui-theme');
		if (sheet && state.themeRev != null && Number(state.themeRev) !== themeRev) {
			themeRev = state.themeRev;
			sheet.href = `/theme.css?r=${themeRev}`;
		}
		const live = state.live;
		document.body.classList.toggle('watching', Boolean(live));
		document.body.dataset.thinking = state.thinkingLevel || 'off';
		spend.textContent = footerLeft(state.stats ?? {}, state.autoCompactEnabled !== false);
		sessionSource.textContent = '';
		sessionTitle.textContent = '';
		sessionCwd.textContent = '';
		const provider = state.model?.provider;
		if (personal) {
			modelName.textContent = state.model?.id ?? 'pi';
			thinking.textContent = state.thinkingLevel && state.thinkingLevel !== 'off' ? state.thinkingLevel : '';
			context.textContent = contextChip(state.stats ?? {});
		} else {
			context.textContent = '';
			// Until a model is chosen nothing a person types can work, and this label was the only
			// place that said so -- greyed out, in a status bar, reading "(unknown) unknown". It
			// now names the action instead, and the theme makes it look like one.
			const unset = !state.model?.id || provider === 'unknown';
			modelName.dataset.unset = String(unset);
			modelName.textContent = unset
				? 'Choose a model'
				: (provider ? `(${provider}) ${state.model.id}` : state.model.id);
			thinking.textContent = state.model?.reasoning || state.thinkingLevel ? `• ${state.thinkingLevel && state.thinkingLevel !== 'off' ? state.thinkingLevel : 'thinking off'}` : '';
		}
		const status = state.failed ? 'failed'
			: live?.closed ? 'terminal ended'
			: !socket || socket.readyState !== WebSocket.OPEN ? 'reconnecting'
			: '';
		modelStatus.textContent = status;
		modelStatus.classList.toggle('working', false);
		modelStatus.onclick = null;
	}

	function renderWidgets() {
		if (!widgets) return;
		const groups = state.ui?.widgets ?? {};
		const keys = Object.keys(groups).filter(key => (groups[key] ?? []).length);
		widgets.hidden = keys.length === 0;
		if (!keys.length) { widgets.replaceChildren(); return; }
		const frame = document.createDocumentFragment();
		for (const key of keys) {
			const block = el('div', null, 'entry-widget');
			block.dataset.key = key;
			for (const line of groups[key]) block.append(el('div', line, 'entry-widget-line'));
			frame.append(block);
		}
		widgets.replaceChildren(frame);
	}

	function paintQueue() {
		if (!queueBox) return;
		const steering = state?.queue?.steering ?? [];
		const followUp = state?.queue?.followUp ?? [];
		const empty = steering.length === 0 && followUp.length === 0;
		queueBox.hidden = empty;
		queueBox.replaceChildren();
		if (empty) return;
		const pull = () => command('dequeue').then(applyQueue).catch(fail);
		for (const text of steering) {
			const row = el('button', `Steering: ${text}`, 'entry-queue-line');
			row.type = 'button';
			row.onclick = pull;
			queueBox.append(row);
		}
		for (const text of followUp) {
			const row = el('button', `Follow-up: ${text}`, 'entry-queue-line');
			row.type = 'button';
			row.onclick = pull;
			queueBox.append(row);
		}
		queueBox.append(el('div', '↳ click a line or Alt+Up to edit', 'entry-queue-hint'));
	}

	function applyQueue(q) {
		const texts = [...(q?.steering ?? []), ...(q?.followUp ?? [])].filter(text => String(text ?? '').trim());
		if (!texts.length) return;
		input.value = [texts.join('\n\n'), input.value].filter(text => text.trim()).join('\n\n');
		saveDraft();
		hooks.onDraftChange?.();
	}

	function render() {
		if (!state) return;
		renderTranscript();
		renderWidgets();
		renderStatus();
		paintWork();
		paintQueue();
		if (state.ui?.editor && state.ui.editor.id !== lastEditor) {
			lastEditor = state.ui.editor.id;
			const editor = state.ui.editor;
			if (editor.paste) input.setRangeText(editor.text, input.selectionStart, input.selectionEnd, 'end');
			else if (!input.value) input.value = editor.text;
			saveDraft(); hooks.onDraftChange?.();
			input.dispatchEvent(new Event('input', { bubbles: true }));
		}
		// An extension asking a question outranks a picker we opened ourselves.
		const ask = state.ui?.dialogs?.[0];
		if (ask) showExtensionDialog(ask);
		else if (overlay?.kind === 'extension') closeDialog();
		auth.render(state.auth);
		const focusedTab = (state.tabs ?? []).find(tab => tab.focused);
		if (focusedTab) tabTitle(focusedTab);
		if (sessionRailOpen()) paintSessionRail();
	}

	/* -------------------------------------------------------------- dialogs */
	function closeDialog(restore = false) {
		const cancel = overlay?.onCancel;
		overlay = null; dialog.hidden = true; dialog.replaceChildren();
		if (restore) Promise.resolve(cancel?.()).catch(fail);
		if (hooks.canFocus?.()) input.focus();
	}

	function showUsage(report = {}) {
		const now = Date.now();
		overlay = { kind: 'usage' };
		dialog.hidden = false;
		dialog.className = 'usage-panel';
		const frame = document.createDocumentFragment();
		frame.append(el('p', 'usage', 'entry-dialog-title'));
		for (const provider of report.providers ?? []) {
			const block = el('div', null, 'usage-provider');
			const age = readingAge(provider.fetchedAt, now);
			const head = el('p', null, 'usage-provider-name');
			head.append(el('span', provider.name || provider.id || 'provider'));
			if (provider.plan) head.append(el('span', ` · ${provider.plan}`, 'usage-plan'));
			if (age.stale) head.append(el('span', ` · ${age.label}`, 'usage-stale'));
			block.append(head);
			if (!provider.windows?.length) {
				block.append(el('p', provider.note || 'no meter', 'usage-empty'));
			} else {
				for (const window of provider.windows) {
					const row = el('div', null, 'usage-window');
					row.append(el('p', window.label || 'limit', 'usage-window-label'));
					const meter = el('p', null, 'usage-meter');
					meter.append(el('span', meterBar(window.percent), 'usage-bar'));
					meter.append(el('span', `  ${percentLabel(window.percent)}`, 'usage-percent'));
					row.append(meter);
					row.append(el('p', resetText(window.resetsAt, now), 'usage-reset'));
					block.append(row);
				}
				if (provider.note) block.append(el('p', provider.note, 'usage-note'));
			}
			frame.append(block);
		}
		frame.append(el('p', 'esc closes', 'entry-dialog-hint'));
		dialog.replaceChildren(frame);
		dialog.tabIndex = 0;
		dialog.onkeydown = event => {
			if (event.key === 'Escape') { event.preventDefault(); closeDialog(); }
		};
		dialog.focus();
	}

	function showDialog({ kind, title, hint, rows, onPick, onMove, onCancel, selected, search = rows.length > 8 }) {
		overlay = { kind, title, onCancel };
		dialog.hidden = false;
		dialog.className = search ? 'compact-select' : '';
		let filter = '', active = Math.max(0, rows.findIndex(row => row.label === selected));
		const paint = () => {
			const matches = rows.filter(row => row.label.toLowerCase().includes(filter.toLowerCase()));
			active = Math.max(0, Math.min(active, matches.length - 1));
			const frame = document.createDocumentFragment();
			frame.append(el('p', title, 'entry-dialog-title'));
			if (search) {
				const box = el('input', null, 'compact-search');
				box.value = filter; box.placeholder = 'filter';
				box.oninput = () => { filter = box.value; active = 0; paint(); box.focus(); };
				box.onkeydown = keys;
				frame.append(box);
				frame.append(el('span', `${matches.length}/${rows.length}`, 'compact-count'));
			}
			matches.slice(0, 60).forEach((row, index) => {
				const option = el('button', null, `entry-dialog-option${index === active ? ' active' : ''}${row.unavailable ? ' unavailable' : ''}`);
				option.type = 'button';
				option.append(el('span', row.label, 'entry-dialog-option-label'));
				if (row.note) option.append(el('small', row.note));
				option.onclick = () => { closeDialog(); Promise.resolve(row.pick ? row.pick() : onPick?.(row)).catch(fail); };
				frame.append(option);
			});
			if (!matches.length) frame.append(el('p', 'nothing matches', 'entry-dialog-hint'));
			frame.append(el('p', hint ?? 'enter chooses · esc closes', 'entry-dialog-hint'));
			dialog.replaceChildren(frame);
			dialog.tabIndex = 0;
			if (search) dialog.querySelector('.compact-search')?.focus();
			else dialog.focus();
			dialog.querySelector('.entry-dialog-option.active')?.scrollIntoView({ block: 'nearest' });
			const row = matches[active];
			if (row && onMove) Promise.resolve(onMove(row)).catch(fail);
		};
		function keys(event) {
			const matches = rows.filter(row => row.label.toLowerCase().includes(filter.toLowerCase()));
			if (event.key === 'ArrowDown') { active = Math.min(active + 1, matches.length - 1); event.preventDefault(); paint(); }
			else if (event.key === 'ArrowUp') { active = Math.max(active - 1, 0); event.preventDefault(); paint(); }
			else if (event.key === 'Enter') { event.preventDefault(); const row = matches[active]; if (row) { closeDialog(); Promise.resolve(row.pick ? row.pick() : onPick?.(row)).catch(fail); } }
			else if (event.key === 'Escape') { event.preventDefault(); closeDialog(true); }
		}
		dialog.onkeydown = keys;
		paint();
	}

	function showStockSettings(initial) {
		let cur = { ...initial };
		let filter = '';
		const stack = [{ kind: 'main', active: 0 }];
		overlay = {
			kind: 'settings',
			onCancel: async () => {
				const themeView = stack.find(view => view.kind === 'theme');
				if (themeView?.original) await command('theme', { name: themeView.original });
			},
		};
		dialog.hidden = false;
		dialog.className = 'tui-settings';
		const top = () => stack.at(-1);
		function paintList(rows, { heading, description, hint } = {}) {
			const view = top();
			view.active = Math.max(0, Math.min(view.active ?? 0, Math.max(0, rows.length - 1)));
			const active = view.active;
			const visible = 10;
			let start = 0;
			if (active >= start + visible) start = active - visible + 1;
			if (active < start) start = active;
			const frame = document.createDocumentFragment();
			if (heading) frame.append(el('p', heading, 'tui-setting-heading'));
			if (description) frame.append(el('p', description, 'tui-setting-lead'));
			rows.slice(start, start + visible).forEach((row, offset) => {
				const index = start + offset;
				const btn = el('button', null, `tui-setting${index === active ? ' active' : ''}`);
				btn.type = 'button';
				btn.append(
					el('span', index === active ? '→' : ' ', 'slash-marker'),
					el('span', row.label, 'tui-setting-label'),
					el('span', row.value ?? '', 'tui-setting-value'),
				);
				btn.onclick = () => { view.active = index; Promise.resolve(row.activate?.()).catch(fail); };
				frame.append(btn);
			});
			frame.append(el('div', `(${rows.length ? active + 1 : 0}/${rows.length})`, 'slash-count'));
			frame.append(el('p', rows[active]?.description ?? '', 'tui-setting-desc'));
			frame.append(el('p', hint, 'entry-dialog-hint'));
			dialog.replaceChildren(frame);
			dialog.tabIndex = 0;
			dialog.focus();
		}
		function paint() {
			const view = top();
			if (view.kind === 'main') {
				const q = filter.toLowerCase();
				const defs = SETTING_DEFS.filter(def => !q || def.label.toLowerCase().includes(q) || def.description.toLowerCase().includes(q));
				paintList(defs.map(def => ({
					label: def.label,
					value: displayValue(def, def.kind === 'theme' ? (state?.theme ?? cur.theme) : cur[def.key], cur),
					description: def.description,
					activate: () => activate(def),
				})), { hint: 'Type to search · Enter/Space to change · Esc to cancel' });
				return;
			}
			if (view.kind === 'theme') {
				const current = state?.theme ?? view.saved;
				const rows = [
					...(personal ? [] : [{ label: 'Automatic', value: '', description: 'Use separate themes for light and dark terminal appearance', activate: () => openThemeAuto() }]),
					...(view.names ?? []).map(name => ({
						label: `${name === current ? '✓ ' : '  '}${name}`,
						value: '',
						description: 'Color theme for the interface',
						activate: async () => {
							await command('theme', { name, persist: true });
							stack.pop();
							paint();
						},
					})),
				];
				paintList(rows, {
					heading: 'Theme',
					description: personal ? 'Select a theme. Garden and night are chosen; the device palette is ignored.' : 'Select a theme, or choose Automatic to follow terminal appearance.',
					hint: 'Enter to select · Esc to go back',
				});
				return;
			}
			if (view.kind === 'theme-auto') {
				paintList([
					{ label: 'Light theme', value: view.light, description: 'Theme to use in automatic mode when the terminal is light', activate: () => openThemePick('light') },
					{ label: 'Dark theme', value: view.dark, description: 'Theme to use in automatic mode when the terminal is dark', activate: () => openThemePick('dark') },
					{ label: 'Apply', value: 'save and go back', description: 'Save and go back', activate: async () => {
						await command('theme', { name: `${view.light}/${view.dark}`, persist: true });
						stack.length = 1;
						paint();
					} },
					{ label: 'Change mode', value: 'switch to single theme', description: 'Switch to one theme for light and dark', activate: () => { stack.pop(); paint(); } },
				], { heading: 'Automatic Theme', description: 'Choose themes for terminal light and dark appearance.', hint: 'Enter to select · Esc to go back' });
				return;
			}
			if (view.kind === 'theme-pick') {
				paintList((view.names ?? []).map(name => ({
					label: `${name === view.current ? '✓ ' : '  '}${name}`,
					value: '',
					description: view.which === 'light' ? 'Select the theme to use for light terminal appearance' : 'Select the theme to use for dark terminal appearance',
					activate: async () => {
						const parent = stack.at(-2);
						if (parent) parent[view.which] = name;
						await command('theme', { name, persist: false });
						stack.pop();
						paint();
					},
				})), { heading: view.which === 'light' ? 'Light Theme' : 'Dark Theme', hint: 'Enter to select · Esc to go back' });
				return;
			}
			if (view.kind === 'warnings') {
				const on = cur.warnings?.anthropicExtraUsage !== false;
				paintList([{ label: 'Anthropic extra usage', value: on ? 'true' : 'false', description: 'Warn when Anthropic subscription auth may use paid extra usage', activate: async () => {
					cur = await command('settings', { key: 'warningsAnthropicExtraUsage', value: !on });
					paint();
				} }], { hint: 'Enter/Space to change · Esc to go back' });
				return;
			}
			if (view.kind === 'model-thinking') {
				const models = view.models.length ? view.models : [{ provider: 'none', id: 'No models available', none: true }];
				paintList(models.map(model => ({
					label: model.none ? model.id : `${model.id} [${model.provider}]`,
					value: model.none ? '' : (cur.modelThinkingLevels?.[`${model.provider}/${model.id}`] ?? ''),
					description: model.none ? 'Log in to a provider or configure an API key first' : 'Select a model to configure',
					activate: () => { if (!model.none) { stack.push({ kind: 'thinking-level', model, active: 0, levels: view.levels }); paint(); } },
				})), { heading: 'Per-Model Thinking Level', description: 'Select a model to configure', hint: 'Enter to select · Esc to go back' });
				return;
			}
			if (view.kind === 'thinking-level') {
				const levels = view.levels ?? ['off', 'minimal', 'low', 'medium', 'high'];
				const key = `${view.model.provider}/${view.model.id}`;
				paintList(levels.map(level => ({
					label: `${cur.modelThinkingLevels?.[key] === level ? '✓ ' : '  '}${level}`,
					value: '',
					description: 'Select default thinking level for this model',
					activate: async () => {
						cur = await command('settings', { key: 'modelThinkingLevels', value: { ...cur.modelThinkingLevels, [key]: level } });
						stack.pop();
						paint();
					},
				})), { heading: `Thinking Level for ${view.model.id}`, hint: 'Enter to select · Esc to go back' });
			}
		}
		async function activate(def) {
			if (def.kind === 'theme') {
				const info = await command('themes');
				stack.push({ kind: 'theme', names: info.names ?? [], saved: info.saved ?? state?.theme, original: info.saved ?? state?.theme, active: 0 });
				paint();
				return;
			}
			if (def.key === 'warnings') { stack.push({ kind: 'warnings', active: 0 }); paint(); return; }
			if (def.key === 'modelThinking') {
				let models = [];
				let levels;
				try { models = await command('models'); } catch { models = []; }
				try { levels = (await command('thinking')).available; } catch {}
				stack.push({ kind: 'model-thinking', models: Array.isArray(models) ? models : [], levels, active: 0 });
				paint();
				return;
			}
			const next = cycleValue(def, cur[def.key]);
			cur = await command('settings', { key: def.key, value: next });
			paint();
		}
		function openThemeAuto() {
			const saved = String(top().saved ?? 'dark');
			const [light, dark] = saved.includes('/') ? saved.split('/') : [saved, saved];
			stack.push({ kind: 'theme-auto', light, dark, names: top().names, active: 0 });
			paint();
		}
		function openThemePick(which) {
			const parent = top();
			stack.push({ kind: 'theme-pick', which, names: parent.names ?? [], current: parent[which], active: 0 });
			paint();
		}
		dialog.onkeydown = event => {
			const view = top();
			if (event.key === 'ArrowDown') { view.active = (view.active ?? 0) + 1; event.preventDefault(); paint(); }
			else if (event.key === 'ArrowUp') { view.active = Math.max((view.active ?? 0) - 1, 0); event.preventDefault(); paint(); }
			else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); dialog.querySelector('.tui-setting.active')?.click(); }
			else if (event.key === 'Escape') {
				event.preventDefault();
				if (stack.length > 1) {
					const leaving = stack.pop();
					if (leaving.kind === 'theme' && leaving.original) command('theme', { name: leaving.original }).catch(fail);
					paint();
				} else if (filter) { filter = ''; paint(); }
				else closeDialog();
			} else if (view.kind === 'main' && event.key === 'Backspace') { event.preventDefault(); filter = filter.slice(0, -1); view.active = 0; paint(); }
			else if (view.kind === 'main' && event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
				filter += event.key; view.active = 0; event.preventDefault(); paint();
			}
		};
		paint();
	}

	let shownDialogId = null;
	function showExtensionDialog(ask) {
		if (overlay?.kind === 'extension' && shownDialogId === ask.id) return;
		shownDialogId = ask.id;
		const answer = fields => command('dialog', { dialogId: ask.id, ...fields }).catch(fail);
		if (ask.method === 'select') {
			showDialog({ kind: 'extension', title: ask.title, hint: 'from an extension · esc cancels',
				rows: [...ask.options.map(option => ({ label: option, pick: () => answer({ value: option }) })), { label: 'cancel', pick: () => answer({ cancelled: true }) }] });
			return;
		}
		if (ask.method === 'confirm') {
			showDialog({ kind: 'extension', title: ask.title, hint: ask.message ?? '', search: false,
				rows: [{ label: 'yes', pick: () => answer({ confirmed: true }) }, { label: 'no', pick: () => answer({ confirmed: false }) }] });
			return;
		}
		overlay = { kind: 'extension' };
		dialog.hidden = false; dialog.className = '';
		const box = el('textarea');
		box.value = ask.prefill ?? ''; box.placeholder = ask.placeholder ?? '';
		const ok = el('button', 'answer'); ok.type = 'button'; ok.onclick = () => { closeDialog(); answer({ value: box.value }); };
		const no = el('button', 'cancel'); no.type = 'button'; no.onclick = () => { closeDialog(); answer({ cancelled: true }); };
		const actions = el('div', null, 'entry-dialog-actions'); actions.append(ok, no);
		dialog.replaceChildren(el('p', ask.title, 'entry-dialog-title'), box, actions);
		box.focus();
	}

	/* ------------------------------------------------------- slash commands */
	const COMMANDS = [
		['/login', 'sign in with a subscription or API key', provider => auth.login(provider)],
		['/logout', 'remove credentials saved in Guey', () => auth.logout()],
		['/model', 'pick the model', async () => {
			const models = await command('models');
			showDialog({ kind: 'model', title: 'model', rows: models.map(m => ({ label: `${m.provider}/${m.id}`, pick: () => command('model', { provider: m.provider, modelId: m.id }) })) });
		}],
		['/resume', 'open a session, or watch a running terminal', async () => {
			const rows = await command('sessions');
			const choices = [];
			for (const session of rows) {
				const title = session.name ?? session.firstMessage?.slice(0, 80) ?? session.id;
				const when = new Date(session.modified).toLocaleString();
				if (session.liveOwner) choices.push({ label: `▶ ${title}`, note: `watch live · terminal pid ${session.liveOwner.pid}`, pick: () => command('attach', { pid: session.liveOwner.pid }) });
				choices.push({ label: title, note: `${session.liveOwner ? 'open a copy' : 'resume'} · ${session.cwd} · ${when}`, pick: () => command('resume', { path: session.path }) });
			}
			showDialog({ kind: 'resume', title: 'sessions', hint: '▶ watches a running terminal · the rest open here', rows: choices });
		}],
		['/new', 'start a session', () => command('new')],
		['/name', 'name this session · /name some words', argument => {
			if (!argument) throw new Error('/name needs a name');
			return command('name', { name: argument });
		}],
		['/abort', 'stop the turn', () => command('abort')],
		['/reload', 'reload skills and extensions', async () => {
			showFlash('Reloading keybindings, extensions, skills, prompts, themes, and context files...');
			await command('reload');
			showFlash('Reloaded keybindings, extensions, skills, prompts, themes, and context files');
		}],
		['/tab', 'open the tabs window', () => openSessionRail()],
		...(personal ? [
			['/graph', 'open the personal knowledge map', () => { hooks.onGraph?.(); }],
			['/antiburn', 'open the antiburn GUI on the canvas', () => world.spawn({ kind: 'page', id: 'antiburn', title: 'antiburn', src: '/antiburn.html', sticky: true })],
			['/usage', 'Claude, Codex, and Grok subscription meters', async () => {
				showFlash('reading usage…');
				let report;
				try {
					report = await command('usage');
				} catch {
					const res = await fetch('/antiburn-report.json', { cache: 'no-store' });
					if (!res.ok) throw new Error('/usage needs a local usage reading');
					report = await res.json();
				}
				showFlash('');
				showUsage(report);
			}],
			['/guey-reload', 'reload this page (new HTML, CSS, JS)', () => { location.reload(); }],
		] : []),
		['/guey', 'reload the page, or restart the process · /guey reload | /guey restart', async (argument) => {
			const verb = String(argument ?? '').trim().toLowerCase();
			if (!verb || verb === 'reload') { location.reload(); return; }
			if (verb === 'restart') { await restartGuey(); return; }
			throw new Error('/guey wants reload or restart');
		}],
		['/guey-restart', 'restart this Guey process (loads new server code)', () => restartGuey()],
		['/detach', 'stop watching the terminal', () => command('detach')],
		['/thinking', 'thinking level', async () => {
			const info = await command('thinking');
			showDialog({ kind: 'thinking', title: 'thinking', rows: (info.available ?? []).map(level => ({
				label: level, note: level === info.current ? 'now' : '', pick: () => command('thinking', { level }),
			})) });
		}],
		['/compact', 'summarize older context · /compact extra instructions', argument => command('compact', { text: argument || undefined })],
		['/session', 'this session\'s file, tokens, cost', async () => {
			const info = await command('session');
			const line = `${info.name ?? info.sessionId} · ${info.model?.provider}/${info.model?.id} · ${info.thinkingLevel} · ${info.sessionFile}`;
			showDialog({ kind: 'session', title: 'session', hint: line, rows: [{ label: 'ok', pick: () => {} }] });
		}],
		['/copy', 'copy the last assistant message', async () => {
			const text = await command('copy');
			if (!text) throw new Error('nothing to copy');
			await navigator.clipboard.writeText(text);
		}],
		['/fork', 'new session from a previous user message', async () => {
			const rows = await command('forks');
			showDialog({ kind: 'fork', title: 'fork', rows: rows.map(row => ({
				label: row.text.slice(0, 80) || row.entryId, pick: () => command('fork', { entryId: row.entryId }),
			})) });
		}],
		['/theme', 'Color theme for the interface', async () => {
			const info = await command('themes');
			const saved = info.saved ?? state.theme;
			showDialog({
				kind: 'theme', title: 'Theme', hint: personal ? 'Select garden or night. The device palette is ignored.' : 'Select a theme, or choose Automatic to follow terminal appearance.',
				selected: saved,
				rows: info.names.map(name => ({ label: name, note: name === saved ? 'saved' : '', pick: () => command('theme', { name, persist: true }) })),
				onMove: row => command('theme', { name: row.label }),
				onCancel: () => command('theme', { name: saved }),
			});
		}],
		['/settings', 'Open settings menu', async () => {
			showStockSettings(await command('settings'));
		}],
		['/tree', 'jump to a previous turn in this session', async () => {
			const rows = await command('forks');
			showDialog({ kind: 'tree', title: 'tree', rows: rows.map(row => ({
				label: row.text.slice(0, 80) || row.entryId, pick: () => command('tree', { entryId: row.entryId }),
			})) });
		}],
	];

	function catalog() {
		const extra = (state?.commands ?? []).map(item => {
			const name = item.name.startsWith('/') ? item.name : `/${item.name}`;
			return [name, item.description ?? '', () => command('prompt', { text: name })];
		});
		const rows = [...COMMANDS, ...extra.filter(([name]) => !COMMANDS.some(row => row[0] === name))];
		const byName = new Map(rows.map(row => [row[0], row]));
		const missing = name => [name, SLASH_VIEW[name]?.[1] ?? '', () => { throw new Error(`${name} is not available in Guey yet`); }];
		const ordered = [];
		for (const name of STOCK_SLASH_ORDER) {
			if (name === '/quit') ordered.push([name, SLASH_VIEW[name][1], () => { window.close(); }]);
			else ordered.push(byName.get(name) ?? missing(name));
		}
		for (const row of extra) {
			if (!ordered.some(item => item[0] === row[0])) ordered.push(row);
		}
		for (const name of ['/tab', '/guey', '/guey-restart', ...(personal ? ['/graph', '/usage', '/antiburn', '/guey-reload'] : [])]) {
			if (byName.has(name) && !ordered.some(item => item[0] === name)) ordered.push(byName.get(name));
		}
		return ordered;
	}
	function slashRows() {
		return catalog().filter(([name]) => {
			if (name === '/theme') return false;
			if (personal && !state?.auth && ['/login', '/logout'].includes(name)) return false;
			return true;
		});
	}
	function paintSlash() {
		const draft = input.value;
		if (draft !== lastSlashDraft) { slashIndex = 0; lastSlashDraft = draft; }
		const showing = draft.startsWith('/') && !draft.includes(' ');
		const matches = showing ? slashRows().filter(([name]) => name.startsWith(draft)) : [];
		slashMenu.hidden = !matches.length;
		if (!matches.length) return;
		slashIndex = Math.max(0, Math.min(slashIndex, matches.length - 1));
		const visible = STOCK_SLASH_VISIBLE;
		let start = 0;
		if (slashIndex >= start + visible) start = slashIndex - visible + 1;
		if (slashIndex < start) start = slashIndex;
		const windowed = matches.slice(start, start + visible);
		const items = windowed.map(([name, description], offset) => {
			const index = start + offset;
			const item = el('button', null, `slash-item${index === slashIndex ? ' active' : ''}`);
			item.type = 'button';
			item.dataset.command = name;
			const view = SLASH_VIEW[name];
			item.append(
				el('span', index === slashIndex ? '→' : ' ', 'slash-marker'),
				el('span', view?.[0] ?? name.replace(/^\//, ''), 'slash-name'),
				el('span', view?.[1] ?? description, 'slash-desc'),
			);
			item.onclick = () => { input.value = name; slashMenu.hidden = true; run(name); };
			return item;
		});
		slashMenu.replaceChildren(...items, el('div', `(${slashIndex + 1}/${matches.length})`, 'slash-count'));
	}

	// `/name the thing` — the word is the command, the rest is its argument, the
	// way a terminal reads it. A line that is not a command is a prompt.
	function run(line) {
		const [name, ...rest] = line.split(' ');
		const entry = COMMANDS.find(([command]) => command === name) ?? catalog().find(([command]) => command === name);
		if (!entry) return false;
		const restore = name === '/graph' ? keptDraft : null;
		input.value = restore ?? ''; saveDraft(); slashMenu.hidden = true; hooks.onDraftChange?.();
		try { Promise.resolve(entry[2](rest.join(' ').trim())).catch(fail); } catch (error) { fail(error); }
		return true;
	}

	/* ---------------------------------------------------------------- input */
	const draftKey = personal ? 'guey-draft' : 'guey-stock-draft';
	const saveDraft = () => { try { localStorage.setItem(draftKey, input.value); } catch {} };
	try { input.value = localStorage.getItem(draftKey) ?? ''; } catch {}

	const filesInput = document.getElementById('entry-files');
	const plusButton = document.getElementById('entry-plus');
	const attachLabel = plusButton || filesInput?.closest('.entry-attach');
	let pendingStrip = document.getElementById('entry-pending');
	if (!pendingStrip && inputZone) {
		pendingStrip = el('div', null, 'entry-pending');
		pendingStrip.id = 'entry-pending';
		pendingStrip.hidden = true;
		inputZone.before(pendingStrip);
	}
	let attachments = [];
	function dropAttachment(piece) {
		piece.controller?.abort();
		if (piece.imageUrl) URL.revokeObjectURL(piece.imageUrl);
		const index = attachments.indexOf(piece);
		if (index >= 0) attachments.splice(index, 1);
		paintPending();
	}
	function paintPending() {
		const names = attachments.map(p => p.name).join(', ');
		if (attachLabel) {
			attachLabel.classList.toggle('has-files', attachments.length > 0);
			attachLabel.title = attachments.length ? names : 'attach';
			const mark = attachLabel.querySelector('span');
			if (mark) mark.textContent = attachments.length ? String(attachments.length) : '+';
		}
		if (!pendingStrip) return;
		pendingStrip.replaceChildren();
		if (!attachments.length) { pendingStrip.hidden = true; return; }
		pendingStrip.hidden = false;
		attachments.forEach(piece => {
			const chip = el('button', null, 'entry-pending-chip');
			chip.type = 'button';
			chip.setAttribute('aria-label', `remove ${piece.name}`);
			if (!piece.path && personal) chip.classList.add('is-uploading');
			const thumb = piece.imageUrl
				? (() => { const img = document.createElement('img'); img.className = 'entry-image'; img.alt = piece.name; img.src = piece.imageUrl; return img; })()
				: (piece.image ? imageNode(piece.image, piece.name) : null);
			if (thumb) chip.append(thumb);
			else chip.append(el('span', piece.name));
			if (personal && !piece.path) chip.append(el('span', uploadPercent(piece.loaded, piece.total), 'entry-pending-progress'));
			chip.onclick = () => dropAttachment(piece);
			pendingStrip.append(chip);
		});
	}
	function bytesToB64(buffer) {
		const bytes = new Uint8Array(buffer);
		let binary = '';
		for (const byte of bytes) binary += String.fromCharCode(byte);
		return btoa(binary);
	}
	function isImageFile(file) {
		const name = file.name || '';
		const type = file.type || '';
		return type.startsWith('image/') || (!type && /\.(png|jpe?g|gif|webp|bmp)$/i.test(name));
	}
	async function resizeImage(file) {
		const bitmap = await createImageBitmap(file);
		const max = 1600;
		const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
		const canvas = document.createElement('canvas');
		canvas.width = Math.max(1, Math.round(bitmap.width * scale));
		canvas.height = Math.max(1, Math.round(bitmap.height * scale));
		canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
		bitmap.close();
		const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.85));
		return bytesToB64(await blob.arrayBuffer());
	}
	async function attachPersonal(file) {
		if (file.size > MAX_UPLOAD_BYTES) { fail(new Error(`${file.name || 'file'} is larger than 1 GB`)); return; }
		const piece = {
			name: file.name || (isImageFile(file) ? 'image' : 'file'),
			path: null,
			loaded: 0,
			total: file.size || 0,
			imageUrl: isImageFile(file) ? URL.createObjectURL(file) : null,
			controller: new AbortController(),
		};
		attachments.push(piece);
		paintPending();
		try {
			const saved = await postUpload(file, {
				signal: piece.controller.signal,
				onProgress(loaded, total) {
					piece.loaded = loaded;
					piece.total = total || piece.total;
					paintPending();
				},
			});
			piece.path = saved.path;
			piece.loaded = saved.size ?? piece.total;
			paintPending();
		} catch (error) {
			if (attachments.includes(piece)) dropAttachment(piece);
			else paintPending();
			if (error.name !== 'AbortError') fail(error);
		}
	}
	async function attachFile(file) {
		if (!file) return;
		if (personal) return attachPersonal(file);
		// The socket caps a frame at 8 MiB and base64 costs a third, so the
		// ceiling here has to sit below 6 MiB — at 6 the frame is exactly the
		// cap and the envelope tips it over, which closes the connection
		// instead of telling anyone the file was too big.
		if (file.size > 5 * 1024 * 1024) { fail(new Error(`${file.name || 'file'} is larger than 5 MB`)); return; }
		try {
			const name = file.name || (file.type.startsWith('image/') ? 'image' : 'file');
			if (isImageFile(file)) {
				attachments.push({ name, image: { type: 'image', mimeType: 'image/jpeg', data: await resizeImage(file) } });
			} else {
				attachments.push({ name, file: { name, data: bytesToB64(await file.arrayBuffer()) } });
			}
		} catch (error) { fail(error); }
	}
	filesInput?.addEventListener('change', async () => {
		const chosen = [...(filesInput.files ?? [])];
		filesInput.value = '';
		await Promise.all(chosen.map(attachFile));
		paintPending();
	});

	if (personal && plusButton && filesInput) {
		plusButton.addEventListener('click', event => {
			event.preventDefault();
			filesInput.click();
		});
	}
	async function attachFiles(list) {
		const files = [...(list ?? [])].filter(Boolean);
		if (!files.length) return;
		await Promise.all(files.map(attachFile));
		paintPending();
		hooks.onDraftChange?.();
	}
	let shareGate = Promise.resolve();
	function consumeIncomingShares() {
		const run = async () => {
			const files = await takeSharedFiles();
			if (!files.length) return;
			await clearSharedFiles();
			hooks.onIncomingShare?.();
			await attachFiles(files);
			try {
				if (new URLSearchParams(location.search).has('shared')) {
					history.replaceState(null, '', `${location.pathname}${location.hash}`);
				}
			} catch { /* ignore */ }
		};
		shareGate = shareGate.then(run, run);
		return shareGate;
	}
	if (personal) {
		consumeIncomingShares();
		addEventListener('guey:take-shares', () => consumeIncomingShares());
		addEventListener('pageshow', () => consumeIncomingShares());
		navigator.serviceWorker?.addEventListener('message', event => {
			if (event.data?.type === 'guey-share') consumeIncomingShares();
		});
		if ('launchQueue' in window) {
			window.launchQueue.setConsumer(async launch => {
				const files = [];
				for (const handle of launch.files ?? []) {
					try { files.push(await handle.getFile()); } catch { /* skipped */ }
				}
				if (!files.length) return;
				hooks.onIncomingShare?.();
				await attachFiles(files);
			});
		}
	}
	function pasteFiles(bag) {
		if (!bag) return [];
		const listed = [...(bag.files ?? [])].filter(Boolean);
		if (listed.length) return listed;
		const files = [];
		for (const item of bag.items ?? []) {
			if (item.kind !== 'file') continue;
			const file = item.getAsFile();
			if (file) files.push(file);
		}
		return files;
	}
	input.addEventListener('paste', event => {
		const files = pasteFiles(event.clipboardData);
		if (!files.length) return;
		event.preventDefault();
		Promise.all(files.map(attachFile)).then(() => {
			paintPending();
			hooks.onDraftChange?.();
		});
	});

	async function submit(behavior, extra = {}) {
		if (!slashMenu.hidden && behavior !== 'followUp') {
			const active = slashMenu.querySelector('.slash-item.active') || slashMenu.querySelector('.slash-item');
			const name = active?.dataset.command;
			if (name) { run(name); return { accepted: true, kind: 'slash' }; }
		}
		const text = input.value;
		if (personal) {
			if (attachments.some(piece => !piece.path)) {
				fail(new Error('wait for the file to finish uploading'));
				return { accepted: false, error: 'uploading' };
			}
			const notes = attachments.filter(piece => piece.path).map(piece => `[uploaded file: ${piece.path}]`);
			const body = [text.trim(), ...notes].filter(Boolean).join('\n\n');
			if (!body) return { accepted: false, error: 'empty' };
			if (!notes.length && !state?.busy && run(text.trim())) return { accepted: true, kind: 'command' };
			const sendBehavior = behavior ?? (state?.busy ? 'steer' : undefined);
			const sent = attachments;
			attachments = []; paintPending();
			input.value = ''; saveDraft(); slashMenu.hidden = true; hooks.onDraftChange?.();
			unlockDoneSound();
			try {
				const data = await command('prompt', { text: body, ...(sendBehavior ? { behavior: sendBehavior } : {}), ...extra });
				for (const piece of sent) if (piece.imageUrl) URL.revokeObjectURL(piece.imageUrl);
				return data && typeof data === 'object' ? { accepted: data.accepted !== false, ...data } : { accepted: true };
			} catch (error) {
				if (!input.value) { input.value = text; saveDraft(); hooks.onDraftChange?.(); }
				attachments = sent.concat(attachments); paintPending(); fail(error);
				return { accepted: false, error: error.message ?? String(error) };
			}
		}
		const images = attachments.map(p => p.image).filter(Boolean);
		const files = attachments.map(p => p.file).filter(Boolean);
		if (!text.trim() && !images.length && !files.length) return { accepted: false, error: 'empty' };
		if (!images.length && !files.length && !state?.busy && run(text.trim())) return { accepted: true, kind: 'command' };
		const sendBehavior = behavior ?? (state?.busy ? 'steer' : undefined);
		const sent = attachments;
		attachments = []; paintPending();
		input.value = ''; saveDraft(); slashMenu.hidden = true; hooks.onDraftChange?.();
		unlockDoneSound();
		try {
			const data = await command('prompt', { text: text.trim() || (images.length || files.length ? 'See attached.' : ''), ...(sendBehavior ? { behavior: sendBehavior } : {}), ...(images.length ? { images } : {}), ...(files.length ? { files } : {}), ...extra });
			return data && typeof data === 'object' ? { accepted: data.accepted !== false, ...data } : { accepted: true };
		} catch (error) {
			if (!input.value) { input.value = text; saveDraft(); hooks.onDraftChange?.(); }
			attachments = sent.concat(attachments); paintPending(); fail(error);
			return { accepted: false, error: error.message ?? String(error) };
		}
	}

	async function promptFromVoice(text) {
		const pinnedSession = state?.sessionId ?? null;
		const pinnedTab = focusedTabId();
		const draft = input.value;
		const block = composerBlockReason({
			draft,
			attachments: attachments.length,
			slashOpen: Boolean(slashMenu && !slashMenu.hidden),
			busy: Boolean(state?.busy),
		});
		if (block) return { accepted: false, error: block, sessionId: pinnedSession, tabId: pinnedTab };
		const trimmed = String(text ?? '').trim();
		if (!trimmed) return { accepted: false, error: 'empty', sessionId: pinnedSession, tabId: pinnedTab };
		if (trimmed.startsWith('/')) return { accepted: false, error: 'slash commands are not ordinary voice prompts', sessionId: pinnedSession, tabId: pinnedTab };
		if (state?.sessionId !== pinnedSession || focusedTabId() !== pinnedTab) {
			return { accepted: false, error: 'session changed', expected: pinnedSession, sessionId: state?.sessionId ?? null, tabId: focusedTabId() };
		}
		input.value = trimmed;
		input.dispatchEvent(new Event('input', { bubbles: true }));
		hooks.onDraftChange?.();
		if (state?.sessionId !== pinnedSession || focusedTabId() !== pinnedTab) {
			input.value = draft;
			input.dispatchEvent(new Event('input', { bubbles: true }));
			hooks.onDraftChange?.();
			return { accepted: false, error: 'session changed', expected: pinnedSession, sessionId: state?.sessionId ?? null, tabId: focusedTabId() };
		}
		const result = await submit(undefined, { expectedSessionId: pinnedSession, expectedTabId: pinnedTab });
		return {
			...result,
			sessionId: state?.sessionId ?? null,
			tabId: focusedTabId(),
			expected: pinnedSession,
			focusChanged: state?.sessionId !== pinnedSession || focusedTabId() !== pinnedTab,
		};
	}

	function moveSlash(delta) {
		if (slashMenu.hidden) return false;
		const draft = input.value;
		const matches = slashRows().filter(([name]) => name.startsWith(draft));
		if (!matches.length) return false;
		slashIndex = Math.max(0, Math.min(slashIndex + delta, matches.length - 1));
		paintSlash();
		return true;
	}
	input.addEventListener('input', () => {
		if (!input.value.startsWith('/')) keptDraft = input.value;
		saveDraft(); paintSlash();
	});
	if (slashMenu && !slashMenu.dataset.wheelBound) {
		slashMenu.dataset.wheelBound = '1';
		slashMenu.addEventListener('wheel', event => {
			if (slashMenu.hidden) return;
			event.preventDefault();
			moveSlash(event.deltaY > 0 ? 1 : -1);
		}, { passive: false });
	}
	inputZone?.addEventListener('wheel', event => {
		if (slashMenu.hidden) return;
		event.preventDefault();
		moveSlash(event.deltaY > 0 ? 1 : -1);
	}, { passive: false });
	const dictation = personal ? createDictation(input) : { start: () => {}, stop: () => {} };
	if (personal) attachHoldSpace(input, dictation);
	input.addEventListener('keydown', event => {
		if ((event.key === 'o' || event.key === 'O') && event.ctrlKey && !event.altKey && !event.metaKey) {
			event.preventDefault();
			expandAll = !expandAll;
			render();
			return;
		}
		if (event.key === 'Escape') {
			if (sessionRailOpen()) { closeSessionRail(); return; }
			if (overlay) { closeDialog(true); return; }
			if (!slashMenu.hidden) { slashMenu.hidden = true; return; }
			if (state?.busy) {
				event.preventDefault();
				command('abort').then(applyQueue).catch(fail);
				return;
			}
			hooks.onEscapeIdle?.();
			return;
		}
		if (sessionRailOpen() && ['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft'].includes(event.key) && !event.altKey) {
			event.preventDefault();
			moveRail(event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : -1);
			return;
		}
		if (sessionRailOpen() && event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
			event.preventDefault();
			activateRail();
			return;
		}
		if (!sessionRailOpen() && !overlay && slashMenu.hidden && ['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft'].includes(event.key) && !event.altKey && !event.ctrlKey && !event.metaKey) {
			const back = event.key === 'ArrowUp' || event.key === 'ArrowLeft';
			const atStart = input.selectionStart === 0 && input.selectionEnd === 0;
			const atEnd = input.selectionStart === input.value.length && input.selectionEnd === input.value.length;
			if ((back ? atStart : atEnd) && cycleTab(back ? -1 : 1)) {
				event.preventDefault();
				return;
			}
		}
		if (event.key === 'ArrowUp' && event.altKey) {
			event.preventDefault();
			command('dequeue').then(applyQueue).catch(fail);
			return;
		}
		if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && !slashMenu.hidden) {
			event.preventDefault();
			moveSlash(event.key === 'ArrowDown' ? 1 : -1);
			return;
		}
		if (event.key === 'Enter' && event.altKey && !event.shiftKey && !event.isComposing) {
			event.preventDefault();
			submit('followUp');
			return;
		}
		if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); submit(); }
		// Ctrl+C on an idle prompt is how a terminal stops work; keep the reflex.
		if (event.key === 'c' && event.ctrlKey && state?.busy) { event.preventDefault(); command('abort').catch(fail); }
		if (event.key === 'o' && event.ctrlKey) {
			event.preventDefault();
			const tools = [...output.querySelectorAll('[data-tool-id]')];
			const last = tools.at(-1)?.dataset.toolId;
			if (last) { open.has(last) ? open.delete(last) : open.add(last); render(); }
		}
	});

	// The model name in the status line is the model picker, the way ctrl+p is
	// in the tui.
	modelName.onclick = () => run('/model');

	setInterval(() => {
		if (!spinner) return;
		spin++;
		const frames = WORK_SPIN;
		spinner.textContent = frames[spin % frames.length];
	}, 80);
	addEventListener('pointerdown', unlockDoneSound);
	addEventListener('keydown', unlockDoneSound);
	addEventListener('resize', () => { if (socket?.readyState === WebSocket.OPEN) hello(); });
	// A tab left open in the background is not somebody using a computer, but it holds the socket
	// open, and the control plane reads an open socket as "in use" and keeps the machine awake --
	// which is how a forgotten tab bills a whole night. So a hidden tab lets go after a while and
	// reconnects the moment it is looked at again. Never mid-turn: the agent is doing work
	// somebody is waiting on, and dropping the socket there would abandon its output.
	const IDLE_TAB_MS = 5 * 60 * 1000;
	let hiddenTimer;
	function releaseIfStillHidden() {
		if (!document.hidden) return;
		if (state?.busy) { hiddenTimer = setTimeout(releaseIfStillHidden, 30_000); return; }
		try { socket?.close(1000, 'tab hidden'); } catch {}
	}
	document.addEventListener('visibilitychange', () => {
		clearTimeout(hiddenTimer);
		if (document.hidden) { hiddenTimer = setTimeout(releaseIfStillHidden, IDLE_TAB_MS); return; }
		if (socket?.readyState === WebSocket.OPEN) hello();
		else connect();
	});
	if (personal && 'serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
	connect();

	return {
		submit,
		dictation,
		isLive: () => socket?.readyState === WebSocket.OPEN,
		isBusy: () => Boolean(state?.busy),
		guiSnapshot,
		subscribe(fn) {
			guiListeners.add(fn);
			if (state) fn(guiSnapshot());
			return () => guiListeners.delete(fn);
		},
		onTurnEnd(fn) {
			turnListeners.add(fn);
			return () => turnListeners.delete(fn);
		},
		promptFromVoice,
		composerStatus: () => ({
			draft: input.value,
			attachments: attachments.length,
			slashOpen: Boolean(slashMenu && !slashMenu.hidden),
			busy: Boolean(state?.busy),
		}),
		latestAnswer: () => latestCompletedAssistant(state?.messages ?? []),
		assistantText: assistantTextFromMessage,
		newTab: () => command('tab-new'),
		focusTab: (tabId, extra = {}) => command('tab-focus', { tabId, ...extra }),
		closeTab: (tabId, extra = {}) => command('tab-close', { tabId, ...extra }),
		openWindow: (spec) => command('window-open', { window: spec }),
		closeWindow: (id) => command('window-close', { windowId: id }),
		setTheme: (name, persist = true) => command('theme', { name, persist }),
		windows: () => state?.windows ?? [],
		attachFiles,
	};
}
