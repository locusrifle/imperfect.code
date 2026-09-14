import { test } from 'node:test';
import assert from 'node:assert/strict';
import { grokAccess, parseGrokCredits, piXaiAccess } from '../usage-grok.mjs';

test('grokAccess reads the first stored key without exposing other fields', () => {
  const access = grokAccess({
    'https://auth.x.ai::example': { key: 'tok', expires_at: '2026-09-12T00:00:00Z' },
  });
  assert.equal(access.token, 'tok');
  assert.equal(access.expiresAt, '2026-09-12T00:00:00Z');
  assert.equal(access.label, 'grok-cli');
  assert.equal(grokAccess({}), null);
});

test('parseGrokCredits uses the 0–100 credit window Grok reports', () => {
  const parsed = parseGrokCredits({
    subscriptionTier: 'SuperGrok',
    config: {
      creditUsagePercent: 42,
      currentPeriod: { end: '2026-09-15T00:00:00Z' },
    },
  });
  assert.equal(parsed.plan, 'SuperGrok');
  assert.equal(parsed.windows[0].percent, 42);
  assert.equal(parsed.windows[0].label, 'Usage limit');
  assert.equal(parsed.windows[0].resetsAt, '2026-09-15T00:00:00Z');
});

test('piXaiAccess reads Pi oauth without treating Grok CLI as the same login', () => {
  const access = piXaiAccess({ xai: { type: 'oauth', access: 'pi-tok', expires: 1789121954170 } });
  assert.equal(access.token, 'pi-tok');
  assert.equal(access.label, 'pi');
  assert.ok(Date.parse(access.expiresAt) > 0);
  assert.equal(piXaiAccess({}), null);
});
