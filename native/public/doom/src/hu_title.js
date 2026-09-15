// Built-in map-title selection from hu_stuff.c:HU_Start. Keeping the tables in
// this renderer-free module makes their exact d_englsh content and indexing
// independently testable.

import * as english from './d_englsh.js';
import { GameMode_t } from './doomdef.js';

export const HU_DOOM_TITLES = Object.freeze([
  english.HUSTR_E1M1, english.HUSTR_E1M2, english.HUSTR_E1M3,
  english.HUSTR_E1M4, english.HUSTR_E1M5, english.HUSTR_E1M6,
  english.HUSTR_E1M7, english.HUSTR_E1M8, english.HUSTR_E1M9,
  english.HUSTR_E2M1, english.HUSTR_E2M2, english.HUSTR_E2M3,
  english.HUSTR_E2M4, english.HUSTR_E2M5, english.HUSTR_E2M6,
  english.HUSTR_E2M7, english.HUSTR_E2M8, english.HUSTR_E2M9,
  english.HUSTR_E3M1, english.HUSTR_E3M2, english.HUSTR_E3M3,
  english.HUSTR_E3M4, english.HUSTR_E3M5, english.HUSTR_E3M6,
  english.HUSTR_E3M7, english.HUSTR_E3M8, english.HUSTR_E3M9,
  english.HUSTR_E4M1, english.HUSTR_E4M2, english.HUSTR_E4M3,
  english.HUSTR_E4M4, english.HUSTR_E4M5, english.HUSTR_E4M6,
  english.HUSTR_E4M7, english.HUSTR_E4M8, english.HUSTR_E4M9,
]);

export const HU_DOOM2_TITLES = Object.freeze([
  english.HUSTR_1,  english.HUSTR_2,  english.HUSTR_3,  english.HUSTR_4,
  english.HUSTR_5,  english.HUSTR_6,  english.HUSTR_7,  english.HUSTR_8,
  english.HUSTR_9,  english.HUSTR_10, english.HUSTR_11, english.HUSTR_12,
  english.HUSTR_13, english.HUSTR_14, english.HUSTR_15, english.HUSTR_16,
  english.HUSTR_17, english.HUSTR_18, english.HUSTR_19, english.HUSTR_20,
  english.HUSTR_21, english.HUSTR_22, english.HUSTR_23, english.HUSTR_24,
  english.HUSTR_25, english.HUSTR_26, english.HUSTR_27, english.HUSTR_28,
  english.HUSTR_29, english.HUSTR_30, english.HUSTR_31, english.HUSTR_32,
]);

// hu_stuff.c:HU_TITLEY = 167 - SHORT(hu_font[0]->height).
export function HU_TitleYForFontHeight(height) {
  return 167 - Math.trunc(height);
}

export function HU_LevelTitle(gamemode, episode, map) {
  if (!Number.isInteger(map)) return '';

  switch (gamemode) {
    case GameMode_t.shareware:
    case GameMode_t.registered:
    case GameMode_t.retail: {
      if (!Number.isInteger(episode)
          || episode < 1 || episode > 4
          || map < 1 || map > 9) return '';
      const index = (episode - 1) * 9 + map - 1;
      return HU_DOOM_TITLES[index] ?? '';
    }
    case GameMode_t.commercial:
    default:
      if (map < 1 || map > 32) return '';
      return HU_DOOM2_TITLES[map - 1] ?? '';
  }
}
