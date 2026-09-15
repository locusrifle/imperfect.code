// Ported from: linuxdoom-1.10/hu_stuff.c — heads-up display.
// Pickup / item / secret messages, level title, and the STCFN font.

import { players, consoleplayer, gameepisode, gamemap, gamemode, automapactive } from './doomstat.js';
import { MSGON, MSGOFF } from './d_englsh.js';
import {
  HU_DrawLayout, HU_FONTEND, HU_FONTSIZE, HU_FONTSTART, HU_GetFont,
  HU_LayoutText, HU_ShutdownFont,
} from './hu_font.js';
import {
  HU_AdvanceMessageState, HU_EmptyMessageState, HU_ForceNextMessage,
  HU_InstallMessageState, HU_MSGTIMEOUT,
} from './hu_message_logic.js';
import { HU_LevelTitle, HU_TitleYForFontHeight } from './hu_title.js';

// hu_stuff.c:showMessages — when false, gameplay messages are suppressed.
// The toggle's own confirmation message is forced through regardless
// (vanilla's message_dontfuckwithme).
export let showMessages = true;

export function HU_SetShowMessages(value) {
  showMessages = (value | 0) !== 0;
}

export { HU_FONTSTART, HU_FONTEND, HU_FONTSIZE };
export const HU_MSGX      = 0;
export const HU_MSGY      = 0;
export const HU_TITLEX    = 0;
export let HU_TITLEY      = 167; // initialized from STCFN033 in HU_Start
export { HU_MSGTIMEOUT };

// State.
let _msgState     = HU_EmptyMessageState();
let _titleText    = '';
let _lastMo       = null;

export function HU_Init() { /* fonts loaded lazily on first draw */ }

export function HU_Shutdown() {
  HU_ShutdownFont();
  _msgState = HU_EmptyMessageState();
  _titleText = '';
  _lastMo = null;
}

export function HU_Start() {
  // hu_stuff.c:425-432 resets both the one-shot force and active overwrite
  // lock along with the message widget at the start of each level.
  _msgState = HU_EmptyMessageState();
  // hu_stuff.c:440-470 builds the title widget once per HU_Start. It has no
  // timeout; HU_Drawer gates the persistent line on automapactive.
  HU_TITLEY = HU_TitleYForFontHeight(HU_GetFont()[0].h);
  _titleText = HU_LevelTitle(gamemode, gameepisode, gamemap);
}

// Direct browser-side helper for pushing a message into the widget. Gameplay
// normally writes player.message and lets HU_Ticker apply the reference order.
// `force` shows the direct message even when messages are toggled off.
export function HU_QueueMessage(text, force) {
  const installed = HU_InstallMessageState(_msgState, text, showMessages, force);
  _msgState = installed.state;
  return installed.consumed;
}

// m_menu.c:M_ChangeMessages — flip the message display on/off and show the
// confirmation message itself (forced through the showMessages gate).
export function HU_ToggleMessages() {
  HU_SetShowMessages(showMessages ? 0 : 1);
  const p = players[consoleplayer];
  if (p !== null && p !== undefined) {
    // m_menu.c:M_ChangeMessages writes through player.message and arms
    // message_dontfuckwithme. HU_Ticker installs it after expiring the old tic.
    p.message = showMessages ? MSGON : MSGOFF;
    _msgState = HU_ForceNextMessage(_msgState);
  } else {
    // The browser can expose this toggle before player bootstrap; retain a
    // useful fallback without changing the in-game reference path.
    HU_QueueMessage(showMessages ? MSGON : MSGOFF, true);
  }
}

export function HU_Ticker() {
  const p = players[consoleplayer];
  if (p === null || p === undefined) return;
  // Auto-detect new level (player mo changed).
  if (p.mo !== _lastMo) {
    _lastMo = p.mo;
    HU_Start();
  }
  // hu_stuff.c:511-530 expires the previous counter before ingesting a new
  // player message. Do not clear a suppressed/locked message: vanilla leaves
  // it pending until messages are enabled or the forced-message lock expires.
  const advanced = HU_AdvanceMessageState(_msgState, p.message, showMessages);
  _msgState = advanced.state;
  if (advanced.consumed === true) p.message = '';
}

export function HU_Responder(_ev) { return false; }

// Render one string at virtual (vx, vy) using the loaded STCFN font.
function drawText(ctx, text, vx, vy, dstX, dstY, sx, sy) {
  if (text === '' || text === null) return;
  const layout = HU_LayoutText(text, HU_GetFont(), { x: vx, y: vy });
  HU_DrawLayout(ctx, layout, dstX, dstY, sx, sy);
}

// HU_Drawer renders messages on top of the 3D view; the STBAR is drawn separately
// by st_stuff.js. dstX/dstY/dstW/dstH = full 320x200 virtual screen.
export function HU_Drawer(overlayCtx, dstX, dstY, dstW, dstH) {
  const p = players[consoleplayer];
  if (p === null || p === undefined || p.mo === null) return;
  const sx = dstW / 320;
  const sy = dstH / 200;
  // Pickup / item / secret message at top-left.
  if (_msgState.counter > 0 && _msgState.text !== '') {
    drawText(overlayCtx, _msgState.text, HU_MSGX, HU_MSGY, dstX, dstY, sx, sy);
  }
  // hu_stuff.c:486-493 draws the persistent title only over the automap.
  if (automapactive && _titleText !== '') {
    drawText(overlayCtx, _titleText, HU_TITLEX, HU_TITLEY, dstX, dstY, sx, sy);
  }
}
