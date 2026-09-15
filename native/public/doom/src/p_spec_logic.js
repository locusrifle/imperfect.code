// Pure fixed-point helpers for per-tic sector/line specials.

export const SCROLL_TEXTURE_STEP = 1 << 16; // FRACUNIT

// p_spec.h:577 stair_e, p_floor.c:491-500 stair parameters.
export const build8 = 0;
export const turbo16 = 1;

export function P_StairSpeed(type) {
  return type === build8 ? SCROLL_TEXTURE_STEP / 4 : SCROLL_TEXTURE_STEP * 4;
}

// Retained Three.js planes need an explicit refresh when gameplay changes the
// flat number. Vanilla's renderer reads sector.floorpic afresh every frame.
export function P_ChangeSectorFloorPic(sector, flatnum, updateSectorPlanes) {
  if (sector.floorpic === flatnum) return false;
  sector.floorpic = flatnum;
  if (updateSectorPlanes !== null && updateSectorPlanes !== undefined) {
    updateSectorPlanes(sector);
  }
  return true;
}

// p_spec.c special 48 advances side 0 by one texture column every tic.
export function P_AdvanceScrollTextureOffset(textureOffset) {
  return (textureOffset + SCROLL_TEXTURE_STEP) | 0;
}
