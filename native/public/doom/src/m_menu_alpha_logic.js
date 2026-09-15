// Pure alpha-key routing for m_menu.c:M_Responder's default branch.

const code = (letter) => letter.charCodeAt(0);

export const M_ALPHA_KEYS = Object.freeze({
  continue: code('c'), // Browser-only Continue row; no vanilla equivalent.
  main: Object.freeze([
    code('n'), code('o'), code('l'), code('s'), code('r'), code('q'),
  ]),
  episode: Object.freeze([code('k'), code('t'), code('i'), code('t')]),
  skill: Object.freeze([code('i'), code('h'), code('h'), code('u'), code('n')]),
  // The browser Options menu deliberately omits the source End Game row.
  options: Object.freeze([code('m'), code('g'), code('s'), 0, code('m'), 0, code('s')]),
  sound: Object.freeze([code('s'), 0, code('m'), 0]),
  slots: Object.freeze([code('1'), code('2'), code('3'), code('4'), code('5'), code('6')]),
});

export function M_FindAlphaItem(items, itemOn, key) {
  // m_menu.c:1696-1715 deliberately uses two scans instead of beginning at
  // the current row: duplicate letters advance to the next matching row and
  // wrap, while a unique letter eventually re-selects the current row.
  for (let i = itemOn + 1; i < items.length; i++) {
    if ((items[i].alphaKey ?? 0) === key) return i;
  }
  for (let i = 0; i <= itemOn && i < items.length; i++) {
    if ((items[i].alphaKey ?? 0) === key) return i;
  }
  return -1;
}
