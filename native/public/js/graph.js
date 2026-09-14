import { grid } from './pi-card.js';
import { knowledgeTree, layoutKnowledgeTree, treeConnector } from './graph-layout.js';

const NS = 'http://www.w3.org/2000/svg';
function svg(name, attrs) {
	const el = document.createElementNS(NS, name);
	for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
	return el;
}
function phase() {
	const cs = getComputedStyle(document.documentElement);
	return {
		unit: parseFloat(cs.getPropertyValue('--ic-grid-major')) || grid().unit || 24,
		ox: parseFloat(cs.getPropertyValue('--ic-grid-origin-x')) || 0,
		oy: parseFloat(cs.getPropertyValue('--ic-grid-origin-y')) || 0,
	};
}
const snap = (n, origin, unit) => origin + Math.round((n - origin) / unit) * unit;
const onLine = (n, origin, unit) => Math.abs((n - origin) / unit - Math.round((n - origin) / unit)) * unit < 0.75;

function wrapLines(text, maxWidth, ctx) {
	if (ctx.measureText(text).width <= maxWidth) return [text];
	const lines = [];
	let line = '';
	// Prefer the domain boundary, then break any remaining long word.
	for (const word of String(text).split(/\s+|(?<=\.)/)) {
		if (line && ctx.measureText(`${line} ${word}`).width <= maxWidth) { line += ` ${word}`; continue; }
		if (line) lines.push(line);
		line = '';
		for (const char of word) {
			if (line && ctx.measureText(line + char).width > maxWidth) { lines.push(line); line = ''; }
			line += char;
		}
	}
	if (line || !lines.length) lines.push(line);
	return lines;
}

function renderMarkdown(container, text, onLink) {
	// The actual Markdown, with working wiki links. textContent keeps raw HTML
	// inert; preserving line breaks avoids inventing paragraphs around each link.
	const body = document.createElement('div');
	body.className = 'knowledge-md';
	for (const part of String(text).split(/(\[\[[^\]]+\]\])/g)) {
		const match = part.match(/^\[\[([^\]|#]+)(?:#([^\]|]+))?(?:\|([^\]]+))?\]\]$/);
		if (!match) { body.append(document.createTextNode(part)); continue; }
		const button = document.createElement('button');
		button.type = 'button';
		button.className = 'knowledge-wiki';
		button.textContent = match[3] || match[1];
		button.dataset.target = match[1].trim();
		button.onclick = event => { event.stopPropagation(); onLink(match[1].trim()); };
		body.append(button);
	}
	container.append(body);
}

export function mountKnowledgeGraph({ getPan = () => ({ x: 0, y: 0 }) } = {}) {
	const host = document.createElement('div');
	host.id = 'knowledge-graph-host';
	host.hidden = true;
	const graph = svg('svg', { id: 'knowledge-graph', 'aria-hidden': 'true' });
	const edges = svg('g', { class: 'edge-layer' });
	graph.append(edges);
	const cards = document.createElement('div');
	cards.id = 'knowledge-cards';
	function control(id, text, label) {
		const button = document.createElement('button');
		button.id = id;
		button.type = 'button';
		button.textContent = text;
		button.setAttribute('aria-label', label);
		return button;
	}
	const close = control('knowledge-graph-close', '\u00d7', 'Close graph');
	const collapse = control('knowledge-close', '\u2212', 'Collapse page');
	const back = control('knowledge-back', 'back', 'Previous page');
	collapse.hidden = back.hidden = true;
	host.append(graph, cards, close, collapse, back);
	document.body.append(host);

	let data;
	let open = false;
	let expandedId = null;
	let request = null;
	let loadVersion = 0;
	const history = [];
	const nodeEls = new Map();
	const ctx = document.createElement('canvas').getContext('2d');

	function layout() {
		if (!data) return;
		const { unit, ox, oy } = phase();
		const pan = getPan();
		// The graph lays out inside its own host, which stops above the bar. Reading
		// the window instead anchored the root under the bar, out of reach.
		const box = host.getBoundingClientRect();
		const width = Math.round(box.width) || innerWidth;
		const height = Math.round(box.height) || innerHeight;
		graph.setAttribute('viewBox', `0 0 ${width} ${height}`);
		const fontPx = Math.max(10, unit * 0.5);
		ctx.font = `${fontPx}px ui-monospace, monospace`;
		const columns = Math.max(4, Math.floor(width / unit));
		const maxCells = columns - columns % 2;
		const sizes = new Map();
		const labels = new Map();
		for (const node of data.nodes) {
			// Even widths: the title, card centre and its connector all share a
			// grid intersection. Odd widths caused the former half-cell offset.
			const cap = Math.min(width < 700 ? 4 : 8, maxCells);
			let cellW = Math.max(4, Math.ceil((ctx.measureText(node.label).width + unit * 0.9) / (2 * unit)) * 2);
			cellW = Math.min(cellW, cap);
			while (cellW < cap && ctx.measureText(node.label).width + unit * 0.9 > cellW * unit) cellW += 2;
			cellW = Math.min(cellW, cap);
			const lines = wrapLines(node.label, cellW * unit - unit * 0.9, ctx).slice(0, 1);
			let cellH = 1;
			if (expandedId === node.id) {
				cellW = Math.min(maxCells, 18);
				cellH = Math.max(4, Math.min(12, Math.floor(height / unit) - 10));
			}
			sizes.set(node.id, { cellW, cellH });
			labels.set(node.id, lines);
		}
		// Matching sibling envelopes keep the visible crown symmetric as well as
		// its centre lines. An open document is deliberately its own size.
		for (const kids of knowledgeTree(data).children.values()) {
			const closed = kids.filter(id => id !== expandedId);
			const cellW = Math.max(0, ...closed.map(id => sizes.get(id).cellW));
			const cellH = Math.max(0, ...closed.map(id => sizes.get(id).cellH));
			for (const id of closed) sizes.set(id, { cellW, cellH });
		}
		const tree = layoutKnowledgeTree(data, sizes, { maxSpan: maxCells });
		// Centre the trunk, not each card. When the drop is open, sit in the canvas below it.
		const anchorX = snap(width / 2 + pan.x, ox, unit);
		const anchorY = snap(height - unit + pan.y, oy, unit);
		const boxes = new Map();
		for (const node of data.nodes) {
			const packed = tree.boxes.get(node.id);
			const card = nodeEls.get(node.id);
			card.hidden = !packed;
			if (!packed) continue;
			const box = { left: anchorX + packed.left * unit, top: anchorY + packed.top * unit, w: packed.w * unit, h: packed.h * unit };
			boxes.set(node.id, box);
			Object.assign(card.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.w}px`, height: `${box.h}px` });
			const expanded = node.id === expandedId;
			card.classList.toggle('expanded', expanded);
			card.classList.toggle('opened', expanded);
			card.setAttribute('aria-expanded', String(expanded));
			const label = card.querySelector('.node-label');
			label.replaceChildren(...labels.get(node.id).map(text => {
				const span = document.createElement('span');
				span.className = 'node-label-line';
				span.textContent = text;
				return span;
			}));
		}
		edges.replaceChildren(...tree.edges.map(([from, to]) => svg('path', {
			class: 'edge', 'data-edge': `${from}::${to}`,
			d: treeConnector(boxes.get(from), boxes.get(to), unit),
		})));
		collapse.hidden = !expandedId;
		back.hidden = history.length < 2;
	}

	function resolveTarget(target) {
		const key = target.replace(/\.md$/i, '').toLowerCase();
		const dir = expandedId?.includes('/') ? expandedId.slice(0, expandedId.lastIndexOf('/') + 1) : '';
		return data.nodes.find(n => n.id.toLowerCase() === dir + key)?.id
			|| data.nodes.find(n => n.id.toLowerCase() === key || n.path?.replace(/\.md$/i, '').toLowerCase() === key)?.id;
	}

	async function openPage(id, remember = true) {
		id = nodeEls.has(id) ? id : resolveTarget(id);
		if (!id) return;
		request?.abort();
		request = new AbortController();
		const pending = request;
		if (remember && history.at(-1) !== id) history.push(id);
		expandedId = id;
		for (const card of nodeEls.values()) card.querySelector('.node-body').removeAttribute('id');
		const card = nodeEls.get(id);
		const doc = card.querySelector('.node-body');
		doc.id = 'knowledge-document';
		doc.textContent = 'loading\u2026';
		layout();
		try {
			const res = await fetch(`/graph/page?id=${encodeURIComponent(id)}`, { signal: pending.signal });
			if (!res.ok) throw new Error('Could not load page');
			const page = await res.json();
			if (pending.signal.aborted || expandedId !== id) return;
			doc.replaceChildren();
			const heading = document.createElement('h1');
			heading.textContent = page.title || id;
			doc.append(heading);
			renderMarkdown(doc, page.missing ? 'Missing page' : page.content, target => void openPage(target));
		} catch (error) {
			if (pending.signal.aborted) return;
			const message = document.createElement('p');
			message.className = 'knowledge-error';
			message.textContent = 'Could not load page';
			doc.replaceChildren(message);
		}
	}
	function collapsePage() {
		request?.abort();
		const previous = expandedId;
		expandedId = null;
		history.length = 0;
		layout();
		nodeEls.get(previous)?.focus({ preventScroll: true });
	}
	function closeGraph() {
		request?.abort();
		loadVersion++;
		open = false;
		expandedId = null;
		history.length = 0;
		host.hidden = true;
		host.classList.remove('open');
	}
	function draw() {
		cards.replaceChildren();
		nodeEls.clear();
		for (const node of data.nodes) {
			// An article can contain link buttons. A button containing other buttons
			// cannot, and used to re-fetch a page whenever its text was tapped.
			const card = document.createElement('article');
			card.className = `node${node.id === data.root ? ' root' : ''}${node.missing ? ' missing' : ''}`;
			card.dataset.node = node.id;
			card.tabIndex = 0;
			card.setAttribute('role', 'button');
			card.setAttribute('aria-label', node.label);
			const label = document.createElement('div');
			label.className = 'node-label';
			const body = document.createElement('div');
			body.className = 'node-body';
			card.append(label, body);
			card.addEventListener('click', () => { if (expandedId !== node.id) void openPage(node.id); });
			card.addEventListener('keydown', event => {
				if (event.target !== card || !['Enter', ' '].includes(event.key)) return;
				event.preventDefault();
				if (expandedId === node.id) collapsePage(); else void openPage(node.id);
			});
			cards.append(card);
			nodeEls.set(node.id, card);
		}
		layout();
	}
	collapse.onclick = collapsePage;
	back.onclick = () => { history.pop(); void openPage(history.at(-1), false); };
	close.onclick = closeGraph;
	addEventListener('resize', () => { if (open) layout(); });
	addEventListener('imperfect:gridchange', () => { if (open) layout(); });
	host.openKnowledgePage = openPage;
	return {
		isOpen: () => open,
		layout,
		close: closeGraph,
		async open() {
			const version = ++loadVersion;
			open = true;
			expandedId = null;
			history.length = 0;
			host.hidden = false;
			host.classList.add('open');
			try {
				const res = await fetch('/graph.json');
				if (!res.ok) throw new Error('graph failed');
				const next = await res.json();
				if (version !== loadVersion) return;
				data = next;
				draw();
			} catch {
				if (version !== loadVersion) return;
				data = { root: 'error', nodes: [{ id: 'error', label: 'Could not load graph', missing: true }], edges: [] };
				draw();
			}
		},
	};
}

export { phase as knowledgeGridPhase, onLine as knowledgeOnGridLine };
