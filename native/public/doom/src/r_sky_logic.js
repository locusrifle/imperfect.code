// Pure fixed-point sky-column projection from r_plane.c:R_DrawPlanes.

import { SCREENWIDTH } from './doomdef.js';
import { FRACUNIT } from './m_fixed.js';

export const SKY_TEXTUREMID = 100 * FRACUNIT;
export const SKY_COLUMNS_PER_TURN = 1024;

// r_segs.c:530-534 joins two outdoor ceilings even when their heights differ.
// The retained renderer fills the otherwise-open vertical interval with a
// screen-space sky seam.
export function R_NeedsSkyCeilingSeam(front, back, skyFlatNum) {
  return front !== null && front !== undefined &&
    back !== null && back !== undefined &&
    front.ceilingpic === skyFlatNum && back.ceilingpic === skyFlatNum &&
    front.ceilingheight !== back.ceilingheight;
}

export function R_SkyTextureColumn(angleRadians, widthMask) {
  let angularColumn = Math.floor(
    angleRadians / (Math.PI * 2) * SKY_COLUMNS_PER_TURN,
  );
  angularColumn = ((angularColumn % SKY_COLUMNS_PER_TURN) +
    SKY_COLUMNS_PER_TURN) % SKY_COLUMNS_PER_TURN;
  return angularColumn & widthMask;
}

export function R_SkyTextureU(angleRadians, textureWidth, widthMask) {
  return (R_SkyTextureColumn(angleRadians, widthMask) + 0.5) / textureWidth;
}

export function R_SkyRowStep(viewwidth, detailshift = 0) {
  const pspriteiscale = Math.trunc(FRACUNIT * SCREENWIDTH / viewwidth);
  return pspriteiscale >> detailshift;
}

export function R_SkyTextureRow(
  screenY,
  viewwidth,
  viewheight,
  detailshift = 0,
  texturemid = SKY_TEXTUREMID,
) {
  const centery = Math.trunc(viewheight / 2);
  const frac = texturemid + (screenY - centery) * R_SkyRowStep(viewwidth, detailshift);
  return Math.floor(frac / FRACUNIT);
}

export function R_SkyVisibleRows(viewwidth, viewheight, detailshift = 0) {
  return {
    first: R_SkyTextureRow(0, viewwidth, viewheight, detailshift),
    last: R_SkyTextureRow(viewheight - 1, viewwidth, viewheight, detailshift),
  };
}
