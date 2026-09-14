import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));

test('place is appended to Pi, not used as a replacement system prompt', () => {
  const start = readFileSync(join(root, 'start.mjs'), 'utf8');
  assert.match(start, /place\.md/);
  assert.match(start, /appendSystemPrompt/);
  assert.doesNotMatch(start, /systemPrompt:\s/);
});

test('place names the two trees and the browser', () => {
  const place = readFileSync(join(root, 'place.md'), 'utf8');
  assert.match(place, /\/opt\/imperfect\/data/);
  assert.match(place, /\/opt\/imperfect/);
  assert.match(place, /browser/i);
  assert.match(place, /sleep/i);
  assert.match(place, /docs\/apps\.md/);
  assert.doesNotMatch(place, /AGENTS\.md is the only/);
});
