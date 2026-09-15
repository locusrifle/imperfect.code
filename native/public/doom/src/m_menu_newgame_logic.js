// Pure routing rule from m_menu.c:M_NewGame.

import { GameMode_t } from './doomdef.js';

export function M_NewGameRoute(netgame, demoplayback, gamemode) {
  if (netgame === true && demoplayback !== true) return 'message';
  return gamemode === GameMode_t.commercial ? 'skill' : 'episode';
}
