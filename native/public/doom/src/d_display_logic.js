// Pure D_Display coordinate helpers. Kept separate from d_main.js so the
// reference integer math can be verified without constructing Three.js.

import { SCREENWIDTH } from './doomdef.js';

const PAUSE_CENTERING_WIDTH = 68;

// d_main.c:D_Display starts a wipe whenever the requested state differs from
// wipegamestate.  A browser wipe spans RAFs, so do not replace an in-flight
// melt with another capture; vanilla's blocking wipe cannot be re-entered.
export function D_ShouldStartWipe(gamestate, wipegamestate, wipeActive) {
  return wipeActive !== true && gamestate !== wipegamestate;
}

// d_main.c:303-310. M_PAUSE itself is 69 pixels wide in the stock IWAD, but
// vanilla deliberately centers with the literal 68 and integer division.
export function D_PausePatchPosition(
  automapactive,
  viewwindowx,
  viewwindowy,
  scaledviewwidth,
) {
  // R_ExecuteSetViewSize initializes these before the first native display.
  // The browser renderer is a full 320-wide view and leaves the legacy width
  // at zero until a caller supplies one, so use that real viewport as its
  // initialized equivalent.
  const width = scaledviewwidth > 0 ? scaledviewwidth : SCREENWIDTH;
  const x = (scaledviewwidth > 0 ? viewwindowx : 0) +
    Math.trunc((width - PAUSE_CENTERING_WIDTH) / 2);
  const y = automapactive === true ? 4 : viewwindowy + 4;
  return { x, y };
}
