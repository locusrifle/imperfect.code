const BAR_WIDTH = 20;
const STALE_MS = 60 * 60 * 1000;

export function meterBar(percent, width = BAR_WIDTH) {
	const n = Math.round((Math.max(0, Math.min(100, Number(percent) || 0)) / 100) * width);
	return `${'█'.repeat(n)}${'░'.repeat(width - n)}`;
}

export function resetText(resetsAt, now = Date.now()) {
	if (resetsAt == null || resetsAt === '') return 'reset unknown';
	const t = typeof resetsAt === 'number'
		? resetsAt * (resetsAt < 1e12 ? 1000 : 1)
		: Date.parse(resetsAt);
	if (!Number.isFinite(t)) return 'reset unknown';
	if (t <= now) return 'window ended';
	return `resets ${new Date(t).toLocaleString()}`;
}

export function readingAge(fetchedAt, now = Date.now()) {
	const t = Date.parse(fetchedAt);
	if (!Number.isFinite(t)) return { stale: true, label: 'no reading' };
	const age = now - t;
	if (age > STALE_MS) return { stale: true, label: 'stale' };
	return { stale: false, label: 'live' };
}

export function percentLabel(percent) {
	if (percent == null || Number.isNaN(Number(percent))) return '—';
	return `${Math.round(Number(percent))}% used`;
}
