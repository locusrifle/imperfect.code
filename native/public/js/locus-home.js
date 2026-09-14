// The home screen: your apps on the ruled ground, with the agent one keystroke away.
//
// The framing this serves: Locus is where somebody keeps the things they have built. An app here
// is a page this computer serves, so a project that becomes a page becomes a tile without anything
// learning a new window kind. The harness is a drop over the top rather than the whole screen,
// because the screen belongs to the apps.
const $ = id => document.getElementById(id);
const harness = $("terminal-entry");
const home = $("locus-home");
const frame = $("window-frame");
const windowLayer = $("locus-window");

// Everything here is a page this application already serves. Adding one is adding a line.
const APPS = [
	{ id: "files", title: "files", note: "what is on this computer", src: "/files.html" },
	{ id: "antiburn", title: "antiburn", note: "what you are spending", src: "/antiburn.html" },
	// The screen of the machine itself. Its address is asked for at the moment it is opened and
	// never kept: the URL carries an access token, and a token nobody stores is a token nobody
	// leaks. Locus holds the fleet credential that mints it; this computer does not.
	{ id: "desktop", title: "desktop", note: "the screen of this machine", remote: "/__desktop" },
];

const openHarness = () => { harness.classList.add("open"); $("entry-input")?.focus(); };
const closeHarness = () => { harness.classList.remove("open"); $("entry-input")?.blur(); };
const harnessOpen = () => harness.classList.contains("open");
const toggleHarness = () => (harnessOpen() ? closeHarness() : openHarness());

async function openApp(app) {
	$("window-title").textContent = app.title;
	windowLayer.hidden = false;
	home.hidden = true;
	closeHarness();
	// Our own pages stay sandboxed; the supplier's stream needs its own origin and its socket,
	// and a sandbox that suits a local page would silently break it.
	if (app.remote) frame.removeAttribute("sandbox");
	else frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms");
	if (!app.remote) { frame.src = app.src; return; }
	// Fetched per open rather than held: the address is short-lived and carries a token.
	$("window-title").textContent = `${app.title} — connecting`;
	try {
		const response = await fetch(app.remote, { headers: { accept: "application/json" } });
		if (!response.ok) throw new Error(String(response.status));
		const { url } = await response.json();
		if (!url) throw new Error("no address");
		frame.src = url;
		$("window-title").textContent = app.title;
	} catch {
		$("window-title").textContent = app.title;
		// Say what happened in the window rather than leaving a blank frame that looks like a
		// screen which failed to draw.
		frame.removeAttribute("src");
		frame.srcdoc = '<p style="font:14px ui-monospace,monospace;padding:24px">This machine\'s screen could not be reached. It may still be starting.</p>';
	}
}

function closeApp() {
	windowLayer.hidden = true;
	home.hidden = false;
	// Let the frame go rather than leaving a page running behind a hidden panel.
	frame.removeAttribute("src");
	frame.removeAttribute("srcdoc");
	$("window-title").textContent = "";
}

// What this machine can actually offer. Asked once, so a tile that cannot work here is never
// drawn rather than drawn and then failing when somebody trusts it.
async function capabilities() {
	try {
		const response = await fetch("/__machine", { headers: { accept: "application/json" } });
		return response.ok ? await response.json() : {};
	} catch { return {}; }
}

function paint(can = {}) {
	const list = $("home-apps");
	list.replaceChildren();
	for (const app of APPS) {
		if (app.id === "desktop" && !can.desktop) continue;
		const item = document.createElement("li");
		const tile = document.createElement("button");
		tile.type = "button";
		tile.className = "tile";
		tile.innerHTML = "";
		const title = document.createElement("span");
		title.className = "tile-title";
		title.textContent = app.title;
		const note = document.createElement("span");
		note.className = "tile-note";
		note.textContent = app.note;
		tile.append(title, note);
		tile.onclick = () => openApp(app);
		item.append(tile);
		list.append(item);
	}
	// An empty slot is the honest way to say what this place is for. It is not a button that
	// does nothing: it explains how a thing you build turns into a tile.
	const slot = document.createElement("li");
	slot.className = "slot";
	slot.innerHTML = "";
	const label = document.createElement("span");
	label.className = "slot-label";
	label.textContent = "your next app";
	const how = document.createElement("span");
	how.className = "slot-note";
	how.textContent = "ask the agent to build one, and it lands here";
	slot.append(label, how);
	list.append(slot);
}

// Alt+L, the same reach as the drop on Noah's own machine. Refused while a text field has the
// caret only if that field is the composer -- otherwise the shortcut would be unreachable from
// the very place you use it.
addEventListener("keydown", event => {
	if (event.altKey && !event.ctrlKey && !event.metaKey && event.key.toLowerCase() === "l") {
		event.preventDefault();
		toggleHarness();
		return;
	}
	if (event.key === "Escape") {
		if (harnessOpen()) { closeHarness(); return; }
		if (!windowLayer.hidden) closeApp();
	}
});

$("window-close").onclick = closeApp;
paint();
capabilities().then(paint);
