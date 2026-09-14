import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutKnowledgeTree, treeConnector } from '../public/js/graph-layout.js';

const home = {
	root: 'agents',
	nodes: ['agents', 'emails', 'projects', 'practice', 'garden', 'rifle', 'site'].map(id => ({ id })),
	edges: [['agents', 'emails'], ['agents', 'projects'], ['agents', 'practice'], ['projects', 'garden'], ['projects', 'rifle'], ['projects', 'site'], ['emails', 'agents'], ['garden', 'emails'], ['site', 'garden'], ['rifle', 'projects']],
};
const sizes = (data, expanded) => new Map(data.nodes.map(n => [n.id, n.id === expanded ? { cellW: 14, cellH: 10 } : { cellW: 4, cellH: 1 }]));
function check(tree, expanded) {
	const all = [...tree.boxes.values()];
	for (const b of all) for (const key of ['left', 'top', 'w', 'h', 'x']) assert.equal(Number.isInteger(b[key]), true, `${b.id}.${key}`);
	for (const [parent, kids] of tree.children) {
		const p = tree.boxes.get(parent);
		const boxes = kids.map(id => tree.boxes.get(id));
		if (!boxes.length) continue;
		const byRow = new Map();
		for (const b of boxes) {
			const key = b.top + b.h;
			if (!byRow.has(key)) byRow.set(key, []);
			byRow.get(key).push(b);
		}
		for (const row of byRow.values()) {
			row.sort((a, b) => a.left - b.left);
			assert.equal((row[0].x + row.at(-1).x) / 2, p.x, 'parent centred on each row');
			for (let i = 1; i < row.length - 1; i++) assert.equal(row[i].x - row[i - 1].x, row[i + 1].x - row[i].x, 'equal sibling spacing');
		}
		for (const b of boxes) {
			assert.ok(b.top + b.h <= p.top - 2, 'tree grows upwards with a connector gutter');
			const numbers = [...treeConnector(p, b, 1).matchAll(/-?\d+(?:\.\d+)?/g)].map(m => Number(m[0]));
			assert.ok(numbers.every(Number.isInteger), 'ports and segments on cell lines');
		}
	}
	for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
		const a = all[i], b = all[j];
		if (expanded && (a.id === expanded || b.id === expanded)) continue;
		assert.ok(a.left + a.w <= b.left || b.left + b.w <= a.left || a.top + a.h <= b.top || b.top + b.h <= a.top, `${a.id} overlaps ${b.id}`);
	}
}

test('home is an upward symmetric tree, not an undirected web or wrapped chain', () => {
	const tree = layoutKnowledgeTree(home, sizes(home));
	check(tree);
	assert.equal(tree.edges.length, home.nodes.length - 1);
	assert.deepEqual(tree.children.get('agents'), ['emails', 'projects', 'practice']);
	assert.deepEqual(tree.children.get('projects'), ['garden', 'rifle', 'site']);
	assert.equal(tree.boxes.get('projects').x, 0, 'projects is the central trunk');
	assert.equal(tree.boxes.get('rifle').x, 0);
	assert.equal(tree.bounds.right - tree.bounds.left, 16, 'a three-card crown fits a phone without breaking the tree');
});

test('any card can expand without losing symmetry, upward direction, or overlap guarantees', () => {
	for (const node of home.nodes) check(layoutKnowledgeTree(home, sizes(home, node.id)), node.id);
});

test('unequal titles, uneven depths and even sibling counts still centre on grid intersections', () => {
	const data = { root: 'r', nodes: ['r', 'a', 'b', 'c', 'd', 'e', 'f', 'g'].map(id => ({ id })), edges: [['r', 'a'], ['r', 'b'], ['a', 'c'], ['a', 'd'], ['a', 'e'], ['b', 'f'], ['c', 'g']] };
	const measured = new Map(data.nodes.map((n, i) => [n.id, { cellW: 4 + 2 * (i % 3), cellH: 1 + (i % 2) }]));
	check(layoutKnowledgeTree(data, measured));
});

test('wide sibling sets wrap into centred rows instead of becoming a chain or a jammed paragraph', () => {
	const nodes = ['r', ...Array.from({ length: 6 }, (_, i) => `c${i}`)];
	const data = { root: 'r', nodes: nodes.map(id => ({ id })), edges: nodes.slice(1).map(id => ['r', id]) };
	const sized = new Map(nodes.map(id => [id, { cellW: 4, cellH: 1 }]));
	const tree = layoutKnowledgeTree(data, sized, { maxSpan: 16 });
	check(tree);
	const tops = new Set(nodes.slice(1).map(id => tree.boxes.get(id).top));
	assert.equal(tops.size, 2);
});

test('cyclic links and unknown capped nodes cannot become extra roots or recurse forever', () => {
	const data = { root: 'r', nodes: [{ id: 'r' }, { id: 'a' }], edges: [['r', 'a'], ['a', 'r'], ['a', 'absent'], ['r', 'r']] };
	const tree = layoutKnowledgeTree(data, sizes(data));
	assert.deepEqual(tree.edges, [['r', 'a']]);
	check(tree);
});
