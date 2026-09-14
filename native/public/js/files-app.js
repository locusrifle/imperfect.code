// The laptop's filesystem as one of the phone's applications.
//
// Read-only: this process runs as Noah, so browsing and opening is the whole
// need, and a write path would be machine authority handed to a stray tap. The
// phone's own storage is stock Android's job.

const list = document.getElementById('files-list');
const label = document.getElementById('files-path');
const up = document.getElementById('files-up');

let here = { path: '', parent: null };

function el(tag, text, className) {
	const node = document.createElement(tag);
	if (text != null) node.textContent = text;
	if (className) node.className = className;
	return node;
}

function size(bytes) {
	if (bytes == null) return '';
	const units = ['B', 'K', 'M', 'G', 'T'];
	let n = bytes;
	let i = 0;
	while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
	return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)}${units[i]}`;
}

function fail(message) {
	list.replaceChildren(el('p', message, 'files-note'));
}

async function show(path) {
	let data;
	try {
		const res = await fetch(`/files/list?path=${encodeURIComponent(path)}`, { headers: { accept: 'application/json' } });
		if (!res.ok) { fail(await res.text() || 'cannot read that'); return; }
		data = await res.json();
	} catch { fail('the laptop did not answer'); return; }
	here = data;
	label.textContent = data.path ? `~/${data.path}` : '~';
	up.hidden = data.parent === null;
	const rows = document.createDocumentFragment();
	for (const entry of data.entries) {
		const row = el('button', null, 'files-row');
		row.type = 'button';
		row.dataset.kind = entry.kind;
		if (entry.hidden) row.dataset.hidden = 'true';
		row.append(el('span', entry.directory ? `${entry.name}/` : entry.name, 'files-name'));
		row.append(el('span', entry.directory ? '' : size(entry.size), 'files-size'));
		row.onclick = () => (entry.directory ? show(entry.path) : preview(entry));
		rows.append(row);
	}
	if (!data.entries.length) rows.append(el('p', 'empty', 'files-note'));
	if (data.truncated) rows.append(el('p', 'more entries than shown', 'files-note'));
	list.replaceChildren(rows);
	list.scrollTop = 0;
}

// Preview happens in this window, not a new one: one application, one viewport.
async function preview(entry) {
	const back = el('button', '‹ back', 'files-back');
	back.type = 'button';
	back.onclick = () => show(here.path);
	const head = el('div', null, 'files-preview-head');
	head.append(back, el('span', entry.name, 'files-preview-name'));
	const stage = el('div', null, 'files-stage');
	const url = `/files/open?path=${encodeURIComponent(entry.path)}`;
	if (entry.kind === 'image') {
		const img = el('img', null, 'files-image');
		img.alt = entry.name;
		img.src = url;
		stage.append(img);
	} else if (entry.kind === 'video' || entry.kind === 'audio') {
		const media = document.createElement(entry.kind === 'video' ? 'video' : 'audio');
		media.className = `files-${entry.kind}`;
		media.controls = true;
		media.playsInline = true;
		media.preload = 'metadata';
		media.src = url;
		stage.append(media);
	} else if (entry.kind === 'text') {
		try {
			const res = await fetch(`/files/text?path=${encodeURIComponent(entry.path)}`);
			if (!res.ok) throw new Error(await res.text());
			stage.append(el('pre', (await res.json()).text, 'files-text'));
		} catch (error) {
			stage.append(el('p', error.message || 'cannot read that', 'files-note'));
		}
	} else if (entry.kind === 'pdf') {
		const frame = document.createElement('iframe');
		frame.className = 'files-pdf';
		frame.title = entry.name;
		frame.src = url;
		stage.append(frame);
	} else {
		stage.append(el('p', `no preview for ${entry.name}`, 'files-note'));
	}
	list.replaceChildren(head, stage);
}

up.onclick = () => { if (here.parent !== null) void show(here.parent); };
void show('');
