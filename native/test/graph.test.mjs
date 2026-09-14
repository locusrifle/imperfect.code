import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { get } from 'node:http';
import { createGueyServer } from '../../server.mjs';
import { walkKnowledgeGraph, readKnowledgePage, parseWikilinks } from '../graph.mjs';

function stubRuntime(cwd) {
  const events = new EventEmitter();
  const data = { cwd, sessionId: 'g', busy: false, messages: [] };
  return { events, snapshot: () => data, async command() { return {}; }, async close() {} };
}

function httpGet(port, path) {
  return new Promise((resolve, reject) => {
    get({ hostname: '127.0.0.1', port, path, headers: { host: `127.0.0.1:${port}` } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    }).on('error', reject);
  });
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'guey-graph-'));
  const home = join(root, 'home');
  const outside = join(root, 'outside.md');
  await mkdir(home);
  await writeFile(outside, '# secret\n');
  await writeFile(join(home, 'agents.md'), '# Agents\nSee [[locus.garden]] and [[locus.site|portfolio]] and [[gone#heading]] and [[locusrifle]] and [[escape]].\n<script>alert(1)</script>\n');
  await symlink(join(home, 'agents.md'), join(home, 'AGENTS.md'));
  await writeFile(join(home, 'locus.garden.md'), '# Garden\nBack [[agents]].\n');
  await writeFile(join(home, 'locus.site.md'), '# Site\nBack [[AGENTS]].\n');
  await writeFile(join(home, 'locusrifle.md'), '# Rifle\nParent [[agents]]. Escape [[../outside]] and [[/etc/passwd]].\n');
  await symlink(outside, join(home, 'escape.md'));
  return { root, home };
}

test('wikilinks parse aliases and headings', () => {
  const links = parseWikilinks('[[agents#the human|map]] and [[locus.site]]');
  assert.deepEqual(links, [
    { target: 'agents', heading: 'the human', alias: 'map' },
    { target: 'locus.site', heading: '', alias: '' },
  ]);
});

test('walk follows wikilinks, aliases, cycles, symlink root, missing, and refuses escapes', async () => {
  const { root, home } = await fixture();
  try {
    const graph = await walkKnowledgeGraph({ root: home });
    const ids = graph.nodes.map(n => n.id).sort();
    assert.equal(graph.root, 'agents');
    assert.ok(ids.includes('agents'));
    assert.ok(ids.includes('locus.garden'));
    assert.ok(ids.includes('locus.site'));
    assert.ok(ids.includes('locusrifle'));
    assert.ok(ids.some(id => id.startsWith('missing:')));
    assert.ok(!ids.includes('outside'));
    assert.ok(!ids.includes('escape'));
    assert.ok(!graph.nodes.some(n => n.path && n.path.includes('..')));
    const cycle = graph.edges.filter(e => e.from === 'locus.garden' && e.to === 'agents');
    assert.equal(cycle.length, 1);
    const alias = graph.edges.find(e => e.alias === 'portfolio');
    assert.ok(alias);
    const heading = graph.edges.find(e => e.heading === 'heading');
    assert.ok(heading);
    const page = await readKnowledgePage({ graph, id: 'agents' });
    assert.match(page.content, /<script>/);
    await assert.rejects(() => readKnowledgePage({ graph, id: '../../outside' }), /unknown/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('walk respects file bound', async () => {
  const { root, home } = await fixture();
  try {
    const graph = await walkKnowledgeGraph({ root: home, maxFiles: 2 });
    assert.ok(graph.nodes.filter(n => !n.missing).length <= 2);
    assert.ok(graph.nodes.length <= 2);
    assert.equal(graph.truncated, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('many missing links cannot exceed node/edge caps and set truncated', async () => {
  const root = await mkdtemp(join(tmpdir(), 'guey-graph-miss-'));
  const links = Array.from({ length: 40 }, (_, i) => `[[gone-${i}]]`).join(' ');
  await writeFile(join(root, 'agents.md'), `# Agents\n${links}\n`);
  try {
    const graph = await walkKnowledgeGraph({ root, maxFiles: 8, maxNodes: 8, maxEdges: 8 });
    assert.ok(graph.nodes.length <= 8);
    assert.ok(graph.edges.length <= 8);
    assert.equal(graph.truncated, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('oversized file is byte-bounded and truncated', async () => {
  const root = await mkdtemp(join(tmpdir(), 'guey-graph-big-'));
  await writeFile(join(root, 'agents.md'), `# Agents\n${'x'.repeat(4000)}\n[[child]]\n`);
  await writeFile(join(root, 'child.md'), '# Child\n');
  try {
    const graph = await walkKnowledgeGraph({ root, maxBytes: 80 });
    assert.equal(graph.truncated, true);
    const page = await readKnowledgePage({ graph, id: 'agents', maxBytes: 80 });
    assert.equal(page.truncated, true);
    assert.ok(Buffer.byteLength(page.content, 'utf8') <= 80);
    assert.ok(!page.content.includes('[[child]]') || page.content.length <= 80);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('personal graph endpoints; stock 404; path escape 404', async () => {
  const { root, home } = await fixture();
  const runtime = stubRuntime(home);
  const personal = await createGueyServer({
    port: 0, host: '127.0.0.1', stateDir: join(root, 'p'), runtime, product: 'locusrifle', knowledgeRoot: home,
  });
  const stock = await createGueyServer({
    port: 0, host: '127.0.0.1', stateDir: join(root, 's'), runtime, product: 'stock', knowledgeRoot: home,
  });
  const p = await personal.listen();
  const s = await stock.listen();
  try {
    const g = await httpGet(p.port, '/graph.json');
    assert.equal(g.status, 200);
    const data = JSON.parse(g.body);
    assert.equal(data.root, 'agents');
    const page = await httpGet(p.port, '/graph/page?id=agents');
    assert.equal(page.status, 200);
    assert.match(JSON.parse(page.body).content, /<script>/);
    const bad = await httpGet(p.port, '/graph/page?id=../../outside');
    assert.equal(bad.status, 404);
    const passwd = await httpGet(p.port, '/graph/page?id=/etc/passwd');
    assert.equal(passwd.status, 404);
    const stockG = await httpGet(s.port, '/graph.json');
    assert.equal(stockG.status, 404);
    const stockP = await httpGet(s.port, '/graph/page?id=agents');
    assert.equal(stockP.status, 404);
  } finally {
    await personal.close();
    await stock.close();
    await rm(root, { recursive: true, force: true });
  }
});
