// Pure modal-message input rule from m_menu.c:M_Responder.

import { KEY_ESCAPE } from './doomdef.js';

export function M_MessageAcceptsKey(needsInput, key) {
  if (needsInput !== true) return true;
  return key === 0x20 /*space*/ || key === 0x6e /*n*/ ||
    key === 0x79 /*y*/ || key === KEY_ESCAPE;
}
