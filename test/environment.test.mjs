import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PI_OPENING, applyEnvironment } from '../native/environment-prompt.mjs';

const root = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));

test('environment replaces Pi opening, not the whole prompt', () => {
  const start = readFileSync(join(root, 'start.mjs'), 'utf8');
  assert.match(start, /locus-environment/);
  assert.doesNotMatch(start, /appendSystemPrompt/);
  assert.doesNotMatch(start, /systemPrompt:\s/);
});

test('environment names the two trees and wikilinks apps', () => {
  const environment = readFileSync(join(root, 'environment.md'), 'utf8');
  assert.match(environment, /\/opt\/imperfect\/data/);
  assert.match(environment, /Not only a coding assistant/);
  assert.match(environment, /\[\[apps\]\]/);
});

test('Pi tools stay after the environment opening', () => {
  const environment = readFileSync(join(root, 'environment.md'), 'utf8').trim();
  const built = `${PI_OPENING}\n\nAvailable tools:\n- bash\n\nGuidelines:\n- Be concise`;
  const next = applyEnvironment(built, environment);
  assert.match(next, /^You are the agent on this person's computer/);
  assert.doesNotMatch(next, /expert coding assistant/);
  assert.match(next, /Available tools:/);
  assert.match(next, /Be concise/);
  assert.match(next, /\[\[apps\]\]/);
});
