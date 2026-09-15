// Canvas equivalent of r_draw.c:R_FillBackScreen/R_DrawViewBorder. The
// border is composed at Doom's native 320x168 view area, then nearest-scaled
// with the rest of the logical screen. Its transparent center reveals the
// scissored Three.js world behind the overlay.

import { GameMode_t, SCREENWIDTH } from './doomdef.js';
import { W_CacheLumpName } from './w_wad.js';
import {
  V_CreatePaletteCanvasInfo,
  V_DecodePatchToCanvas,
  V_DrawPatchAtCanvas,
} from './v_video.js';
import { VIEW_AREA_HEIGHT } from './r_view.js';

let _borderCanvas = null;
let _borderCtx = null;
const _flatCache = new Map();

function getBorderCanvas() {
  if (_borderCanvas !== null) return _borderCanvas;
  _borderCanvas = document.createElement('canvas');
  _borderCanvas.width = SCREENWIDTH;
  _borderCanvas.height = VIEW_AREA_HEIGHT;
  _borderCtx = _borderCanvas.getContext('2d');
  _borderCtx.imageSmoothingEnabled = false;
  return _borderCanvas;
}

function getFlat(name) {
  let info = _flatCache.get(name);
  if (info !== undefined) return info;
  const indices = W_CacheLumpName(name, 0);
  const alphas = new Uint8Array(indices.length);
  alphas.fill(255);
  info = V_CreatePaletteCanvasInfo(indices, alphas, 64, 64);
  _flatCache.set(name, info);
  return info;
}

function drawPatch(name, x, y) {
  V_DrawPatchAtCanvas(_borderCtx, V_DecodePatchToCanvas(name), x, y);
}

function composeBorder(view, gamemode) {
  getBorderCanvas();
  _borderCtx.clearRect(0, 0, SCREENWIDTH, VIEW_AREA_HEIGHT);
  const flatName = gamemode === GameMode_t.commercial ? 'GRNROCK' : 'FLOOR7_2';
  const flat = getFlat(flatName).canvas;
  for (let y = 0; y < VIEW_AREA_HEIGHT; y += 64) {
    for (let x = 0; x < SCREENWIDTH; x += 64) {
      _borderCtx.drawImage(flat, x, y);
    }
  }

  // The native renderer writes the 3D view over screens[0] after copying the
  // backscreen border. Transparency performs that same overwrite here.
  _borderCtx.clearRect(
    view.viewwindowx,
    view.viewwindowy,
    view.scaledviewwidth,
    view.viewheight,
  );

  for (let x = 0; x < view.scaledviewwidth; x += 8) {
    drawPatch('BRDR_T', view.viewwindowx + x, view.viewwindowy - 8);
    drawPatch('BRDR_B', view.viewwindowx + x, view.viewwindowy + view.viewheight);
  }
  for (let y = 0; y < view.viewheight; y += 8) {
    drawPatch('BRDR_L', view.viewwindowx - 8, view.viewwindowy + y);
    drawPatch('BRDR_R', view.viewwindowx + view.scaledviewwidth, view.viewwindowy + y);
  }
  drawPatch('BRDR_TL', view.viewwindowx - 8, view.viewwindowy - 8);
  drawPatch('BRDR_TR', view.viewwindowx + view.scaledviewwidth, view.viewwindowy - 8);
  drawPatch('BRDR_BL', view.viewwindowx - 8, view.viewwindowy + view.viewheight);
  drawPatch('BRDR_BR', view.viewwindowx + view.scaledviewwidth, view.viewwindowy + view.viewheight);
  return _borderCanvas;
}

export function R_DrawViewBorder(overlayCtx, layout, view, gamemode) {
  if (view.scaledviewwidth === SCREENWIDTH) return;
  const border = composeBorder(view, gamemode);
  overlayCtx.drawImage(
    border,
    0,
    0,
    SCREENWIDTH,
    VIEW_AREA_HEIGHT,
    layout.screenX,
    layout.screenY,
    layout.screenWidth,
    VIEW_AREA_HEIGHT * layout.scale,
  );
}

export function R_ShutdownViewBorder() {
  _flatCache.clear();
  if (_borderCanvas !== null) {
    _borderCanvas.width = 0;
    _borderCanvas.height = 0;
  }
  _borderCanvas = null;
  _borderCtx = null;
}
