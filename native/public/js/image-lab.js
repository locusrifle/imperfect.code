// The image lab.
//
// One wall of pictures, one prompt. Tapping a picture selects it; what is
// selected becomes what the next prompt is made from. That is the whole
// interaction, and everything below serves it.
//
// The page draws before it knows anything. `/lab/state` is a fetch, and this
// product has already learned once -- in the app drawer -- that a surface
// which waits on a round trip before showing a single element is
// indistinguishable from a broken one.

const grid = document.getElementById('lab-grid');
const empty = document.getElementById('lab-empty');
const rail = document.getElementById('lab-rail');
const foldersEl = document.getElementById('lab-folders');
const boardsEl = document.getElementById('lab-boards');
const connectEl = document.getElementById('lab-connect');
const bar = document.getElementById('lab-bar');
const picked = document.getElementById('lab-picked');
const promptEl = document.getElementById('lab-prompt');
const sendEl = document.getElementById('lab-send');
const noteEl = document.getElementById('lab-note');

// Selection is an array, not a set: combining three references is an
// instruction with an order, and the order the person tapped is the order they
// meant.
let selection = [];
let state = { pictures: [], pins: [], folders: [], boards: [], codex: {}, pinterest: {} };
let view = { kind: 'all', id: '' };
// Pictures still being drawn, newest first. They are not in `state` because
// they are not in the library yet.
const drawing = new Map();

function say(message, bad = false) {
	noteEl.textContent = message || '';
	noteEl.hidden = !message;
	noteEl.classList.toggle('is-bad', Boolean(bad));
}

async function postJson(path, body) {
	const response = await fetch(path, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body ?? {}),
	});
	const answer = await response.json().catch(() => ({ error: 'the machine did not answer' }));
	if (!response.ok) throw Object.assign(new Error(answer.error || 'that did not work'), answer);
	return answer;
}

// ---- what the wall is showing ----

function itemsForView() {
	if (view.kind === 'board') return state.pins.filter(pin => pin.board === view.id);
	if (view.kind === 'folder') return state.pictures.filter(picture => picture.folder === view.id);
	if (view.kind === 'loose') return state.pictures.filter(picture => !picture.folder);
	return state.pictures;
}

function emptyMessage() {
	if (view.kind === 'board') return 'This board has no pins yet. Drop images here to add some.';
	if (view.kind === 'folder') return 'Nothing filed here yet. Select pictures and file them in.';
	if (!state.codex.signedIn) {
		return 'No pictures yet. This machine is not signed in to a ChatGPT subscription, so it cannot draw one — sign in with pi, then reopen the lab.';
	}
	return 'No pictures yet. Describe one below, or select some inspiration first and combine it.';
}

function cardFor(item, kind) {
	const rank = selection.indexOf(item.id);
	const card = document.createElement('button');
	card.type = 'button';
	card.className = 'lab-card';
	card.dataset.id = item.id;
	card.dataset.kind = kind;
	card.setAttribute('aria-pressed', rank >= 0 ? 'true' : 'false');

	const badge = document.createElement('span');
	badge.className = 'lab-rank';
	badge.textContent = String(rank + 1);
	card.append(badge);

	const image = document.createElement('img');
	image.src = item.src;
	image.alt = item.prompt || item.note || (kind === 'pin' ? 'pin' : 'picture');
	image.loading = 'lazy';
	// The wall is columns, so an image whose height is unknown until it loads
	// reflows everything below it. Nothing here knows the size in advance, so
	// the reflow is accepted rather than faked with a wrong aspect ratio.
	card.append(image);

	const caption = item.prompt || item.note;
	if (caption) {
		const note = document.createElement('span');
		note.className = 'lab-card-note';
		note.textContent = caption;
		card.append(note);
	}
	return card;
}

function drawingCard(entry) {
	const card = document.createElement('div');
	card.className = 'lab-card is-drawing';
	if (entry.failed) card.classList.add('is-failed');
	if (entry.frame) {
		const image = document.createElement('img');
		image.src = `data:image/png;base64,${entry.frame}`;
		image.alt = '';
		// Keyed by frame number so the browser treats each frame as a new
		// element and the fade actually plays.
		image.dataset.frame = String(entry.frames);
		card.append(image);
	}
	const label = document.createElement('span');
	label.className = 'lab-drawing-label';
	label.textContent = entry.failed ? entry.failed : (entry.frame ? 'drawing…' : 'starting…');
	card.append(label);
	return card;
}

function render() {
	const items = itemsForView();
	grid.replaceChildren();

	// Work in progress belongs at the head of the wall, where the person is
	// already looking after pressing send.
	if (view.kind !== 'board') {
		for (const entry of drawing.values()) grid.append(drawingCard(entry));
	}
	for (const item of items) grid.append(cardFor(item, view.kind === 'board' ? 'pin' : 'picture'));

	const nothing = !items.length && !drawing.size;
	empty.textContent = nothing ? emptyMessage() : '';
	empty.hidden = !nothing;
	renderRail();
	renderPicked();
}

function shelfButton(label, count, current, onPick) {
	const li = document.createElement('li');
	const button = document.createElement('button');
	button.type = 'button';
	button.textContent = label;
	button.setAttribute('aria-current', current ? 'true' : 'false');
	button.addEventListener('click', onPick);
	li.append(button);
	if (count != null) {
		const badge = document.createElement('span');
		badge.className = 'lab-count';
		badge.textContent = String(count);
		li.append(badge);
	}
	return li;
}

function renderRail() {
	foldersEl.replaceChildren();
	foldersEl.append(shelfButton('Everything', state.pictures.length, view.kind === 'all', () => {
		view = { kind: 'all', id: '' };
		render();
	}));
	const loose = state.pictures.filter(p => !p.folder).length;
	if (state.folders.length) {
		foldersEl.append(shelfButton('Unfiled', loose, view.kind === 'loose', () => {
			view = { kind: 'loose', id: '' };
			render();
		}));
	}
	for (const folder of state.folders) {
		foldersEl.append(shelfButton(
			folder.name,
			state.pictures.filter(p => p.folder === folder.id).length,
			view.kind === 'folder' && view.id === folder.id,
			() => { view = { kind: 'folder', id: folder.id }; render(); },
		));
	}
	const add = document.createElement('li');
	const addButton = document.createElement('button');
	addButton.type = 'button';
	addButton.textContent = '+ folder';
	addButton.style.color = 'var(--muted, #8a7259)';
	addButton.addEventListener('click', newFolder);
	add.append(addButton);
	foldersEl.append(add);

	boardsEl.replaceChildren();
	for (const board of state.boards) {
		boardsEl.append(shelfButton(
			board.name,
			state.pins.filter(p => p.board === board.id).length,
			view.kind === 'board' && view.id === board.id,
			() => { view = { kind: 'board', id: board.id }; render(); },
		));
	}
	if (!state.boards.length) {
		const li = document.createElement('li');
		li.style.cssText = 'padding:5px 8px;color:var(--muted,#8a7259)';
		li.textContent = state.pinterest.connected ? 'no boards imported' : 'not connected';
		boardsEl.append(li);
	}
	connectEl.textContent = state.pinterest.connected ? 'Pinterest boards…'
		: state.pinterest.configured ? 'Connect Pinterest' : 'Set up Pinterest';
}

function thumbFor(id) {
	return state.pictures.find(p => p.id === id) || state.pins.find(p => p.id === id) || null;
}

function renderPicked() {
	if (!selection.length) { picked.hidden = true; picked.replaceChildren(); return; }
	picked.hidden = false;
	picked.replaceChildren();

	for (const id of selection) {
		const item = thumbFor(id);
		if (!item) continue;
		const button = document.createElement('button');
		button.type = 'button';
		button.className = 'lab-picked-thumb';
		button.title = 'remove from the selection';
		const image = document.createElement('img');
		image.src = item.src;
		image.alt = '';
		button.append(image);
		button.addEventListener('click', () => { toggle(id); });
		picked.append(button);
	}

	const label = document.createElement('span');
	label.className = 'lab-picked-label';
	label.textContent = selection.length === 1 ? '1 selected' : `${selection.length} selected`;
	picked.append(label);

	const actions = document.createElement('span');
	actions.className = 'lab-picked-actions';

	// Filing and deleting only make sense for pictures. A selection that is
	// all pins is inspiration for the prompt and nothing else.
	const pictures = selection.filter(id => state.pictures.some(p => p.id === id));
	if (pictures.length && state.folders.length) {
		const file = document.createElement('select');
		file.innerHTML = '<option value="">file into…</option>'
			+ state.folders.map(f => `<option value="${f.id}"></option>`).join('');
		// Names are set as text, never as markup: a folder is named by a
		// person and may contain anything.
		[...file.options].slice(1).forEach((option, index) => { option.textContent = state.folders[index].name; });
		file.addEventListener('change', async () => {
			const folder = file.value;
			if (!folder) return;
			try {
				await Promise.all(pictures.map(id => postJson('/lab/picture/move', { id, folder })));
				selection = [];
				await refresh();
			} catch (error) { say(error.message, true); }
		});
		actions.append(file);
	}
	if (pictures.length) {
		const remove = document.createElement('button');
		remove.type = 'button';
		remove.textContent = 'delete';
		remove.addEventListener('click', async () => {
			if (!confirm(`Delete ${pictures.length === 1 ? 'this picture' : `these ${pictures.length} pictures`}? This cannot be undone.`)) return;
			try {
				await Promise.all(pictures.map(id => postJson('/lab/picture/delete', { id })));
				selection = [];
				await refresh();
			} catch (error) { say(error.message, true); }
		});
		actions.append(remove);
	}
	const clear = document.createElement('button');
	clear.type = 'button';
	clear.textContent = 'clear';
	clear.addEventListener('click', () => { selection = []; render(); });
	actions.append(clear);
	picked.append(actions);
}

function toggle(id) {
	const at = selection.indexOf(id);
	if (at >= 0) selection.splice(at, 1);
	else if (selection.length < 8) selection.push(id);
	else { say('Eight references is the most that can be combined at once.'); return; }
	render();
}

grid.addEventListener('click', event => {
	const card = event.target.closest('.lab-card');
	if (!card || !card.dataset.id) return;
	toggle(card.dataset.id);
});

// ---- folders ----

async function newFolder() {
	const name = prompt('Name this folder');
	if (!name) return;
	try {
		await postJson('/lab/folder/create', { name });
		await refresh();
	} catch (error) { say(error.message, true); }
}

// ---- drawing ----

// One streamed response, read as server-sent events. `fetch` rather than
// EventSource because this is a POST with a body, and the body is the prompt.
async function readStream(response, onFrame) {
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		let cut;
		while ((cut = buffer.indexOf('\n\n')) >= 0) {
			const block = buffer.slice(0, cut);
			buffer = buffer.slice(cut + 2);
			for (const line of block.split('\n')) {
				if (!line.startsWith('data: ')) continue;
				try { onFrame(JSON.parse(line.slice(6))); } catch { /* a torn frame is not worth stopping for */ }
			}
		}
	}
}

async function send(event) {
	event.preventDefault();
	const text = promptEl.value.trim();
	if (!text) { promptEl.focus(); return; }
	const combine = [...selection];

	const key = `drawing-${Date.now()}`;
	drawing.set(key, { frame: '', frames: 0, failed: '' });
	// The prompt clears and the selection stays: making a second picture from
	// the same references is the common next thing, and retyping the
	// selection to do it would be busywork.
	promptEl.value = '';
	promptEl.style.height = '';
	sendEl.disabled = true;
	say('');
	// Back to everything, or the picture being drawn appears in a view that is
	// not showing it.
	if (view.kind === 'board') view = { kind: 'all', id: '' };
	render();

	try {
		const response = await fetch('/lab/generate', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ prompt: text, combine, folder: view.kind === 'folder' ? view.id : '' }),
		});
		if (!response.ok) {
			const answer = await response.json().catch(() => ({}));
			throw new Error(answer.error || `the machine refused that (${response.status})`);
		}
		let saved = false;
		await readStream(response, frame => {
			const entry = drawing.get(key);
			if (!entry) return;
			if (frame.type === 'partial') {
				entry.frame = frame.image;
				entry.frames += 1;
				render();
			} else if (frame.type === 'saved') {
				saved = true;
				drawing.delete(key);
				state.pictures.unshift(frame.picture);
				render();
				if (frame.note) say(frame.note);
			} else if (frame.type === 'error') {
				entry.failed = frame.error;
				render();
				say(frame.signedOut
					? `${frame.error}. Sign in on this machine with pi, then try again.`
					: frame.error, true);
			}
		});
		// A stream that ended without either outcome is a dropped connection,
		// not a finished picture. Saying nothing would leave a card drawing
		// forever.
		if (!saved && drawing.has(key)) {
			const entry = drawing.get(key);
			if (!entry.failed) { entry.failed = 'the connection dropped'; say('The connection dropped before the picture finished.', true); }
			render();
		}
		if (saved) await refresh();
	} catch (error) {
		const entry = drawing.get(key);
		if (entry) { entry.failed = error.message; render(); }
		say(error.message, true);
	} finally {
		sendEl.disabled = false;
	}
}

bar.addEventListener('submit', send);

// Enter sends, shift+enter makes a new line. The prompt is usually one line,
// and reaching for a button after every one of them would be the slow part.
promptEl.addEventListener('keydown', event => {
	if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); bar.requestSubmit(); }
});
promptEl.addEventListener('input', () => {
	promptEl.style.height = 'auto';
	promptEl.style.height = `${Math.min(promptEl.scrollHeight, 144)}px`;
});

// ---- Pinterest ----

connectEl.addEventListener('click', async () => {
	try {
		if (!state.pinterest.configured) {
			const appId = prompt('Pinterest app id');
			if (!appId) return;
			const appSecret = prompt('Pinterest app secret');
			if (!appSecret) return;
			await postJson('/lab/pinterest/configure', { appId, appSecret });
			await refresh();
			say('Pinterest app saved. Press Connect Pinterest again to approve it.');
			return;
		}
		if (!state.pinterest.connected) {
			const answer = await (await fetch('/lab/pinterest/authorize')).json();
			if (answer.error) throw new Error(answer.error);
			// Their approval happens on Pinterest, in their own browser. The
			// window closes itself when the callback lands.
			window.open(answer.url, 'pinterest', 'width=560,height=720');
			say('Approve the connection in the window that opened, then press Pinterest boards.');
			return;
		}
		await pickBoard();
	} catch (error) { say(error.message, true); }
});

async function pickBoard() {
	const answer = await (await fetch('/lab/pinterest/boards')).json();
	if (answer.error) throw new Error(answer.error);
	if (!answer.boards?.length) { say('That Pinterest account has no boards this app can see.'); return; }
	const listed = answer.boards.map((board, index) => `${index + 1}. ${board.name} (${board.pinCount})`).join('\n');
	const choice = prompt(`Which board?\n\n${listed}`);
	const index = Number(choice) - 1;
	const board = answer.boards[index];
	if (!board) return;

	say(`Importing ${board.name}…`);
	const response = await fetch('/lab/pinterest/import', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ remoteId: board.remoteId, name: board.name }),
	});
	let kept = 0;
	await readStream(response, frame => {
		if (frame.type === 'pin') { kept = frame.kept; say(`Importing ${board.name}… ${kept}`); }
		else if (frame.type === 'error') say(frame.error, true);
		else if (frame.type === 'done') say(`${board.name}: ${frame.kept} pins.`);
	});
	await refresh();
	const imported = state.boards.find(b => b.remoteId === board.remoteId);
	if (imported) { view = { kind: 'board', id: imported.id }; render(); }
}

// ---- inspiration that did not come from an API ----

// Dropped, pasted, or chosen from the person's own files. This is how
// reference images get in when a service is not involved, which is most of
// the time and all of the time before a Pinterest app is approved.
async function keepImages(files, boardId) {
	const images = [...files].filter(file => file && file.type.startsWith('image/'));
	if (!images.length) return;
	let kept = 0;
	for (const file of images) {
		try {
			const query = new URLSearchParams();
			if (boardId) query.set('board', boardId);
			if (file.name) query.set('note', file.name);
			const response = await fetch(`/lab/pin/add?${query}`, {
				method: 'POST',
				headers: { 'Content-Type': file.type },
				body: file,
			});
			const answer = await response.json().catch(() => ({}));
			if (!response.ok) throw new Error(answer.error || 'that image would not keep');
			kept += 1;
			say(`Kept ${kept} of ${images.length}…`);
		} catch (error) { say(error.message, true); }
	}
	if (!kept) return;
	await refresh();
	say(kept === 1 ? 'Kept 1 image.' : `Kept ${kept} images.`);
	// Land the person on the shelf the images went to, or they have to go
	// looking for what they just dropped.
	const shelf = state.boards.find(b => b.id === (boardId || ''))
		|| state.boards.find(b => b.remoteId === 'local:dropped');
	if (shelf) { view = { kind: 'board', id: shelf.id }; render(); }
}

// The whole page is the drop target. Aiming at a particular strip would be a
// rule to learn for no gain.
document.addEventListener('dragover', event => { event.preventDefault(); });
document.addEventListener('drop', event => {
	if (!event.dataTransfer?.files?.length) return;
	event.preventDefault();
	keepImages(event.dataTransfer.files, view.kind === 'board' ? view.id : '');
});
document.addEventListener('paste', event => {
	const files = [...(event.clipboardData?.files || [])];
	if (!files.length) return;
	// Only when the prompt is not being typed into: pasting text into the
	// prompt must keep working.
	if (document.activeElement === promptEl && !files.length) return;
	event.preventDefault();
	keepImages(files, view.kind === 'board' ? view.id : '');
});

// ---- keeping up to date ----

async function refresh() {
	const response = await fetch('/lab/state');
	if (!response.ok) throw new Error('the lab could not be read');
	const next = await response.json();
	state = { ...state, ...next };
	render();
	return state;
}

// Drawn once with nothing in it, so the shape of the lab is on screen before
// the first fetch answers.
render();
refresh().then(() => {
	if (!state.codex.signedIn) {
		sendEl.disabled = true;
		promptEl.placeholder = 'no ChatGPT subscription signed in on this machine';
		say(state.codex.reason || state.codex.error || 'This machine is not signed in to a ChatGPT subscription, so it cannot draw. Boards and filing still work.', true);
	}
}).catch(error => say(error.message, true));
