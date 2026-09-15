// Pure status-bar layout/state helpers from st_stuff.c.

export const ST_HEALTHX = 90;
export const ST_ARMORX = 221;
export const ST_BIG_NUMBER_Y = 171;
export const ST_PERCENT_PATCH = 'STTPRCNT';
export const ST_FRAGSX = 138;
export const ST_FRAGSWIDTH = 2;
export const ST_AMMO_CURRENT_X = 288;
export const ST_AMMO_MAX_X = 314;
// Ammo enums are clip, shell, cell, missile; the status-bar labels are
// BULL, SHEL, RCKT, CELL, so cells and rockets deliberately cross rows.
export const ST_AMMO_Y = Object.freeze([173, 179, 191, 185]);
const ST_FACE_BACKGROUNDS = Object.freeze(['STFB0', 'STFB1', 'STFB2', 'STFB3']);

export function ST_FaceBackgroundPatch(netgame, consoleplayer) {
  return netgame ? ST_FACE_BACKGROUNDS[consoleplayer] : null;
}

export function ST_DeathmatchStatusPlan(deathmatch, frags, consoleplayer) {
  const active = deathmatch !== 0;
  let fragCount = 0;
  for (let i = 0; i < 4; i++) {
    const value = frags?.[i] | 0;
    fragCount = (fragCount + (i === consoleplayer ? -value : value)) | 0;
  }
  return { showArms: !active, showFrags: active, fragCount };
}

// st_stuff.c ST_updateWidgets assigns the card first and then lets the
// corresponding skull key replace it. Vanilla only loads STKEYS0..5.
export function ST_KeyPatch(cards, slot) {
  if (cards?.[slot + 3] === true) return `STKEYS${slot + 3}`;
  if (cards?.[slot] === true) return `STKEYS${slot}`;
  return null;
}
