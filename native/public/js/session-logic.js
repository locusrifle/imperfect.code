// Pure helpers for the imperfect voice mediator. No DOM, no network.

export const VOICE_MODEL = 'gpt-live-1';
export const VOICE_KEEP_EXCHANGES = 4;
export const VOICE_TEXT_MAX = 8000;
export const VOICE_APPEND_MAX = 1800;

export function turnActive(snap) {
	return Boolean(snap?.streaming ?? snap?.busy);
}

export function micConflict(dictation) {
	return Boolean(dictation?.live || dictation?.pending);
}

export function composerBlockReason({ draft, attachments, slashOpen, busy } = {}) {
	if (slashOpen) return 'slash picker is open';
	if (Number(attachments) > 0) return 'composer has attachments';
	if (String(draft ?? '').trim()) return 'composer has a draft';
	if (busy) return 'Pi is still working in this tab';
	return null;
}

export function userTextFromMessage(entry) {
	if (!entry || entry.role !== 'user') return '';
	if (typeof entry.content === 'string') return entry.content.trim();
	const texts = [];
	for (const block of entry.content ?? []) {
		if (block?.type === 'text' && block.text) texts.push(block.text);
		else if (typeof block === 'string') texts.push(block);
	}
	return texts.join('\n').trim();
}

export function latestUserText(messages = []) {
	for (let i = messages.length - 1; i >= 0; i--) {
		const text = userTextFromMessage(messages[i]);
		if (text) return text;
	}
	return '';
}

function clipNote(value, max) {
	const text = String(value ?? '').trim();
	if (text.length <= max) return text;
	return text.slice(0, max);
}

export function formatHarnessNow(snap = {}, { max = VOICE_TEXT_MAX } = {}) {
	const lines = [
		'[harness-now]',
		'Same identity as this harness. Already here. Do not greet as a new person. Do not read this note aloud. Wait for Noah.',
	];
	lines.push(snap.busy ? 'busy: work is in flight' : 'idle');
	if (snap.failed) lines.push(`failed: ${clipNote(snap.failed, 200)}`);
	const heard = clipNote(latestUserText(snap.messages), 400);
	const said = clipNote(latestReadyAssistant(snap.messages, { idle: !snap.busy })?.text ?? '', 400);
	if (heard) lines.push(`last Noah: ${heard}`);
	if (said) lines.push(`last you: ${said}`);
	return lines.join('\n').slice(0, max);
}

export function assistantTextFromMessage(entry) {
	if (!entry || entry.role !== 'assistant') return '';
	const texts = [];
	if (typeof entry.content === 'string') texts.push(entry.content);
	else {
		for (const block of entry.content ?? []) {
			if (block?.type === 'text' && block.text) texts.push(block.text);
		}
	}
	if (entry.errorMessage) texts.push(String(entry.errorMessage));
	return texts.join('\n').trim();
}

export function isReadyAssistant(entry, { idle = false } = {}) {
	if (!entry || entry.role !== 'assistant' || entry.partial) return false;
	const text = assistantTextFromMessage(entry);
	if (!text) return false;
	const status = entry.status ?? entry.stopReason;
	if (entry.errorMessage || status === 'error') return true;
	if (status && ['stop', 'completed', 'end'].includes(status)) return true;
	if (!status && idle) return true;
	return false;
}

export function latestReadyAssistant(messages = [], opts = {}) {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (isReadyAssistant(messages[i], opts)) {
			return { index: i, text: assistantTextFromMessage(messages[i]), message: messages[i] };
		}
	}
	return null;
}

export function latestCompletedAssistant(messages = [], opts = {}) {
	return latestReadyAssistant(messages, opts);
}

export function assistantBaseline(messages = [], opts = { idle: true }) {
	const latest = latestReadyAssistant(messages, opts);
	if (!latest) return { index: -1, id: null };
	return { index: latest.index, id: latest.message?.id ?? null };
}

export function assistantFingerprint(messages = [], opts = { idle: true }) {
	const latest = latestReadyAssistant(messages, opts);
	return latest ? `${latest.index}:${latest.text}` : '';
}

export function answerEvidence(messages = []) {
	const latest = latestReadyAssistant(messages, { idle: true });
	if (!latest) return null;
	const truncated = latest.text.length > VOICE_TEXT_MAX;
	return {
		text: truncated ? latest.text.slice(0, VOICE_TEXT_MAX) : latest.text,
		index: latest.index,
		id: latest.message?.id ?? null,
		truncated,
	};
}

export function answerFromTurn(ended, baseline) {
	if (ended?.error) return { error: ended.error, failed: ended.failed ?? null };
	const ev = ended?.answer;
	if (!ev || typeof ev.index !== 'number' || !ev.text) {
		return { error: 'Pi finished without a completed answer' };
	}
	const sameIndex = baseline && ev.index === baseline.index;
	const sameId = baseline?.id != null && ev.id != null && ev.id === baseline.id;
	if (sameIndex || sameId) return { error: 'Pi finished without a completed answer' };
	return { text: ev.text, truncated: Boolean(ev.truncated), index: ev.index, id: ev.id ?? null };
}

export function focusChanged(pinned, current) {
	if (!pinned) return false;
	return pinned.sessionId !== current?.sessionId || (pinned.tabId != null && current?.tabId != null && pinned.tabId !== current.tabId);
}

export function rememberCall(seen, callId) {
	if (!callId || seen.has(callId)) return false;
	seen.add(callId);
	return true;
}

export function parseToolArguments(raw) {
	if (raw == null || raw === '') return { ok: true, value: {} };
	if (typeof raw === 'object' && !Array.isArray(raw)) return { ok: true, value: raw };
	try {
		const value = JSON.parse(raw);
		if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: 'invalid arguments' };
		return { ok: true, value };
	} catch {
		return { ok: false, error: 'invalid arguments' };
	}
}

function extraKeys(args, allowed) {
	return Object.keys(args).some(key => !allowed.includes(key));
}

export function validateToolCall(name, args = {}) {
	if (name === 'send_to_pi') {
		if (extraKeys(args, ['text'])) return { error: 'unexpected argument' };
		if (typeof args.text !== 'string') return { error: 'text must be a string' };
		if (!args.text.trim()) return { error: 'text required' };
		if (args.text.length > VOICE_TEXT_MAX) return { error: 'text too long' };
		return { ok: true, value: { text: args.text } };
	}
	if (name === 'read_answer') {
		if (extraKeys(args, ['full'])) return { error: 'unexpected argument' };
		if (args.full != null && typeof args.full !== 'boolean') return { error: 'full must be boolean' };
		return { ok: true, value: { full: args.full === true } };
	}
	if (name === 'control_view') {
		if (extraKeys(args, ['target', 'action'])) return { error: 'unexpected argument' };
		if (!['harness', 'graph', 'desktop'].includes(args.target)) return { error: 'invalid target' };
		if (!['open', 'close'].includes(args.action)) return { error: 'invalid action' };
		return { ok: true, value: { target: args.target, action: args.action } };
	}
	if (name === 'manage_tabs') {
		if (extraKeys(args, ['action', 'tab_id', 'confirm'])) return { error: 'unexpected argument' };
		if (!['list', 'new', 'focus', 'close'].includes(args.action)) return { error: 'invalid action' };
		if ((args.action === 'focus' || args.action === 'close')) {
			if (typeof args.tab_id !== 'string' || !args.tab_id) return { error: 'tab_id required' };
		}
		if (args.confirm != null && typeof args.confirm !== 'boolean') return { error: 'confirm must be boolean' };
		return { ok: true, value: { action: args.action, tab_id: args.tab_id, confirm: args.confirm === true } };
	}
	return { error: `unknown tool ${name}` };
}

export function functionCallsFromResponse(response) {
	const output = response?.output;
	if (!Array.isArray(output)) return [];
	return output.filter(item => item?.type === 'function_call' && item.call_id);
}

export function staleCommandError(c, snap = {}) {
	if (!c || (c.expectedSessionId == null && c.expectedTabId == null)) return null;
	const focused = (snap.tabs ?? []).find(tab => tab.focused);
	const focusedId = focused?.id ?? null;
	if (c.type === 'prompt') {
		if (c.expectedSessionId != null && c.expectedSessionId !== snap.sessionId) return 'session changed';
		if (c.expectedTabId != null && focusedId != null && c.expectedTabId !== focusedId) return 'session changed';
	}
	if (c.type === 'tab-close' || c.type === 'tab-focus') {
		if (c.expectedTabId != null && c.tabId != null && c.expectedTabId !== c.tabId) return 'session changed';
		if (c.expectedSessionId != null) {
			const target = (snap.tabs ?? []).find(tab => tab.id === c.tabId);
			if (target?.sessionId && target.sessionId !== c.expectedSessionId) return 'session changed';
		}
	}
	return null;
}

export function tabCloseBusyError(c, snap = {}) {
	if (c?.type !== 'tab-close') return null;
	const target = (snap.tabs ?? []).find(tab => tab.id === c.tabId);
	if (target?.busy && !c.closeConfirmed) return 'tab is busy';
	return null;
}

function unansweredFunction(items) {
	const calls = new Set(items.filter(item => item.type === 'function_call').map(item => item.call_id).filter(Boolean));
	const outs = new Set(items.filter(item => item.type === 'function_call_output').map(item => item.call_id).filter(Boolean));
	for (const id of calls) if (!outs.has(id)) return true;
	return false;
}

export function exchangeGroups(items = []) {
	const groups = [];
	let current = null;
	for (const item of items) {
		const starts = item?.type === 'message' && item.role === 'user';
		if (starts || !current) {
			current = { items: [item] };
			groups.push(current);
			continue;
		}
		current.items.push(item);
	}
	for (const group of groups) {
		group.pending = group.items.some(item => item?.status && item.status !== 'completed' && item.status !== 'incomplete')
			|| unansweredFunction(group.items);
	}
	return groups;
}

export function itemIdsToDelete(items = [], keep = VOICE_KEEP_EXCHANGES) {
	const completed = exchangeGroups(items).filter(group => !group.pending);
	const extra = completed.length - keep;
	if (extra <= 0) return [];
	const ids = [];
	for (let i = 0; i < extra; i++) {
		for (const item of completed[i].items) if (item?.id) ids.push(item.id);
	}
	return ids;
}

export function tabTarget(tabs, tabId) {
	if (!tabId) return { error: 'tab_id required' };
	const list = Array.isArray(tabs) ? tabs : [];
	const tab = list.find(item => item.id === tabId);
	if (!tab) return { error: 'Unknown tab' };
	return { tab };
}

export function formatPiResult({ tabId, sessionId, text, error, truncated } = {}) {
	const tag = `[pi-result tab=${tabId ?? ''} session=${sessionId ?? ''}]`;
	if (error) return `${tag} error: ${error}`.slice(0, VOICE_TEXT_MAX);
	return `${tag}${truncated ? ' truncated=true' : ''}\n${text ?? ''}`.slice(0, VOICE_TEXT_MAX);
}

export function spokenWorkResult({ text, error, truncated } = {}) {
	if (error) return `The work failed: ${error}`.slice(0, VOICE_APPEND_MAX);
	const body = String(text ?? '').trim() || 'The work finished with no text to speak.';
	return `${truncated ? '(truncated)\n' : ''}${body}`.slice(0, VOICE_APPEND_MAX);
}

export function clientDelegationId(event) {
	if (event?.type !== 'session.delegation.created') return null;
	if (event.delegation?.target && event.delegation.target !== 'client') return null;
	const id = event.delegation?.id;
	return typeof id === 'string' && id ? id : null;
}

export function routeVoiceRequest(text) {
	const raw = String(text ?? '').trim();
	if (!raw) return { error: 'nothing heard' };
	const t = raw.toLowerCase();
	if (/\bread the full answer\b/.test(t) || /\bread (that|the answer|the screen)\b/.test(t) || /\bwhat(s|'s| is) on (the )?screen\b/.test(t)) {
		return { ok: true, name: 'read_answer', value: { full: /\bfull\b/.test(t) } };
	}
	for (const target of ['harness', 'graph', 'desktop']) {
		if (!t.includes(target)) continue;
		if (t.includes('close')) return { ok: true, name: 'control_view', value: { target, action: 'close' } };
		if (t.includes('open')) return { ok: true, name: 'control_view', value: { target, action: 'open' } };
	}
	if (/\b(new tab|another tab)\b/.test(t)) return { ok: true, name: 'manage_tabs', value: { action: 'new' } };
	if (/\blist tabs\b/.test(t)) return { ok: true, name: 'manage_tabs', value: { action: 'list' } };
	return { ok: true, name: 'send_to_pi', value: { text: raw } };
}

export function spokenToolResult(name, result) {
	if (name === 'send_to_pi' && result?.accepted) return null;
	if (!result || result.error) return spokenWorkResult({ error: result?.error || 'that failed' });
	if (name === 'read_answer') {
		if (result.busy) return 'Work is still running on screen.';
		if (!result.text) return 'There is no completed answer on screen.';
		return spokenWorkResult({ text: result.text });
	}
	if (name === 'control_view') {
		const extra = result.note ? ` ${result.note}` : '';
		return `That view is ${result.open ? 'open' : 'closed'}.${extra}`;
	}
	if (name === 'manage_tabs') {
		if (result.needsConfirm) return result.error || 'That tab is still working.';
		const tabs = result.tabs ?? [];
		if (result.ok && tabs.length) return `${tabs.length} tabs.`;
		return 'Done.';
	}
	return 'Done.';
}

export function canCreateResponse({ needResponse, responseActive, responsePending, userSpeaking, toolTasks } = {}) {
	return Boolean(needResponse) && !responseActive && !responsePending && !userSpeaking && !(toolTasks > 0);
}
