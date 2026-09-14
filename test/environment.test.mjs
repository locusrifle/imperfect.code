import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));

test('environment is appended to Pi, not used as a replacement system prompt', () => {
  const start = readFileSync(join(root, 'start.mjs'), 'utf8');
  assert.match(start, /environment\.md/);
  assert.match(start, /appendSystemPrompt/);
  assert.doesNotMatch(start, /systemPrompt:\s/);
});

test('environment names the two trees and wikilinks apps', () => {
  const environment = readFileSync(join(root, 'environment.md'), 'utf8');
  assert.match(environment, /\/opt\/imperfect\/data/);
  assert.match(environment, /\/opt\/imperfect/);
  assert.match(environment, /browser/i);
  assert.match(environment, /sleep/i);
  assert.match(environment, /\[\[apps\]\]/);
  assert.doesNotMatch(environment, /place\.md/);
});
