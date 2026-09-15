// Pure finale routing/data helpers shared by g_game.js and f_finale.js.
// Keeping these free of browser/audio dependencies makes the map breakpoints
// and selected text/background straightforward to regression-test.

import { GameMode_t } from './doomdef.js';
import {
  E1TEXT, E2TEXT, E3TEXT, E4TEXT,
  C1TEXT, C2TEXT, C3TEXT, C4TEXT, C5TEXT, C6TEXT,
} from './d_englsh.js';

const DOOM1_FINALES = Object.freeze({
  1: Object.freeze({ flat: 'FLOOR4_8', text: E1TEXT }),
  2: Object.freeze({ flat: 'SFLR6_1',  text: E2TEXT }),
  3: Object.freeze({ flat: 'MFLR8_4',  text: E3TEXT }),
  4: Object.freeze({ flat: 'MFLR8_3',  text: E4TEXT }),
});

const DOOM2_FINALES = Object.freeze({
  6:  Object.freeze({ flat: 'SLIME16', text: C1TEXT }),
  11: Object.freeze({ flat: 'RROCK14', text: C2TEXT }),
  20: Object.freeze({ flat: 'RROCK07', text: C3TEXT }),
  30: Object.freeze({ flat: 'RROCK17', text: C4TEXT }),
  15: Object.freeze({ flat: 'RROCK13', text: C5TEXT }),
  31: Object.freeze({ flat: 'RROCK19', text: C6TEXT }),
});

// f_finale.c:F_StartFinale selects finale content from game mode plus the
// episode/map that just ended. The fallback mirrors the indetermined-mode C
// path and also keeps malformed/custom games from drawing undefined content.
export function F_GetFinaleSpec(mode, episode, map) {
  if (mode === GameMode_t.commercial) {
    return DOOM2_FINALES[map] || Object.freeze({ flat: 'F_SKY1', text: C1TEXT });
  }
  if (mode === GameMode_t.shareware ||
      mode === GameMode_t.registered ||
      mode === GameMode_t.retail) {
    return DOOM1_FINALES[episode] || DOOM1_FINALES[1];
  }
  // f_finale.c's default/indetermined branch is deliberately Doom-II-like,
  // independent of the episode number.
  return Object.freeze({ flat: 'F_SKY1', text: C1TEXT });
}

// g_game.c:G_WorldDone: normal chapter breaks follow MAP06/11/20/30. The
// MAP15 and MAP31 messages are shown only when their secret exit was taken.
export function F_ShouldStartCommercialFinale(mode, map, secretExit) {
  if (mode !== GameMode_t.commercial) return false;
  if (map === 6 || map === 11 || map === 20 || map === 30) return true;
  return secretExit === true && (map === 15 || map === 31);
}

// f_finale.c:F_ArtScreenDrawer — Ultimate Doom replaces E1's HELP2 page with
// CREDIT; registered/shareware keep HELP2. E3 is handled by the bunny scroll.
export function F_GetDoom1ArtPatch(mode, episode) {
  if (episode === 1) return mode === GameMode_t.retail ? 'CREDIT' : 'HELP2';
  if (episode === 2) return 'VICTORY2';
  if (episode === 4) return 'ENDPIC';
  return null;
}

// f_finale.c:F_Ticker polls ticcmd buttons, not raw keyboard events. Keeping
// the 50-tic guard separate makes held attack/use input survive until the
// first tic on which skipping is allowed.
export function F_ShouldAdvanceCommercial(finaleCount, buttons) {
  return finaleCount > 50 && buttons.some((value) => value !== 0);
}

// f_finale.c:F_TextWrite reveals one source character every three tics after
// its ten-tic lead-in. C integer division truncates toward zero before the
// negative result is clamped, which matters at the lead-in boundary.
export function F_GetFinaleTextCount(finaleCount) {
  return Math.max(0, Math.trunc((finaleCount - 10) / 3));
}

// f_finale.c:F_BunnyScroll uses C integer division before subtracting the
// half-speed offset from 320. Truncating the final subtraction instead moves
// the panorama one pixel early on every odd tic.
export function F_GetBunnyScroll(finalecount) {
  const offset = Math.trunc((finalecount - 230) / 2);
  return Math.max(0, Math.min(320, 320 - offset));
}

// f_finale.c:F_BunnyScroll — END0 is held silently, then END1..END6 advance
// every five tics. The static laststage makes each newly displayed stage fire
// exactly one pistol sound even when the drawer runs more than once per tic.
export function F_UpdateBunnyStage(finalecount, laststage) {
  if (finalecount < 1130) {
    return { stage: -1, laststage, playPistol: false };
  }
  if (finalecount < 1180) {
    return { stage: 0, laststage: 0, playPistol: false };
  }
  const stage = Math.min(((finalecount - 1180) / 5) | 0, 6);
  const playPistol = stage > laststage;
  return {
    stage,
    laststage: playPistol ? stage : laststage,
    playPistol,
  };
}
