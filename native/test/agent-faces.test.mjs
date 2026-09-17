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

	assert.notEqual(pi.note, claude.note);
	assert.doesNotMatch(claude.note, /\bPi\b/, 'Claude’s own line does not explain Pi');
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
