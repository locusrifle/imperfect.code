// Pure save-menu state transitions from linuxdoom-1.10/m_menu.c. Keeping the
// string editor and quick-slot routing independent of Canvas/localStorage makes
// the byte/width boundaries directly testable.

import { KEY_BACKSPACE, KEY_ENTER, KEY_ESCAPE, gamestate_t } from './doomdef.js';
import { EMPTYSTRING } from './d_englsh.js';

export const SAVE_SLOTS = 6;
export const SAVE_STRING_SIZE = 24;
export const SAVE_STRING_PIXEL_LIMIT = (SAVE_STRING_SIZE - 2) * 8;
export const QUICK_SAVE_NONE = -1;
export const QUICK_SAVE_PICKING = -2;

export function M_NormalizeSaveSlots(records) {
  const slots = Array.from({ length: SAVE_SLOTS }, () => ({
    description: EMPTYSTRING,
    occupied: false,
  }));
  if (!Array.isArray(records)) return slots;

  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (record === null || record === undefined || typeof record !== 'object') continue;
    const slot = Number.isInteger(record.slot) ? record.slot : index;
    if (slot < 0 || slot >= SAVE_SLOTS) continue;
    slots[slot] = {
      description: typeof record.description === 'string'
        ? record.description
        : EMPTYSTRING,
      // Native enables a load row when the save file exists, independently of
      // the description bytes it contains.
      occupied: true,
    };
  }
  return slots;
}

export function M_BeginSaveEdit(description) {
  const oldText = typeof description === 'string' ? description : EMPTYSTRING;
  return {
    oldText,
    text: oldText === EMPTYSTRING ? '' : oldText,
  };
}

function upperAscii(code) {
  return code >= 0x61 && code <= 0x7a ? code - 0x20 : code;
}

// Result kinds mirror the three exits from m_menu.c's saveStringEnter branch:
// editing, cancel (restore old text), and finish (optionally queue a save).
export function M_ApplySaveEditKey(text, oldText, key, stringWidth) {
  if (key === KEY_BACKSPACE) {
    return { kind: 'editing', text: text.length > 0 ? text.slice(0, -1) : text };
  }
  if (key === KEY_ESCAPE) return { kind: 'cancel', text: oldText };
  if (key === KEY_ENTER) return { kind: 'finish', text, save: text.length > 0 };

  const code = upperAscii(key | 0);
  // After toupper(), vanilla accepts space or glyphs in HU's ! through _ range.
  if (code !== 0x20 && (code < 0x21 || code > 0x5f)) {
    return { kind: 'editing', text };
  }
  if (code < 0x20 || code > 0x7f || text.length >= SAVE_STRING_SIZE - 1) {
    return { kind: 'editing', text };
  }
  // This deliberately checks the old width, not the prospective width. Doom
  // can therefore append one final wide glyph while the current width is 175.
  if (stringWidth(text) >= SAVE_STRING_PIXEL_LIMIT) {
    return { kind: 'editing', text };
  }
  return { kind: 'editing', text: text + String.fromCharCode(code) };
}

export function M_QuickSaveRoute(usergame, gamestate, quickSaveSlot) {
  if (usergame !== true) return 'inactive';
  if (gamestate !== gamestate_t.GS_LEVEL) return 'nonlevel';
  return quickSaveSlot < 0 ? 'pick' : 'confirm';
}

export function M_QuickLoadRoute(netgame, quickSaveSlot) {
  if (netgame === true) return 'netgame';
  return quickSaveSlot < 0 ? 'no-slot' : 'confirm';
}

export function M_FormatSavePrompt(template, description) {
  // A replacement callback keeps `$&`, `$\`` and `$'` in a legal save name
  // literal, matching sprintf rather than JavaScript replacement expansion.
  return template.replace('%s', () => description);
}
