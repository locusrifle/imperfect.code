import { test } from 'node:test';
import assert from 'node:assert/strict';
import { meterBar, percentLabel, readingAge, resetText } from '../public/js/usage.js';

test('meter bar is twenty cells and fills by percent', () => {
  assert.equal(meterBar(0), '░░░░░░░░░░░░░░░░░░░░');
  assert.equal(meterBar(100), '████████████████████');
  assert.equal(meterBar(50).length, 20);
  assert.equal(percentLabel(74.4), '74% used');
});

test('reset and stale follow the clock', () => {
  const now = Date.parse('2026-09-11T05:30:00Z');
  assert.equal(resetText('2026-09-10T08:49:59Z', now), 'window ended');
  assert.match(resetText('2026-09-11T10:59:59Z', now), /resets /);
  assert.equal(readingAge('2026-09-10T07:27:36Z', now).stale, true);
  assert.equal(readingAge(new Date(now - 1000).toISOString(), now).stale, false);
});
