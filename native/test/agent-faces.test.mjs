import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { faceFor } from '../public/js/agent-faces.js';

const HARNESS = new URL('../public/js/harness.js', import.meta.url);

test('a harness introduces itself in its own name, not the other one’s', async () => {
	const pi = faceFor('pi');
	const claude = faceFor('claude');

	assert.equal(pi.name, 'pi');
	assert.equal(claude.name, 'claude');

	// The bug this replaces: the runtime hands over "claude 2.1.273" and the
	// shared header printed it after the word pi with a v in front, giving
	// "pi vclaude 2.1.273".
	assert.equal(pi.versionLabel('0.85.0'), 'v0.85.0');
	assert.equal(claude.versionLabel('claude 2.1.273'), '2.1.273');
	assert.doesNotMatch(claude.versionLabel('claude 2.1.273'), /claude/i, 'the name is not printed twice');

	// Before the SDK's init frame there is no version at all, and the runtime
	// sends the bare word. "claude claude" is what a person saw while waiting
	// for their first prompt.
	assert.equal(claude.versionLabel('claude'), '', 'no version yet means no version shown');

	// The native Claude TUI carries no explanatory line under its hints.
	assert.equal(claude.note, null, 'Claude says nothing the real TUI does not say');
	assert.equal(typeof pi.note, 'string', 'Pi keeps the line it already had');
});

test('an unknown or missing agent falls back to pi rather than to nothing', () => {
	assert.equal(faceFor(undefined).name, 'pi');
	assert.equal(faceFor('something-else').name, 'pi');
});

test('Claude’s hints only name keys this GUI actually answers', async () => {
	const source = await readFile(HARNESS, 'utf8');
	const claude = faceFor('claude');
	const keys = [...claude.compactHints, ...claude.expandedHints].map(row => row[0]);

	// `!`, `!!` and ctrl+d are Pi TUI bindings with no handler in this window.
	// Advertising them here would replace one wrong banner with another.
	for (const dead of ['!', '!!', 'ctrl+c/ctrl+d', 'ctrl+d']) {
		assert.ok(!keys.includes(dead), `Claude must not advertise ${dead}, which this GUI does not implement`);
	}

	// Every key Claude does name has a handler in the shared renderer.
	assert.match(source, /event\.key === 'Escape'/, 'escape');
	assert.match(source, /event\.key === 'c' && event\.ctrlKey/, 'ctrl+c');
	assert.match(source, /event\.key === 'o' && event\.ctrlKey/, 'ctrl+o');
	assert.ok(keys.includes('escape') && keys.includes('/') && keys.includes('ctrl+o'));
});

test('the shared header no longer hardcodes one agent’s name', async () => {
	const source = await readFile(HARNESS, 'utf8');
	assert.ok(source.includes("import { faceFor } from './agent-faces.js'"), 'the slot is wired');
	assert.ok(!source.includes("el('span', 'pi', 'entry-startup-name')"), 'the name comes from the face');
	assert.ok(!source.includes('Ask it how to use or extend Pi.'), 'the note comes from the face');
	assert.ok(!source.includes('STARTUP_COMPACT_HINTS'), 'the old shared constants are gone, not shadowed');
});

test('the slash catalogue belongs to the agent, and names nothing it cannot run', async () => {
	const pi = faceFor('pi').slashView;
	const claude = faceFor('claude').slashView;
	const runtime = await readFile(new URL('../claude-runtime.mjs', import.meta.url), 'utf8');

	// Pi's catalogue is untouched by this change.
	assert.equal(Object.keys(pi).length, 23);
	for (const name of ['/tree', '/fork', '/compact', '/thinking', '/reload', '/share']) {
		assert.ok(name in pi, `${name} is still Pi's`);
	}

	// Claude's names only verbs its own runtime answers. Its command switch
	// ends in `default: throw`, so anything absent there is a thrown error.
	assert.ok(Object.keys(claude).length < Object.keys(pi).length);
	for (const name of Object.keys(claude)) {
		if (name === '/quit') continue; // handled by the window, not the runtime
		const verb = name.slice(1);
		assert.match(runtime, new RegExp(`case '${verb}'`), `/${verb} must exist in claude-runtime`);
	}

	// The ones that would have thrown are gone, including the two that look
	// harmless — the runtime implements neither.
	for (const dead of ['/tree', '/fork', '/clone', '/compact', '/thinking', '/reload', '/new', '/resume', '/scoped-models', '/export', '/import', '/share', '/changelog', '/hotkeys', '/trust']) {
		assert.ok(!(dead in claude), `Claude must not offer ${dead}`);
		if (['/new', '/resume'].includes(dead)) {
			assert.doesNotMatch(runtime, new RegExp(`case '${dead.slice(1)}'`), `${dead} really is unimplemented`);
		}
	}
});
