// The phone shell: one full viewport per open application.
//
// #imperfect-world is a horizontal pager, not a canvas of free-floating windows.
// Each open application owns a slot the width of the viewport; a swipe moves
// between them, which is Hyprland's workspace feel in the phone's own language.
// The wallpaper sits behind, showing through the gap around every frame.
//
// Layout is CSS. Nothing here measures the viewport and writes pixels back,
// because that is what makes rotation stutter: the slot is 100% of a flex
// container, so a rotation is a reflow the compositor already knows how to do.
// The only thing JavaScript remembers across a rotation is which application is
// showing — an index, never a scroll offset.

// An application is a picture before it is a word, and the truest picture is the one the
// application already answers to. antiburn's is the icon in its own desktop build, lifted off the
// rounded dark tile that build wraps it in -- the mark is a matrix of lit dots, and the tile was
// a macOS convention that read as the one black square in a room made of daylight. Doom's is
// M_DOOM, the title-screen lump inside the IWAD the port loads -- `tools/doom-logo.mjs` writes
// it out beside the port, which is why it is a path and not a drawing. Doom's is not in git: see
// docs/doom.md for the WAD. Neither logo is ours to relicense; each names the thing it opens.
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
	// a screen on a stand: the machine itself, which is what the desktop window shows
	desktop: 'M1 2h14v1H1zM1 10h14v1H1zM1 3h1v7H1zM14 3h1v7h-1zM7 11h2v2H7zM4 13h8v1H4z',
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

export function mountShell(options = {}) {
	const world = options.world ?? document.getElementById('imperfect-world');
	const slots = new Map();          // id -> slot element
	const order = [];                 // ids, left to right
	const titles = new Map();
	let active = null;
	let sheet = null;
	let wallpaperSelector = null;
	let wallpaperRows = [];
	let wallpaperIndex = 0;
	let currentWallpaper = null;
	const WALLPAPER_KEY = 'imperfect-wallpaper';
	const LAYOUT_KEY = 'imperfect-shell-layout';
	let layout = 'dwindle';
	try {
		const saved = localStorage.getItem(LAYOUT_KEY);
		if (saved === 'dwindle' || saved === 'scrolling') layout = saved;
	} catch {}

	function setLayout(next, { persist = true } = {}) {
		layout = next === 'scrolling' ? 'scrolling' : 'dwindle';
		world.dataset.layout = layout;
		if (persist) {
			try { localStorage.setItem(LAYOUT_KEY, layout); } catch {}
		}
		return layout;
	}

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

	function setWallpaper(row, { animate = true, persist = true } = {}) {
		if (!row?.src) return;
		const wall = wallpaper();
		if (!currentWallpaper || !animate) {
			wall.style.backgroundImage = `url("${row.src}")`;
		} else {
			const next = el('div', null, 'om-wall-incoming');
			next.style.backgroundImage = `url("${row.src}")`;
			next.addEventListener('animationend', () => {
				wall.style.backgroundImage = `url("${row.src}")`;
				next.remove();
			}, { once: true });
			wall.append(next);
		}
		currentWallpaper = row;
		if (persist) {
			try { localStorage.setItem(WALLPAPER_KEY, row.id); } catch {}
		}
	}

	async function loadWallpapers() {
		try {
			const response = await fetch('/wallpapers', { cache: 'no-store' });
			if (!response.ok) throw new Error('wallpapers unavailable');
			const rows = await response.json();
			wallpaperRows = Array.isArray(rows) ? rows : [];
		} catch { wallpaperRows = []; }
		if (!wallpaperRows.length) return;
		let saved = '';
		try { saved = localStorage.getItem(WALLPAPER_KEY) || ''; } catch {}
		wallpaperIndex = Math.max(0, wallpaperRows.findIndex(row => row.id === saved));
		setWallpaper(wallpaperRows[wallpaperIndex], { animate: false, persist: saved !== wallpaperRows[wallpaperIndex].id });
	}

	function closeWallpaperSelector() {
		wallpaperSelector?.remove();
		wallpaperSelector = null;
		document.body.classList.remove('wallpaper-open');
	}

	function openWallpaperSelector() {
		if (wallpaperSelector) { closeWallpaperSelector(); return; }
		if (!wallpaperRows.length) { void loadWallpapers().then(openWallpaperSelector); return; }
		const frame = el('div', null, 'wallpaper-selector');
		frame.setAttribute('role', 'dialog');
		frame.setAttribute('aria-label', 'wallpapers');
		const back = el('div', null, 'wallpaper-back');
		back.onclick = closeWallpaperSelector;
		const card = el('div', null, 'wallpaper-card');
		const preview = el('img', null, 'wallpaper-preview');
		preview.alt = '';
		const title = el('p', null, 'wallpaper-title');
		const strip = el('div', null, 'wallpaper-strip');
		const hint = el('p', '←/→ browse · enter choose · esc close', 'wallpaper-hint');
		card.append(preview, title, strip, hint);
		frame.append(back, card);
		document.body.append(frame);
		document.body.classList.add('wallpaper-open');
		wallpaperSelector = frame;

		const choose = () => {
			setWallpaper(wallpaperRows[wallpaperIndex], { animate: true, persist: true });
			closeWallpaperSelector();
		};
		const select = next => {
			wallpaperIndex = (next + wallpaperRows.length) % wallpaperRows.length;
			const row = wallpaperRows[wallpaperIndex];
			preview.src = row.src;
			title.textContent = `${row.label} · ${row.theme}`;
			for (const item of strip.children) item.setAttribute('aria-current', String(item.dataset.index === String(wallpaperIndex)));
			strip.querySelector(`[data-index="${wallpaperIndex}"]`)?.scrollIntoView({ block: 'nearest', inline: 'center' });
		};
		wallpaperRows.forEach((row, index) => {
			const item = el('button', null, 'wallpaper-thumb');
			item.type = 'button'; item.dataset.index = String(index); item.title = `${row.label} · ${row.theme}`;
			const image = el('img'); image.src = row.src; image.alt = row.label; image.loading = 'lazy';
			item.append(image);
			item.onclick = () => index === wallpaperIndex ? choose() : select(index);
			strip.append(item);
		});
		frame.onkeydown = event => {
			if (event.key === 'Escape') { event.preventDefault(); closeWallpaperSelector(); }
			else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') { event.preventDefault(); select(wallpaperIndex + 1); }
			else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') { event.preventDefault(); select(wallpaperIndex - 1); }
			else if (event.key === 'Enter') { event.preventDefault(); choose(); }
		};
		select(wallpaperIndex);
		frame.tabIndex = 0;
		frame.focus();
	}

	function markCount() {
		document.body.classList.toggle('shell-empty', order.length === 0);
	}

	function paintActive() {
		for (const [id, node] of slots) node.classList.toggle('active', id === active);
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
				paintActive();
				options.onActive?.(id);
			}
		}, { root: world, threshold: [0.6] })
		: null;

	function slot(id, title, options = {}) {
		const key = String(id || 'window');
		let node = slots.get(key);
		if (node) {
			if (title) titles.set(key, title);
			node.dataset.fullscreen = String(Boolean(options.fullscreen));
			if (options.fullscreen) world.dataset.fullscreenApp = key;
			paintActive();
			return node.querySelector('.om-frame');
		}
		node = el('div', null, 'om-slot');
		node.dataset.app = key;
		node.dataset.fullscreen = String(Boolean(options.fullscreen));
		const frame = el('div', null, 'om-frame');
		node.append(frame);
		world.append(node);
		slots.set(key, node);
		order.push(key);
		titles.set(key, title || key);
		watcher?.observe(node);
		markCount();
		if (order.length === 1) active = key;
		if (options.fullscreen) world.dataset.fullscreenApp = key;
		paintActive();
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
		if (world.dataset.fullscreenApp === key) delete world.dataset.fullscreenApp;
		if (active === key) active = order[Math.min(at, order.length - 1)] ?? null;
		markCount();
		paintActive();
		if (active) focus(active);
	}

	function focus(id) {
		const node = slots.get(String(id || ''));
		if (!node) return;
		active = node.dataset.app;
		paintActive();
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
		// The drawer is a panel in the middle of the screen, where the agent's drop would otherwise
		// cover it. Opening it retracts the drop first so the list is an answer to the key press.
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

	world.classList.add('om-pager');
	// A browser surface has no Hyprland workspace to own this choice. Local storage
	// remembers it through reloads, the closest honest equivalent to Omarchy's
	// per-workspace layout memory here.
	setLayout(layout);
	wallpaper();
	void loadWallpapers();
	markCount();

	// Rotation and the software keyboard both resize the visual viewport. The
	// only response is to put the active application back in view.
	addEventListener('orientationchange', restore);
	addEventListener('resize', restore);

	return {
		slot,
		release,
		focus,
		openSheet,
		openWallpaperSelector,
		closeSheet,
		sheetOpen: () => Boolean(sheet),
		restore,
		layout: () => layout,
		setLayout,
		toggleLayout: () => setLayout(layout === 'dwindle' ? 'scrolling' : 'dwindle'),
		has: id => slots.has(String(id || '')),
		ids: () => [...order],
		active: () => active,
		get count() { return order.length; },
	};
}
