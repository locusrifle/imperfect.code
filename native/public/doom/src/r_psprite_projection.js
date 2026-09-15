// Pure player-sprite projection and Canvas drawing helpers. These mirror the
// fixed-point bounds and flip branch in r_things.c:R_DrawPSprite.

import { FixedMul, FRACUNIT } from './m_fixed.js';
import { SCREENWIDTH } from './doomdef.js';

function fixedFloor(value) {
  return Math.floor(value / FRACUNIT);
}

function fixedCeil(value) {
  return Math.floor((value + FRACUNIT - 1) / FRACUNIT);
}

// At the reference 320-wide view, pspritescale is FRACUNIT. R_DrawPSprite's
// horizontal projection therefore reduces to sx - spriteoffset. Vertically,
// its BASEYCENTER + FRACUNIT/2 texture midpoint puts the first patch row at
// ceil(sy - spritetopoffset - 0.5), including fractional weapon bob.
export function R_PspritePatchBounds(pspSx, pspSy, patch) {
  const left = fixedFloor(pspSx - patch.leftoffset * FRACUNIT);
  const top = fixedCeil(pspSy - patch.topoffset * FRACUNIT - FRACUNIT / 2);
  return {
    left,
    top,
    right: left + patch.w,
    bottom: top + patch.h,
    width: patch.w,
    height: patch.h,
  };
}

// r_things.c:R_DrawPSprite after R_ExecuteSetViewSize has selected a reduced
// view. Coordinates are local to the view window; the caller adds
// viewwindowx/viewwindowy when composing into the 320x200 logical screen.
export function R_ProjectPspritePatch(pspSx, pspSy, patch, viewwidth, viewheight) {
  const scale = Math.trunc(FRACUNIT * viewwidth / SCREENWIDTH);
  const centerxfrac = Math.trunc(viewwidth / 2) * FRACUNIT;
  const centeryfrac = Math.trunc(viewheight / 2) * FRACUNIT;
  let tx = pspSx - 160 * FRACUNIT - patch.leftoffset * FRACUNIT;
  const left = Math.floor((centerxfrac + FixedMul(tx, scale)) / FRACUNIT);
  tx += patch.w * FRACUNIT;
  const right = Math.floor((centerxfrac + FixedMul(tx, scale)) / FRACUNIT);

  const texturemid = 100 * FRACUNIT + FRACUNIT / 2 -
    (pspSy - patch.topoffset * FRACUNIT);
  const topfixed = centeryfrac - FixedMul(texturemid, scale);
  const bottomfixed = topfixed + scale * patch.h;
  const top = fixedCeil(topfixed);
  const bottom = fixedCeil(bottomfixed);

  return {
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
    sourceWidth: patch.w,
    sourceHeight: patch.h,
    clipLeft: Math.max(0, left),
    clipTop: Math.max(0, top),
    clipRight: Math.min(viewwidth, right),
    clipBottom: Math.min(viewheight, bottom),
    scale,
  };
}

// A flipped sprite keeps the exact same projected rectangle. Vanilla starts
// at spritewidth-1 with a negative xiscale; Canvas expresses that by moving
// the origin to the rectangle's right edge and reversing the local X axis.
export function R_DrawPspritePatch(ctx, canvas, bounds, dstX, dstY, scaleX, scaleY, flipped) {
  const x = dstX + bounds.left * scaleX;
  const y = dstY + bounds.top * scaleY;
  const width = bounds.width * scaleX;
  const height = bounds.height * scaleY;
  const sourceWidth = bounds.sourceWidth ?? bounds.width;
  const sourceHeight = bounds.sourceHeight ?? bounds.height;
  if (flipped !== true) {
    ctx.drawImage(canvas, 0, 0, sourceWidth, sourceHeight, x, y, width, height);
    return;
  }

  ctx.save();
  try {
    ctx.translate(x + width, y);
    ctx.scale(-1, 1);
    ctx.drawImage(canvas, 0, 0, sourceWidth, sourceHeight, 0, 0, width, height);
  } finally {
    ctx.restore();
  }
}
