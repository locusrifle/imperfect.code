// Pure routing for the closed-menu function keys handled by the shared switch.

import {
  KEY_F2, KEY_F3, KEY_F4, KEY_F5, KEY_F6, KEY_F7, KEY_F8, KEY_F9, KEY_F10,
} from './doomdef.js';

export function M_ClosedShortcutRoute(key) {
  switch (key) {
    case KEY_F2: return 'save';
    case KEY_F3: return 'load';
    case KEY_F4: return 'sound';
    case KEY_F5: return 'detail';
    case KEY_F6: return 'quicksave';
    case KEY_F7: return 'endgame';
    case KEY_F8: return 'messages';
    case KEY_F9: return 'quickload';
    case KEY_F10: return 'quit';
    default: return null;
  }
}
