// omarchy mobile — Guey's conversation UI in a Quake drop over the canvas, with
// one full viewport per open application. A phone types on its own OS keyboard:
// the custom two-page key sheet was removed on 2026-09-14, because Android and
// iOS already ship a keyboard people know, and rebuilding one was the imitation
// this shell otherwise refuses.

import { grid, bindHarnessKeys, ALT_LABEL, registerKeyBinding, activeKeyBindings } from "./pi-card.js";
import { mountShell } from "./shell.js";
import { mountReviewWindow } from "./review-window.js";
import { mountGueyPi } from "./harness.js";
import { mountKnowledgeGraph } from "./graph.js";

const el = (id) => document.getElementById(id);

// A coarse pointer is a touch screen, which is the one place we must not steal
// focus: doing so opens the OS keyboard over the thing somebody just tapped.
const isPhone = () => matchMedia("(pointer: coarse)").matches;

function measureGrid() {
	grid();
	dispatchEvent(new CustomEvent("imperfect:gridchange"));
}
measureGrid();

const entry = el("terminal-entry");
const input = el("entry-input");
const reach = el("harness-reach");
const terminal = el("entry-terminal");
const quakeHome = entry;
const herdrFace = document.createElement("section");
herdrFace.id = "herdr-face";
herdrFace.className = "herdr-face";
herdrFace.setAttribute("aria-label", "Herdr");
let herdrOpen = false;
let shell = null;
let pi = null;

const isQuakeOpen = () => entry.classList.contains("open");
const isHarnessOpen = () => herdrOpen || isQuakeOpen();

function openHarness() {
	if (herdrOpen) closeHerdr();
	entry.classList.add("open");
	if (reach) reach.hidden = true;
	// The OS keyboard is summoned by focus, so on a phone that is the whole reveal.
	input.focus();
}
function closeHarness() {
	if (herdrOpen) { closeHerdr(); return; }
	entry.classList.remove("open");
	input.blur();
	if (reach) reach.hidden = false;
}
function toggleHarness() {
	if (herdrOpen) { closeHerdr(); openHarness(); return; }
	isQuakeOpen() ? closeHarness() : openHarness();
}

function openHerdr() {
	if (herdrOpen || !shell || !terminal || !quakeHome) return;
	closeHarness();
	shell.closeSheet();
	const frame = shell.slot("herdr", "Herdr", { fullscreen: true });
	herdrFace.append(terminal);
	frame.append(herdrFace);
	herdrOpen = true;
	document.body.classList.add("herdr-open");
	pi?.setHerdrFace(true);
	input.focus();
}

function closeHerdr() {
	if (!herdrOpen || !terminal || !quakeHome) return;
	herdrOpen = false;
	pi?.setHerdrFace(false);
	quakeHome.append(terminal);
	herdrFace.remove();
	shell?.release("herdr");
	document.body.classList.remove("herdr-open");
	input.blur();
	if (reach) reach.hidden = false;
}

function toggleHerdr() { herdrOpen ? closeHerdr() : openHerdr(); }

let desk = null;
const SWIPE_MIN = 56;

function harnessEdge(node) {
	return Boolean(node?.closest?.('#harness-reach, .drop-handle'));
}

let swipe = null;

// Two fingers anywhere, not an edge. The one-finger reaches are anchored to the
// handle, the top and the bottom because a finger dragging in the middle of the
// desk is doing something else; two fingers are not, so the tabs do not need an
// edge of their own. Touch only — a trackpad reports the same gesture as wheel.
const fingers = new Map();
let tabsGesture = false;

function twoFingerDrop() {
	if (fingers.size !== 2) return;
	const moves = [...fingers.values()].map(f => ({ dx: f.x - f.startX, dy: f.y - f.startY }));
	if (!moves.every(m => Math.abs(m.dy) >= SWIPE_MIN && Math.abs(m.dy) > Math.abs(m.dx))) return;
	const down = moves.every(m => m.dy > 0);
	const up = moves.every(m => m.dy < 0);
	if (!down && !up) return; // fingers disagreeing is a pinch or a stretch, not a drop
	tabsGesture = true;
	swipe = null; // a finger that armed an edge reach loses it to the two-finger one
	if (down) openTabs();
	else if (isHarnessOpen()) { pi.closeTabs(); closeHarness(); }
}

addEventListener("pointerdown", event => {
	if (event.pointerType === "touch") {
		fingers.set(event.pointerId, { startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY });
		if (fingers.size > 1) swipe = null;
	}
	if (event.button) return;
	const fromHandle = harnessEdge(event.target);
	const fromTop = event.clientY < 28;
	const fromBottom = event.clientY > innerHeight - 56;
	if (!fromHandle && !fromTop && !fromBottom) return;
	swipe = { id: event.pointerId, x: event.clientX, y: event.clientY, fromHandle, fromTop, fromBottom };
	try { event.target.setPointerCapture?.(event.pointerId); } catch { /* not a capturing target */ }
}, { capture: true });

addEventListener("pointermove", event => {
	const finger = fingers.get(event.pointerId);
	if (finger) {
		finger.x = event.clientX;
		finger.y = event.clientY;
		if (!tabsGesture) twoFingerDrop();
	}
	if (!swipe || event.pointerId !== swipe.id) return;
	const dx = event.clientX - swipe.x;
	const dy = event.clientY - swipe.y;
	if (Math.abs(dy) < SWIPE_MIN || Math.abs(dy) < Math.abs(dx)) return;
	if (dy > 0 && (swipe.fromHandle || swipe.fromTop) && !isHarnessOpen()) openHarness();
	else if (dy < 0 && isHarnessOpen() && (swipe.fromHandle || swipe.fromTop)) closeHarness();
	else if (dy < 0 && swipe.fromBottom) { closeHarness(); desk?.openSheet(); }
	swipe = null;
}, { capture: true });

function endSwipe(event) {
	swipe = null;
	if (event?.pointerType === "touch") {
		fingers.delete(event.pointerId);
		// The gesture is spent until every finger is off, so one drag drops the
		// panel once rather than repeating as the fingers keep travelling.
		if (!fingers.size) tabsGesture = false;
	}
}
addEventListener("pointerup", endSwipe, { capture: true });
addEventListener("pointercancel", endSwipe, { capture: true });

function linePx(el) {
	const cs = getComputedStyle(el);
	const raw = cs.lineHeight;
	const font = Number.parseFloat(cs.fontSize) || 16;
	const n = Number.parseFloat(raw);
	if (!Number.isFinite(n)) return font * 1.2;
	if (/em$/i.test(raw)) return font * n;
	if (n > 4) return n;
	return font * (n > 0 ? n : 1.2);
}
function grow() {
	const stack = input.closest(".entry-input-stack");
	input.style.height = "auto";
	const line = linePx(input);
	const cap = Math.max(line * 2, Math.floor(innerHeight * 0.3));
	const next = Math.min(Math.max(input.scrollHeight, line), cap);
	input.style.height = `${next}px`;
	if (stack) stack.style.height = "";
}

// The applications the menu can open. Everything but the desktop is a `page`,
// the empty container — which is how the next web project joins this list
// without a new window kind.
// The notes each of these carried are gone with the column that showed them. "placeholder" and
// "three-doom" told a person nothing they could act on, and a drawer is for launching, not for
// reading. The drawing and the name are the whole row.
const APPS = [
	{ id: "files", title: "files", window: { kind: "page", src: "/files.html" } },
	{ id: "antiburn", title: "antiburn", window: { kind: "page", src: "/antiburn.html" } },
	{ id: "doom", title: "Doom", window: { kind: "page", src: "/doom/index.html" } },
	{ id: "image-lab", title: "Image Lab", window: { kind: "page", src: "/image-lab.html" } },
];

const LAUNCH_THEMES = new Set(["garden", "night"]);

function readLaunchTheme() {
	const query = new URLSearchParams(location.search).get("theme");
	const cookie = document.cookie.split(";").map(p => p.trim()).find(p => p.startsWith("ic-theme="));
	const fromCookie = cookie ? decodeURIComponent(cookie.slice("ic-theme=".length)) : "";
	const want = query || fromCookie;
	return LAUNCH_THEMES.has(want) ? want : "";
}

function applyDeskTheme(name) {
	if (!LAUNCH_THEMES.has(name)) return;
	document.documentElement.dataset.icTheme = name;
	document.cookie = `ic-theme=${encodeURIComponent(name)}; path=/; max-age=31536000; samesite=lax`;
}

applyDeskTheme(readLaunchTheme() || "garden");

const builtInApps = () => APPS.map(app => ({
	id: app.id,
	title: app.title,
	open: () => pi.openWindow({ ...app.window, id: app.id, title: app.title }),
}));

// The screen of this machine itself.
//
// It is the one application that is not a page this computer serves, so it is the one that does
// not go through the agent's window list. The address is minted by the door at the moment it is
// opened, is short-lived, and carries an access token -- a token nobody stores is a token nobody
// leaks, and the server's window list is agent state that gets written down. So the desk mounts
// this window itself, and the model never learns the address.
//
// The tile is drawn only where it can work. `/__machine` is answered by the door's proxy, not by
// this computer, and it says whether this account's machine is a Box with a supplier screen. A
// machine somebody already owns has none, and a dead tile is worse than no tile.
let screen = null;
let asked = null;

// Asked once. What a machine is does not change between two presses of a key, and the drawer
// already waits on one request the first time it opens.
function askDesktop() {
	asked ??= (async () => {
		try {
			const response = await fetch("/__machine", { headers: { accept: "application/json" } });
			return response.ok && Boolean((await response.json())?.desktop);
		} catch { return false; }
	})();
	return asked;
}

function desktopWindow() {
	screen ??= mountReviewWindow({
		id: "desktop",
		allowExternal: true,
		host: () => shell.slot("desktop", "desktop"),
	});
	return screen;
}

function closeDesktop() {
	screen?.close();
	shell.release("desktop");
}

async function openDesktop() {
	const window = desktopWindow();
	try {
		const response = await fetch("/__desktop", { headers: { accept: "application/json" } });
		if (!response.ok) throw new Error(String(response.status));
		const { url } = await response.json();
		if (!url) throw new Error("no address");
		await window.show({ kind: "page", title: "desktop", src: url });
	} catch {
		// Say what happened in the window rather than leaving a blank frame, which is what a
		// screen that failed to draw looks like.
		await window.show({ kind: "text", title: "desktop", text: "This machine's screen could not be reached. It may still be starting." });
	}
}

// What the agent has written into /apps changes when the agent writes an app, which is rare, and
// never between two presses of the same key. So the answer is kept and the drawer opens out of it
// at once; the fetch behind it only decides what the NEXT open shows. Asking the network every
// time is what made a keystroke feel like a page load.
let appsKnown = null;
async function refreshApps() {
	const built = builtInApps();
	if (await askDesktop()) built.push({ id: "desktop", title: "desktop", open: openDesktop });
	try {
		const response = await fetch("/apps/list");
		if (!response.ok) return (appsKnown = built);
		const extra = await response.json();
		if (!Array.isArray(extra)) return (appsKnown = built);
		const seen = new Set(built.map(app => app.id));
		for (const app of extra) {
			if (!app?.id || seen.has(app.id) || !String(app.src || "").startsWith("/apps/")) continue;
			seen.add(app.id);
			built.push({
				id: app.id,
				title: app.title || app.id,
				open: () => pi.openWindow({ kind: "page", src: app.src, id: app.id, title: app.title || app.id }),
			});
		}
	} catch {}
	return (appsKnown = built);
}

// Synchronous when we already know, a promise only on the very first open.
function listedApps() {
	if (appsKnown) { void refreshApps(); return appsKnown; }
	return refreshApps();
}

shell = desk = mountShell({
	world: el("imperfect-world"),
	apps: listedApps,
	onReveal: () => closeHarness(),
	onError: (error) => console.warn("application did not open", error),
});

const knowledge = mountKnowledgeGraph({
	world: el("imperfect-world"),
});

pi = mountGueyPi({
	elements: {
		output: el("entry-output"),
		input,
		dialog: el("entry-dialog"),
		widgets: el("entry-widgets"),
		slashMenu: el("slash-menu"),
		modelStatus: el("entry-model-status"),
		modelName: el("entry-pi-label"),
		spend: el("entry-spend"),
			thinking: el("entry-thinking"),
			permission: el("entry-permission"),
		sessionTitle: el("entry-session-name"),
		sessionSource: el("entry-source"),
		sessionCwd: el("entry-cwd"),
		context: el("entry-context"),
		screen: document.querySelector(".entry-screen"),
	},
	hooks: {
		onDraftChange: grow,
		onIncomingShare: openHarness,
		onReveal: openHarness,
		canFocus: () => isHarnessOpen() && !isPhone(),
		onEscapeIdle: closeHarness,
		isHerdrOpen: () => herdrOpen,
		sessionRailHost: herdrFace,
		onGraph: () => { knowledge.open(); },
		onWindowOpen: closeHarness,
		slot: (id, title) => shell.slot(id, title),
		release: (id) => shell.release(id),
	},
});

function openAppById(id) {
	const app = APPS.find(item => item.id === id);
	if (!app) return;
	shell.closeSheet();
	closeHarness();
	return pi.openWindow({ ...app.window, id: app.id, title: app.title });
}

function closeShowingWindow() {
	if (herdrOpen || shell.active() === "herdr") { closeHerdr(); return; }
	const id = shell.active();
	if (!id) return;
	if (id === "desktop") { closeDesktop(); return; }
	pi.closeWindow(id).catch(error => console.warn("application did not close", error));
}

function openKeyGuide() {
	const make = (tag, text, className) => {
		const node = document.createElement(tag);
		if (text != null) node.textContent = text;
		if (className) node.className = className;
		return node;
	};
	const old = document.getElementById("key-guide");
	if (old) { old.remove(); return; }
	shell.closeSheet();
	closeHarness();
	const frame = document.createElement("div");
	frame.id = "key-guide";
	frame.className = "key-guide";
	frame.setAttribute("role", "dialog");
	frame.setAttribute("aria-label", "key bindings");
	const back = document.createElement("div");
	back.className = "key-guide-back";
	back.onclick = () => frame.remove();
	const card = document.createElement("div");
	card.className = "key-guide-card";
	card.append(make("p", "key bindings", "key-guide-title"));
	for (const binding of activeKeyBindings()) {
		const row = make("p", null, "key-guide-row");
		row.append(make("kbd", binding.label), make("span", binding.description));
		card.append(row);
	}
	card.append(make("p", "esc closes", "key-guide-hint"));
	frame.append(back, card);
	frame.tabIndex = 0;
	frame.onkeydown = event => {
		if (event.key !== "Escape") return;
		event.preventDefault();
		frame.remove();
	};
	document.body.append(frame);
	frame.focus();
}


reach?.addEventListener("click", openHarness);

document.addEventListener("click", (event) => {
	const source = event.target.closest("[data-ask]");
	if (!source?.dataset.ask) return;
	openHarness();
	input.value = source.dataset.ask;
	input.dispatchEvent(new Event("input", { bubbles: true }));
	grow();
	if (!isPhone()) input.focus();
});

addEventListener("wheel", event => {
	if (event.ctrlKey) event.preventDefault();
}, { passive: false });
addEventListener("gesturestart", event => event.preventDefault());

addEventListener("resize", () => {
	measureGrid();
	knowledge.layout();
});
visualViewport?.addEventListener("resize", () => {
	measureGrid();
	knowledge.layout();
});

// The tabs are a face of the harness panel, not a second panel: Alt+T drops it
// already showing them, and drops it again to put the whole thing away. Escape
// inside the rail steps back to the conversation, so this reach is only ever
// one press from either direction.
function openTabs() {
	if (herdrOpen) return;
	if (!isQuakeOpen()) openHarness();
	pi.openTabs();
}
function toggleTabs() {
	if (herdrOpen) return;
	if (isQuakeOpen() && pi.tabsOpen()) { pi.closeTabs(); closeHarness(); return; }
	openTabs();
}

bindHarnessKeys({ onHarness: toggleHarness, onTabs: toggleTabs });
// Herdr's tab chords live in the same registry as the rest of the shell. Both
// faces call the same tab host, so switching a face never changes the session.
for (let index = 0; index < 9; index++) {
	registerKeyBinding({
		label: `Alt+${index + 1}`,
		description: `switch to tab ${index + 1}`,
		code: `Digit${index + 1}`,
		alt: true,
		when: () => pi.hasTab(index),
		handler: () => pi.focusTabIndex(index).catch(error => console.warn('tab focus failed', error)),
	});
}
registerKeyBinding({
	label: 'Alt+←', description: 'previous tab', code: 'ArrowLeft', alt: true,
	when: () => (pi.guiSnapshot().tabs ?? []).length > 1,
	handler: () => pi.cycleTab(-1),
});
registerKeyBinding({
	label: 'Alt+→', description: 'next tab', code: 'ArrowRight', alt: true,
	when: () => (pi.guiSnapshot().tabs ?? []).length > 1,
	handler: () => pi.cycleTab(1),
});
registerKeyBinding({
	label: 'Alt+Shift+←', description: 'move tab previous', code: 'ArrowLeft', alt: true, shift: true,
	when: () => (pi.guiSnapshot().tabs ?? []).length > 1,
	handler: () => pi.moveTab(-1),
});
registerKeyBinding({
	label: 'Alt+Shift+→', description: 'move tab next', code: 'ArrowRight', alt: true, shift: true,
	when: () => (pi.guiSnapshot().tabs ?? []).length > 1,
	handler: () => pi.moveTab(1),
});
registerKeyBinding({
	label: 'Alt+Enter', description: 'toggle Herdr fullscreen window', code: 'Enter', alt: true,
	handler: toggleHerdr,
});
registerKeyBinding({
	label: 'Alt+C', description: 'new agent tab', code: 'KeyC', alt: true,
	handler: () => pi.newTab().catch(error => console.warn('new tab failed', error)),
});
registerKeyBinding({
	label: 'Alt+L', description: 'toggle shell layout', code: 'KeyL', alt: true,
	handler: () => shell.toggleLayout(),
});
// Alt+A and Alt+G are free exact bindings in the current Hyprland map; keeping them in this
// registry makes the same shortcuts exist for a phone browser and for the laptop window.
registerKeyBinding({ label: "Alt+W", description: "close showing app", code: "KeyW", alt: true, handler: closeShowingWindow });
registerKeyBinding({ label: "Alt+Space", description: "open application drawer", code: "Space", alt: true, handler: () => shell.openSheet() });
registerKeyBinding({ label: "Alt+Shift+Space", description: "choose wallpaper", code: "Space", alt: true, shift: true, handler: () => shell.openWallpaperSelector() });
registerKeyBinding({ label: "Alt+K", description: "open key guide", code: "KeyK", alt: true, handler: openKeyGuide });
registerKeyBinding({ label: "Alt+A", description: "open antiburn", code: "KeyA", alt: true, handler: () => openAppById("antiburn") });
registerKeyBinding({ label: "Alt+G", description: "open knowledge graph", code: "KeyG", alt: true, handler: () => knowledge.open() });
registerKeyBinding({ label: "Esc", description: "close Herdr fullscreen window", code: "Escape", when: () => herdrOpen, target: input, handler: closeHerdr });
// Escape belongs to the nearest open surface. Registering only the drawer case leaves the
// harness, wallpaper picker, and application windows to keep their own escape handling.
registerKeyBinding({ label: "Esc", description: "close application drawer", code: "Escape", when: () => shell.sheetOpen(), handler: () => shell.closeSheet() });

function paintIntro() {
	const box = document.getElementById("startup-intro");
	if (!box) return;
	if (localStorage.getItem("ic-shortcuts-seen")) { box.hidden = true; return; }
	const alt = ALT_LABEL === "OPT" ? "Option" : "Alt";
	box.hidden = false;
	box.replaceChildren();
	const title = document.createElement("p");
	title.className = "intro-title";
	title.textContent = "A few reaches";
	const lines = [
		`${alt}+Y drops the agent. On a phone, swipe down.`,
		`${alt}+T drops it showing your sessions. On a phone, swipe down with two fingers.`,
		`${alt}+W closes the app that is showing, and stops it. It never closes the agent.`,
		`${alt}+Space opens the app drawer. On a phone, swipe up.`,
	];
	box.append(title);
	for (const text of lines) {
		const p = document.createElement("p");
		p.textContent = text;
		box.append(p);
	}
	const done = document.createElement("button");
	done.type = "button";
	done.textContent = "got it";
	done.onclick = () => {
		localStorage.setItem("ic-shortcuts-seen", "1");
		box.hidden = true;
	};
	box.append(done);
}
paintIntro();

const launch = readLaunchTheme();
if (launch) {
	pi.setTheme(launch, true).catch(() => {});
}

if (reach) reach.hidden = isHarnessOpen();
input.addEventListener("input", grow);
grow();
