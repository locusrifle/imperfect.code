// Pure floor/ceiling texture-coordinate mapping from r_plane.c:R_MapPlane.
// Keeping this separate from the Three.js geometry builder lets the signed
// world-coordinate convention be checked without constructing WebGL objects.

export const FLAT_SIZE = 64;

export function R_FlatTextureUV(worldX, worldY) {
  // r_plane.c initializes ds_xfrac from +world X, but ds_yfrac from -world Y.
  // R_DrawSpan then wraps both fixed-point coordinates to the 64x64 flat.
  return {
    u: worldX / FLAT_SIZE,
    v: -worldY / FLAT_SIZE,
  };
}
