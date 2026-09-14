// A rooted view of the wiki, not a drawing of every backlink. Cross-references
// stay in the readable pages. Cell-space geometry keeps drawing and grid identical.
export function knowledgeTree(data) {
	const ids = new Set(data.nodes.map(node => node.id));
	const outgoing = new Map();
	for (const edge of data.edges) {
		const [from, to] = Array.isArray(edge) ? edge : [edge.from, edge.to];
		if (!ids.has(from) || !ids.has(to) || from === to) continue;
		if (!outgoing.has(from)) outgoing.set(from, []);
		outgoing.get(from).push(to);
	}
	const children = new Map();
	const depth = new Map([[data.root, 0]]);
	const queue = [data.root];
	const edges = [];
	for (let i = 0; i < queue.length; i++) {
		const id = queue[i];
		const kids = [];
		for (const to of outgoing.get(id) || []) {
			if (depth.has(to)) continue;
			depth.set(to, depth.get(id) + 1);
			kids.push(to);
			queue.push(to);
			edges.push([id, to]);
		}
		children.set(id, kids);
	}
	return { children, depth, edges };
}

function shift(box, dx, dy) {
	return { ...box, x: box.x + dx, left: box.left + dx, top: box.top + dy };
}

export function layoutKnowledgeTree(data, sizes, { maxSpan = Infinity } = {}) {
	const tree = knowledgeTree(data);
	const gap = 2;
	const size = id => sizes.get(id) || { cellW: 4, cellH: 1 };

	function pack(ids) {
		const rows = [];
		let row = [];
		let used = 0;
		for (const id of ids) {
			const w = size(id).cellW;
			const need = row.length ? used + gap + w : w;
			if (row.length && need > maxSpan) {
				rows.push(row);
				row = [id];
				used = w;
			} else {
				row.push(id);
				used = need;
			}
		}
		if (row.length) rows.push(row);
		return rows;
	}

	function branch(id) {
		const { cellW: w, cellH: h } = size(id);
		const boxes = new Map([[id, { id, x: 0, left: -w / 2, top: 0, w, h }]]);
		const contour = [{ left: -w / 2, right: w / 2 }];
		let nextBottom = -gap;
		for (const ids of pack(tree.children.get(id) || [])) {
			const kids = ids.map(branch);
			let step = 0;
			for (let i = 0; i < kids.length; i++) {
				for (let j = i + 1; j < kids.length; j++) {
					const a = kids[i].contour, b = kids[j].contour;
					for (let d = 0; d < Math.min(a.length, b.length); d++) {
						step = Math.max(step, (a[d].right - b[d].left + gap) / (j - i));
					}
				}
			}
			step = Math.ceil(step / 2) * 2;
			const merged = [];
			kids.forEach((kid, i) => {
				const dx = (i - (kids.length - 1) / 2) * step;
				const dy = nextBottom - size(kid.id).cellH;
				for (const [cid, box] of kid.boxes) boxes.set(cid, shift(box, dx, dy));
				kid.contour.forEach((c, d) => {
					const prior = merged[d];
					merged[d] = {
						left: Math.min(prior?.left ?? Infinity, c.left + dx),
						right: Math.max(prior?.right ?? -Infinity, c.right + dx),
					};
				});
			});
			contour.push(...merged);
			nextBottom = Math.min(...kids.map((kid, i) => {
				const dx = (i - (kids.length - 1) / 2) * step;
				void dx;
				return kid.bounds.top + (nextBottom - size(kid.id).cellH);
			})) - gap;
		}
		const all = [...boxes.values()];
		return {
			id,
			boxes,
			contour,
			bounds: {
				left: Math.min(...all.map(b => b.left)),
				right: Math.max(...all.map(b => b.left + b.w)),
				top: Math.min(...all.map(b => b.top)),
				bottom: Math.max(...all.map(b => b.top + b.h)),
			},
		};
	}

	if (!data.nodes.length) {
		return { ...tree, boxes: new Map(), bounds: { left: 0, right: 0, top: 0, bottom: 0 } };
	}
	const laid = branch(data.root);
	const root = laid.boxes.get(data.root);
	const boxes = new Map();
	for (const [id, box] of laid.boxes) boxes.set(id, shift(box, 0, -(root.top + root.h)));
	const all = [...boxes.values()];
	return {
		...tree,
		boxes,
		bounds: {
			left: Math.min(...all.map(b => b.left)),
			right: Math.max(...all.map(b => b.left + b.w)),
			top: Math.min(...all.map(b => b.top)),
			bottom: 0,
		},
	};
}

export function treeConnector(parent, child, unit) {
	const ax = parent.left + parent.w / 2;
	const bx = child.left + child.w / 2;
	const ay = parent.top;
	const by = child.top + child.h;
	const junction = by + unit;
	return ax === bx ? `M ${ax} ${ay} L ${bx} ${by}`
		: `M ${ax} ${ay} L ${ax} ${junction} L ${bx} ${junction} L ${bx} ${by}`;
}
