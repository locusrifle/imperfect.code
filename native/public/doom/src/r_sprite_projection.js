// Pure world-sprite projection helpers. Kept separate from r_things.js so
// the fixed-point geometry can be compared directly with r_things.c without
// loading Three.js.

import { FRACUNIT } from './m_fixed.js';

// r_things.c:R_ProjectSprite stores:
//   vis->gz  = thing->z;
//   vis->gzt = thing->z + spritetopoffset[lump];
// The patch then extends down by its source height. THREE.Sprite is centred
// vertically, so its position is the midpoint of those exact source bounds.
export function R_SpritePatchWorldBounds(mobjZ, patchTopOffset, patchHeight) {
  const top = mobjZ / FRACUNIT + patchTopOffset;
  const bottom = top - patchHeight;
  return { top, bottom, center: (top + bottom) / 2 };
}

// Allocation-free form used by the per-frame billboard update path.
export function R_SpriteBillboardCenterY(mobjZ, patchTopOffset, patchHeight) {
  return mobjZ / FRACUNIT + patchTopOffset - patchHeight / 2;
}
