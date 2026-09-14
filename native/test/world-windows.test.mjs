import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyWorldWindow, closeWorldWindow, sanitizeWorldWindow } from '../world-windows.mjs';

test('only desktop, video, image, text, or page; media src is an in-app asset', () => {
  assert.deepEqual(sanitizeWorldWindow({ kind: 'desktop', title: 'Laptop' }), { id: 'desktop', kind: 'desktop', title: 'Laptop' });
  const src = '/content/media/1277046e60949e6f/dafde4200f652cdb';
  assert.equal(sanitizeWorldWindow({ kind: 'video', src, title: 'Clip' }).src, src);
  assert.throws(() => sanitizeWorldWindow({ kind: 'video', src: 'https://example.com/x.mp4' }), /in-app/);
  assert.throws(() => sanitizeWorldWindow({ kind: 'video', src: '/etc/passwd' }), /in-app/);
  assert.throws(() => sanitizeWorldWindow({ kind: 'iframe' }), /kind/);
  assert.deepEqual(sanitizeWorldWindow({ kind: 'page', title: 'antiburn' }), { id: 'antiburn', kind: 'page', title: 'antiburn', src: '/antiburn.html' });
  // page is the empty container: any in-app page, so another web project needs
  // no new window kind. A foreign origin or a traversal is still refused.
  assert.deepEqual(sanitizeWorldWindow({ kind: 'page', id: 'files', title: 'files', src: '/files.html' }), { id: 'files', kind: 'page', title: 'files', src: '/files.html' });
  assert.throws(() => sanitizeWorldWindow({ kind: 'page', src: 'https://example.com/x.html' }), /in-app/);
  assert.throws(() => sanitizeWorldWindow({ kind: 'page', src: '/a/../b.html' }), /in-app/);
  assert.throws(() => sanitizeWorldWindow({ kind: 'page', src: '/index.js' }), /in-app/);
});

test('replacing the same id does not stack windows; closing drops only that id', () => {
  const src = '/content/media/1277046e60949e6f/dafde4200f652cdb';
  const one = applyWorldWindow([], { kind: 'video', id: 'clip', src, title: 'A' });
  const two = applyWorldWindow(one, { kind: 'video', id: 'clip', src, title: 'B' });
  assert.equal(two.length, 1);
  assert.equal(two[0].title, 'B');
  assert.deepEqual(closeWorldWindow(two, 'clip'), []);
  assert.throws(() => closeWorldWindow(two), /window id required/);
});
