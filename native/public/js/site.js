// omarchy mobile — Guey's conversation UI in a Quake drop over the canvas, with
// one full viewport per open application. A phone types on its own OS keyboard:
// the custom two-page key sheet was removed on 2026-09-14, because Android and
// iOS already ship a keyboard people know, and rebuilding one was the imitation
// this shell otherwise refuses.

import { grid, bindHarnessKeys } from "./pi-card.js";
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

const SWIPE_MIN = 56;

function harnessEdge(node) {
	return Boolean(node?.closest?.('#harness-reach, .drop-handle'));
}

let swipe = null;

addEventListener("pointerdown", event => {
	if (event.button || !harnessEdge(event.target)) return;
	swipe = { id: event.pointerId, x: event.clientX, y: event.clientY };
	try { event.target.setPointerCapture?.(event.pointerId); } catch { /* not a capturing target */ }
}, { capture: true });

addEventListener("pointermove", event => {
	if (!swipe || event.pointerId !== swipe.id) return;
	const dx = event.clientX - swipe.x;
	const dy = event.clientY - swipe.y;
	if (Math.abs(dy) < SWIPE_MIN || Math.abs(dy) < Math.abs(dx)) return;
	if (!isHarnessOpen() && dy > 0) openHarness();
	else if (isHarnessOpen() && dy < 0) closeHarness();
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
const APPS = [
	{ id: "files", title: "files", note: "what is on this computer", window: { kind: "page", src: "/files.html" } },
	{ id: "antiburn", title: "antiburn", note: "what you are spending", window: { kind: "page", src: "/antiburn.html" } },
];

async function listedApps() {
	const built = APPS.map(app => ({
		id: app.id,
		title: app.title,
		note: app.note,
		open: () => pi.openWindow({ ...app.window, id: app.id, title: app.title }),
	}));
	try {
		const response = await fetch("/apps/list");
		if (!response.ok) return built;
		const extra = await response.json();
		if (!Array.isArray(extra)) return built;
		const seen = new Set(built.map(app => app.id));
		for (const app of extra) {
			if (!app?.id || seen.has(app.id) || !String(app.src || "").startsWith("/apps/")) continue;
			seen.add(app.id);
			built.push({
				id: app.id,
				title: app.title || app.id,
				note: app.note || "on this computer",
				open: () => pi.openWindow({ kind: "page", src: app.src, id: app.id, title: app.title || app.id }),
			});
		}
	} catch {}
	return built;
}

const shell = mountShell({
	world: el("imperfect-world"),
	apps: listedApps,
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
if (reach) reach.hidden = isHarnessOpen();
input.addEventListener("input", grow);
grow();
