// Pure cursor restoration for the browser's dynamic MainDef rows.

// MainDef.lastOn is a stable integer in vanilla because its item array never
// changes after M_Init. The browser prepends Continue during a user game and
// omits unsupported/mode-specific rows, so restore the same logical item when
// possible. If that item disappeared, New Game is the source-defined root
// fallback; before any item has been remembered, retain the initial row index.
export function M_RestoreMainCursor(itemKeys, lastItemKey, initialIndex = 0) {
  if (!Array.isArray(itemKeys) || itemKeys.length === 0) return -1;

  if (typeof lastItemKey === 'string') {
    const semantic = itemKeys.indexOf(lastItemKey);
    if (semantic !== -1) return semantic;

    const newGame = itemKeys.indexOf('newgame');
    if (newGame !== -1) return newGame;
  }

  return Math.max(0, Math.min(itemKeys.length - 1, initialIndex | 0));
}
