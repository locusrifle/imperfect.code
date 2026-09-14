import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PI_OPENING, applyEnvironment, fillEnvironment } from '../native/environment-prompt.mjs';

const root = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));

test('environment replaces Pi opening, not the whole prompt', () => {
  const start = readFileSync(join(root, 'start.mjs'), 'utf8');
  assert.match(start, /imperfect-environment/);
  assert.doesNotMatch(start, /appendSystemPrompt/);
  assert.doesNotMatch(start, /systemPrompt:\s/);
});

test('environment names the person, the two trees, and the wikilinks', () => {
  const environment = readFileSync(join(root, 'environment.md'), 'utf8');
  assert.match(environment, /\{\{NAME\}\}/);
  assert.match(environment, /\/opt\/imperfect\/data/);
  assert.match(environment, /To put a page in the interface, read \[\[apps\]\]/);
  assert.match(environment, /how data is kept and moved between sandboxes, read \[\[snapshot\]\]/);
});

test('signup handle becomes the name in the opening', () => {
  const template = readFileSync(join(root, 'environment.md'), 'utf8');
  const noah = fillEnvironment(template, 'noah');
  assert.match(noah, /^You are Noah's personal computing assistant/);
  assert.doesNotMatch(noah, /\{\{NAME\}\}/);
  const unknown = fillEnvironment(template, '');
  assert.match(unknown, /^You are this person's personal computing assistant/);
});

test('Pi tools stay after the environment opening', () => {
  const environment = fillEnvironment(readFileSync(join(root, 'environment.md'), 'utf8'), 'noah');
  const built = `${PI_OPENING}\n\nAvailable tools:\n- bash\n\nGuidelines:\n- Be concise`;
  const next = applyEnvironment(built, environment);
  assert.match(next, /^You are Noah's personal computing assistant/);
  assert.doesNotMatch(next, /expert coding assistant/);
  assert.match(next, /Available tools:/);
  assert.match(next, /Be concise/);
  assert.match(next, /\[\[apps\]\]/);
});
