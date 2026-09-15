// Shared STCFN/HU font loading, layout, and Canvas drawing.
//
// Doom treats each glyph as a patch: its width advances the pen, while its
// left/top offsets only affect where the patch pixels land.  Keeping layout in
// 320x200 virtual coordinates lets the HUD and finale use the same WAD font at
// any browser canvas size without changing the reference spacing.

import { V_DecodePatchToCanvas, V_DrawPatchAtCanvas } from './v_video.js';

export const HU_FONTSTART = '!'.charCodeAt(0);
export const HU_FONTEND = '_'.charCodeAt(0);
export const HU_FONTSIZE = HU_FONTEND - HU_FONTSTART + 1;

const huFont = new Array(HU_FONTSIZE);
let fontLoaded = false;

export function HU_GetFont() {
  if (!fontLoaded) {
    for (let i = 0; i < HU_FONTSIZE; i++) {
      const code = HU_FONTSTART + i;
      huFont[i] = V_DecodePatchToCanvas(`STCFN${String(code).padStart(3, '0')}`);
    }
    fontLoaded = true;
  }
  return huFont;
}

export function HU_ShutdownFont() {
  huFont.fill(null);
  fontLoaded = false;
}

// ctype's toupper is only relevant to the ASCII WAD font range here.
export function HU_FontIndex(code) {
  if (code >= 97 && code <= 122) code -= 32;
  const index = code - HU_FONTSTART;
  return index >= 0 && index < HU_FONTSIZE ? index : -1;
}

// Pure virtual-coordinate layout. Unsupported characters (including spaces)
// advance four pixels, matching F_TextWrite/F_CastPrint. Newlines are optional
// because finale text handles them specially while the cast printer does not.
export function HU_LayoutText(text, font, options = {}) {
  const startX = options.x ?? 0;
  const startY = options.y ?? 0;
  const maxChars = Math.max(0, Math.trunc(options.maxChars ?? text.length));
  const lineHeight = options.lineHeight ?? null;
  const maxX = options.maxX ?? Infinity;
  const glyphs = [];
  let x = startX;
  let y = startY;
  let consumed = 0;
  let stopped = false;

  for (let i = 0; i < text.length && consumed < maxChars; i++) {
    const code = text.charCodeAt(i);
    consumed++;
    if (code === 10 && lineHeight !== null) {
      x = startX;
      y += lineHeight;
      continue;
    }

    const index = HU_FontIndex(code);
    const glyph = index < 0 ? null : font[index];
    if (glyph === null || glyph === undefined) {
      x += 4;
      continue;
    }

    if (x + glyph.w > maxX) {
      stopped = true;
      break;
    }

    glyphs.push({ glyph, index, x, y });
    x += glyph.w;
  }

  return { glyphs, x, y, consumed, stopped };
}

export function HU_TextWidth(text, font) {
  return HU_LayoutText(text, font).x;
}

export function HU_LayoutCenteredText(text, font, centerX, y) {
  const width = HU_TextWidth(text, font);
  const x = centerX - Math.trunc(width / 2);
  return { width, ...HU_LayoutText(text, font, { x, y }) };
}

export function HU_DrawLayout(ctx, layout, dstX, dstY, sx, sy) {
  for (const placement of layout.glyphs) {
    V_DrawPatchAtCanvas(
      ctx,
      placement.glyph,
      dstX + placement.x * sx,
      dstY + placement.y * sy,
      sx,
      sy,
    );
  }
}
