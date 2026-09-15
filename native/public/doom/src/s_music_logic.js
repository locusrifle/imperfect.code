// Pure level-music routing from s_sound.c:S_Start.

import { GameMode_t } from './doomdef.js';
import {
  mus_e1m1,
  mus_e1m5,
  mus_e1m9,
  mus_e2m4,
  mus_e2m5,
  mus_e2m6,
  mus_e2m7,
  mus_e3m2,
  mus_e3m3,
  mus_e3m4,
  mus_runnin,
} from './sounds.js';

// Ultimate Doom reuses these E1-E3 tracks because it has no D_E4M* lumps.
const E4_MUSIC = Object.freeze([
  mus_e3m4,
  mus_e3m2,
  mus_e3m3,
  mus_e1m5,
  mus_e2m7,
  mus_e2m4,
  mus_e2m6,
  mus_e2m5,
  mus_e1m9,
]);

export function S_LevelMusic(gamemode, gameepisode, gamemap) {
  if (gamemode === GameMode_t.commercial) return mus_runnin + gamemap - 1;
  if (gameepisode < 4) return mus_e1m1 + (gameepisode - 1) * 9 + gamemap - 1;
  return E4_MUSIC[gamemap - 1];
}
