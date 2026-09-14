import { percentLabel, readingAge, resetText } from './usage.js';

const el = (tag, text, className) => {
	const node = document.createElement(tag);
	if (text != null) node.textContent = text;
	if (className) node.className = className;
	return node;
};

function formatCount(n) {
	const v = Number(n) || 0;
	if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
	if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
	return String(v);
}

function meter(percent) {
	const pct = Math.max(0, Math.min(100, Number(percent) || 0));
	const row = el('div', null, 'ab-meter-row');
	const track = el('div', null, 'ab-track');
	const fill = el('div', null, `ab-fill${pct >= 90 ? ' crit' : pct >= 70 ? ' warn' : ''}`);
	fill.style.width = `${pct}%`;
	track.append(fill);
	row.append(track, el('span', percentLabel(pct), 'ab-pct'));
	return row;
}

export function paintAntiburn(root, report = {}) {
	if (!root) return;
	root.replaceChildren();
	root.append(el('p', 'antiburn', 'ab-wordmark'));
	root.append(el('p', report.fetchedAt ? new Date(report.fetchedAt).toLocaleString() : 'no reading', 'ab-fetched'));
	for (const provider of report.providers ?? []) {
		const card = el('section', null, 'ab-provider');
		const age = readingAge(provider.fetchedAt);
		const head = el('p', null, 'ab-name');
		head.append(el('span', provider.name || provider.id || 'provider'));
		if (provider.plan) head.append(el('span', ` · ${provider.plan}`, 'ab-plan'));
		if (age.stale) head.append(el('span', ` · ${age.label}`, 'ab-stale'));
		card.append(head);
		if (!provider.windows?.length) {
			card.append(el('p', provider.note || 'no meter', 'ab-empty'));
		} else {
			for (const window of provider.windows) {
				const row = el('div', null, 'ab-window');
				row.append(el('p', window.label || 'limit', 'ab-label'));
				row.append(meter(window.percent));
				row.append(el('p', resetText(window.resetsAt), 'ab-reset'));
				card.append(row);
			}
			if (provider.note) card.append(el('p', provider.note, 'ab-note'));
		}
		const stats = provider.stats;
		if (stats && (stats.totalSessions || stats.activeDays || stats.todayTokens)) {
			const row = el('div', null, 'ab-stats');
			for (const [label, value] of [
				['today', formatCount(stats.todaySessions)],
				['tokens', formatCount(stats.todayTokens)],
				['sessions', formatCount(stats.totalSessions)],
				['days', formatCount(stats.activeDays)],
			]) {
				const cell = el('div', null, 'ab-stat');
				cell.append(el('div', value, 'ab-stat-value'));
				cell.append(el('div', label, 'ab-stat-label'));
				row.append(cell);
			}
			card.append(row);
		}
		if (provider.models?.length) {
			const list = el('div', null, 'ab-models');
			for (const model of provider.models.slice(0, 5)) {
				const line = el('div', null, 'ab-model');
				line.append(el('span', model.id, 'ab-model-id'));
				line.append(el('span', formatCount(model.tokens), 'ab-model-n'));
				list.append(line);
			}
			card.append(list);
		}
		root.append(card);
	}
}

export async function mountAntiburn(root) {
	try {
		const res = await fetch('/antiburn-report.json', { cache: 'no-store' });
		if (!res.ok) throw new Error('no reading');
		paintAntiburn(root, await res.json());
	} catch (error) {
		paintAntiburn(root, { providers: [{ id: 'none', name: 'antiburn', windows: [], note: String(error.message || error) }] });
	}
}

// A module-scope document read made this file unimportable outside a browser,
// which took review-window.js and its whole test file with it.
if (typeof document !== 'undefined') {
	const boot = document.getElementById('antiburn-app');
	if (boot) void mountAntiburn(boot);
}
