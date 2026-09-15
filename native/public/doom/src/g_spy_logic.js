// Pure helpers for g_game.c:G_Responder's F12 spy-mode branch.

import { KEY_F12, MAXPLAYERS, gamestate_t } from './doomdef.js';
import { evtype_t } from './d_event.js';

export function G_ShouldCycleDisplayPlayer(
  gamestate,
  eventType,
  key,
  singledemo,
  deathmatch,
) {
  return gamestate === gamestate_t.GS_LEVEL &&
    eventType === evtype_t.ev_keydown &&
    key === KEY_F12 &&
    (singledemo === true || deathmatch === 0);
}

export function G_NextDisplayPlayer(current, consoleplayer, playeringame) {
  let next = current;
  do {
    next++;
    if (next === MAXPLAYERS) next = 0;
  } while (playeringame[next] !== true && next !== consoleplayer);
  return next;
}
