import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectReleaseFiles } from '../install/imperfect.mjs';

const ROOT = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));

test('the window installer is a script, not a second product', () => {
  const script = join(ROOT, 'desktop/install.sh');
  const clone = join(ROOT, 'install.sh');
  assert.ok(existsSync(script));
  assert.ok(existsSync(clone));
  const help = spawnSync('bash', [script, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Tauri window/);
  assert.match(help.stdout, /install\/imperfect\.mjs/);
  const rust = readFileSync(join(ROOT, 'desktop/src-tauri/src/main.rs'), 'utf8');
  assert.match(rust, /start\.mjs/);
  assert.match(rust, /127\.0\.0\.1/);
  assert.equal(rust.includes('locus-garden'), false);
});

test('the hosted pack does not carry the window', () => {
  const files = collectReleaseFiles(ROOT);
  assert.equal(files.some(rel => rel.startsWith('desktop/')), false);
  assert.ok(files.includes('start.mjs'));
});
