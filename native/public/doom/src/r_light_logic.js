// Pure mirrors of linuxdoom-1.10's light-table indexing.  The WebGL shader
// uses the same constants and formulas; keeping CPU versions here makes the
// integer lookup behavior independently testable without importing Three.js.

export const LIGHTLEVELS = 16;
export const MAXLIGHTSCALE = 48;
export const MAXLIGHTZ = 128;
export const NUMCOLORMAPS = 32;
export const DISTMAP = 2;
export const REFERENCE_SCREENWIDTH = 320;

// zlight always uses the reference SCREENWIDTH/2 numerator. Scalelight uses
// the current view projection and is handled separately below.
export const LIGHT_PROJECTION = REFERENCE_SCREENWIDTH / 2;

function clamp(value, low, high) {
  return Math.min(Math.max(value, low), high);
}

function startMap(lightBucket, extralight) {
  const light = clamp((lightBucket + extralight) | 0, 0, LIGHTLEVELS - 1);
  return (((LIGHTLEVELS - 1 - light) * 2) * NUMCOLORMAPS / LIGHTLEVELS) | 0;
}

export function R_ScalelightAttenuation(scaleIndex, scaledViewWidth = REFERENCE_SCREENWIDTH) {
  const width = Math.max(1, scaledViewWidth | 0);
  // Keep the two integer divisions separate: r_main.c evaluates
  // j*SCREENWIDTH/scaledviewwidth/DISTMAP from left to right.
  return Math.floor(Math.floor(scaleIndex * REFERENCE_SCREENWIDTH / width) / DISTMAP);
}

export function R_ScalelightRow(
  lightBucket,
  extralight,
  scaleIndex,
  scaledViewWidth = REFERENCE_SCREENWIDTH,
) {
  const index = clamp(scaleIndex | 0, 0, MAXLIGHTSCALE - 1);
  const level = startMap(lightBucket, extralight) -
    R_ScalelightAttenuation(index, scaledViewWidth);
  return clamp(level, 0, NUMCOLORMAPS - 1);
}

export function R_ScaleIndexForDepth(viewDepth, scaledViewWidth = REFERENCE_SCREENWIDTH) {
  const depth = Math.max(viewDepth, 1 / 65536);
  const numerator = Math.max(1, scaledViewWidth | 0) * 8;
  return Math.min(Math.floor(numerator / depth), MAXLIGHTSCALE - 1);
}

// r_segs.c:R_RenderSegLoop / R_RenderMaskedSegRange and
// r_things.c:R_ProjectSprite use a projection based on the current viewwidth,
// then select the scalelight table rebuilt for scaledviewwidth.
export function R_WallLightRow(
  lightBucket,
  extralight,
  viewDepth,
  scaledViewWidth = REFERENCE_SCREENWIDTH,
) {
  const scaleIndex = R_ScaleIndexForDepth(viewDepth, scaledViewWidth);
  return R_ScalelightRow(lightBucket, extralight, scaleIndex, scaledViewWidth);
}

// r_plane.c:R_MapPlane plus the zlight table built by
// r_main.c:R_InitLightTables.  One LIGHTZ step is 2^20 fixed-point units,
// i.e. 16 map units after removing FRACBITS (16).
export function R_PlaneLightRow(lightBucket, extralight, viewDepth) {
  const zIndex = Math.min(Math.floor(Math.max(viewDepth, 0) / 16), MAXLIGHTZ - 1);
  const scale = Math.floor(LIGHT_PROJECTION / (zIndex + 1));
  const level = startMap(lightBucket, extralight) - Math.floor(scale / DISTMAP);
  return clamp(level, 0, NUMCOLORMAPS - 1);
}
