// Pure construction of g_game.c:G_DoCompleted's wbstartstruct_t payload.
// Keeping this separate from the renderer-heavy game module makes the exact
// per-player snapshot (including the frag matrix) deterministic to test.

import { GameMode_t, MAXPLAYERS, TICRATE } from './doomdef.js';

// g_game.c:978/987 — par times in seconds. Episode zero is unused; Linux Doom
// has no episode-four par row and the intermission does not draw E4 par time.
const pars = [
  [0],
  [0, 30, 75, 120, 90, 165, 180, 180, 30, 165],
  [0, 90, 90, 90, 120, 90, 360, 240, 30, 170],
  [0, 90, 45, 90, 150, 90, 90, 165, 30, 135],
];

const cpars = [
   30, 90, 120, 120,  90, 150, 120, 120, 270,  90,
  210, 150, 150, 150, 210, 150, 420, 150, 210, 150,
  240, 150, 180, 150, 150, 300, 330, 420, 300, 180,
  120,  30,
];

export function G_IntermissionParTime(gamemode, episode, map) {
  if (gamemode === GameMode_t.commercial) {
    return map >= 1 && map <= cpars.length ? TICRATE * cpars[map - 1] : 0;
  }
  if (episode < 1 || episode >= pars.length || map < 1 || map > 9) return 0;
  return TICRATE * pars[episode][map];
}

function snapshotFrags(player) {
  const frags = new Int32Array(MAXPLAYERS);
  if (player === null || player === undefined || player.frags == null) return frags;
  for (let i = 0; i < MAXPLAYERS; i++) frags[i] = player.frags[i] | 0;
  return frags;
}

export function G_BuildIntermissionInfo({
  gamemode,
  gameepisode,
  gamemap,
  next,
  maxkills,
  maxitems,
  maxsecret,
  leveltime,
  consoleplayer,
  players,
  playeringame,
}) {
  const console = players[consoleplayer];
  const plyr = new Array(MAXPLAYERS);

  for (let i = 0; i < MAXPLAYERS; i++) {
    const player = players[i];
    plyr[i] = {
      in: playeringame[i] === true,
      skills: player?.killcount | 0,
      sitems: player?.itemcount | 0,
      ssecret: player?.secretcount | 0,
      stime: leveltime | 0,
      frags: snapshotFrags(player),
      // d_player.h:wbplayerstruct_t carries this unused field. Static C
      // storage leaves it at zero; preserve the complete payload shape.
      score: 0,
    };
  }

  return {
    epsd: gameepisode - 1,
    didsecret: console?.didsecret === true,
    last: gamemap - 1,
    next,
    maxkills: maxkills | 0,
    maxitems: maxitems | 0,
    maxsecret: maxsecret | 0,
    maxfrags: 0,
    partime: G_IntermissionParTime(gamemode, gameepisode, gamemap),
    pnum: consoleplayer | 0,
    plyr,
  };
}
