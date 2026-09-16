// omarchy mobile — Guey's conversation UI in a Quake drop over the canvas, with
// one full viewport per open application. A phone types on its own OS keyboard:
// the custom two-page key sheet was removed on 2026-09-14, because Android and
// iOS already ship a keyboard people know, and rebuilding one was the imitation
// this shell otherwise refuses.

import { grid, bindHarnessKeys, ALT_LABEL } from "./pi-card.js";
import { mountShell } from "./shell.js";
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

const isHarnessOpen = () => entry.classList.contains("open");

function openHarness() {
	entry.classList.add("open");
	if (reach) reach.hidden = true;
	// The OS keyboard is summoned by focus, so on a phone that is the whole reveal.
	input.focus();
}
function closeHarness() {
	entry.classList.remove("open");
	input.blur();
	if (reach) reach.hidden = false;
}
function toggleHarness() { isHarnessOpen() ? closeHarness() : openHarness(); }

let desk = null;
const SWIPE_MIN = 56;

function harnessEdge(node) {
	return Boolean(node?.closest?.('#harness-reach, .drop-handle'));
}

let swipe = null;

addEventListener("pointerdown", event => {
	if (event.button) return;
	const fromHandle = harnessEdge(event.target);
	const fromTop = event.clientY < 28;
	const fromBottom = event.clientY > innerHeight - 56;
	if (!fromHandle && !fromTop && !fromBottom) return;
	swipe = { id: event.pointerId, x: event.clientX, y: event.clientY, fromHandle, fromTop, fromBottom };
	try { event.target.setPointerCapture?.(event.pointerId); } catch { /* not a capturing target */ }
}, { capture: true });

addEventListener("pointermove", event => {
	if (!swipe || event.pointerId !== swipe.id) return;
	const dx = event.clientX - swipe.x;
	const dy = event.clientY - swipe.y;
	if (Math.abs(dy) < SWIPE_MIN || Math.abs(dy) < Math.abs(dx)) return;
	if (dy > 0 && (swipe.fromHandle || swipe.fromTop) && !isHarnessOpen()) openHarness();
	else if (dy < 0 && isHarnessOpen() && (swipe.fromHandle || swipe.fromTop)) closeHarness();
	else if (dy < 0 && swipe.fromBottom) { closeHarness(); desk?.openSheet(); }
	swipe = null;
}, { capture: true });

function endSwipe() { swipe = null; }
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

// What the agent has written into /apps changes when the agent writes an app, which is rare, and
// never between two presses of the same key. So the answer is kept and the drawer opens out of it
// at once; the fetch behind it only decides what the NEXT open shows. Asking the network every
// time is what made a keystroke feel like a page load.
let appsKnown = null;
async function refreshApps() {
	const built = builtInApps();
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

const shell = desk = mountShell({
	world: el("imperfect-world"),
	apps: listedApps,
	onReveal: () => closeHarness(),
	onError: (error) => console.warn("application did not open", error),
});

const knowledge = mountKnowledgeGraph({
	world: el("imperfect-world"),
});

const pi = mountGueyPi({
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
		onGraph: () => { knowledge.open(); },
		onWindowOpen: closeHarness,
		slot: (id, title) => shell.slot(id, title),
		release: (id) => shell.release(id),
	},
});

// Omarchy's theme reaches the phone through the server's revision, not a poll.


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

bindHarnessKeys({ onHarness: toggleHarness });
addEventListener("keydown", event => {
	if (event.repeat || event.ctrlKey || event.metaKey) return;
	if (event.altKey && event.code === "KeyW") {
		// Closes the showing in-platform window: server list + iframe. Apps here are pages,
		// not child processes, so there is no extra backend pid. Never the harness.
		event.preventDefault();
		const id = shell.active();
		if (id) pi.closeWindow(id);
		return;
	}
	if (event.altKey && event.code === "Space") {
		event.preventDefault();
		shell.openSheet();
	}
	// A panel in the middle of the screen reads as a dialog, and a dialog a keyboard cannot
	// dismiss is a trap. The backdrop closes it for a pointer; this is the same way out.
	// Only when the drawer is showing, so Escape still belongs to the harness the rest of the time.
	if (event.code === "Escape" && !event.altKey && shell.sheetOpen()) {
		event.preventDefault();
		event.stopPropagation();
		shell.closeSheet();
	}
}, true);

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
