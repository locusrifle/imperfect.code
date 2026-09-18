import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { faceFor, commandsFor } from '../public/js/agent-faces.js';

const HARNESS = new URL('../public/js/harness.js', import.meta.url);

test('the window has one face; backends only change which commands they answer', () => {
	assert.equal(faceFor('pi').name, 'pi');
	assert.equal(faceFor('claude').name, 'pi');
	assert.equal(faceFor(undefined).name, 'pi');
	assert.equal(faceFor('claude').note, faceFor('pi').note);
	assert.equal(faceFor('claude').compactHints, faceFor('pi').compactHints);
	assert.equal(faceFor().versionLabel('claude 2.1.273'), 'v2.1.273');
	assert.equal(faceFor().versionLabel('0.85.0'), 'v0.85.0');
	assert.equal(faceFor().versionLabel('claude'), '');
});

test('a backend names only the verbs it can run', async () => {
	const pi = commandsFor('pi');
	const claude = commandsFor('claude');
	const runtime = await readFile(new URL('../claude-runtime.mjs', import.meta.url), 'utf8');

	assert.ok('/harness' in pi);
	assert.ok('/harness' in claude);
	assert.ok('/tree' in pi);
	for (const name of Object.keys(claude)) {
		if (name === '/quit' || name === '/harness') continue;
		const verb = name.slice(1);
		assert.match(runtime, new RegExp(`case '${verb}'`), `/${verb} must exist in claude-runtime`);
	}
	for (const dead of ['/tree', '/fork', '/clone', '/compact', '/thinking', '/reload', '/new', '/resume']) {
		assert.ok(!(dead in claude), `Claude must not offer ${dead}`);
	}
});

test('the shared header is not a costume per harness', async () => {
	const source = await readFile(HARNESS, 'utf8');
	assert.ok(source.includes("import { faceFor, commandsFor, permissionFor } from './agent-faces.js'"));
	assert.ok(!source.includes("el('span', 'pi', 'entry-startup-name')"));
	assert.doesNotMatch(source, /\+ new Claude/);
});
