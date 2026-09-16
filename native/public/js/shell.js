// The phone shell: one full viewport per open application.
//
// #imperfect-world is a horizontal pager, not a canvas of free-floating windows.
// Each open application owns a slot the width of the viewport; a swipe moves
// between them, which is Hyprland's workspace feel in the phone's own language.
// Omarchy's wallpaper sits behind, showing through the gap around every frame.
//
// Layout is CSS. Nothing here measures the viewport and writes pixels back,
// because that is what makes rotation stutter: the slot is 100% of a flex
// container, so a rotation is a reflow the compositor already knows how to do.
// The only thing JavaScript remembers across a rotation is which application is
// showing — an index, never a scroll offset.

const BAR_ID = 'om-bar';

// An application is a picture before it is a word, and the truest picture is the one the
// application already answers to. antiburn ships an icon with its desktop build; Doom's is
// M_DOOM, the title-screen lump inside the IWAD the port loads -- `tools/doom-logo.mjs` writes
// it out beside the port, which is why it is a path and not a drawing. Neither is in git: see
// docs/doom.md for the WAD, and neither logo is ours to relicense.
//
// The rest are this product's own applications, so they are drawn here on the 8x8 grid the whole
// product stands on, in `currentColor` -- they follow the accent, cost no request, and cannot
// arrive late and shift the row. A real logo that is missing (a clone with no WAD) falls back to
// the same drawing rather than a broken-image box.
const LOGOS = {
	antiburn: '/icons/antiburn.png',
	doom: '/doom/M_DOOM.png',
};
const GLYPHS = {
	// a folder: the tab, then the body as a ruled box
	files: 'M2 3h5v2H2zM2 5h12v1H2zM2 13h12v1H2zM2 6h1v7H2zM13 6h1v7h-1z',
	// a meter climbing, which is what antiburn watches
	antiburn: 'M2 9h3v5H2zM6.5 6h3v8h-3zM11 2h3v12h-3z',
	// a sight: four arms and the shot between them
	doom: 'M7 1h2v4H7zM7 11h2v4H7zM1 7h4v2H1zM11 7h4v2h-4zM6 6h4v4H6z',
	// a picture: a frame with a sun over a peak
	'image-lab': 'M2 2h12v2H2zM2 12h12v2H2zM2 4h2v8H2zM12 4h2v8h-2zM5 5h2v2H5zM4 10h2v2H4zM6 8h2v4H6zM8 10h2v2H8z',
};
const BRAND_MARK = 'M3 3h10v10H3z';

function drawnIcon(id) {
	const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.setAttribute('viewBox', '0 0 16 16');
	svg.setAttribute('aria-hidden', 'true');
	const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
	path.setAttribute('d', GLYPHS[id] || BRAND_MARK);
	path.setAttribute('fill', 'currentColor');
	svg.append(path);
	return svg;
}

function appIcon(id) {
	const box = el('span', null, 'om-app-icon');
	box.setAttribute('aria-hidden', 'true');
	const logo = LOGOS[id];
	if (!logo) {
		box.append(drawnIcon(id));
		return box;
	}
	const mark = document.createElement('img');
	mark.src = logo;
	mark.alt = '';
	mark.draggable = false;
	mark.onerror = () => { mark.remove(); box.append(drawnIcon(id)); };
	box.append(mark);
	return box;
}

function el(tag, text, className) {
	const node = document.createElement(tag);
	if (text != null) node.textContent = text;
	if (className) node.className = className;
	return node;
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
	'August', 'September', 'October', 'November', 'December'];

function isoWeek(date) {
	const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
	const day = d.getUTCDay() || 7;
	d.setUTCDate(d.getUTCDate() + 4 - day);
	const start = Date.UTC(d.getUTCFullYear(), 0, 1);
	return Math.ceil(((d - start) / 86400000 + 1) / 7);
}

// Omarchy's clock formats are the user's, so they are honoured rather than
// replaced. This is the subset those patterns use; an unknown token is left
// alone instead of being guessed at.
export function formatClock(pattern, date = new Date()) {
	const pad = n => String(n).padStart(2, '0');
	const tokens = {
		dddd: DAYS[date.getDay()],
		ddd: DAYS[date.getDay()].slice(0, 3),
		MMMM: MONTHS[date.getMonth()],
		MMM: MONTHS[date.getMonth()].slice(0, 3),
		yyyy: String(date.getFullYear()),
		HH: pad(date.getHours()),
		mm: pad(date.getMinutes()),
		ss: pad(date.getSeconds()),
		ww: pad(isoWeek(date)),
		d: String(date.getDate()),
	};
	// Quoted runs are literal in Omarchy's patterns ('W'ww is week 37).
	return String(pattern ?? '').replace(/'([^']*)'|dddd|ddd|MMMM|MMM|yyyy|HH|mm|ss|ww|d/g,
		(match, quoted) => (quoted !== undefined ? quoted : tokens[match] ?? match));
}

export function mountShell(options = {}) {
	const world = options.world ?? document.getElementById('imperfect-world');
	const slots = new Map();          // id -> slot element
	const order = [];                 // ids, left to right
	const titles = new Map();
	let active = null;
	let bar = null;
	let dots = null;
	let clockNode = null;
	let clockFormats = { format: 'HH:mm', alt: '' };
	let clockAlt = false;
	let clockTimer = 0;
	let sheet = null;

	function wallpaper() {
		let wall = document.getElementById('om-wall');
		if (!wall) {
			wall = el('div', null, 'om-wall');
			wall.id = 'om-wall';
			wall.setAttribute('aria-hidden', 'true');
			document.body.prepend(wall);
		}
		return wall;
	}

	// The layer exists and carries the ruled ground; nothing paints a picture onto it yet.
	// Omarchy used to supply one, and was removed on 2026-09-14 with the laptop shell -- a hosted
	// machine has no Omarchy state to read. This is where a chosen wallpaper will go.
	function paintWallpaper() { wallpaper(); }

	function markCount() {
		document.body.classList.toggle('shell-empty', order.length === 0);
		if (bar) bar.dataset.apps = String(order.length);
	}

	function paintDots() {
		for (const [id, node] of slots) node.classList.toggle('active', id === active);
		if (!dots) return;
		dots.replaceChildren();
		for (const id of order) {
			const dot = el('button', null, 'om-ws');
			dot.type = 'button';
			dot.dataset.app = id;
			dot.title = titles.get(id) || id;
			dot.setAttribute('aria-label', `show ${titles.get(id) || id}`);
			dot.setAttribute('aria-current', String(id === active));
			dot.onclick = () => focus(id);
			dots.append(dot);
		}
	}

	// An observer, not a scroll listener doing arithmetic: the browser tells us
	// which slot is showing, and that survives a rotation for free.
	const watcher = typeof IntersectionObserver === 'function'
		? new IntersectionObserver(entries => {
			for (const entry of entries) {
				if (!entry.isIntersecting || entry.intersectionRatio < 0.6) continue;
				const id = entry.target.dataset.app;
				if (!id || id === active) continue;
				active = id;
				paintDots();
				options.onActive?.(id);
			}
		}, { root: world, threshold: [0.6] })
		: null;

	function slot(id, title) {
		const key = String(id || 'window');
		let node = slots.get(key);
		if (node) {
			if (title) titles.set(key, title);
			paintDots();
			return node.querySelector('.om-frame');
		}
		node = el('div', null, 'om-slot');
		node.dataset.app = key;
		const frame = el('div', null, 'om-frame');
		node.append(frame);
		world.append(node);
		slots.set(key, node);
		order.push(key);
		titles.set(key, title || key);
		watcher?.observe(node);
		markCount();
		if (order.length === 1) active = key;
		paintDots();
		// A new application is what you wanted to look at.
		focus(key);
		return frame;
	}

	function release(id) {
		const key = String(id || '');
		const node = slots.get(key);
		if (!node) return;
		const at = order.indexOf(key);
		watcher?.unobserve(node);
		node.remove();
		slots.delete(key);
		titles.delete(key);
		order.splice(at, 1);
		if (active === key) active = order[Math.min(at, order.length - 1)] ?? null;
		markCount();
		paintDots();
		if (active) focus(active);
	}

	function focus(id) {
		const node = slots.get(String(id || ''));
		if (!node) return;
		active = node.dataset.app;
		paintDots();
		node.scrollIntoView({ behavior: 'instant', inline: 'center', block: 'nearest' });
	}

	// Rotation: put the showing application back under the thumb without
	// touching a pixel offset. The slot is already the right size by then.
	function restore() {
		if (!active) return;
		const node = slots.get(active);
		node?.scrollIntoView({ behavior: 'instant', inline: 'center', block: 'nearest' });
	}

	function closeSheet() {
		sheet?.remove();
		sheet = null;
		document.body.classList.remove('sheet-open');
	}

	function openSheet() {
		if (sheet) { closeSheet(); return; }
		// The drawer is a panel in the middle of the screen now, and the middle of the screen is
		// where the agent's drop hangs when it is down -- so the menu button in the bar opened a
		// drawer underneath the console and looked like it had done nothing. The keyboard already
		// retracted the drop before opening; the button has to ask for the same thing.
		options.onReveal?.();
		// The drawer used to await options.apps() -- a network round trip to /apps/list -- before
		// creating a single element, so pressing the key did nothing at all for as long as that
		// took and the drawer felt broken rather than slow. The frame goes up on the same tick as
		// the press; the rows arrive into it. A list that resolves synchronously (the second open,
		// from cache) never paints an empty frame at all, because rows are filled before the
		// browser has had a chance to draw.
		const next = el('div', null, 'om-sheet');
		next.setAttribute('role', 'dialog');
		next.setAttribute('aria-label', 'applications');
		const list = el('div', null, 'om-sheet-list');
		next.append(list);
		const backdrop = el('div', null, 'om-sheet-back');
		backdrop.onclick = closeSheet;
		next.prepend(backdrop);
		document.body.append(next);
		document.body.classList.add('sheet-open');
		sheet = next;
		const mine = next;

		const paint = apps => {
			// A slow answer that lands after the drawer was closed, or after it was closed and
			// opened again, must not write into the sheet that is showing now.
			if (sheet !== mine) return;
			list.replaceChildren();
			for (const app of Array.isArray(apps) ? apps : []) {
				const item = el('button', null, 'om-app');
				item.type = 'button';
				item.append(appIcon(app.id), el('span', app.title, 'om-app-name'));
				if (slots.has(app.id)) item.dataset.open = 'true';
				item.onclick = () => {
					closeSheet();
					if (slots.has(app.id)) { focus(app.id); return; }
					Promise.resolve(app.open()).catch(error => options.onError?.(error));
				};
				list.append(item);
			}
			if (!list.childElementCount) list.append(el('p', 'no applications', 'om-app-empty'));
		};

		let apps;
		try { apps = options.apps?.() ?? []; } catch { apps = []; }
		if (apps && typeof apps.then === 'function') apps.then(paint, () => paint([]));
		else paint(apps);
	}

	function paintClock() {
		if (!clockNode) return;
		const pattern = clockAlt && clockFormats.alt ? clockFormats.alt : clockFormats.format;
		clockNode.textContent = formatClock(pattern);
	}

	function widget(spec) {
		const id = String(spec?.id ?? '');
		if (id === 'menu') {
			const button = el('button', null, 'om-menu');
			button.type = 'button';
			button.setAttribute('aria-label', 'applications');
			button.append(el('i', null, 'om-menu-glyph'));
			button.onclick = openSheet;
			return button;
		}
		if (id === 'workspaces') {
			dots = el('div', null, 'om-workspaces');
			paintDots();
			return dots;
		}
		if (id === 'clock') {
			clockFormats = { format: spec.format || 'HH:mm', alt: spec.formatAlt || '' };
			clockNode = el('button', null, 'om-clock');
			clockNode.type = 'button';
			clockNode.onclick = () => { clockAlt = !clockAlt; paintClock(); };
			paintClock();
			clearInterval(clockTimer);
			clockTimer = setInterval(paintClock, 15_000);
			return clockNode;
		}
		return null;
	}

	// The bar's arrangement, position and clock formats come from Omarchy's own
	// shell.json. Widgets it lists that belong to laptop hardware or to stock
	// Android are dropped by the server, not faked here.
	//
	// A machine with no Omarchy has no arrangement at all, and that used to render
	// three empty zones -- a bar with no menu in it, which is a black screen with
	// no way in. Naming the menu in that case is not inventing somebody's bar; it
	// is refusing to draw a dead end. An arrangement that exists is still obeyed
	// exactly, including one that deliberately omits the menu.
	// The bar is this shell's own. It used to be assembled from Omarchy's shell.json, which only
	// ever existed on one laptop; a machine without it rendered three empty zones, which is a black
	// screen with no way in. The menu is the way in, so the menu is not optional.
	async function mountBar() {
		bar?.remove();
		const next = el('footer', null, 'om-bar');
		next.id = BAR_ID;
		next.dataset.position = 'bottom';
		for (const [side, specs] of [['left', []], ['center', [{ id: 'menu' }]], ['right', [{ id: 'clock' }]]]) {
			const zone = el('div', null, `om-bar-${side}`);
			for (const spec of specs) {
				const node = widget(spec);
				if (node) zone.append(node);
			}
			next.append(zone);
		}
		document.body.append(next);
		document.body.dataset.bar = next.dataset.position;
		bar = next;
		markCount();
	}

	world.classList.add('om-pager');
	paintWallpaper();
	markCount();
	void mountBar();

	// Rotation and the software keyboard both resize the visual viewport. The
	// only response is to put the active application back in view.
	addEventListener('orientationchange', restore);
	addEventListener('resize', restore);

	return {
		slot,
		release,
		focus,
		openSheet,
		closeSheet,
		sheetOpen: () => Boolean(sheet),
		restore,
		has: id => slots.has(String(id || '')),
		ids: () => [...order],
		active: () => active,
		get count() { return order.length; },
	};
}
