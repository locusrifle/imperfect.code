// One window type in the phone shell.
// Contents are video, image, text, or a same-origin page — and `page` is the
// empty container every other web project is manifested inside, which is why
// antiburn is not a window kind of its own.
//
// The window fills the slot the shell gives it. No pixel sizing, no fullscreen
// gesture: rotating the phone is how an application gets the larger view.
// Never innerHTML, never auto-focus, never a foreign URL unless the parent opts in.

import { mountAntiburn } from './antiburn-app.js';

// Pages that are in-page applications rather than documents to frame.
const MOUNTED_PAGES = new Map([['/antiburn.html', mountAntiburn]]);

function el(tag, text, className) {
	const node = document.createElement(tag);
	if (text != null) node.textContent = text;
	if (className) node.className = className;
	return node;
}

function isSafeDataUrl(raw) {
	if (!raw.startsWith('data:')) return false;
	const comma = raw.indexOf(',');
	if (comma < 5) return false;
	const mime = raw.slice(5, comma).split(';')[0].toLowerCase();
	return mime.startsWith('image/') || mime.startsWith('video/') || mime.startsWith('audio/') || mime === 'text/plain';
}

function isInAppPath(raw) {
	if (!raw.startsWith('/') || raw.startsWith('//')) return false;
	if (raw.includes('\\')) return false;
	let path = raw.split('#')[0].split('?')[0];
	try { path = decodeURIComponent(path); }
	catch { return false; }
	return !path.split('/').includes('..');
}

export function isAllowedSrc(src, { allowExternal = false } = {}) {
	if (src == null || src === '') return false;
	const raw = String(src).trim();
	if (!raw) return false;
	if (raw.startsWith('blob:')) return true;
	if (raw.startsWith('data:')) return isSafeDataUrl(raw);
	if (isInAppPath(raw)) return true;
	let url;
	try { url = new URL(raw); }
	catch { return false; }
	const protocol = url.protocol.toLowerCase();
	if (protocol === 'javascript:' || protocol === 'vbscript:' || protocol === 'file:') return false;
	if (protocol === 'blob:') return true;
	if (protocol === 'data:') return isSafeDataUrl(raw);
	if (protocol === 'http:' || protocol === 'https:') {
		if (allowExternal) return true;
		try { return url.origin === location.origin; }
		catch { return false; }
	}
	return false;
}

export function classifyContent(input = {}) {
	if (typeof input === 'string') return 'text';
	if (input.kind === 'video' || input.kind === 'image' || input.kind === 'text' || input.kind === 'page') return input.kind;
	if (input.kind === 'blocked' || input.kind === 'unknown' || input.kind === 'empty') return input.kind;
	const file = input.file;
	const mime = String(file?.type || input.type || '').toLowerCase();
	const name = String(file?.name || input.name || '');
	const src = String(input.src || '');
	if (/\/content\/media\//.test(src)) return 'video';
	if (mime.startsWith('video/') || /\.(mp4|webm|ogv?|mov|m4v)(\?|$)/i.test(name) || /\.(mp4|webm|ogv?|mov|m4v)(\?|$)/i.test(src)) return 'video';
	if (mime.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|svg)(\?|$)/i.test(name) || /\.(png|jpe?g|gif|webp|bmp|svg)(\?|$)/i.test(src)) return 'image';
	if (input.text != null) return 'text';
	if (mime.startsWith('text/') || /^application\/(json|xml)$/i.test(mime) || /\.(txt|md|json|csv|log|xml)$/i.test(name)) return 'text';
	if (file || input.src || input.type || name) return 'unknown';
	return 'empty';
}

function normalize(input) {
	if (input == null || input === '') return {};
	if (typeof input === 'string') return { kind: 'text', text: input };
	return input;
}

function phoneLayout() {
	try { return Boolean(matchMedia('(pointer: coarse), (max-width: 700px)').matches); }
	catch { return false; }
}

async function readText(content) {
	if (content.text != null) return String(content.text);
	const file = content.file;
	if (file && typeof file.text === 'function') return String(await file.text());
	return '';
}

export function mountReviewWindow(options = {}) {
	let panel = null;
	let stage = null;
	let bodyHost = null;
	let gen = 0;
	let opening = null;
	let ownedUrl = null;
	let current = null;

	function worldHost() {
		return options.host?.() ?? options.world ?? document.getElementById('imperfect-world') ?? document.body;
	}

	function setTitle(text) {
		const node = panel?.querySelector('.review-status');
		if (node) node.textContent = text;
		panel?.setAttribute('aria-label', text || 'review');
	}

	function forgetUrl() {
		if (ownedUrl) {
			try { URL.revokeObjectURL(ownedUrl); } catch { /* already gone */ }
			ownedUrl = null;
		}
	}

	function clearStage() {
		forgetUrl();
		if (stage) stage.replaceChildren();
	}

	function paintMessage(kind, text) {
		clearStage();
		const note = el('p', text, `review-message review-${kind}`);
		stage.append(note);
		panel.dataset.kind = kind;
	}

	function mediaSrc(content) {
		const allow = { allowExternal: Boolean(options.allowExternal) };
		if (content.src != null && content.src !== '') {
			if (!isAllowedSrc(content.src, allow)) return { blocked: true };
			return { src: String(content.src), owned: false };
		}
		if (content.file) {
			const src = URL.createObjectURL(content.file);
			return { src, owned: true };
		}
		return { empty: true };
	}

	function paintMedia(tag, content, kind) {
		const resolved = mediaSrc(content);
		if (resolved.blocked) {
			paintMessage('blocked', 'blocked: external URL');
			current = { kind: 'blocked', name: content.name || '', title: content.title || '' };
			return;
		}
		if (resolved.empty) {
			clearStage();
			panel.dataset.kind = kind;
			return;
		}
		clearStage();
		if (resolved.owned) ownedUrl = resolved.src;
		const node = document.createElement(tag);
		node.className = `review-${kind}`;
		if (tag === 'img') {
			node.alt = content.title || content.name || 'image';
			node.draggable = false;
		} else {
			node.controls = true;
			node.playsInline = true;
			node.autoplay = false;
			node.setAttribute('playsinline', '');
			node.setAttribute('webkit-playsinline', '');
			node.setAttribute('controlslist', 'nodownload');
			node.preload = 'metadata';
			const label = content.title || content.name;
			if (label) node.setAttribute('aria-label', label);
		}
		node.src = resolved.src;
		stage.append(node);
		panel.dataset.kind = kind;
	}

	async function paint(content) {
		const source = normalize(content);
		const title = source.title || source.name || source.file?.name || '';
		const kind = classifyContent(source);
		setTitle(title || kind);
		current = { kind, name: source.name || '', title };
		if (!stage) return;
		if (kind === 'empty') {
			clearStage();
			panel.dataset.kind = 'empty';
			return;
		}
		if (kind === 'image') {
			paintMedia('img', source, 'image');
			return;
		}
		if (kind === 'video') {
			paintMedia('video', source, 'video');
			return;
		}
		if (kind === 'text') {
			const text = await readText(source);
			if (!stage || !panel) return;
			clearStage();
			const pre = el('pre', text, 'review-text');
			stage.append(pre);
			panel.dataset.kind = 'text';
			current = { kind: 'text', name: source.name || '', title };
			return;
		}
		if (kind === 'page') {
			const src = String(source.src || '/antiburn.html');
			// The empty container: any page this application serves can be shown
			// here. A foreign origin is still refused — the shell only manifests
			// projects that live behind the same tailnet door.
			if (!isInAppPath(src) || !/\.html$/.test(src.split('?')[0])) {
				paintMessage('blocked', 'blocked: not an in-app page');
				current = { kind: 'blocked', name: source.name || '', title };
				return;
			}
			clearStage();
			panel.dataset.kind = 'page';
			current = { kind: 'page', name: source.name || '', title, src };
			const mount = MOUNTED_PAGES.get(src.split('?')[0]);
			if (mount) {
				const host = el('div', null, 'review-page');
				stage.append(host);
				void mount(host);
				return;
			}
			const frame = document.createElement('iframe');
			frame.className = 'review-page-frame';
			frame.title = title || 'page';
			frame.setAttribute('loading', 'eager');
			// Workspace apps are not the product. Without same-origin they cannot
			// reach the shell. Built-in pages keep the existing frame.
			if (src.split('?')[0].startsWith('/apps/')) frame.setAttribute('sandbox', 'allow-scripts allow-forms');
			frame.src = src;
			stage.append(frame);
			return;
		}
		paintMessage('unknown', `can't preview ${title || 'this file'}`);
		current = { kind: 'unknown', name: source.name || '', title };
	}

	function ensurePanel() {
		if (panel) return;
		const phone = phoneLayout();

		const next = el('div', null, 'world-window review-panel');
		next.id = options.id || 'review-panel';
		next.setAttribute('role', 'dialog');
		next.setAttribute('aria-modal', 'false');
		next.setAttribute('aria-label', options.title || 'window');
		if (phone) next.classList.add('review-phone');
		const viewport = el('div', null, 'review-viewport');
		stage = el('div', null, 'review-stage');
		bodyHost = el('div', null, 'review-body');
		viewport.append(stage, bodyHost);
		const controls = el('div', null, 'review-controls');
		controls.append(el('span', 'review', 'review-status'));
		const stop = el('button', 'close', 'review-close');
		stop.type = 'button';
		stop.setAttribute('aria-label', 'close review');
		stop.onclick = () => { close(); options.onClose?.(); };
		controls.append(stop);
		next.append(viewport, controls);
		worldHost().append(next);
		panel = next;
	}

	function close() {
		gen += 1;
		opening = null;
		forgetUrl();
		current = null;
		panel?.remove();
		panel = null;
		stage = null;
		bodyHost = null;
	}

	function isOpen() { return Boolean(panel); }

	function content() { return current; }

	async function show(spec) {
		const mine = ++gen;
		opening = (async () => {
			ensurePanel();
			await paint(spec);
		})();
		try {
			await opening;
		} finally {
			if (mine === gen) opening = null;
		}
	}

	return {
		show,
		open: show,
		close,
		isOpen,
		content,
		get body() { return bodyHost; },
	};
}

export function mountWorldWindows(options = {}) {
	const windows = new Map();
	const closed = new Set();
	const sticky = new Set();
	function mark() {
		document.body?.classList.toggle('world-live', windows.size > 0);
	}
	async function spawn(spec = {}) {
		const id = String(spec.id || 'window');
		if (spec.sticky) sticky.add(id);
		if (closed.has(id)) return windows.get(id);
		let win = windows.get(id);
		if (!win) {
			win = mountReviewWindow({
				...options,
				id,
				// The shell gives each application its own viewport, named by id.
				host: () => options.host?.(id, spec.title || id),
				onClose() {
					options.release?.(id);
					windows.delete(id);
					sticky.delete(id);
					closed.add(id);
					mark();
					options.onClose?.(id);
				},
			});
			windows.set(id, win);
			mark();
		}
		await win.show(spec);
		options.onOpen?.(id);
		return win;
	}
	function close(id) {
		if (id) {
			windows.get(id)?.close();
			windows.delete(id);
			mark();
			return;
		}
		for (const win of windows.values()) win.close();
		windows.clear();
		mark();
	}
	function sync(list) {
		const wanted = new Set();
		for (const spec of Array.isArray(list) ? list : []) {
			if (!spec?.id) continue;
			wanted.add(spec.id);
			if (!closed.has(spec.id)) void spawn(spec);
		}
		for (const id of [...closed]) {
			if (!wanted.has(id)) closed.delete(id);
		}
		for (const id of [...windows.keys()]) {
			if (!wanted.has(id) && !sticky.has(id)) close(id);
		}
	}
	return { spawn, close, sync, get: id => windows.get(id), list: () => [...windows.keys()] };
}
