// Pure intermission input polling shared by WI_Ticker and regression tests.
// wi_stuff.c deliberately ignores raw responder events and detects only
// rising BT_ATTACK / BT_USE edges from each active player's ticcmd.

import { BT_ATTACK, BT_USE } from './d_event.js';

export function WI_CheckForAccelerate(players, playeringame) {
  let accelerate = false;
  const count = Math.min(players.length, playeringame.length);

  for (let i = 0; i < count; i++) {
    if (playeringame[i] !== true) continue;
    const player = players[i];
    if (player === null || player === undefined) continue;
    const buttons = player.cmd?.buttons | 0;

    if ((buttons & BT_ATTACK) !== 0) {
      if (!player.attackdown) accelerate = true;
      player.attackdown = 1;
    } else {
      player.attackdown = 0;
    }

    if ((buttons & BT_USE) !== 0) {
      if (!player.usedown) accelerate = true;
      player.usedown = 1;
    } else {
      player.usedown = 0;
    }
  }

  return accelerate;
}
