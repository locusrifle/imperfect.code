// Pure Doom-menu text measurements and message layout from m_menu.c.

import { HU_LayoutText, HU_TextWidth } from './hu_font.js';

// m_menu.c:1255-1271 — unsupported characters advance four pixels; the shared
// HU layout helper applies the same upper-casing and STCFN patch widths.
export function M_StringWidth(text, font) {
  return HU_TextWidth(text, font);
}

// m_menu.c:1278-1290 — every line is exactly hu_font[0]'s patch height.
export function M_StringHeight(text, font) {
  const lineHeight = font[0].h;
  let height = lineHeight;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) height += lineHeight;
  }
  return height;
}

// m_menu.c:1752-1777 — center the complete block around y=100, then center
// each individual line around x=160. M_WriteText clips at SCREENWIDTH.
export function M_LayoutMessage(text, font) {
  const lineHeight = font[0].h;
  let y = 100 - Math.trunc(M_StringHeight(text, font) / 2);
  const glyphs = [];
  for (const line of text.split('\n')) {
    const x = 160 - Math.trunc(M_StringWidth(line, font) / 2);
    const layout = HU_LayoutText(line, font, { x, y, maxX: 320 });
    glyphs.push(...layout.glyphs);
    y += lineHeight;
  }
  return { glyphs };
}
