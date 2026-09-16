import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyContent, isAllowedSrc, mountReviewWindow } from '../public/js/review-window.js';

class Elem {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentElement = null;
    this.className = '';
    this.id = '';
    this.attrs = {};
    this.textContent = '';
    this.innerHTML = '';
    this.onclick = null;
    this.value = '';
    this.src = '';
    this.alt = '';
    this.controls = false;
    this.playsInline = false;
    this.autoplay = false;
    this.preload = '';
    this.draggable = true;
    this.style = {};
    this.dataset = {};
    this.hidden = false;
    this.focused = false;
    this.listeners = {};
    if (this.tagName === 'IFRAME') this.contentWindow = { frame: this };
    this.classList = {
      add: (...names) => { for (const name of names) this.className = `${this.className} ${name}`.trim(); },
      remove: (...names) => {
        const drop = new Set(names);
        this.className = this.className.split(/\s+/).filter(name => name && !drop.has(name)).join(' ');
      },
      contains: name => this.className.split(/\s+/).includes(name),
      toggle: (name, on) => {
        const has = this.className.split(/\s+/).includes(name);
        const next = on ?? !has;
        if (next && !has) this.classList.add(name);
        if (!next && has) this.classList.remove(name);
      },
    };
  }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
    if (k === 'id') this.id = String(v);
    if (k === 'class') this.className = String(v);
    if (k === 'src') this.src = String(v);
  }
  getAttribute(k) { return this.attrs[k]; }
  focus() { this.focused = true; }
  closest(sel) {
    let node = this;
    while (node) {
      if (sel.startsWith('.') && String(node.className).split(/\s+/).includes(sel.slice(1))) return node;
      if (sel === 'button' && node.tagName === 'BUTTON') return node;
      node = node.parentElement;
    }
    return null;
  }
  append(...kids) {
    for (const kid of kids) { kid.parentElement = this; this.children.push(kid); }
  }
  replaceChildren(...kids) {
    for (const kid of this.children) kid.parentElement = null;
    this.children = [];
    this.append(...kids);
  }
  remove() {
    if (!this.parentElement) return;
    this.parentElement.children = this.parentElement.children.filter(c => c !== this);
    this.parentElement = null;
  }
  querySelector(sel) {
    return this.querySelectorAll(sel)[0] ?? null;
  }
  querySelectorAll(sel) {
    const wantClass = sel.startsWith('.') ? sel.slice(1).split('.')[0] : null;
    const wantId = sel.startsWith('#') ? sel.slice(1) : null;
    const found = [];
    const walk = node => {
      const classes = String(node.className).split(/\s+/);
      if (wantClass && classes.includes(wantClass)) found.push(node);
      if (wantId && node.id === wantId) found.push(node);
      for (const child of node.children) walk(child);
    };
    walk(this);
    return found;
  }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
}

function installDom({ phone = false, world = true } = {}) {
  const body = new Elem('body');
  let host = body;
  if (world) {
    host = new Elem('div');
    host.id = 'imperfect-world';
    host.setAttribute('id', 'imperfect-world');
    body.append(host);
  }
  globalThis.document = {
    body,
    createElement: tag => new Elem(tag),
    getElementById: id => body.querySelector(`#${id}`),
  };
  globalThis.location = { protocol: 'http:', host: '127.0.0.1:9', origin: 'http://127.0.0.1:9' };
  globalThis.innerWidth = phone ? 390 : 1280;
  globalThis.innerHeight = phone ? 844 : 720;
  globalThis.matchMedia = query => ({
    matches: phone && (query.includes('coarse') || query.includes('700px')),
  });
  const created = [];
  const revoked = [];
  let n = 0;
  globalThis.URL.createObjectURL = blob => {
    const url = `blob:test/${++n}`;
    created.push({ url, blob });
    return url;
  };
  globalThis.URL.revokeObjectURL = url => { revoked.push(url); };
  // The booting card listens for the page's own "I am running" message.
  const heard = new Set();
  globalThis.addEventListener = (type, fn) => { if (type === 'message') heard.add(fn); };
  globalThis.removeEventListener = (type, fn) => { if (type === 'message') heard.delete(fn); };
  const post = event => { for (const fn of [...heard]) fn(event); };
  return { body, host, created, revoked, post };
}

test('classifyContent reads kind, mime, name, and studio media path', () => {
  assert.equal(classifyContent('notes'), 'text');
  assert.equal(classifyContent({ kind: 'video', src: 'https://evil.example/x' }), 'video');
  assert.equal(classifyContent({ file: { type: 'image/png', name: 'a.png' } }), 'image');
  assert.equal(classifyContent({ name: 'clip.mp4' }), 'video');
  assert.equal(classifyContent({ src: '/content/media/proj/asset' }), 'video');
  assert.equal(classifyContent({ name: 'notes.txt' }), 'text');
  assert.equal(classifyContent({ name: 'pack.zip' }), 'unknown');
  assert.equal(classifyContent({}), 'empty');
});

test('isAllowedSrc allows blob, safe data, and in-app paths; refuses the rest', () => {
  globalThis.location = { protocol: 'http:', host: '127.0.0.1:9', origin: 'http://127.0.0.1:9' };
  assert.equal(isAllowedSrc('blob:http://127.0.0.1/abc'), true);
  assert.equal(isAllowedSrc('data:image/png;base64,aaaa'), true);
  assert.equal(isAllowedSrc('data:text/plain,hi'), true);
  assert.equal(isAllowedSrc('/content/media/proj/asset'), true);
  assert.equal(isAllowedSrc('/content/media/proj/../asset'), false);
  assert.equal(isAllowedSrc('//evil.example/clip.mp4'), false);
  assert.equal(isAllowedSrc('data:text/html,<script>alert(1)</script>'), false);
  assert.equal(isAllowedSrc('javascript:alert(1)'), false);
  assert.equal(isAllowedSrc('https://evil.example/clip.mp4'), false);
  assert.equal(isAllowedSrc('http://127.0.0.1:9/content/media/p/a'), true);
  assert.equal(isAllowedSrc('https://evil.example/clip.mp4', { allowExternal: true }), true);
  assert.equal(isAllowedSrc('javascript:alert(1)', { allowExternal: true }), false);
});

test('show mounts a desk-shaped window with a parent body host', async () => {
  const { body, host } = installDom();
  const review = mountReviewWindow();
  await review.show({ title: 'Clip title', kind: 'video', src: '/content/media/proj/asset' });
  assert.equal(review.isOpen(), true);
  const panel = host.querySelector('#review-panel');
  assert.ok(panel);
  assert.equal(panel.parentElement.id, 'imperfect-world');
  assert.equal(panel.attrs.role, 'dialog');
  assert.equal(panel.attrs['aria-modal'], 'false');
  assert.equal(panel.attrs['aria-label'], 'Clip title');
  assert.equal(host.querySelector('.review-status').textContent, 'Clip title');
  assert.ok(host.querySelector('.review-controls'));
  assert.equal(host.querySelector('.review-close'), null, 'Alt+W closes a window; no button repeats it');
  assert.equal(host.querySelector('.review-expand'), null);
  assert.equal(host.querySelectorAll('.review-corner').length, 0);
  assert.equal(body.querySelector('.desk-panel'), null);
  const video = host.querySelector('.review-video');
  assert.equal(video.tagName, 'VIDEO');
  assert.equal(video.src, '/content/media/proj/asset');
  assert.equal(video.controls, true);
  assert.equal(video.playsInline, true);
  assert.equal(video.autoplay, false);
  assert.equal(host.querySelector('iframe'), null);
  assert.equal(review.body, host.querySelector('.review-body'));
  assert.equal(review.body.children.length, 0);
});

test('parent can fill the body host without the window parsing HTML', async () => {
  const { host } = installDom();
  const review = mountReviewWindow();
  await review.show({ title: 'Clip', src: '/content/media/p/a' });
  const approve = document.createElement('button');
  approve.type = 'button';
  approve.textContent = 'approve';
  review.body.append(approve);
  const blocked = document.createElement('p');
  blocked.textContent = 'connection blocked';
  review.body.append(blocked);
  assert.equal(host.querySelector('.review-body').children.length, 2);
  assert.equal(approve.innerHTML, '');
  assert.equal(review.body.innerHTML, '');
  await review.show({ title: 'Clip 2', src: '/content/media/p/b' });
  assert.equal(review.body, host.querySelector('.review-body'));
  assert.equal(review.body.children.length, 2);
  assert.equal(host.querySelector('.review-video').src, '/content/media/p/b');
  assert.equal(host.querySelector('.review-status').textContent, 'Clip 2');
});

test('open is show', async () => {
  installDom();
  const review = mountReviewWindow();
  assert.equal(review.open, review.show);
});

test('video from a File uses native controls, never a scripted iframe', async () => {
  const { host } = installDom();
  const review = mountReviewWindow();
  await review.open({ file: { name: 'clip.mp4', type: 'video/mp4' } });
  assert.equal(host.querySelector('iframe'), null);
  const video = host.querySelector('.review-video');
  assert.equal(video.tagName, 'VIDEO');
  assert.equal(video.src.startsWith('blob:'), true);
  assert.equal(host.querySelector('script'), null);
});

test('text is inert textContent, including script source', async () => {
  const { host } = installDom();
  const review = mountReviewWindow();
  await review.open({ text: '<script>alert(1)</script><img src=x onerror=alert(1)>' });
  const pre = host.querySelector('.review-text');
  assert.equal(pre.tagName, 'PRE');
  assert.equal(pre.textContent, '<script>alert(1)</script><img src=x onerror=alert(1)>');
  assert.equal(pre.innerHTML, '');
  assert.equal(pre.children.length, 0);
  assert.equal(host.querySelector('script'), null);
  assert.equal(host.querySelector('img'), null);
});

test('external http src is refused and not assigned', async () => {
  const { host } = installDom();
  const review = mountReviewWindow();
  await review.show({ kind: 'video', title: 'clip', src: 'https://evil.example/clip.mp4' });
  assert.equal(review.isOpen(), true);
  assert.equal(host.querySelector('video'), null);
  const note = host.querySelector('.review-blocked');
  assert.ok(note);
  assert.match(note.textContent, /blocked/i);
  assert.equal(review.content().kind, 'blocked');
  assert.ok(review.body);
});

test('show does not focus the panel or the media', async () => {
  const { host } = installDom();
  const review = mountReviewWindow();
  await review.show({ title: 'Clip', src: '/content/media/p/a' });
  assert.equal(host.querySelector('#review-panel').focused, false);
  assert.equal(host.querySelector('.review-video').focused, false);
  assert.equal(host.querySelector('.review-video').attrs.autofocus, undefined);
});

test('close removes the panel and revokes an owned object URL', async () => {
  const { host, created, revoked } = installDom();
  const review = mountReviewWindow();
  await review.open({ file: { name: 'a.png', type: 'image/png' } });
  assert.equal(created.length, 1);
  review.close();
  assert.equal(review.isOpen(), false);
  assert.equal(review.body, null);
  assert.equal(host.children.length, 0);
  assert.deepEqual(revoked, [created[0].url]);
});

test('replacing content revokes the previous owned URL', async () => {
  const { host, created, revoked } = installDom();
  const review = mountReviewWindow();
  await review.open({ file: { name: 'a.png', type: 'image/png' } });
  await review.open({ file: { name: 'b.mp4', type: 'video/mp4' } });
  assert.equal(created.length, 2);
  assert.deepEqual(revoked, [created[0].url]);
  assert.equal(host.querySelector('.review-video').src, created[1].url);
  review.close();
  assert.deepEqual(revoked, [created[0].url, created[1].url]);
});

test('close during a slow text read does not paint a superseded body', async () => {
  const { host } = installDom();
  const review = mountReviewWindow();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const first = review.open({
    name: 'slow.txt',
    type: 'text/plain',
    file: { name: 'slow.txt', type: 'text/plain', async text() { await gate; return 'stale'; } },
  });
  review.close();
  release();
  await first;
  assert.equal(review.isOpen(), false);
  assert.equal(review.body, null);
  assert.equal(host.children.length, 0);
});

test('unknown files stay closed as a message, not HTML', async () => {
  const { host } = installDom();
  const review = mountReviewWindow();
  await review.open({ name: 'pack.zip', type: 'application/zip' });
  assert.equal(host.querySelector('iframe'), null);
  assert.match(host.querySelector('.review-unknown').textContent, /pack\.zip/);
});

test('the window fills the slot the shell gives it, with no pixel sizing', async () => {
  const { host } = installDom({ phone: true });
  const slots = [];
  const review = mountReviewWindow({ host: () => { const slot = document.createElement('div'); slot.className = 'om-frame'; host.append(slot); slots.push(slot); return slot; } });
  await review.show({ title: 'Clip', src: '/content/media/p/a' });
  const panel = slots[0].querySelector('#review-panel');
  assert.ok(panel, 'the window mounts inside the slot, not the pager');
  assert.ok(panel.classList.contains('review-phone'));
  // One viewport per application: CSS fills the frame, so nothing writes pixels
  // and a rotation costs no relayout from script.
  assert.deepEqual(panel.style, {}, 'no inline geometry is written at all');
});

test('there is no fullscreen state: rotating is how a window gets the larger view', async () => {
  const { host } = installDom();
  const review = mountReviewWindow();
  await review.open({ text: 'x' });
  const panel = host.querySelector('#review-panel');
  const viewport = host.querySelector('.review-viewport');
  const tap = () => {
    const payload = { button: 0, pointerId: 1, clientX: 20, clientY: 20, target: viewport, preventDefault() {} };
    for (const fn of viewport.listeners.pointerdown ?? []) fn(payload);
  };
  tap(); tap();
  assert.equal(panel.classList.contains('expanded'), false, 'double-tap no longer expands');
  assert.deepEqual(panel.style, {});
  review.close();
  assert.equal(review.isOpen(), false);
});

test('page is the empty container: any in-app page is framed, a foreign one is not', async () => {
  const { host } = installDom();
  const review = mountReviewWindow();
  await review.show({ kind: 'page', title: 'files', src: '/files.html' });
  const frame = host.querySelector('.review-page-frame');
  assert.ok(frame, 'an in-app page is framed whole');
  assert.equal(frame.attrs.src ?? frame.src, '/files.html');
  await review.show({ kind: 'page', title: 'evil', src: 'https://example.com/x.html' });
  assert.equal(host.querySelector('.review-page-frame'), null);
  assert.match(host.querySelector('.review-blocked').textContent, /in-app/);
});

test('an ordinary page is up when it has loaded', async () => {
  const { host } = installDom();
  const review = mountReviewWindow();
  await review.show({ kind: 'page', title: 'files', src: '/files.html' });
  const card = host.querySelector('.review-loading');
  assert.ok(card, 'a frame that has not loaded says so rather than sitting blank');
  assert.equal(card.querySelector('.review-loading-name').textContent, 'files');
  const frame = host.querySelector('.review-page-frame');
  for (const fn of frame.listeners.load ?? []) fn();
  assert.equal(host.querySelector('.review-loading'), null);
});

test('a booting page waits for the page to say it is running, not for load', async () => {
  const { host, post } = installDom();
  const review = mountReviewWindow();
  await review.show({ kind: 'page', title: 'Doom', src: '/doom/index.html' });
  const frame = host.querySelector('.review-page-frame');
  for (const fn of frame.listeners.load ?? []) fn();
  assert.ok(host.querySelector('.review-loading'), 'Doom is still fetching a WAD when the frame loads');
  post({ source: frame.contentWindow, data: { type: 'imperfect:ready' } });
  assert.equal(host.querySelector('.review-loading'), null);
});

test("one frame saying it is running does not clear another window's card", async () => {
  const { host, post } = installDom();
  const review = mountReviewWindow();
  await review.show({ kind: 'page', title: 'Doom', src: '/doom/index.html' });
  post({ source: { other: true }, data: { type: 'imperfect:ready' } });
  assert.ok(host.querySelector('.review-loading'));
  review.close();
});

test('a foreign page is refused, unless this one window was mounted to allow it', async () => {
  const { host } = installDom();
  const shut = mountReviewWindow();
  await shut.show({ kind: 'page', title: 'screen', src: 'https://box.on.ascii.dev/vnc?token=secret' });
  assert.equal(host.querySelector('.review-page-frame'), null, 'a window the agent opens frames nothing foreign');
  assert.ok(host.querySelector('.review-blocked'));
  assert.equal(shut.content().kind, 'blocked');
  shut.close();

  const open = mountReviewWindow({ allowExternal: true });
  await open.show({ kind: 'page', title: 'desktop', src: 'https://box.on.ascii.dev/vnc?token=secret' });
  const frame = host.querySelector('.review-page-frame');
  assert.ok(frame, 'the machine\'s own screen is the one caller that may');
  assert.equal(frame.src, 'https://box.on.ascii.dev/vnc?token=secret');
  // No sandbox: the stream needs its own origin and its socket.
  assert.equal(frame.attrs.sandbox, undefined);
  open.close();
});

test('allowExternal is for the src, not for the page: a javascript: url is still refused', async () => {
  const { host } = installDom();
  const review = mountReviewWindow({ allowExternal: true });
  await review.show({ kind: 'page', title: 'x', src: 'javascript:alert(1)' });
  assert.equal(host.querySelector('.review-page-frame'), null);
  assert.ok(host.querySelector('.review-blocked'));
  review.close();
});
