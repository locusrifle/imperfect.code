import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { chromium } from 'playwright';
import { WebSocket } from 'ws';
import { createGueyServer } from '../../server.mjs';
import { sanitizeWorldWindow } from '../world-windows.mjs';

// A real browser against the real server, with a scripted runtime in place of a
// model: the frontend contract, not the agent, is what this file proves.
function browserPath() {
	const bundled = chromium.executablePath();
	if (existsSync(bundled)) return undefined; // playwright's own download
	for (const path of ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable']) if (existsSync(path)) return path;
	return null;
}

function waitForCommand(runtime, predicate) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => { clearInterval(poll); reject(new Error('No matching command reached the runtime')); }, 10000);
		const poll = setInterval(() => {
			const found = runtime.sent.find(predicate);
			if (found) { clearInterval(poll); clearTimeout(timer); resolve(found); }
		}, 10);
	});
}

function scriptedRuntime(cwd) {
	const events = new EventEmitter();
	const data = {
		sessionId: 'browser-test', sessionFile: join(cwd, 'session.jsonl'), cwd, name: 'browser',
		model: { id: 'fixture-model', provider: 'fixture', name: 'Fixture', contextWindow: 1000 }, thinkingLevel: 'off',
		busy: false, operation: null, failed: null, commands: [], messages: [], partial: null, runningTools: [],
		queue: { steering: [], followUp: [] }, stats: { tokens: { total: 12, input: 1200, output: 300, cacheRead: 4000, cacheWrite: 0 }, cost: 0.5, contextUsage: { tokens: 80, contextWindow: 1000, percent: 8 } },
		ui: { dialogs: [], statuses: {}, widgets: {}, notifications: [], editor: null },
		resources: { skills: ['fixture'], extensions: [], tools: ['bash'] },
		startup: { version: '0.85.0', quiet: false, sections: [{ name: 'Skills', compact: 'fixture', expanded: '/tmp/skills/fixture/SKILL.md' }], update: null },
		tabs: [{ id: 'browser-test', sessionId: 'browser-test', name: 'browser', busy: false, focused: true }],
		diagnostics: [],
	};
	const changed = () => events.emit('change');
	const sent = [];
	const runtime = {
		events, sent, data, snapshot: () => data,
		async command(c) {
			sent.push(c);
			switch (c.type) {
				case 'prompt':
					if (c.behavior === 'steer') {
						data.queue.steering.push(c.text); changed();
						return { accepted: true };
					}
					if (c.behavior === 'followUp') {
						data.queue.followUp.push(c.text); changed();
						return { accepted: true };
					}
					data.messages.push({
						role: 'user',
						content: [{ type: 'text', text: c.text }, ...(Array.isArray(c.images) ? c.images : [])],
						timestamp: Date.now(),
					});
					data.busy = true; changed();
					return { accepted: true };
				case 'abort': {
					const queue = data.queue; data.queue = { steering: [], followUp: [] }; data.busy = false; changed();
					return queue;
				}
				case 'dequeue': {
					const queue = data.queue; data.queue = { steering: [], followUp: [] }; changed();
					return queue;
				}
				case 'sessions': return [
					{ id: 'own', path: join(cwd, 'own.jsonl'), cwd, name: 'Own session', modified: Date.now(), messageCount: 2, copyOnResume: false },
					{ id: 'ext', path: '/elsewhere/live.jsonl', cwd: '/elsewhere', firstMessage: 'terminal session', modified: Date.now(), messageCount: 9, copyOnResume: true, liveOwner: { pid: 4242, startedAt: new Date().toISOString() } },
				];
				case 'models': return [{ provider: 'fixture', id: 'fixture-model', name: 'Fixture' }];
				case 'name': data.name = c.name; changed(); return;
				case 'attach': data.live = { pid: c.pid, connected: true, closed: false, waiting: null }; changed(); return { pid: c.pid };
				case 'detach': delete data.live; changed(); return;
				case 'new': data.messages = []; data.sessionId = 'fresh'; changed(); return;
				case 'tab-new': {
					data.tabs = (data.tabs ?? []).map(tab => ({
						...tab,
						focused: false,
						messages: tab.focused ? data.messages : tab.messages,
						sessionId: tab.focused ? data.sessionId : tab.sessionId,
						name: tab.focused ? data.name : tab.name,
					}));
					if (!data.tabs.length) data.tabs = [{ id: data.sessionId, sessionId: data.sessionId, name: data.name, busy: false, focused: false, messages: data.messages }];
					const id = `t${data.tabs.length + 1}`;
					data.tabs.push({ id, sessionId: id, name: '', busy: false, focused: true, messages: [] });
					data.messages = [];
					data.sessionId = id;
					data.name = '';
					changed();
					return;
				}
				case 'tab-focus': {
					const tab = (data.tabs ?? []).find(item => item.id === c.tabId);
					if (!tab) throw new Error('Unknown tab');
					if (tab.focused) return { id: c.tabId, focused: true };
					data.tabs = data.tabs.map(item => {
						if (item.focused) return { ...item, focused: false, messages: data.messages, sessionId: data.sessionId, name: data.name };
						return { ...item, focused: item.id === c.tabId };
					});
					data.messages = tab.messages ?? [];
					data.sessionId = tab.sessionId;
					data.name = tab.name;
					changed();
					return { id: c.tabId, focused: true };
				}
				case 'tab-close': {
					const tabs = data.tabs ?? [];
					if (tabs.length <= 1) throw new Error('The last tab stays open');
					const index = tabs.findIndex(tab => tab.id === c.tabId);
					if (index < 0) throw new Error('Unknown tab');
					const next = tabs.filter(tab => tab.id !== c.tabId);
					const focusId = tabs[index].focused ? next[Math.max(0, index - 1)].id : (tabs.find(tab => tab.focused)?.id ?? next[0].id);
					data.tabs = next.map(tab => ({ ...tab, focused: tab.id === focusId }));
					changed();
					return { ok: true, focused: focusId };
				}
				default: throw new Error(`Unsupported command: ${c.type}`);
			}
		},
		async close() {},
	};
	return runtime;
}

test('a real browser drives the harness: streaming, tools, dialogs, slash commands, watching and reconnect', async (t) => {
	const executablePath = browserPath();
	if (executablePath === null) return t.skip('No chromium available; run `npx playwright install chromium`');
	const root = await mkdtemp(join(tmpdir(), 'guey-browser-test-'));
	const runtime = scriptedRuntime(root);
	const app = await createGueyServer({ port: 0, host: '127.0.0.1', stateDir: root, runtime });
	const address = await app.listen();
	const base = `http://127.0.0.1:${address.port}`;
	const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
	const page = await browser.newPage();
	const crashes = [];
	page.on('pageerror', e => crashes.push(e.message));
	try {
		await page.goto(base);
		// The design system has to actually arrive: a missing stylesheet still renders.
		await page.waitForFunction(() => getComputedStyle(document.body).fontFamily.includes('Commit Mono'));
		// The ground behind Omarchy's wallpaper is the theme's own darker
		// background, in either browser scheme: Omarchy decides the mode, not the
		// phone. The design system still has to have arrived above.
		const ground = async () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
		await page.emulateMedia({ colorScheme: 'light' });
		const light = await ground();
		await page.emulateMedia({ colorScheme: 'dark' });
		assert.equal(await ground(), light, 'the canvas does not follow the browser scheme');
		assert.notEqual(light, 'rgba(0, 0, 0, 0)', 'the canvas is painted, not transparent');
		assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundImage), 'none', 'the ruled garden background is gone');
		const themeCss = await page.evaluate(async () => (await fetch('/theme.css')).text());
		assert.match(themeCss, /--tui-accent:/);
		assert.match(await page.getAttribute('#tui-theme', 'href'), /theme\.css/);
		await page.waitForFunction(() => (document.getElementById('entry-pi-label')?.textContent || '').includes('fixture-model'));
		assert.match(await page.textContent('#entry-pi-label'), /fixture-model/);
		assert.match(await page.textContent('#entry-spend'), /\$0\.500/);
		assert.equal(await page.evaluate(() => document.getElementById('terminal-entry').classList.contains('open')), false);
		assert.equal(await page.locator('#entry-hint').count(), 0);
		await page.keyboard.press('Alt+y');
		await page.waitForFunction(() => document.getElementById('terminal-entry').classList.contains('open'));
		assert.equal(await page.isVisible('.drop-handle'), true);

		await page.waitForSelector('.entry-startup');
		assert.match(await page.textContent('.entry-startup'), /pi v0\.85\.0/);
		assert.match(await page.textContent('.entry-startup'), /escape interrupt/);
		assert.match(await page.textContent('.entry-startup'), /Press ctrl\+o to show full startup help/);
		assert.match(await page.textContent('.entry-startup-section'), /\[Skills\]/);
		assert.match(await page.textContent('.entry-startup-section'), /fixture/);
		assert.equal(await page.locator('.entry-line.system:text-is("pi")').count(), 0);
		await page.locator('#entry-input').click();
		await page.locator('#entry-input').press('Control+o');
		await page.waitForFunction(() => (document.querySelector('.entry-startup')?.textContent || '').includes('to interrupt'));
		assert.match(await page.textContent('.entry-startup-section'), /SKILL\.md/);
		await page.locator('#entry-input').press('Control+o');
		await page.waitForFunction(() => (document.querySelector('.entry-startup')?.textContent || '').includes('Press ctrl+o'));

		// Sending: the prompt reaches the runtime and the composer clears.
		await page.fill('#entry-input', 'hello pi');
		await page.press('#entry-input', 'Enter');
		await page.waitForSelector('.entry-line.user:has-text("hello pi")');
		assert.equal(await page.locator('.entry-startup').count(), 1, 'startup header stays above messages, as in the TUI');
		assert.equal(await page.inputValue('#entry-input'), '');
		runtime.data.startup = { ...runtime.data.startup, quiet: true, update: { version: '0.85.1' } };
		runtime.events.emit('change');
		await page.waitForFunction(() => !document.querySelector('.entry-startup'));
		await page.waitForSelector('.entry-update:has-text("Update Available")');
		assert.match(await page.textContent('.entry-update'), /New version 0\.85\.1/);
		assert.match(await page.textContent('.entry-update'), /pi update/);
		runtime.data.startup = { ...runtime.data.startup, quiet: false, update: null };
		runtime.events.emit('change');
		await page.waitForSelector('.entry-startup');
		assert.equal(await page.locator('.entry-update').count(), 0);
		const prompt = runtime.sent.find(c => c.type === 'prompt');
		assert.equal(prompt?.text, 'hello pi');

		// Streaming partial, a running tool, then the settled transcript.
		runtime.data.partial = { role: 'assistant', content: [{ type: 'thinking', thinking: 'weighing it' }, { type: 'text', text: 'partial ans' }] };
		runtime.data.runningTools = [{ toolCallId: 't1', toolName: 'bash', args: { command: 'ls' }, result: { content: [{ type: 'text', text: 'a\nb' }] } }];
		runtime.data.busy = true; runtime.data.streaming = true; runtime.data.operation = 'working';
		runtime.events.emit('change');
		await page.waitForSelector('.entry-line.assistant:has-text("partial ans")');
		await page.waitForSelector('.entry-line.thinking:has-text("weighing it")');
		await page.waitForSelector('.entry-tool.pending .entry-tool-title:has-text("ls")');
		await page.waitForSelector('#entry-input-zone.working');
		assert.match(await page.textContent('#entry-work'), /fixture-model/);
		assert.equal(await page.locator('#entry-live').count(), 0);
		assert.doesNotMatch(await page.textContent('#entry-work'), /Working/);

		runtime.data.operation = 'compacting';
		runtime.events.emit('change');
		await page.waitForSelector('#entry-work:has-text("Compacting context")');
		assert.match(await page.textContent('#entry-work'), /escape to cancel/);
		assert.doesNotMatch(await page.textContent('#entry-work'), /Working/);
		runtime.data.operation = 'working';
		runtime.events.emit('change');
		await page.waitForFunction(() => (document.querySelector('#entry-work')?.textContent || '').includes('fixture-model'));

		runtime.data.partial = null; runtime.data.runningTools = [];
		runtime.data.messages.push(
			{ role: 'assistant', content: [{ type: 'text', text: 'final **answer**' }, { type: 'toolCall', id: 't1', name: 'bash', arguments: { command: 'ls' } }] },
			{ role: 'toolResult', toolCallId: 't1', toolName: 'bash', content: 'a\nb', isError: false },
		);
		runtime.data.busy = false; runtime.data.streaming = false; runtime.events.emit('change');
		await page.waitForSelector('.entry-line.assistant strong:has-text("answer")');
		await page.waitForSelector('.entry-tool.ok .entry-tool-cmd');
		assert.equal(await page.isVisible('.entry-tool.ok .entry-tool-output'), true);
		assert.match(await page.textContent('.entry-tool.ok .entry-tool-cmd'), /\$ ls/);

		// Tool output is inserted as text, never as markup.
		runtime.data.messages.push({ role: 'toolResult', toolCallId: 't2', toolName: 'read', content: '<img src=x onerror=alert(1)>', isError: false });
		runtime.events.emit('change');
		await page.waitForSelector('.entry-tool .entry-tool-title:has-text("read")');
		assert.equal(await page.evaluate(() => document.querySelectorAll('#entry-output img').length), 0);

		// Slash menu, and a command that takes an argument.
		await page.fill('#entry-input', '/na');
		await page.waitForSelector('#slash-menu .slash-name:text-is("name")');
		await page.fill('#entry-input', '/name renamed');
		await page.press('#entry-input', 'Enter');
		await waitForCommand(runtime, c => c.type === 'name' && c.name === 'renamed');
		assert.equal(runtime.data.name, 'renamed');
		assert.equal(await page.inputValue('#entry-input'), '');

		// Extension dialogs are answered in the terminal's own list style.
		runtime.data.ui.dialogs = [{ id: 'd1', method: 'select', title: 'Pick a branch', options: ['main', 'next'] }];
		runtime.events.emit('change');
		await page.waitForSelector('#entry-dialog:not([hidden]) .entry-dialog-title:has-text("Pick a branch")');
		const answered = waitForCommand(runtime, c => c.type === 'dialog');
		await page.click('.entry-dialog-option:has-text("next")');
		assert.equal((await answered).value, 'next');
		runtime.data.ui.dialogs = []; runtime.events.emit('change');

		// Watching a terminal session, from the session list.
		await page.fill('#entry-input', '/resume');
		await page.press('#entry-input', 'Enter');
		await page.waitForSelector('.entry-dialog-option:has-text("terminal session")');
		const watch = waitForCommand(runtime, c => c.type === 'attach');
		await page.click('.entry-dialog-option:has-text("▶")');
		assert.equal((await watch).pid, 4242);
		await page.waitForSelector('body.watching');
		const stop = waitForCommand(runtime, c => c.type === 'detach');
		await page.fill('#entry-input', '/detach');
		await page.press('#entry-input', 'Enter');
		await stop;
		await page.waitForSelector('body:not(.watching)');

		runtime.data.busy = true; runtime.data.operation = 'working'; runtime.events.emit('change');
		await page.waitForSelector('#entry-input-zone.working');
		const stopped = waitForCommand(runtime, c => c.type === 'abort');
		await page.locator('#entry-input').focus();
		await page.keyboard.press('Escape');
		await stopped;

		// Drafts survive a reload; an extension's editor pastes into that draft and never submits.
		await page.fill('#entry-input', 'kept draft');
		await page.reload();
		await page.waitForFunction(() => (document.getElementById('entry-pi-label')?.textContent || '').includes('fixture-model'));
		await page.keyboard.press('Alt+y');
		await page.waitForFunction(() => document.getElementById('terminal-entry').classList.contains('open'));
		assert.equal(await page.inputValue('#entry-input'), 'kept draft');
		await page.fill('#entry-input', '');
		const before = runtime.sent.length;
		runtime.data.ui.editor = { id: 'e1', text: 'dictated words', paste: true };
		runtime.events.emit('change');
		await page.waitForFunction(() => document.getElementById('entry-input').value === 'dictated words');
		assert.equal(runtime.sent.length, before, 'a pasted editor value must not submit');

		// A dropped socket reconnects, onto the transcript the runtime kept meanwhile.
		runtime.data.messages.push({ role: 'assistant', content: [{ type: 'text', text: 'kept across the drop' }] });
		for (const ws of app.sockets.clients) ws.terminate();
		// The status line itself is hidden in this composition -- `body.imperfect .entry-status` is
		// display:none, because the painting carries no chrome -- so this waits on what the console
		// knows, not on something a person can read. What the person sees is the next line landing.
		await page.waitForFunction(() => document.getElementById('entry-model-status')?.textContent === 'reconnecting');
		await page.waitForSelector('.entry-line.assistant:has-text("kept across the drop")', { timeout: 15000 });

		assert.deepEqual(crashes, []);
	} finally {
		await browser.close(); await app.close(); await rm(root, { recursive: true, force: true });
	}
});

test('desktop and phone play a done tone when the model finishes, even while looking', async (t) => {
	const executablePath = browserPath();
	if (executablePath === null) return t.skip('No chromium available; run `npx playwright install chromium`');
	const root = await mkdtemp(join(tmpdir(), 'guey-browser-done-sound-'));
	const runtime = scriptedRuntime(root);
	const app = await createGueyServer({ port: 0, host: '127.0.0.1', stateDir: root, runtime });
	const address = await app.listen();
	const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
	const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
	try {
		await page.goto(`http://127.0.0.1:${address.port}`);
		await page.waitForFunction(() => (document.getElementById('entry-pi-label')?.textContent || '').includes('fixture-model'));
		await page.keyboard.press('Alt+y');
		await page.waitForFunction(() => document.getElementById('terminal-entry').classList.contains('open'));
		await page.locator('#entry-input').click();
		const sounds = () => page.evaluate(() => window.__gueyDoneSounds || 0);
		assert.equal(await sounds(), 0);
		runtime.data.busy = true; runtime.data.streaming = false; runtime.events.emit('change');
		runtime.data.busy = false; runtime.data.streaming = false; runtime.events.emit('change');
		await new Promise(r => setTimeout(r, 80));
		assert.equal(await sounds(), 0, 'preflight busy must not sound');
		runtime.data.busy = true; runtime.data.streaming = true; runtime.events.emit('change');
		await page.waitForSelector('#entry-input-zone.working');
		runtime.data.busy = false; runtime.data.streaming = false; runtime.events.emit('change');
		await page.waitForFunction(() => (window.__gueyDoneSounds || 0) === 1, null, { timeout: 3000 });
		assert.equal(await page.evaluate(() => document.visibilityState), 'visible');
		await page.setViewportSize({ width: 390, height: 844 });
		assert.equal(await page.evaluate(() => matchMedia('(pointer: coarse)').matches || innerWidth < 700), true, 'narrow viewport is the phone shell');
		await page.evaluate(() => { window.__gueyDoneSounds = 0; });
		runtime.data.busy = true; runtime.data.streaming = true; runtime.events.emit('change');
		await page.waitForSelector('#entry-input-zone.working');
		runtime.data.busy = false; runtime.data.streaming = false; runtime.events.emit('change');
		await page.waitForFunction(() => (window.__gueyDoneSounds || 0) === 1, null, { timeout: 3000 });
	} finally {
		await browser.close(); await app.close(); await rm(root, { recursive: true, force: true });
	}
});

test('attaching an image shows it in the composer, then in the transcript', async (t) => {
	const executablePath = browserPath();
	if (executablePath === null) return t.skip('No chromium available; run `npx playwright install chromium`');
	const root = await mkdtemp(join(tmpdir(), 'guey-browser-attach-'));
	const runtime = scriptedRuntime(root);
	const app = await createGueyServer({ port: 0, host: '127.0.0.1', stateDir: root, runtime });
	const address = await app.listen();
	const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
	const page = await browser.newPage();
	try {
		await page.goto(`http://127.0.0.1:${address.port}`);
		await page.waitForFunction(() => (document.getElementById('entry-pi-label')?.textContent || '').includes('fixture-model'));
		await page.keyboard.press('Alt+y');
		await page.waitForFunction(() => document.getElementById('terminal-entry').classList.contains('open'));
		const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
		await page.setInputFiles('#entry-files', { name: 'phone.png', mimeType: 'image/png', buffer: png });
		await page.waitForSelector('#entry-pending:not([hidden]) img.entry-image');
		assert.equal(await page.textContent('.entry-attach span'), '1');
		assert.ok(await page.waitForFunction(() => {
			const img = document.querySelector('#entry-pending img.entry-image');
			return img && img.naturalWidth > 0;
		}));
		await page.waitForSelector('.entry-pending-chip:not(.is-uploading)');

		await page.click('#entry-pending .entry-pending-chip');
		await page.waitForSelector('#entry-pending', { state: 'hidden' });
		assert.equal(await page.textContent('.entry-attach span'), '+');

		await page.setInputFiles('#entry-files', { name: 'phone.png', mimeType: 'image/png', buffer: png });
		await page.waitForSelector('#entry-pending:not([hidden]) img.entry-image');
		await page.waitForFunction(() => !document.querySelector('.entry-pending-chip')?.classList.contains('is-uploading'));
		assert.equal(runtime.sent.filter(c => c.type === 'prompt').length, 0);
		await page.press('#entry-input', 'Enter');
		const sent = await waitForCommand(runtime, c => c.type === 'prompt');
		assert.match(sent.text, /\[uploaded file: .+phone-[0-9a-f-]+\.png\]/);
		assert.equal(sent.images, undefined);
		assert.equal(sent.files, undefined);
		const saved = sent.text.match(/\[uploaded file: (.+)\]/)[1];
		assert.deepEqual(await readFile(saved), png);
		await page.waitForSelector('.entry-line.user');
		assert.equal(await page.isHidden('#entry-pending'), true);
		assert.equal(await page.textContent('.entry-attach span'), '+');
		assert.equal(await page.locator('.entry-line.user img.entry-image').count(), 0);

		// Tool text that looks like markup still must not become an image.
		runtime.data.messages.push({ role: 'toolResult', toolCallId: 'xss', toolName: 'read', content: '<img src=x onerror=alert(1)>', isError: false });
		runtime.events.emit('change');
		await page.waitForSelector('.entry-tool .entry-tool-title:has-text("read")');
		assert.equal(await page.evaluate(() => document.querySelectorAll('#entry-output .entry-tool img').length), 0);
	} finally {
		await browser.close(); await app.close(); await rm(root, { recursive: true, force: true });
	}
});

async function openPersonalComposer(page, address) {
	await page.goto(`http://127.0.0.1:${address.port}`);
	await page.waitForFunction(() => (document.getElementById('entry-pi-label')?.textContent || '').includes('fixture-model'));
	await page.keyboard.press('Alt+y');
	await page.waitForFunction(() => document.getElementById('terminal-entry').classList.contains('open'));
}

test('imperfect plus opens the native picker for photos, audio and video; stock has none', async (t) => {
	const executablePath = browserPath();
	if (executablePath === null) return t.skip('No chromium available; run `npx playwright install chromium`');
	const root = await mkdtemp(join(tmpdir(), 'guey-browser-plus-'));
	const runtime = scriptedRuntime(root);
	const personal = await createGueyServer({ port: 0, host: '127.0.0.1', stateDir: join(root, 'p'), runtime, product: 'imperfect' });
	const stock = await createGueyServer({ port: 0, host: '127.0.0.1', stateDir: join(root, 's'), runtime, product: 'stock' });
	const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
	try {
		const pAddr = await personal.listen();
		const sAddr = await stock.listen();
		const stockPage = await browser.newPage();
		await stockPage.goto(`http://127.0.0.1:${sAddr.port}`);
		await stockPage.waitForSelector('#entry-input');
		assert.equal(await stockPage.locator('#entry-plus').count(), 0);
		assert.equal(await stockPage.locator('#entry-plus-menu').count(), 0);
		assert.equal(await stockPage.locator('#entry-camera').count(), 0);
		assert.equal(await stockPage.locator('#entry-record').count(), 0);
		assert.equal(await stockPage.locator('#entry-recording').count(), 0);
		await stockPage.close();

		const page = await browser.newPage();
		await openPersonalComposer(page, pAddr);
		assert.equal(await page.locator('#entry-plus-menu').count(), 0);
		assert.equal(await page.locator('#entry-camera').count(), 0);
		assert.equal(await page.locator('#entry-record').count(), 0);
		assert.equal(await page.locator('#entry-recording').count(), 0);
		const accept = await page.getAttribute('#entry-files', 'accept') || '';
		assert.match(accept, /^audio\//);
		assert.match(accept, /image\//);
		assert.match(accept, /\.m4a/);
		assert.match(accept, /\.mp3/);
		assert.match(accept, /\.mp4/);
		assert.match(accept, /\.pdf/);
		assert.doesNotMatch(accept, /video\/\*/);
		assert.equal(await page.getAttribute('#entry-files', 'capture'), null);
		const plusStyle = await page.locator('#entry-plus').evaluate(n => {
			const s = getComputedStyle(n);
			return { bg: s.backgroundColor, border: s.borderTopWidth };
		});
		assert.equal(plusStyle.border, '0px');
		const chooser = page.waitForEvent('filechooser');
		await page.click('#entry-plus');
		const dialog = await chooser;
		assert.equal(dialog.isMultiple(), true);
		const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
		await dialog.setFiles({ name: 'note.png', mimeType: 'image/png', buffer: png });
		await page.waitForSelector('#entry-pending:not([hidden])');
		assert.equal(await page.textContent('.entry-attach span'), '1');
		await page.waitForFunction(() => !document.querySelector('.entry-pending-chip')?.classList.contains('is-uploading'));
		await page.fill('#entry-input', 'keep this draft');
		await page.press('#entry-input', 'Enter');
		const sent = await waitForCommand(runtime, c => c.type === 'prompt');
		assert.match(sent.text, /^keep this draft\n\n\[uploaded file: /);
		assert.equal(sent.images, undefined);
		assert.equal(sent.files, undefined);
	} finally {
		await browser.close(); await personal.close(); await stock.close(); await rm(root, { recursive: true, force: true });
	}
});

test('imperfect takes a past recording from the picker and from a share', async (t) => {
	const executablePath = browserPath();
	if (executablePath === null) return t.skip('No chromium available; run `npx playwright install chromium`');
	const root = await mkdtemp(join(tmpdir(), 'guey-browser-recording-'));
	const runtime = scriptedRuntime(root);
	const app = await createGueyServer({ port: 0, host: '127.0.0.1', stateDir: join(root, 'state'), runtime, product: 'imperfect' });
	const address = await app.listen();
	const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
	const page = await browser.newPage();
	try {
		await openPersonalComposer(page, address);
		const m4a = Buffer.from('m4a-bytes');
		await page.setInputFiles('#entry-files', { name: 'walk.m4a', mimeType: 'audio/mp4', buffer: m4a });
		await page.waitForSelector('.entry-pending-chip:not(.is-uploading)');
		assert.match(await page.textContent('.entry-pending-chip') || '', /walk\.m4a/);
		await page.press('#entry-input', 'Enter');
		const first = await waitForCommand(runtime, c => c.type === 'prompt');
		assert.match(first.text, /\[uploaded file: .+walk-[0-9a-f-]+\.m4a\]/);

		await page.evaluate(async () => {
			const cache = await caches.open('guey-share-target');
			const file = new File([new Uint8Array([1, 2, 3, 4])], 'old-talk.m4a', { type: 'audio/mp4' });
			await cache.put('__share/1/old-talk.m4a', new Response(file, {
				headers: { 'Content-Type': 'audio/mp4', 'X-Filename': encodeURIComponent('old-talk.m4a') },
			}));
			dispatchEvent(new Event('guey:take-shares'));
		});
		await page.waitForFunction(() => document.getElementById('terminal-entry').classList.contains('open'));
		await page.waitForSelector('.entry-pending-chip:not(.is-uploading)');
		assert.match(await page.textContent('.entry-pending-chip') || '', /old-talk\.m4a/);
		await page.press('#entry-input', 'Enter');
		const second = await waitForCommand(runtime, c => c.type === 'prompt' && /old-talk/.test(c.text));
		assert.match(second.text, /\[uploaded file: .+old-talk-[0-9a-f-]+\.m4a\]/);

		await page.evaluate(async () => {
			await navigator.serviceWorker.register('/sw.js');
			await navigator.serviceWorker.ready;
			if (!navigator.serviceWorker.controller) {
				await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
			}
			const file = new File([new Uint8Array([9, 8, 7])], 'shared.mp3', { type: 'audio/mpeg' });
			const form = new FormData();
			form.append('recordings', file);
			await fetch('/share-target', { method: 'POST', body: form, redirect: 'manual' });
		});
		const stashed = await page.evaluate(async () => {
			const cache = await caches.open('guey-share-target');
			const keys = await cache.keys();
			return keys.map(k => k.url);
		});
		assert.ok(stashed.some(url => url.includes('shared.mp3')), stashed.join(','));
	} finally {
		await browser.close(); await app.close(); await rm(root, { recursive: true, force: true });
	}
});

test('imperfect uploads while the agent is busy and sends no prompt until Enter', async (t) => {
	const executablePath = browserPath();
	if (executablePath === null) return t.skip('No chromium available; run `npx playwright install chromium`');
	const root = await mkdtemp(join(tmpdir(), 'guey-browser-upload-busy-'));
	const runtime = scriptedRuntime(root);
	runtime.data.busy = true;
	const app = await createGueyServer({ port: 0, host: '127.0.0.1', stateDir: join(root, 'state'), runtime, product: 'imperfect' });
	const address = await app.listen();
	const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
	const page = await browser.newPage();
	try {
		await openPersonalComposer(page, address);
		const pdf = Buffer.from('%PDF-1.4 any type');
		await page.setInputFiles('#entry-files', { name: 'receipt.pdf', mimeType: 'application/pdf', buffer: pdf });
		await page.waitForSelector('.entry-pending-chip:not(.is-uploading)');
		await new Promise(r => setTimeout(r, 80));
		assert.equal(runtime.sent.filter(c => c.type === 'prompt').length, 0);
		await page.press('#entry-input', 'Enter');
		const sent = await waitForCommand(runtime, c => c.type === 'prompt');
		assert.equal(sent.behavior, 'steer');
		assert.match(sent.text, /\[uploaded file: .+receipt-[0-9a-f-]+\.pdf\]/);
		assert.equal(sent.images, undefined);
		assert.equal(sent.files, undefined);
		const saved = sent.text.match(/\[uploaded file: (.+)\]/)[1];
		assert.equal(await readFile(saved, 'utf8'), '%PDF-1.4 any type');
	} finally {
		await browser.close(); await app.close(); await rm(root, { recursive: true, force: true });
	}
});

test('imperfect upload chip shows a percentage while bytes are in flight', async (t) => {
	const executablePath = browserPath();
	if (executablePath === null) return t.skip('No chromium available; run `npx playwright install chromium`');
	const root = await mkdtemp(join(tmpdir(), 'guey-browser-upload-progress-'));
	const runtime = scriptedRuntime(root);
	const app = await createGueyServer({ port: 0, host: '127.0.0.1', stateDir: join(root, 'state'), runtime, product: 'imperfect' });
	const address = await app.listen();
	const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
	const page = await browser.newPage();
	try {
		await openPersonalComposer(page, address);
		const session = await page.context().newCDPSession(page);
		await session.send('Network.emulateNetworkConditions', {
			offline: false,
			latency: 20,
			downloadThroughput: 50_000,
			uploadThroughput: 8_000,
			connectionType: 'cellular2g',
		});
		const blob = Buffer.alloc(48_000, 7);
		const pending = page.waitForFunction(() => {
			const label = document.querySelector('.entry-pending-progress')?.textContent || '';
			return /\d+%/.test(label);
		}, null, { timeout: 8000 });
		await page.setInputFiles('#entry-files', { name: 'chunk.bin', mimeType: 'application/octet-stream', buffer: blob });
		await pending;
		await page.waitForSelector('.entry-pending-chip:not(.is-uploading)');
		assert.equal(runtime.sent.filter(c => c.type === 'prompt').length, 0);
	} finally {
		await browser.close(); await app.close(); await rm(root, { recursive: true, force: true });
	}
});

test('steering and follow-up queues show in the editor chrome', async (t) => {
	const executablePath = browserPath();
	if (executablePath === null) return t.skip('No chromium available; run `npx playwright install chromium`');
	const root = await mkdtemp(join(tmpdir(), 'guey-browser-queue-'));
	const runtime = scriptedRuntime(root);
	const app = await createGueyServer({ port: 0, host: '127.0.0.1', stateDir: join(root, 'store'), runtime });
	const address = await app.listen();
	const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
	const page = await browser.newPage();
	try {
		await page.goto(`http://127.0.0.1:${address.port}`);
		await page.waitForFunction(() => (document.getElementById('entry-pi-label')?.textContent || '').includes('fixture-model'));
		await page.keyboard.press('Alt+y');
		await page.waitForFunction(() => document.getElementById('terminal-entry').classList.contains('open'));
		runtime.data.busy = true; runtime.data.operation = 'working'; runtime.data.thinkingLevel = 'medium'; runtime.events.emit('change');
		await page.waitForSelector('#entry-input-zone.working');
		assert.equal(await page.locator('#entry-live').count(), 0);
		assert.match(await page.textContent('#entry-work'), /fixture-model/);
		assert.match(await page.textContent('#entry-work'), /medium/i);
		assert.match(await page.textContent('#entry-work'), /8%\/1\.0k/i);
		assert.doesNotMatch(await page.textContent('#entry-work'), /Working/);
		const nameplate = await page.evaluate(() => {
			const zone = document.getElementById('entry-input-zone').getBoundingClientRect();
			const work = document.getElementById('entry-work').getBoundingClientRect();
			const label = document.getElementById('entry-pi-label').getBoundingClientRect();
			const thinking = document.getElementById('entry-thinking').getBoundingClientRect();
			const ctx = document.getElementById('entry-context').getBoundingClientRect();
			const leftOf = thinking.width ? thinking.right : label.right;
			return {
				leftStub: Math.round(label.left - work.left),
				rightStub: Math.round(work.right - ctx.right),
				middle: Math.round(ctx.left - leftOf),
				workWidth: Math.round(work.width),
				zoneWidth: Math.round(zone.width),
			};
		});
		assert.ok(nameplate.leftStub > 0, nameplate);
		assert.equal(nameplate.rightStub, nameplate.leftStub);
		assert.equal(nameplate.workWidth, nameplate.zoneWidth);
		assert.ok(nameplate.middle > nameplate.leftStub * 2, nameplate);
		runtime.data.operation = 'compacting';
		runtime.events.emit('change');
		await page.waitForSelector('#entry-work:has-text("Compacting context")');
		assert.match(await page.textContent('#entry-work'), /escape to cancel/);
		assert.doesNotMatch(await page.textContent('#entry-work'), /Working/);
		runtime.data.operation = 'working';
		runtime.events.emit('change');
		await page.waitForFunction(() => (document.querySelector('#entry-work')?.textContent || '').includes('fixture-model'));
		await page.fill('#entry-input', 'steer this way');
		await page.press('#entry-input', 'Enter');
		await page.waitForSelector('#entry-output .entry-queue-line:has-text("Steering: steer this way")');
		const steered = runtime.sent.find(c => c.type === 'prompt' && c.behavior === 'steer');
		assert.equal(steered.text, 'steer this way');
		await page.fill('#entry-input', 'after you finish');
		await page.locator('#entry-input').focus();
		await page.keyboard.press('Alt+Enter');
		await page.waitForSelector('.entry-queue-line:has-text("Follow-up: after you finish")');
		await page.waitForSelector('.entry-queue-hint:has-text("Alt+Up")');
		const follow = runtime.sent.find(c => c.type === 'prompt' && c.behavior === 'followUp');
		assert.equal(follow.text, 'after you finish');
		await page.keyboard.press('Alt+ArrowUp');
		await page.waitForFunction(() => document.getElementById('entry-queue')?.hidden);
		assert.match(await page.inputValue('#entry-input'), /steer this way/);
		assert.match(await page.inputValue('#entry-input'), /after you finish/);
	} finally {
		await browser.close(); await app.close(); await rm(root, { recursive: true, force: true });
	}
});

test('/guey-reload reloads the page instead of prompting', async (t) => {
	const executablePath = browserPath();
	if (executablePath === null) return t.skip('No chromium available; run `npx playwright install chromium`');
	const root = await mkdtemp(join(tmpdir(), 'guey-browser-guey-reload-'));
	const runtime = scriptedRuntime(root);
	const app = await createGueyServer({ port: 0, host: '127.0.0.1', stateDir: join(root, 'store'), runtime });
	const address = await app.listen();
	const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
	const page = await browser.newPage();
	try {
		await page.goto(`http://127.0.0.1:${address.port}`);
		await page.waitForFunction(() => (document.getElementById('entry-pi-label')?.textContent || '').includes('fixture-model'));
		await page.keyboard.press('Alt+y');
		await page.waitForFunction(() => document.getElementById('terminal-entry').classList.contains('open'));
		const cache = await page.evaluate(async () => (await fetch('/js/harness.js')).headers.get('cache-control'));
		assert.equal(cache, 'no-store');
		await page.fill('#entry-input', '/guey-reload');
		await Promise.all([
			page.waitForLoadState('load'),
			page.press('#entry-input', 'Enter'),
		]);
		assert.equal(runtime.sent.some(c => c.type === 'prompt' && String(c.text ?? '').includes('guey-reload')), false);
		await page.waitForFunction(() => (document.getElementById('entry-pi-label')?.textContent || '').includes('fixture-model'));
	} finally {
		await browser.close(); await app.close(); await rm(root, { recursive: true, force: true });
	}
});

test('/tab opens the tabs window and can start a new one', async (t) => {
	const executablePath = browserPath();
	if (executablePath === null) return t.skip('No chromium available; run `npx playwright install chromium`');
	const root = await mkdtemp(join(tmpdir(), 'guey-browser-sessions-'));
	const runtime = scriptedRuntime(root);
	const app = await createGueyServer({ port: 0, host: '127.0.0.1', stateDir: join(root, 'store'), runtime });
	const address = await app.listen();
	const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
	const page = await browser.newPage();
	try {
		await page.goto(`http://127.0.0.1:${address.port}`);
		await page.waitForFunction(() => (document.getElementById('entry-pi-label')?.textContent || '').includes('fixture-model'));
		await page.keyboard.press('Alt+y');
		await page.waitForFunction(() => document.getElementById('terminal-entry').classList.contains('open'));
		await page.waitForSelector('#session-rail', { state: 'attached' });
		await page.fill('#entry-input', '/tab');
		await page.press('#entry-input', 'Enter');
		await page.waitForFunction(() => document.getElementById('session-rail')?.classList.contains('open'));
		const rail = await page.textContent('#session-rail');
		assert.match(rail, /tabs/);
		assert.match(rail, /browser/);
		assert.match(rail, /idle/);
		await page.click('.session-rail-new');
		await waitForCommand(runtime, c => c.type === 'new' || c.type === 'tab-new');
		await page.waitForFunction(() => !document.getElementById('session-rail')?.classList.contains('open'));
	} finally {
		await browser.close(); await app.close(); await rm(root, { recursive: true, force: true });
	}
});

test('+ new opens a blank session and the previous tab keeps its transcript', async (t) => {
	const executablePath = browserPath();
	if (executablePath === null) return t.skip('No chromium available; run `npx playwright install chromium`');
	const root = await mkdtemp(join(tmpdir(), 'guey-browser-tab-new-enter-'));
	const runtime = scriptedRuntime(root);
	runtime.data.messages = [{ role: 'user', content: 'stay on the first tab' }];
	runtime.data.tabs = [{ id: 't1', sessionId: runtime.data.sessionId, name: 'stay on the first tab', busy: false, focused: true, messages: runtime.data.messages }];
	const app = await createGueyServer({ port: 0, host: '127.0.0.1', stateDir: join(root, 'store'), runtime });
	const address = await app.listen();
	const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
	const page = await browser.newPage();
	try {
		await page.goto(`http://127.0.0.1:${address.port}`);
		await page.waitForFunction(() => (document.getElementById('entry-pi-label')?.textContent || '').includes('fixture-model'));
		await page.keyboard.press('Alt+y');
		await page.waitForFunction(() => document.getElementById('terminal-entry').classList.contains('open'));
		await page.waitForFunction(() => (document.getElementById('entry-output')?.textContent || '').includes('stay on the first tab'));
		await page.fill('#entry-input', '/tab');
		await page.press('#entry-input', 'Enter');
		await page.waitForFunction(() => document.getElementById('session-rail')?.classList.contains('open'));
		await page.click('.session-rail-new');
		await page.waitForFunction(() => !document.getElementById('session-rail')?.classList.contains('open'));
		await page.waitForFunction(() => !(document.getElementById('entry-output')?.textContent || '').includes('stay on the first tab'));
		await page.fill('#entry-input', '/tab');
		await page.press('#entry-input', 'Enter');
		await page.waitForFunction(() => document.getElementById('session-rail')?.classList.contains('open'));
		await page.click('[data-tab-id="t1"] .session-rail-open');
		await page.waitForFunction(() => !document.getElementById('session-rail')?.classList.contains('open'));
		await page.waitForFunction(() => (document.getElementById('entry-output')?.textContent || '').includes('stay on the first tab'));
	} finally {
		await browser.close(); await app.close(); await rm(root, { recursive: true, force: true });
	}
});

test('/tab titles use the first prompt and X closes a tab, not the last one', async (t) => {
	const executablePath = browserPath();
	if (executablePath === null) return t.skip('No chromium available; run `npx playwright install chromium`');
	const root = await mkdtemp(join(tmpdir(), 'guey-browser-tab-close-'));
	const runtime = scriptedRuntime(root);
	const id = '01a08407-3233-719e-a1a9-50feac8cee82';
	runtime.data.sessionId = id;
	runtime.data.name = id;
	runtime.data.messages = [{ role: 'user', content: 'name this tab from the first prompt' }];
	runtime.data.tabs = [
		{ id: 't1', sessionId: id, name: id, busy: false, focused: true },
		{ id: 't2', sessionId: 'other', name: 'other', busy: false, focused: false },
	];
	const app = await createGueyServer({ port: 0, host: '127.0.0.1', stateDir: join(root, 'store'), runtime });
	const address = await app.listen();
	const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
	const page = await browser.newPage();
	try {
		await page.goto(`http://127.0.0.1:${address.port}`);
		await page.waitForFunction(() => (document.getElementById('entry-pi-label')?.textContent || '').includes('fixture-model'));
		await page.keyboard.press('Alt+y');
		await page.waitForFunction(() => document.getElementById('terminal-entry').classList.contains('open'));
		await page.fill('#entry-input', '/tab');
		await page.press('#entry-input', 'Enter');
		await page.waitForFunction(() => document.getElementById('session-rail')?.classList.contains('open'));
		const title = await page.textContent('[data-tab-id="t1"] .session-rail-title');
		assert.equal(title, 'name this tab from the first prompt');
		assert.equal(await page.locator('[data-tab-id="t1"] .session-rail-title').count(), 1);
		assert.equal(await page.locator('.session-rail-title', { hasText: id }).count(), 0);
		assert.equal(await page.locator('.session-rail-close').count(), 2);
		await page.click('[data-tab-id="t2"] .session-rail-close');
		await waitForCommand(runtime, c => c.type === 'tab-close' && c.tabId === 't2');
		await page.waitForFunction(() => document.querySelectorAll('#session-rail .session-rail-item').length === 1);
		assert.equal(await page.locator('.session-rail-close').count(), 1);
		assert.equal(await page.locator('.session-rail-close').getAttribute('disabled'), '');
		const before = runtime.sent.filter(c => c.type === 'tab-close').length;
		await page.click('[data-tab-id="t1"] .session-rail-close', { force: true });
		assert.equal(runtime.sent.filter(c => c.type === 'tab-close').length, before);
	} finally {
		await browser.close(); await app.close(); await rm(root, { recursive: true, force: true });
	}
});

test('choosing a tab closes the list immediately, even if focus is slow', async (t) => {
	const executablePath = browserPath();
	if (executablePath === null) return t.skip('No chromium available; run `npx playwright install chromium`');
	const root = await mkdtemp(join(tmpdir(), 'guey-browser-tab-lag-'));
	const runtime = scriptedRuntime(root);
	const orig = runtime.command.bind(runtime);
	runtime.command = async c => {
		if (c.type === 'tab-focus') await new Promise(r => setTimeout(r, 1500));
		return orig(c);
	};
	runtime.data.tabs = [
		{ id: 't1', sessionId: runtime.data.sessionId, name: 'first', busy: false, focused: true },
		{ id: 't2', sessionId: 't2', name: 'second', busy: false, focused: false },
	];
	const app = await createGueyServer({ port: 0, host: '127.0.0.1', stateDir: join(root, 'store'), runtime });
	const address = await app.listen();
	const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
	const page = await browser.newPage();
	try {
		await page.goto(`http://127.0.0.1:${address.port}`);
		await page.waitForFunction(() => (document.getElementById('entry-pi-label')?.textContent || '').includes('fixture-model'));
		await page.keyboard.press('Alt+y');
		await page.waitForFunction(() => document.getElementById('terminal-entry').classList.contains('open'));
		await page.fill('#entry-input', '/tab');
		await page.press('#entry-input', 'Enter');
		await page.waitForFunction(() => document.getElementById('session-rail')?.classList.contains('open'));
		const started = Date.now();
		await page.click('[data-tab-id="t2"] .session-rail-open');
		await page.waitForFunction(() => !document.getElementById('session-rail')?.classList.contains('open'));
		assert.ok(Date.now() - started < 800, 'the list must close without waiting for the session to load');
	} finally {
		await browser.close(); await app.close(); await rm(root, { recursive: true, force: true });
	}
});

test('arrow keys move through the tabs list; rows have no dividing lines', async (t) => {
	const executablePath = browserPath();
	if (executablePath === null) return t.skip('No chromium available; run `npx playwright install chromium`');
	const root = await mkdtemp(join(tmpdir(), 'guey-browser-tab-arrows-'));
	const runtime = scriptedRuntime(root);
	runtime.data.sessionId = 't1';
	runtime.data.name = 'first';
	runtime.data.tabs = [
		{ id: 't1', sessionId: 't1', name: 'first', busy: false, focused: true },
		{ id: 't2', sessionId: 't2', name: 'second', busy: false, focused: false, messages: [{ role: 'user', content: 'second' }] },
	];
	const app = await createGueyServer({ port: 0, host: '127.0.0.1', stateDir: join(root, 'store'), runtime });
	const address = await app.listen();
	const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
	const page = await browser.newPage();
	try {
		await page.goto(`http://127.0.0.1:${address.port}`);
		await page.waitForFunction(() => (document.getElementById('entry-pi-label')?.textContent || '').includes('fixture-model'));
		await page.keyboard.press('Alt+y');
		await page.waitForFunction(() => document.getElementById('terminal-entry').classList.contains('open'));
		await page.fill('#entry-input', '/tab');
		await page.press('#entry-input', 'Enter');
		await page.waitForFunction(() => document.getElementById('session-rail')?.classList.contains('open'));
		assert.equal(await page.locator('.session-rail-item').first().evaluate(n => getComputedStyle(n).borderBottomWidth), '0px');
		assert.equal(await page.locator('#entry-terminal').evaluate(n => getComputedStyle(n).borderBottomWidth), '1px');
		assert.equal(await page.locator('[data-tab-id="t1"].cursor').count(), 1);
		await page.locator('#entry-input').focus();
		await page.keyboard.press('ArrowDown');
		await page.waitForFunction(() => document.querySelector('[data-tab-id="t2"]')?.classList.contains('cursor'));
		const focused = waitForCommand(runtime, c => c.type === 'tab-focus');
		await page.keyboard.press('Enter');
		assert.equal((await focused).tabId, 't2');
	} finally {
		await browser.close(); await app.close(); await rm(root, { recursive: true, force: true });
	}
});

test('an unfocused tab titled new still shows its first prompt', async (t) => {
	const executablePath = browserPath();
	if (executablePath === null) return t.skip('No chromium available; run `npx playwright install chromium`');
	const root = await mkdtemp(join(tmpdir(), 'guey-browser-tab-unfocused-name-'));
	const runtime = scriptedRuntime(root);
	runtime.data.sessionId = 't1';
	runtime.data.name = 'Everytime I make an input into guey';
	runtime.data.tabs = [
		{ id: 't1', sessionId: 't1', name: 'Everytime I make an input into guey', busy: true, focused: true },
		{ id: 't2', sessionId: 't2', name: 'new', prompt: 'clicked new for this session', busy: false, focused: false },
	];
	const app = await createGueyServer({ port: 0, host: '127.0.0.1', stateDir: join(root, 'store'), runtime });
	const address = await app.listen();
	const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
	const page = await browser.newPage();
	try {
		await page.goto(`http://127.0.0.1:${address.port}`);
		await page.waitForFunction(() => (document.getElementById('entry-pi-label')?.textContent || '').includes('fixture-model'));
		await page.keyboard.press('Alt+y');
		await page.waitForFunction(() => document.getElementById('terminal-entry').classList.contains('open'));
		await page.fill('#entry-input', '/tab');
		await page.press('#entry-input', 'Enter');
		await page.waitForFunction(() => document.getElementById('session-rail')?.classList.contains('open'));
		assert.equal(await page.textContent('[data-tab-id="t2"] .session-rail-title'), 'clicked new for this session');
	} finally {
		await browser.close(); await app.close(); await rm(root, { recursive: true, force: true });
	}
});

test('arrow keys switch tabs without opening the list', async (t) => {
	const executablePath = browserPath();
	if (executablePath === null) return t.skip('No chromium available; run `npx playwright install chromium`');
	const root = await mkdtemp(join(tmpdir(), 'guey-browser-tab-cycle-'));
	const runtime = scriptedRuntime(root);
	runtime.data.sessionId = 't1';
	runtime.data.name = 'first';
	runtime.data.tabs = [
		{ id: 't1', sessionId: 't1', name: 'first', busy: false, focused: true },
		{ id: 't2', sessionId: 't2', name: 'second', busy: false, focused: false, messages: [{ role: 'user', content: 'second' }] },
	];
	const app = await createGueyServer({ port: 0, host: '127.0.0.1', stateDir: join(root, 'store'), runtime });
	const address = await app.listen();
	const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
	const page = await browser.newPage();
	try {
		await page.goto(`http://127.0.0.1:${address.port}`);
		await page.waitForFunction(() => (document.getElementById('entry-pi-label')?.textContent || '').includes('fixture-model'));
		await page.keyboard.press('Alt+y');
		await page.waitForFunction(() => document.getElementById('terminal-entry').classList.contains('open'));
		await page.locator('#entry-input').click();
		assert.equal(await page.evaluate(() => document.getElementById('session-rail')?.classList.contains('open')), false);
		const focused = waitForCommand(runtime, c => c.type === 'tab-focus');
		await page.keyboard.press('ArrowRight');
		assert.equal((await focused).tabId, 't2');
	} finally {
		await browser.close(); await app.close(); await rm(root, { recursive: true, force: true });
	}
});

test('a tab still named new takes its title from the first prompt', async (t) => {
	const executablePath = browserPath();
	if (executablePath === null) return t.skip('No chromium available; run `npx playwright install chromium`');
	const root = await mkdtemp(join(tmpdir(), 'guey-browser-tab-new-name-'));
	const runtime = scriptedRuntime(root);
	runtime.data.sessionId = 't2';
	runtime.data.name = 'new';
	runtime.data.messages = [{ role: 'user', content: 'clicked new for this session' }];
	runtime.data.tabs = [
		{ id: 't1', sessionId: 't1', name: 'Everytime I make an input into guey', busy: true, focused: false },
		{ id: 't2', sessionId: 't2', name: 'new', busy: true, focused: true },
	];
	const app = await createGueyServer({ port: 0, host: '127.0.0.1', stateDir: join(root, 'store'), runtime });
	const address = await app.listen();
	const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
	const page = await browser.newPage();
	try {
		await page.goto(`http://127.0.0.1:${address.port}`);
		await page.waitForFunction(() => (document.getElementById('entry-pi-label')?.textContent || '').includes('fixture-model'));
		await page.keyboard.press('Alt+y');
		await page.waitForFunction(() => document.getElementById('terminal-entry').classList.contains('open'));
		await page.fill('#entry-input', '/tab');
		await page.press('#entry-input', 'Enter');
		await page.waitForFunction(() => document.getElementById('session-rail')?.classList.contains('open'));
		assert.equal(await page.textContent('[data-tab-id="t2"] .session-rail-title'), 'clicked new for this session');
		assert.equal(await page.locator('.session-rail-title', { hasText: /^new$/ }).count(), 0);
	} finally {
		await browser.close(); await app.close(); await rm(root, { recursive: true, force: true });
	}
});

test('compaction summary is the TUI completed box, expandable', async (t) => {
	const executablePath = browserPath();
	if (executablePath === null) return t.skip('No chromium available; run `npx playwright install chromium`');
	const root = await mkdtemp(join(tmpdir(), 'guey-browser-compact-'));
	const runtime = scriptedRuntime(root);
	const app = await createGueyServer({ port: 0, host: '127.0.0.1', stateDir: join(root, 'store'), runtime });
	const address = await app.listen();
	const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
	const page = await browser.newPage();
	try {
		await page.goto(`http://127.0.0.1:${address.port}`);
		await page.waitForFunction(() => (document.getElementById('entry-pi-label')?.textContent || '').includes('fixture-model'));
		await page.keyboard.press('Alt+y');
		await page.waitForFunction(() => document.getElementById('terminal-entry').classList.contains('open'));
		runtime.data.messages = [
			{ role: 'compactionSummary', tokensBefore: 250983, summary: 'Kept the session rail and garden charcoal.' },
			{ role: 'user', content: 'hello' },
		];
		runtime.events.emit('change');
		await page.waitForFunction(() => (document.querySelector('.entry-compaction')?.textContent || '').includes('[compaction]'));
		const collapsed = await page.textContent('.entry-compaction');
		assert.match(collapsed, /Compacted from 250[,\u00a0]?983 tokens/);
		assert.match(collapsed, /ctrl\+o to expand/);
		assert.equal(collapsed.includes('session rail'), false);
		await page.evaluate(() => document.querySelector('.entry-compaction-label')?.click());
		await page.waitForFunction(() => (document.querySelector('.entry-compaction')?.textContent || '').includes('session rail'));
	} finally {
		await browser.close(); await app.close(); await rm(root, { recursive: true, force: true });
	}
});

test('theme picker arrows preview without saving, escape restores', async (t) => {
	const executablePath = browserPath();
	if (executablePath === null) return t.skip('No chromium available; run `npx playwright install chromium`');
	const root = await mkdtemp(join(tmpdir(), 'guey-browser-theme-'));
	const agent = join(root, 'agent');
	await mkdir(join(agent, 'themes'), { recursive: true });
	await writeFile(join(agent, 'settings.json'), JSON.stringify({ theme: 'dark' }));
	const runtime = scriptedRuntime(root);
	const app = await createGueyServer({ port: 0, host: '127.0.0.1', stateDir: join(root, 'store'), runtime, agentDir: agent });
	const address = await app.listen();
	const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
	const page = await browser.newPage();
	try {
		await page.goto(`http://127.0.0.1:${address.port}`);
		await page.waitForFunction(() => (document.getElementById('entry-pi-label')?.textContent || '').includes('fixture-model'));
		await page.keyboard.press('Alt+y');
		await page.waitForFunction(() => document.getElementById('terminal-entry').classList.contains('open'));
		await page.fill('#entry-input', '/theme');
		await page.press('#entry-input', 'Enter');
		await page.waitForSelector('#entry-dialog:not([hidden]) .entry-dialog-option');
		await page.keyboard.press('ArrowDown');
		await page.waitForFunction(async () => (await (await fetch('/theme.css')).text()).includes('#f27722'));
		assert.equal(JSON.parse(await readFile(join(agent, 'settings.json'), 'utf8')).theme, 'dark');
		await page.keyboard.press('Escape');
		await page.waitForFunction(async () => !(await (await fetch('/theme.css')).text()).includes('#f27722'));
		assert.equal(JSON.parse(await readFile(join(agent, 'settings.json'), 'utf8')).theme, 'dark');
	} finally {
		await browser.close(); await app.close(); await rm(root, { recursive: true, force: true });
	}
});

test('stock Guey is a full-window Pi shell without personal controls; imperfect keeps them', async (t) => {
	const executablePath = browserPath();
	if (executablePath === null) return t.skip('No chromium available; run `npx playwright install chromium`');
	const root = await mkdtemp(join(tmpdir(), 'guey-product-browser-'));
	const runtime = scriptedRuntime(root);
	const stock = await createGueyServer({ port: 0, host: '127.0.0.1', stateDir: join(root, 'stock'), runtime, product: 'stock' });
	const personal = await createGueyServer({ port: 0, host: '127.0.0.1', stateDir: join(root, 'personal'), runtime, product: 'imperfect' });
	const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
	try {
		const sAddr = await stock.listen();
		const pAddr = await personal.listen();
		const stockPage = await browser.newPage();
		const personalPage = await browser.newPage();
		await personalPage.goto(`http://127.0.0.1:${pAddr.port}`);
		await personalPage.waitForSelector('#harness-reach');
		assert.equal(await personalPage.locator('#entry-files').count(), 1);
		assert.equal(await personalPage.locator('#harness-reach').count(), 1);
		assert.equal(await personalPage.locator('#grid-keys').count(), 0);
		assert.equal(await personalPage.evaluate(() => document.getElementById('terminal-entry').classList.contains('open')), false);
		await personalPage.mouse.move(200, 8);
		await personalPage.mouse.down();
		await personalPage.mouse.move(200, 140, { steps: 8 });
		await personalPage.mouse.up();
		await personalPage.waitForFunction(() => document.getElementById('terminal-entry').classList.contains('open'));
		assert.equal(await personalPage.evaluate(() => {
			const h = document.getElementById('entry-terminal').getBoundingClientRect().height;
			return Math.abs(h - innerHeight * 0.5) < 4;
		}), true, 'harness should be half the viewport');
		await personalPage.locator('.drop-handle').hover();
		await personalPage.mouse.down();
		const handle = await personalPage.locator('.drop-handle').boundingBox();
		await personalPage.mouse.move(handle.x + handle.width / 2, handle.y - 90, { steps: 10 });
		await personalPage.mouse.up();
		await personalPage.waitForFunction(() => !document.getElementById('terminal-entry').classList.contains('open'));

		async function assertStockFills(page, size) {
			await page.setViewportSize(size);
			await page.goto(`http://127.0.0.1:${sAddr.port}`);
			await page.waitForFunction(() => (document.getElementById('entry-pi-label')?.textContent || '').includes('fixture-model'));
			await page.waitForSelector('.entry-startup');
			assert.match(await page.textContent('.entry-startup'), /pi v0\.85\.0/);
			const g = await page.evaluate(() => {
				const term = document.getElementById('entry-terminal');
				const status = document.querySelector('.entry-status');
				const out = document.getElementById('entry-output');
				const tr = term.getBoundingClientRect();
				const sr = status.getBoundingClientRect();
				const or = out.getBoundingClientRect();
				const model = getComputedStyle(document.getElementById('entry-pi-label'));
				return {
					vh: innerHeight, vw: innerWidth,
					termH: tr.height, termW: tr.width, termTop: tr.top,
					statusBottom: sr.bottom, outH: or.height,
					modelBorder: model.borderStyle,
				};
			});
			assert.equal(await page.locator('#entry-files').count(), 0);
			assert.equal(await page.locator('#harness-reach').count(), 0);
			assert.equal(await page.locator('#grid-keys').count(), 0);
			assert.ok(g.termTop === 0 && g.termH >= g.vh - 2, `stock terminal ${g.termH}px of ${g.vh}px at ${size.width}x${size.height}`);
			assert.ok(g.statusBottom >= g.vh - 4, `status ${g.statusBottom} not at bottom of ${g.vh}`);
			assert.ok(g.outH > g.vh * 0.4, `transcript ${g.outH} too short for ${g.vh}`);
			assert.equal(g.modelBorder, 'none');
			return g;
		}
		await assertStockFills(stockPage, { width: 1280, height: 800 });
		await assertStockFills(stockPage, { width: 390, height: 844 });
		await stockPage.fill('#entry-input', 'stock hello');
		await stockPage.press('#entry-input', 'Enter');
		await stockPage.waitForSelector('.entry-line.user:has-text("stock hello")');
		const userBox = await stockPage.locator('.entry-line.user').evaluate(n => {
			const s = getComputedStyle(n);
			return { pad: parseFloat(s.paddingLeft), margin: s.marginLeft };
		});
		assert.ok(userBox.pad >= 6, `user box padding ${userBox.pad}`);
		assert.equal(userBox.margin, '0px');

		runtime.data.partial = { role: 'assistant', content: [{ type: 'thinking', thinking: '**weighing it**' }, { type: 'text', text: 'partial ans' }] };
		runtime.data.runningTools = [{ toolCallId: 't1', toolName: 'bash', args: { command: 'ls /tmp' }, result: { content: [{ type: 'text', text: Array.from({ length: 12 }, (_, i) => `line${i}`).join('\n') }] } }];
		runtime.data.busy = true; runtime.data.operation = 'working';
		runtime.events.emit('change');
		await stockPage.waitForSelector('.entry-line.thinking');
		await stockPage.waitForSelector('#entry-work:has-text("Working")');
		assert.equal(await stockPage.locator('#entry-output .entry-thinking').count(), 0);
		assert.equal(await stockPage.locator('#entry-output .entry-tool.question').count(), 0);
		assert.equal(await stockPage.locator('.entry-line.thinking:has-text("**")').count(), 0);
		assert.match(await stockPage.textContent('.entry-line.thinking'), /weighing it/);
		const thinkStyle = await stockPage.locator('.entry-line.thinking').evaluate(n => getComputedStyle(n).fontStyle);
		assert.equal(thinkStyle, 'italic');
		await stockPage.waitForSelector('.entry-tool.pending .entry-tool-output');
		assert.equal(await stockPage.isVisible('.entry-tool.pending .entry-tool-output'), true);
		assert.match(await stockPage.textContent('.entry-tool.pending .entry-tool-cmd'), /\$ ls \/tmp/);
		assert.match(await stockPage.textContent('.entry-tool.pending .entry-tool-output'), /earlier lines/);
		assert.equal(await stockPage.locator('#entry-output .entry-tool').count(), 1);
		assert.equal(await stockPage.locator('.entry-tool.pending[data-tool-id="t1"]').count(), 1);
		assert.doesNotMatch(await stockPage.textContent('.entry-tool.pending .entry-tool-title'), /↳|✓|✕/);

		runtime.data.partial = { role: 'assistant', content: [{ type: 'toolCall', id: 't1', name: 'bash', arguments: { command: 'ls /tmp' } }] };
		runtime.events.emit('change');
		await stockPage.waitForSelector('.entry-tool.pending[data-tool-id="t1"]');
		assert.equal(await stockPage.locator('#entry-output .entry-tool').count(), 1, 'running + toolCall must stay one display');

		runtime.data.partial = null; runtime.data.runningTools = [];
		runtime.data.messages.push(
			{ role: 'assistant', content: [{ type: 'thinking', thinking: '**done**' }, { type: 'toolCall', id: 't1', name: 'bash', arguments: { command: 'ls /tmp', timeout: 15 } }] },
			{ role: 'toolResult', toolCallId: 't1', toolName: 'bash', content: Array.from({ length: 12 }, (_, i) => `line${i}`).join('\n'), isError: false, details: { durationMs: 2600 } },
		);
		runtime.data.busy = false; runtime.events.emit('change');
		await stockPage.waitForSelector('.entry-tool.ok .entry-tool-output');
		assert.equal(await stockPage.isVisible('.entry-tool.ok .entry-tool-output'), true);
		assert.match(await stockPage.textContent('.entry-tool.ok .entry-tool-cmd'), /\$ ls \/tmp/);
		assert.match(await stockPage.textContent('.entry-tool.ok .entry-tool-timeout'), /timeout 15s/);
		assert.match(await stockPage.textContent('.entry-tool.ok .entry-tool-meta'), /Took 2\.6s/);
		assert.equal(await stockPage.locator('#entry-output .entry-tool').count(), 1);
		assert.equal(await stockPage.locator('#entry-output .entry-tool.question').count(), 0);
		const cmdWeight = await stockPage.locator('.entry-tool.ok .entry-tool-cmd strong').evaluate(n => getComputedStyle(n).fontWeight);
		assert.ok(Number(cmdWeight) >= 600, `toolTitle should be bold, got ${cmdWeight}`);
		const outColor = await stockPage.locator('.entry-tool.ok .entry-tool-output').evaluate(n => getComputedStyle(n).color);
		assert.ok(outColor);

		const collapsed = await stockPage.textContent('.entry-tool.ok .entry-tool-output');
		assert.match(collapsed, /ctrl\+o to expand/);
		const toolBg = await stockPage.locator('.entry-tool.ok[data-tool-id="t1"]').evaluate(n => getComputedStyle(n).backgroundColor);
		assert.notEqual(toolBg, 'rgba(0, 0, 0, 0)');
		assert.match(await stockPage.textContent('#entry-spend'), /8\.0%\/1\.0k/);
		assert.doesNotMatch(await stockPage.textContent('.entry-status'), /watching pid|reconnecting/);
		assert.match(await stockPage.textContent('#entry-pi-label'), /fixture-model/);
		await stockPage.click('.entry-tool.ok .entry-tool-title');
		assert.match(await stockPage.textContent('.entry-tool.ok .entry-tool-output'), /line0/);
		assert.doesNotMatch(await stockPage.textContent('.entry-tool.ok .entry-tool-output'), /\+ to expand/);

		runtime.data.messages.push(
			{ role: 'assistant', content: [{ type: 'toolCall', id: 't-err', name: 'bash', arguments: { command: 'false' } }] },
			{ role: 'toolResult', toolCallId: 't-err', toolName: 'bash', content: 'boom', isError: true },
		);
		runtime.events.emit('change');
		await stockPage.waitForSelector('.entry-tool.error[data-tool-id="t-err"]');
		assert.match(await stockPage.textContent('.entry-tool.error .entry-tool-output'), /boom/);

		runtime.data.messages.push(
			{ role: 'assistant', content: [{ type: 'text', text: 'see `settings-io` and `` `code` `` and `read` now' }, { type: 'toolCall', id: 't-read', name: 'read', arguments: { path: '/tmp/foo.js' } }] },
			{ role: 'toolResult', toolCallId: 't-read', toolName: 'read', content: 'file body', isError: false },
			{ role: 'toolResult', toolCallId: 'orphan-1', toolName: 'read', content: 'orphan body', isError: false },
		);
		runtime.events.emit('change');
		await stockPage.waitForSelector('.entry-line.assistant code:has-text("settings-io")');
		const codeTexts = await stockPage.locator('.entry-line.assistant code').allTextContents();
		assert.deepEqual(codeTexts, ['settings-io', '`code`', 'read']);
		const codeColor = await stockPage.locator('.entry-line.assistant code').first().evaluate(n => getComputedStyle(n).color);
		const mdCode = await stockPage.evaluate(() => {
			const probe = document.createElement('span');
			probe.style.color = getComputedStyle(document.documentElement).getPropertyValue('--tui-mdCode').trim();
			document.body.append(probe);
			const color = getComputedStyle(probe).color;
			probe.remove();
			return color;
		});
		assert.equal(codeColor, mdCode);
		await stockPage.waitForSelector('.entry-tool[data-tool-id="t-read"] .entry-tool-path');
		assert.match(await stockPage.textContent('.entry-tool[data-tool-id="t-read"] .entry-tool-path'), /\/tmp\/foo\.js/);
		const pathColor = await stockPage.locator('.entry-tool[data-tool-id="t-read"] .entry-tool-path').evaluate(n => getComputedStyle(n).color);
		const accent = await stockPage.evaluate(() => {
			const probe = document.createElement('span');
			probe.style.color = getComputedStyle(document.documentElement).getPropertyValue('--tui-accent').trim();
			document.body.append(probe);
			const color = getComputedStyle(probe).color;
			probe.remove();
			return color;
		});
		assert.equal(pathColor, accent);
		await stockPage.waitForSelector('.entry-tool[data-tool-id="orphan-1"]');
		assert.equal(await stockPage.locator('.entry-tool[data-tool-id="orphan-1"]').count(), 1);
		assert.equal(await stockPage.locator('.entry-tool[data-tool-id="t1"]').count(), 1);
		assert.equal(await stockPage.locator('.entry-tool[data-tool-id="t-err"]').count(), 1);

		const titleBorder = await stockPage.locator('.entry-tool-title').first().evaluate(n => getComputedStyle(n).borderStyle);
		assert.equal(titleBorder, 'none');
		const toolBorder = await stockPage.locator('.entry-tool.ok[data-tool-id="t1"]').evaluate(n => getComputedStyle(n).borderStyle);
		assert.equal(toolBorder, 'none');

		runtime.data.busy = true; runtime.data.operation = 'compacting';
		runtime.events.emit('change');
		await stockPage.waitForSelector('#entry-work:has-text("Compacting context")');
		assert.match(await stockPage.textContent('#entry-work'), /escape to cancel/);
		runtime.data.busy = false; runtime.data.operation = null;
		runtime.events.emit('change');

		await stockPage.fill('#entry-input', '/');
		await stockPage.waitForSelector('#slash-menu:not([hidden]) .slash-item');
		const slashNames = await stockPage.locator('.slash-name').allTextContents();
		assert.deepEqual(slashNames, ['settings', 'model', 'tree', 'thinking', 'scoped-models']);
		assert.match(await stockPage.textContent('#slash-menu'), /Open settings menu/);
		assert.match(await stockPage.textContent('.slash-count'), /^\(1\/\d+\)$/);
		for (let i = 0; i < 5; i++) await stockPage.keyboard.press('ArrowDown');
		const scrolled = await stockPage.locator('.slash-name').allTextContents();
		assert.equal(scrolled.includes('settings'), false);
		assert.ok(scrolled.includes('export') || scrolled.includes('copy'), scrolled.join(','));
		assert.match(await stockPage.textContent('.slash-count'), /^\(6\/\d+\)$/);
		const slashBg = await stockPage.locator('.slash-item.active').evaluate(n => getComputedStyle(n).backgroundColor);
		assert.equal(slashBg, 'rgba(0, 0, 0, 0)');
		const slashParent = await stockPage.locator('#slash-menu').evaluate(n => n.parentElement?.id);
		assert.notEqual(slashParent, 'entry-input-zone');
		const zoneH = await stockPage.locator('#entry-input-zone').evaluate(n => n.getBoundingClientRect().height);
		assert.ok(zoneH >= 18 && zoneH < 90, `input zone ${zoneH} should match TUI editor, not swallow the list`);
		await stockPage.fill('#entry-input', '/settings');
		await stockPage.press('#entry-input', 'Enter');
		await stockPage.waitForSelector('#entry-dialog.tui-settings .tui-setting:has-text("Auto-compact")');
		const settingLabels = await stockPage.locator('.tui-setting-label').allTextContents();
		assert.deepEqual(settingLabels.slice(0, 5), ['Auto-compact', 'Auto-resize images', 'Block images', 'Skill commands', 'Show hardware cursor']);
		assert.match(await stockPage.textContent('.tui-setting-desc'), /Automatically compact context/);
		assert.match(await stockPage.textContent('#entry-dialog'), /Type to search/);
		assert.match(await stockPage.textContent('.slash-count'), /\(1\/\d+\)/);
		const inputShown = await stockPage.locator('#entry-input-zone').evaluate(n => getComputedStyle(n).display !== 'none');
		assert.equal(inputShown, true);
		await stockPage.locator('#entry-dialog').focus();
		await stockPage.keyboard.type('theme');
		await stockPage.waitForSelector('.tui-setting-label:has-text("Theme")');
		await stockPage.keyboard.press('Enter');
		await stockPage.waitForSelector('.tui-setting-heading:has-text("Theme")');
		assert.match(await stockPage.textContent('#entry-dialog'), /Automatic/);
		await stockPage.keyboard.press('Escape');
		await stockPage.waitForSelector('.tui-setting-label:has-text("Theme")');
		assert.notEqual(2, 1);
	} finally {
		await browser.close(); await stock.close(); await personal.close(); await rm(root, { recursive: true, force: true });
	}
});

const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function pastePng(page) {
	await page.evaluate(b64 => {
		const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
		const a = new File([bytes], 'shot.png', { type: 'image/png' });
		const b = new File([bytes], 'shot.png', { type: 'image/png' });
		const bag = {
			files: [a],
			items: [{ kind: 'file', type: 'image/png', getAsFile: () => b }],
		};
		const event = new Event('paste', { bubbles: true, cancelable: true });
		Object.defineProperty(event, 'clipboardData', { value: bag });
		document.getElementById('entry-input').focus();
		document.getElementById('entry-input').dispatchEvent(event);
	}, TINY_PNG);
}

test('clipboard image paste attaches; imperfect composer grows with lines', async (t) => {
	const executablePath = browserPath();
	if (executablePath === null) return t.skip('No chromium available; run `npx playwright install chromium`');
	const root = await mkdtemp(join(tmpdir(), 'guey-browser-paste-'));
	const runtime = scriptedRuntime(root);
	const personal = await createGueyServer({ port: 0, host: '127.0.0.1', stateDir: join(root, 'personal'), runtime, product: 'imperfect' });
	const stock = await createGueyServer({ port: 0, host: '127.0.0.1', stateDir: join(root, 'stock'), runtime, product: 'stock' });
	const pAddr = await personal.listen();
	const sAddr = await stock.listen();
	const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
	const page = await browser.newPage();
	try {
		await page.goto(`http://127.0.0.1:${pAddr.port}`);
		await page.waitForFunction(() => (document.getElementById('entry-pi-label')?.textContent || '').includes('fixture-model'));
		await page.keyboard.press('Alt+y');
		await page.waitForFunction(() => document.getElementById('terminal-entry').classList.contains('open'));
		await page.locator('#entry-input').focus();
		await pastePng(page);
		await page.waitForSelector('#entry-pending:not([hidden]) .entry-pending-chip');
		assert.equal(await page.locator('.entry-pending-chip').count(), 1);
		await page.waitForFunction(() => !document.querySelector('.entry-pending-chip')?.classList.contains('is-uploading'));
		const caret = await page.evaluate(() => {
			const zone = document.getElementById('entry-input-zone').getBoundingClientRect();
			const field = document.getElementById('entry-input').getBoundingClientRect();
			return Math.abs((field.top + field.height / 2) - (zone.top + zone.height / 2));
		});
		assert.ok(caret < 14, `caret offset from bar center ${caret}px`);
		await page.press('#entry-input', 'Enter');
		const imagePrompt = await waitForCommand(runtime, c => c.type === 'prompt');
		assert.match(imagePrompt.text, /\[uploaded file: .+shot-[0-9a-f-]+\.png\]/);
		assert.equal(imagePrompt.images, undefined);

		await page.fill('#entry-input', 'one\ntwo\nthree\nfour\nfive');
		const height = await page.locator('#entry-input').evaluate(n => n.getBoundingClientRect().height);
		assert.ok(height > 28, `imperfect composer ${height}px should show more than one line`);

		await page.goto(`http://127.0.0.1:${sAddr.port}`);
		await page.waitForFunction(() => (document.getElementById('entry-pi-label')?.textContent || '').includes('fixture-model'));
		await page.locator('#entry-input').focus();
		await pastePng(page);
		await page.waitForSelector('#entry-pending:not([hidden]) .entry-pending-chip');
	} finally {
		await browser.close(); await personal.close(); await stock.close(); await rm(root, { recursive: true, force: true });
	}
});

test('/graph opens personal map on grid; read/back/close; phone; failed load; stock has no graph', async (t) => {
	const executablePath = browserPath();
	if (executablePath === null) return t.skip('No chromium available; run `npx playwright install chromium`');
	const root = await mkdtemp(join(tmpdir(), 'guey-browser-graph-'));
	const home = join(root, 'home');
	await mkdir(home);
	await writeFile(join(home, 'agents.md'), '# Agents of the long knowledge title\n[[imperfect.computer]] [[locus.site]] [[imperfect]]\n');
	await writeFile(join(home, 'imperfect.computer.md'), '# imperfect.computer\nBack [[agents]].\n');
	await writeFile(join(home, 'locus.site.md'), '# locus.site\nBack [[agents]].\n');
	await writeFile(join(home, 'imperfect.md'), '# imperfect\nBack [[agents]].\n');
	const runtime = scriptedRuntime(root);
	const personal = await createGueyServer({ port: 0, host: '127.0.0.1', stateDir: join(root, 'p'), runtime, product: 'imperfect', knowledgeRoot: home });
	const stock = await createGueyServer({ port: 0, host: '127.0.0.1', stateDir: join(root, 's'), runtime, product: 'stock', knowledgeRoot: home });
	const pAddr = await personal.listen();
	const sAddr = await stock.listen();
	const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
	const page = await browser.newPage();
	try {
		await page.goto(`http://127.0.0.1:${pAddr.port}`);
		await page.waitForFunction(() => (document.getElementById('entry-pi-label')?.textContent || '').includes('fixture-model'));
		await page.keyboard.press('Alt+y');
		await page.waitForFunction(() => document.getElementById('terminal-entry').classList.contains('open'));
		await page.fill('#entry-input', 'keep this draft');
		await page.fill('#entry-input', '/graph');
		await page.press('#entry-input', 'Enter');
		await page.waitForSelector('#knowledge-graph-host.open .node');
		await page.waitForFunction(() => document.querySelectorAll('#knowledge-cards .node').length >= 2);
		assert.equal(runtime.sent.some(c => c.type === 'prompt' && String(c.text || '').includes('/graph')), false);
		const geometry = await page.evaluate(() => {
			const cs = getComputedStyle(document.documentElement);
			const unit = Number.parseFloat(cs.getPropertyValue('--ic-grid-major')) || 24;
			const ox = Number.parseFloat(cs.getPropertyValue('--ic-grid-origin-x')) || 0;
			const oy = Number.parseFloat(cs.getPropertyValue('--ic-grid-origin-y')) || 0;
			const on = (n, o) => Math.abs((n - o) / unit - Math.round((n - o) / unit)) * unit < 1;
			const nodes = [...document.querySelectorAll('#knowledge-cards .node')];
			const boxes = nodes.map(n => {
				const r = n.getBoundingClientRect();
				const label = n.querySelector('.node-label');
				const lr = label.getBoundingClientRect();
				return { r, lr, text: label.textContent, overflow: lr.right > r.right + 1 || lr.bottom > r.bottom + 1 || lr.left < r.left - 1 };
			});
			const paths = [...document.querySelectorAll('#knowledge-graph .edge')].map(p => p.getAttribute('d') || '');
			const segsOff = [];
			for (const d of paths) {
				const nums = [...d.matchAll(/-?\d+(?:\.\d+)?/g)].map(m => Number(m[0]));
				for (let i = 0; i + 3 < nums.length; i += 2) {
					const x1 = nums[i], y1 = nums[i + 1], x2 = nums[i + 2], y2 = nums[i + 3];
					const horiz = Math.abs(y1 - y2) < 0.75, vert = Math.abs(x1 - x2) < 0.75;
					if (!horiz && !vert) segsOff.push({ d, reason: 'diag' });
					else if (horiz && !on(y1, oy)) segsOff.push({ d, reason: 'y' });
					else if (vert && !on(x1, ox)) segsOff.push({ d, reason: 'x' });
				}
			}
			const distinct = boxes.every((a, i) => boxes.every((b, j) => {
				if (i >= j) return true;
				return a.r.right <= b.r.left + 0.5 || b.r.right <= a.r.left + 0.5 || a.r.bottom <= b.r.top + 0.5 || b.r.bottom <= a.r.top + 0.5;
			}));
			const snapped = boxes.every(b => on(b.r.left, ox) && on(b.r.top, oy) && on(b.r.right, ox) && on(b.r.bottom, oy));
			const oneCellOverflow = boxes.some(b => Math.abs(b.r.width - unit) < 1 && b.overflow);
			return {
				count: nodes.length,
				unit, ox, oy,
				overflow: boxes.filter(b => b.overflow).map(b => b.text),
				segsOff,
				distinct,
				snapped,
				oneCellOverflow,
				widerThanCell: boxes.some(b => b.r.width > unit + 1),
			};
		});
		assert.ok(geometry.count >= 4, 'expected four home pages');
		assert.deepEqual(geometry.overflow, [], 'labels overflow boxes');
		assert.deepEqual(geometry.segsOff, [], JSON.stringify(geometry.segsOff));
		assert.equal(geometry.distinct, true);
		assert.equal(geometry.snapped, true);
		assert.equal(geometry.oneCellOverflow, false);
		assert.equal(geometry.widerThanCell, true, 'long titles must grow beyond one cell');
		const probe = await page.evaluate(async () => {
			const r = await fetch('/graph/page?id=agents');
			return { status: r.status, body: await r.text() };
		});
		assert.equal(probe.status, 200, probe.body);
		assert.match(JSON.parse(probe.body).content, /Agents/);
		const opened = await page.evaluate(async () => {
			const fn = document.getElementById('knowledge-graph-host')?.openKnowledgePage;
			if (typeof fn !== 'function') return { ok: false, reason: 'no-fn' };
			await fn('agents');
			const card = document.querySelector('#knowledge-cards .node.expanded');
			const overlay = document.getElementById('knowledge-page');
			return {
				ok: true,
				text: document.getElementById('knowledge-document')?.textContent || '',
				inCard: Boolean(card && card.querySelector('#knowledge-document')),
				overlayHidden: !overlay || overlay.hidden,
			};
		});
		assert.equal(opened.ok, true, JSON.stringify(opened));
		assert.match(opened.text, /Agents/, JSON.stringify(opened));
		assert.equal(opened.inCard, true, 'markdown must expand inside the card');
		assert.equal(opened.overlayHidden, true);
		const wikiTarget = await page.locator('.knowledge-wiki').first().getAttribute('data-target');
		assert.equal(wikiTarget, 'imperfect.computer');
		const garden = await page.evaluate(async () => {
			await document.getElementById('knowledge-graph-host').openKnowledgePage('imperfect.computer');
			return document.getElementById('knowledge-document')?.textContent || '';
		});
		assert.match(garden, /imperfect\.computer/);
		const afterBack = await page.evaluate(async () => {
			await document.getElementById('knowledge-back').click();
			for (let i = 0; i < 40; i++) {
				const t = document.getElementById('knowledge-document')?.textContent || '';
				if (t.includes('Agents of the long') && document.querySelector('#knowledge-cards .node.expanded')?.dataset.node === 'agents') return t;
				await new Promise(r => setTimeout(r, 50));
			}
			return document.getElementById('knowledge-document')?.textContent || '';
		});
		assert.match(afterBack, /Agents/);
		assert.equal(await page.locator('#entry-input').inputValue(), 'keep this draft');
		await page.evaluate(() => document.getElementById('knowledge-close').click());
		await page.waitForFunction(() => !document.querySelector('#knowledge-cards .node.expanded'));
		await page.evaluate(() => document.getElementById('knowledge-graph-close').click());
		await page.waitForFunction(() => document.getElementById('knowledge-graph-host').hidden);
		assert.equal(await page.locator('#entry-input').inputValue(), 'keep this draft');

		await page.setViewportSize({ width: 390, height: 844 });
		const harnessOpen = await page.locator('#terminal-entry').evaluate(el => el.classList.contains('open'));
		if (!harnessOpen) {
			await page.keyboard.press('Alt+y');
			await page.waitForFunction(() => document.getElementById('terminal-entry').classList.contains('open'));
		}
		const graphOpen = await page.locator('#knowledge-graph-host').evaluate(el => el.classList.contains('open') && !el.hidden);
		if (!graphOpen) {
			await page.fill('#entry-input', '/graph');
			await page.press('#entry-input', 'Enter');
			await page.waitForSelector('#knowledge-graph-host.open .node');
		}
		const phoneBoxes = await page.evaluate(() => {
			const cs = getComputedStyle(document.documentElement);
			const unit = Number.parseFloat(cs.getPropertyValue('--ic-grid-major')) || 24;
			const ox = Number.parseFloat(cs.getPropertyValue('--ic-grid-origin-x')) || 0;
			const oy = Number.parseFloat(cs.getPropertyValue('--ic-grid-origin-y')) || 0;
			const on = (n, o) => Math.abs((n - o) / unit - Math.round((n - o) / unit)) * unit < 1;
			const nodes = [...document.querySelectorAll('#knowledge-cards .node')];
			const boxes = nodes.map(n => n.getBoundingClientRect());
			const xs = [...new Set(boxes.map(b => Math.round(b.left)))];
			return {
				count: boxes.length,
				unique: new Set(boxes.map(b => `${Math.round(b.left)},${Math.round(b.top)}`)).size,
				branch: xs.length >= 2,
				overlap: boxes.some((a, i) => boxes.some((b, j) => i < j && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top)),
				snapped: boxes.every(b => on(b.left, ox) && on(b.top, oy) && on(b.right, ox) && on(b.bottom, oy)),
				overflow: nodes.some(n => {
					const r = n.getBoundingClientRect();
					const l = n.querySelector('.node-label').getBoundingClientRect();
					return l.right > r.right + 1 || l.bottom > r.bottom + 1;
				}),
			};
		});
		assert.ok(phoneBoxes.count >= 4, JSON.stringify(phoneBoxes));
		assert.equal(phoneBoxes.unique, phoneBoxes.count, JSON.stringify(phoneBoxes));
		assert.equal(phoneBoxes.snapped, true);
		assert.equal(phoneBoxes.overflow, false);
		assert.equal(phoneBoxes.branch, true);
		assert.equal(phoneBoxes.overlap, false, JSON.stringify(phoneBoxes));
		await page.screenshot({ path: '/tmp/imperfect-graph-phone.png', fullPage: true });
		await page.setViewportSize({ width: 1280, height: 800 });
		await page.evaluate(() => dispatchEvent(new Event('resize')));
		await page.waitForTimeout(50);
		await page.screenshot({ path: '/tmp/imperfect-graph-desktop.png', fullPage: true });
		await page.evaluate(() => document.getElementById('knowledge-graph-close').click());

		await page.route('**/graph/page**', route => route.fulfill({ status: 500, body: 'nope' }));
		if (!await page.locator('#terminal-entry').evaluate(el => el.classList.contains('open'))) await page.keyboard.press('Alt+y');
		await page.waitForFunction(() => document.getElementById('terminal-entry').classList.contains('open'));
		await page.evaluate(() => document.getElementById('knowledge-graph-host').classList.contains('open') || null);
		await page.fill('#entry-input', '/graph');
		await page.press('#entry-input', 'Enter');
		await page.waitForSelector('#knowledge-graph-host.open .node');
		await page.locator('#knowledge-cards .node').first().click({ force: true });
		await page.waitForSelector('.knowledge-error');

		await page.goto(`http://127.0.0.1:${sAddr.port}`);
		await page.waitForFunction(() => (document.getElementById('entry-pi-label')?.textContent || '').includes('fixture-model'));
		const stockGraph = await page.evaluate(async () => (await fetch('/graph.json')).status);
		assert.equal(stockGraph, 404);
		await page.fill('#entry-input', '/');
		await page.waitForSelector('#slash-menu:not([hidden])');
		const slash = await page.locator('#slash-menu').textContent();
		assert.equal(/\bgraph\b/i.test(slash || ''), false);
	} finally {
		await browser.close(); await personal.close(); await stock.close(); await rm(root, { recursive: true, force: true });
	}
});

test('knowledge tree grows upwards symmetrically through seven pages, including phone', async t => {
	const executablePath = browserPath();
	if (executablePath === null) return t.skip('No chromium available');
	const root = await mkdtemp(join(tmpdir(), 'guey-tree-browser-'));
	const home = join(root, 'home');
	await mkdir(home);
	const pages = {
		agents: '# agents.md\n[[emails]] [[projects]] [[practice]]',
		emails: '# emails\nParent: [[agents]].\nAcceptance is not delivery.',
		projects: '# projects\nParent: [[agents]].\n[[imperfect.computer]] [[imperfect]] [[locus.site]]',
		practice: '# practice\nParent: [[agents]].',
		'imperfect.computer': '# imperfect.computer\nParent: [[projects]].\nMail: [[emails]].',
		imperfect: '# imperfect\nParent: [[projects]].',
		'locus.site': '# locus.site\nParent: [[projects]].\nSee [[imperfect.computer]].',
	};
	for (const [id, text] of Object.entries(pages)) await writeFile(join(home, `${id}.md`), text);
	const runtime = scriptedRuntime(root);
	const server = await createGueyServer({ port: 0, host: '127.0.0.1', stateDir: join(root, 'state'), runtime, product: 'imperfect', knowledgeRoot: home });
	const addr = await server.listen();
	const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
	const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
	async function geometry() {
		return page.evaluate(() => {
			const cs = getComputedStyle(document.documentElement);
			const u = parseFloat(cs.getPropertyValue('--ic-grid-major'));
			const ox = parseFloat(cs.getPropertyValue('--ic-grid-origin-x')) || 0;
			const oy = parseFloat(cs.getPropertyValue('--ic-grid-origin-y')) || 0;
			const on = (v, origin) => Math.abs((v - origin) / u - Math.round((v - origin) / u)) < 0.01;
			const nodes = [...document.querySelectorAll('#knowledge-cards .node')];
			const boxes = Object.fromEntries(nodes.map(n => {
				const r = n.getBoundingClientRect();
				return [n.dataset.node, { left: r.left, right: r.right, top: r.top, bottom: r.bottom, cx: r.left + r.width / 2 }];
			}));
			const groups = [['agents', 'emails', 'projects', 'practice'], ['projects', 'imperfect.computer', 'imperfect', 'locus.site']];
			const symmetric = groups.every(([p, a, b, c]) => boxes[p].cx === boxes[b].cx && boxes[p].cx - boxes[a].cx === boxes[c].cx - boxes[p].cx);
			const upwards = groups.every(([p, ...kids]) => kids.every(k => boxes[k].bottom <= boxes[p].top - 2 * u));
			const onGrid = Object.values(boxes).every(b => on(b.left, ox) && on(b.right, ox) && on(b.top, oy) && on(b.bottom, oy));
			const paths = [...document.querySelectorAll('#knowledge-graph .edge')];
			const connectors = paths.every(p => {
				const nums = [...p.getAttribute('d').matchAll(/-?\d+(?:\.\d+)?/g)].map(m => Number(m[0]));
				for (let i = 0; i < nums.length - 2; i += 2) {
					const [x, y, xx, yy] = nums.slice(i, i + 4);
					if (!((x === xx && on(x, ox)) || (y === yy && on(y, oy)))) return false;
				}
				return true;
			});
			const labelOverflow = nodes.filter(n => !n.classList.contains('expanded')).some(n => {
				const r = n.getBoundingClientRect();
				return [...n.querySelectorAll('.node-label-line')].some(s => {
					const b = s.getBoundingClientRect();
					return b.left < r.left || b.right > r.right || b.top < r.top || b.bottom > r.bottom;
				});
			});
			const expanded = document.querySelector('#knowledge-cards .node.expanded')?.dataset.node;
			const all = Object.entries(boxes);
			const overlap = all.some(([id, a], i) => all.some(([jd, b], j) => i < j && id !== expanded && jd !== expanded && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom));
			return { boxes, symmetric, upwards, onGrid, connectors, labelOverflow, overlap, edges: paths.length, inViewport: all.every(b => b.left >= 0 && b.right <= innerWidth && b.top >= 0 && b.bottom <= innerHeight) };
		});
	}
	function check(g, fit = true) {
		for (const key of ['symmetric', 'upwards', 'onGrid', 'connectors']) assert.equal(g[key], true, `${key}: ${JSON.stringify(g)}`);
		assert.equal(g.labelOverflow, false);
		assert.equal(g.overlap, false);
		assert.equal(g.edges, 6, 'backlinks must not create competing trunks');
		assert.ok(g.boxes.agents.bottom > g.boxes.projects.bottom, 'root sits below its branches');
		if (fit) assert.ok(g.boxes.agents.top >= 0 && g.boxes.agents.bottom <= 900, JSON.stringify(g.boxes.agents));
	}
	try {
		await page.goto(`http://127.0.0.1:${addr.port}`);
		await page.waitForFunction(() => document.querySelector('#entry-pi-label')?.textContent.includes('fixture-model'));
		await page.keyboard.press('Alt+y');
		await page.fill('#entry-input', '/graph');
		await page.press('#entry-input', 'Enter');
		await page.waitForSelector('#knowledge-cards [data-node="practice"]');
		assert.equal(await page.locator('#terminal-entry').evaluate(el => el.classList.contains('open')), true, 'graph must not close the harness');
		check(await geometry());
		await page.locator('[data-node="agents"]').click();
		await page.waitForSelector('#knowledge-document .knowledge-wiki');
		check(await geometry());
		await page.locator('#knowledge-document [data-target="emails"]').click();
		await page.waitForFunction(() => document.querySelector('#knowledge-document')?.textContent.includes('Acceptance is not delivery'));
		await page.evaluate(() => document.getElementById('knowledge-back').click());
		await page.waitForFunction(() => (document.getElementById('knowledge-document')?.textContent || '').includes('hello thinking machine') || (document.getElementById('knowledge-document')?.textContent || '').includes('# agents'));
		await page.evaluate(() => document.getElementById('knowledge-close').click());
		check(await geometry());
		const before = await geometry();
		await page.mouse.move(180, 700); await page.mouse.down(); await page.mouse.move(225, 745, { steps: 5 }); await page.mouse.up();
		const after = await geometry();
		check(after, false);
		assert.equal(after.boxes.agents.cx, before.boxes.agents.cx, 'canvas drag does not pan the tree');
		assert.equal(after.boxes.agents.top, before.boxes.agents.top);
		await page.setViewportSize({ width: 1280, height: 900 });
		await page.waitForTimeout(30);
		check(await geometry(), false);
		assert.equal(runtime.sent.some(c => c.type === 'prompt'), false, 'navigation does not send model prompts');
	} finally {
		await browser.close(); await server.close(); await rm(root, { recursive: true, force: true });
	}
});

test('the phone shell is the painting, a pager of viewports, and its own bar', async (t) => {
	const executablePath = browserPath();
	if (executablePath === null) return t.skip('No chromium available; run `npx playwright install chromium`');
	const root = await mkdtemp(join(tmpdir(), 'guey-browser-scene-'));
	const runtime = scriptedRuntime(root);
	const personal = await createGueyServer({
		port: 0, host: '127.0.0.1', stateDir: root, runtime, product: 'imperfect',
	});
	const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
	try {
		const addr = await personal.listen();
		const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
		await openPersonalComposer(page, addr);

		assert.equal(await page.locator('#imperfect-scene').count(), 0);
		// The ground is the painting the door is set in, on its own fixed layer so `cover` re-fits
		// on rotation with no script. Omarchy supplied a wallpaper here until 2026-09-14 and this
		// test still asked for it; a hosted machine has no Omarchy to ask. A phone is taller than
		// it is wide, so it gets the portrait crop.
		const wall = await page.evaluate(() => {
			const node = document.getElementById('om-wall');
			if (!node) return null;
			const style = getComputedStyle(node);
			const box = node.getBoundingClientRect();
			return { image: style.backgroundImage, size: style.backgroundSize, w: Math.round(box.width), h: Math.round(box.height) };
		});
		assert.ok(wall, 'the wallpaper layer exists');
		assert.match(wall.image, /\/media\/ground\/temple-tall\.webp/);
		assert.equal(wall.size, 'cover');
		assert.equal(wall.w, 390);
		assert.equal(wall.h, 844);
		assert.equal((await page.request.get(`http://127.0.0.1:${addr.port}/media/ground/temple-tall.webp`)).status(), 200);

		// The pager fills the viewport above the bar, and scrolls one axis only.
		const world = await page.evaluate(() => {
			const node = document.getElementById('imperfect-world');
			const box = node.getBoundingClientRect();
			const style = getComputedStyle(node);
			return {
				w: Math.round(box.width), h: Math.round(box.height),
				left: Math.round(box.left), top: Math.round(box.top),
				snap: style.scrollSnapType, overflowX: style.overflowX, overflowY: style.overflowY,
				pager: node.classList.contains('om-pager'),
			};
		});
		assert.equal(world.left, 0);
		assert.equal(world.top, 0);
		assert.equal(world.w, 390);
		assert.equal(world.h, 844);
		assert.ok(world.pager);
		assert.match(world.snap, /x mandatory/);
		assert.equal(world.overflowX, 'auto');
		assert.equal(world.overflowY, 'hidden');

		// The bar is this shell's own: its position, its widgets, its clock format. Nothing open is
		// the painting, and the menu is the way in.
		const bar = await page.evaluate(() => {
			const node = document.getElementById('om-bar');
			if (!node) return null;
			return {
				position: node.dataset.position,
				menu: Boolean(node.querySelector('.om-menu')),
				workspaces: Boolean(node.querySelector('.om-workspaces')),
				clock: node.querySelector('.om-clock')?.textContent ?? '',
				dots: node.querySelectorAll('.om-ws').length,
			};
		});
		assert.ok(bar, 'the bar mounted');
		assert.equal(bar.position, 'bottom');
		assert.ok(bar.menu);
		assert.match(bar.clock, /\d\d:\d\d/);
		// The bar carries the menu and the clock. It had a workspace indicator while its
		// arrangement came from Omarchy's shell.json; that went with shell.json, and the pager has
		// had no indicator since -- open two applications and nothing says which one is showing.
		assert.equal(bar.workspaces, false);
		assert.equal(bar.dots, 0);
		assert.ok(await page.evaluate(() => document.body.classList.contains('shell-empty')));

		// The menu lists the applications, and opening one gives it a viewport.
		await page.click('.om-menu');
		await page.waitForSelector('.om-sheet .om-app');
		const apps = await page.$$eval('.om-sheet .om-app-name', nodes => nodes.map(n => n.textContent));
		assert.deepEqual(apps, ['files', 'antiburn', 'Doom', 'Image Lab']);
		// Every row is a picture and a name. antiburn and Doom answer to logos of their own, which
		// are files; the product's own applications are drawn on the pixel grid, which are not.
		const marks = await page.$$eval('.om-sheet .om-app-icon', boxes => boxes.map(box => {
			const img = box.querySelector('img');
			return img ? `img:${new URL(img.src).pathname}:${img.naturalWidth > 0}` : 'drawn';
		}));
		assert.deepEqual(marks, ['drawn', 'img:/icons/antiburn.png:true', 'img:/doom/M_DOOM.png:true', 'drawn']);
		// The drawer is a panel in the middle, not a bar across the foot of the screen.
		const drawer = await page.evaluate(() => {
			const box = document.querySelector('.om-sheet-list').getBoundingClientRect();
			return { w: Math.round(box.width), left: Math.round(box.left), right: Math.round(box.right) };
		});
		assert.ok(drawer.w < 390, `the drawer is no wider than it needs, got ${drawer.w}`);
		assert.equal(drawer.left, 390 - drawer.right, 'the drawer is centred');
		await page.click('.om-sheet .om-app:has-text("files")');
		await page.waitForSelector('.om-slot[data-app="files"] .review-page-frame');
		const slot = await page.evaluate(() => {
			const node = document.querySelector('.om-slot[data-app="files"]');
			const frame = node.querySelector('.om-frame').getBoundingClientRect();
			return {
				w: Math.round(node.getBoundingClientRect().width),
				frameW: Math.round(frame.width),
				radius: getComputedStyle(node.querySelector('.om-frame')).borderTopLeftRadius,
				dots: document.querySelectorAll('.om-ws').length,
			};
		});
		// One full viewport per application, inset by the gap. The corner is square: this product is
		// drawn on a character cell, and a rounded corner is the one shape a cell cannot make.
		assert.equal(slot.w, 390);
		assert.ok(slot.frameW < 390 && slot.frameW > 360, `the gap shows the painting, got ${slot.frameW}`);
		assert.equal(slot.radius, '0px');
		assert.equal(slot.dots, 0, 'still no indicator, see above');
		assert.equal(await page.locator('.om-sheet').count(), 0, 'the sheet closes on choice');
		// Alt+W closes a window, so no button repeats it in the corner of every application.
		assert.equal(await page.locator('.review-close').count(), 0);

		await page.screenshot({ path: '/tmp/imperfect-canvas.png' });

	} finally {
		await browser.close(); await personal.close(); await rm(root, { recursive: true, force: true });
	}
});

test('the machine\'s own screen is a tile the door grants, and its address is never written down', async (t) => {
	const executablePath = browserPath();
	if (executablePath === null) return t.skip('No chromium available; run `npx playwright install chromium`');
	const root = await mkdtemp(join(tmpdir(), 'guey-browser-desktop-'));
	const runtime = scriptedRuntime(root);
	const app = await createGueyServer({ port: 0, host: '127.0.0.1', stateDir: root, runtime, product: 'imperfect' });
	const address = await app.listen();
	const base = `http://127.0.0.1:${address.port}`;
	const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
	try {
		// A machine somebody already owns has no supplier screen, and a dead tile is worse than
		// no tile: this computer answers nothing at /__machine, so the row is simply not drawn.
		const plain = await browser.newPage();
		await plain.goto(base);
		await plain.waitForFunction(() => getComputedStyle(document.body).fontFamily.includes('Commit Mono'));
		await plain.keyboard.press('Alt+ ');
		await plain.waitForSelector('.om-sheet .om-app');
		assert.deepEqual(await plain.$$eval('.om-sheet .om-app-name', n => n.map(x => x.textContent)),
			['files', 'antiburn', 'Doom', 'Image Lab']);

		// A Box has one. The door's proxy answers both of these in front of this computer.
		const page = await browser.newPage();
		let minted = 0;
		await page.route('**/__machine', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ desktop: true }) }));
		await page.route('**/__desktop', route => {
			minted += 1;
			return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ url: `https://box.on.ascii.dev/vnc?token=secret-${minted}` }) });
		});
		await page.route('https://box.on.ascii.dev/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<p>screen</p>' }));
		await page.goto(base);
		await page.waitForFunction(() => getComputedStyle(document.body).fontFamily.includes('Commit Mono'));
		await page.keyboard.press('Alt+ ');
		await page.waitForSelector('.om-sheet .om-app-name:text-is("desktop")');
		await page.click('.om-sheet .om-app:has-text("desktop")');
		await page.waitForSelector('.om-slot[data-app="desktop"] .review-page-frame');
		assert.match(await page.getAttribute('.om-slot[data-app="desktop"] .review-page-frame', 'src'), /^https:\/\/box\.on\.ascii\.dev\/vnc\?token=/);
		assert.equal(minted, 1, 'the address is asked for at the moment it is opened');

		// The point of mounting it here rather than through the agent: the token never reaches the
		// server, so it is in no window list, no session file and no transcript.
		assert.equal(runtime.sent.some(c => c.type === 'window-open'), false);
		assert.equal(JSON.stringify(runtime.data.windows ?? []).includes('ascii.dev'), false);

		// Alt+W closes it even though no server window matches it.
		await page.keyboard.press('Alt+w');
		await page.waitForSelector('.om-slot[data-app="desktop"]', { state: 'detached' });

		// The permission belongs to this one window, not to the window kind. A foreign src cannot
		// even be named through the agent -- the server refuses it before the page hears of it --
		// and review-window.test.mjs proves the page refuses it too, without that allowance.
		assert.throws(() => sanitizeWorldWindow({ kind: 'page', id: 'evil', title: 'evil', src: 'https://box.on.ascii.dev/vnc' }), /in-app/);
	} finally {
		await browser.close(); await app.close(); await rm(root, { recursive: true, force: true });
	}
});

// The startup header is the first surface an agent owns rather than borrows.
// Before this, a Claude session opened under "pi vclaude 2.1.273" — Pi's name
// with Claude's version worn as a version number — above Pi's key hints, two
// of which this window does not even implement.
test('a Claude tab introduces itself as Claude, in a real browser', async (t) => {
	const executablePath = browserPath();
	if (executablePath === null) return t.skip('No chromium available; run `npx playwright install chromium`');
	const root = await mkdtemp(join(tmpdir(), 'guey-claude-face-'));
	const runtime = scriptedRuntime(root);
	// The tab host stamps this onto every snapshot; here the fixture is the host.
	runtime.data.agent = 'claude';
	runtime.data.startup = {
		version: 'claude 2.1.273', quiet: false, update: null,
		sections: [{ name: 'Context', compact: 'AGENTS.md', expanded: '/tmp/AGENTS.md' }],
	};
	const app = await createGueyServer({ port: 0, host: '127.0.0.1', stateDir: root, runtime });
	const address = await app.listen();
	const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
	const page = await browser.newPage();
	const crashes = [];
	page.on('pageerror', e => crashes.push(e.message));
	try {
		await page.goto(`http://127.0.0.1:${address.port}`);
		await page.keyboard.press('Alt+y');
		await page.waitForSelector('.entry-startup');
		const header = await page.textContent('.entry-startup');

		assert.match(header, /claude 2\.1\.273/, 'Claude names itself and its own version');
		assert.doesNotMatch(header, /\bpi\b/i, 'the other harness is not named here');
		assert.doesNotMatch(header, /vclaude/, 'the version is not worn as a version number');

		// Only keys this window answers.
		assert.match(header, /escape interrupt/);
		assert.doesNotMatch(header, /!/, 'bang-bash has no handler in this GUI');
		assert.doesNotMatch(header, /ctrl\+d/, 'ctrl+d has no handler in this GUI');

		// The agent still supplies its own sections, and the shared chrome still works.
		assert.match(await page.textContent('.entry-startup-section'), /\[Context\]/);
		await page.locator('#entry-input').click();
		await page.locator('#entry-input').press('Control+o');
		await page.waitForFunction(() => (document.querySelector('.entry-startup')?.textContent || '').includes('to interrupt'));
		assert.match(await page.textContent('.entry-startup-section'), /AGENTS\.md/);

		assert.deepEqual(crashes, []);
	} finally {
		await browser.close();
		await app.close?.();
		await rm(root, { recursive: true, force: true });
	}
});
