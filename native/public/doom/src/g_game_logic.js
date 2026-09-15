// Pure game-transition helpers split out of g_game.js so WAD-dependent
// routing can be regression-tested without loading the renderer.

import { GameMode_t } from './doomdef.js';

// g_game.c:G_SecretExitLevel — commercial secret exits are disabled when the
// IWAD omits MAP31 (notably the censored German release). Doom 1 never checks
// for a MAP31 lump because its secret levels use the ExM9 namespace.
export function G_SecretExitAvailable(mode, checkNumForName) {
  return mode !== GameMode_t.commercial || checkNumForName('MAP31') >= 0;
}
