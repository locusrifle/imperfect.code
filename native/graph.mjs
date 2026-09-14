import { lstat, open, readFile, realpath } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';

export const DEFAULT_MAX_FILES = 64;
export const DEFAULT_MAX_EDGES = 128;
export const DEFAULT_MAX_BYTES = 256 * 1024;
const WIKI = /\[\[([^\]|#]+)(?:#([^\]|]+))?(?:\|([^\]]+))?\]\]/g;

export function parseWikilinks(text) {
  const links = [];
  const re = new RegExp(WIKI.source, 'g');
  let m;
  while ((m = re.exec(text))) {
    links.push({
      target: m[1].trim(),
      heading: m[2]?.trim() || '',
      alias: m[3]?.trim() || '',
    });
  }
  return links;
}

function slug(name) {
  return name.replace(/\.md$/i, '').replace(/\\/g, '/');
}

async function insideRoot(rootReal, candidate) {
  try {
    const real = await realpath(candidate);
    const prefix = rootReal.endsWith(sep) ? rootReal : rootReal + sep;
    if (real !== rootReal && !real.startsWith(prefix)) return null;
    return real;
  } catch {
    return null;
  }
}

async function resolveMarkdown(rootReal, fromDir, target) {
  const raw = target.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!raw || raw.includes('\0') || raw.includes('..')) return null;
  const base = slug(raw);
  const tries = [
    join(fromDir, `${base}.md`),
    join(fromDir, base),
    join(rootReal, `${base}.md`),
    join(rootReal, base),
  ];
  const extra = [];
  for (const p of tries) {
    extra.push(p.replace(/agents\.md$/i, 'AGENTS.md'));
    extra.push(p.replace(/AGENTS\.md$/, 'agents.md'));
  }
  for (const candidate of [...tries, ...extra]) {
    const real = await insideRoot(rootReal, candidate);
    if (!real) continue;
    try {
      const st = await lstat(real);
      if (st.isDirectory()) continue;
      if (!real.toLowerCase().endsWith('.md')) continue;
      return real;
    } catch {
      /* missing */
    }
  }
  return null;
}

function nodeId(rootReal, fileReal) {
  const rel = relative(rootReal, fileReal).replace(/\\/g, '/');
  return slug(rel) || 'root';
}

function titleFrom(text, fallback) {
  const line = text.split('\n').find(l => l.startsWith('# '));
  return line ? line.slice(2).trim() : fallback;
}

export async function readBounded(file, maxBytes) {
  const st = await lstat(file);
  if (st.size <= maxBytes) {
    return { text: await readFile(file, 'utf8'), truncated: false, bytes: st.size };
  }
  const fh = await open(file, 'r');
  try {
    const buf = Buffer.alloc(maxBytes);
    const { bytesRead } = await fh.read(buf, 0, maxBytes, 0);
    return { text: buf.subarray(0, bytesRead).toString('utf8'), truncated: true, bytes: st.size };
  } finally {
    await fh.close();
  }
}

export async function walkKnowledgeGraph(options = {}) {
  const rootDir = options.root;
  if (!rootDir) throw new Error('knowledge root required');
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxNodes = options.maxNodes ?? maxFiles;
  const maxEdges = options.maxEdges ?? DEFAULT_MAX_EDGES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const rootReal = await realpath(rootDir);
  const startName = options.start ?? 'AGENTS.md';
  const startReal = await resolveMarkdown(rootReal, rootReal, startName)
    ?? await resolveMarkdown(rootReal, rootReal, 'agents.md');
  if (!startReal) throw new Error('knowledge root has no AGENTS.md');

  const nodes = [];
  const edges = [];
  const queue = [startReal];
  const seen = new Set();
  const missingIds = new Set();
  let truncated = false;
  let filesRead = 0;

  const canAddNode = () => nodes.length < maxNodes;
  const canAddEdge = () => edges.length < maxEdges;

  while (queue.length) {
    if (filesRead >= maxFiles || !canAddNode()) {
      truncated = true;
      break;
    }
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    const { text, truncated: fileCut } = await readBounded(file, maxBytes);
    if (fileCut) truncated = true;
    filesRead += 1;
    const id = nodeId(rootReal, file);
    nodes.push({
      id,
      path: relative(rootReal, file).replace(/\\/g, '/'),
      label: titleFrom(text, id),
      missing: false,
    });
    for (const link of parseWikilinks(text)) {
      const resolved = await resolveMarkdown(rootReal, dirname(file), link.target);
      if (!resolved) {
        const missId = `missing:${link.target.toLowerCase()}`;
        if (!missingIds.has(missId) && !nodes.some(n => n.id === missId)) {
          if (!canAddNode()) { truncated = true; continue; }
          missingIds.add(missId);
          nodes.push({ id: missId, path: null, label: link.alias || link.target, missing: true });
        }
        if (!canAddEdge()) { truncated = true; continue; }
        edges.push({ from: id, to: missId, alias: link.alias || '', heading: link.heading || '' });
        continue;
      }
      if (!canAddEdge()) { truncated = true; continue; }
      const toId = nodeId(rootReal, resolved);
      edges.push({ from: id, to: toId, alias: link.alias || '', heading: link.heading || '' });
      if (seen.has(resolved) || queue.includes(resolved)) continue;
      if (filesRead + queue.length >= maxFiles || nodes.length + queue.length >= maxNodes) {
        truncated = true;
        continue;
      }
      queue.push(resolved);
    }
  }
  if (queue.length) truncated = true;

  return {
    root: nodeId(rootReal, startReal),
    rootDir: rootReal,
    truncated,
    nodes,
    edges,
  };
}

export async function readKnowledgePage(options = {}) {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const graph = options.graph ?? await walkKnowledgeGraph(options);
  const id = String(options.id ?? graph.root);
  if (id.startsWith('missing:')) {
    return { id, missing: true, title: id.slice(8), content: '', links: [] };
  }
  const node = graph.nodes.find(n => n.id === id);
  if (!node || !node.path) {
    const err = new Error('unknown page');
    err.code = 'UNKNOWN';
    throw err;
  }
  const file = join(graph.rootDir, node.path);
  const real = await insideRoot(graph.rootDir, file);
  if (!real) {
    const err = new Error('escaped root');
    err.code = 'ESCAPE';
    throw err;
  }
  const { text, truncated } = await readBounded(real, maxBytes);
  return {
    id: node.id,
    missing: false,
    truncated,
    title: node.label,
    content: text,
    links: parseWikilinks(text),
  };
}
