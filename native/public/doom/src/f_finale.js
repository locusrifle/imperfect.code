// Ported from: linuxdoom-1.10/f_finale.c — episode/chapter finale text,
// Doom 1 art screens and bunny scroller, plus Doom II's cast sequence:
//   E1 → text (E1TEXT) → CREDIT/HELP2 still
//   E2 → text (E2TEXT) → VICTORY2 still
//   E3 → text (E3TEXT) → bunny scroller (PFUB1 + PFUB2) → END0..END6 punchline

import {
  gameepisode, gamemode, gamemap,
  players,
  set_automapactive, set_gameaction, set_gamestate, set_viewactive,
  set_wipegamestate,
} from './doomstat.js';
import { GameMode_t, gamestate_t } from './doomdef.js';
import { gameaction_t } from './d_event.js';
import { V_CreatePaletteCanvasInfo, V_DecodePatchToCanvas } from './v_video.js';
import { V_PaletteCSS } from './v_palette.js';
import {
  HU_DrawLayout, HU_GetFont, HU_LayoutCenteredText, HU_LayoutText,
} from './hu_font.js';
import { S_ChangeMusic, S_StartMusic, S_StartSound } from './s_sound.js';
import { mus_victor, mus_read_m, mus_bunny, mus_evil, sfx_pistol } from './sounds.js';
import { W_CacheLumpNum, W_CheckNumForName, lumpinfo } from './w_wad.js';
import { firstspritelump } from './r_data.js';
import { sprites } from './r_things.js';
import {
  F_GetBunnyScroll, F_GetDoom1ArtPatch, F_GetFinaleSpec, F_GetFinaleTextCount,
  F_ShouldAdvanceCommercial, F_UpdateBunnyStage,
} from './f_finale_logic.js';
import {
  F_CreateCastState, F_GetCastDisplay, F_KillCast, F_TickCast,
} from './f_cast_logic.js';

// State machine: 0 = typing text, 1 = post-text still / bunny scroll.
let _stage = 0;
let _finalecount = 0;
let _active = false;
let _done   = null;
let _completionQueued = false;
let _finaleText = '';
let _finaleFlat = '';
let _commercial = false;
let _bunnyLastStage = 0;
const getPatch = V_DecodePatchToCanvas;
const F_TEXTWAIT = 250;
// f_finale.c:TEXTSPEED — one character per 3 tics (≈12 chars/s at 35Hz).
const F_TEXTSPEED = 3;

export function F_StartFinale(onDone) {
  F_Stop();
  // f_finale.c:96-101 — entering a finale consumes the queued game action and
  // disables the live 3D view/automap until the finale advances.
  set_gameaction(gameaction_t.ga_nothing);
  set_gamestate(gamestate_t.GS_FINALE);
  set_viewactive(false);
  set_automapactive(false);
  _active = true;
  _completionQueued = false;
  _done = onDone || (() => {});
  _finalecount = 0;
  _stage = 0;
  _castActive = false;
  const spec = F_GetFinaleSpec(gamemode, gameepisode, gamemap);
  _finaleText = spec.text;
  _finaleFlat = spec.flat;
  _commercial = gamemode === GameMode_t.commercial;
  _bunnyLastStage = 0;
  // The browser rebuilds the local finale ticcmd from held controls each tic.
  // Clear the previous level's last command first so stale buttons cannot skip.
  for (const player of players) {
    if (player?.cmd !== undefined) player.cmd.buttons = 0;
  }
  // f_finale.c:113 — Doom 1 (shareware/registered/retail) plays mus_victor on
  // the end-of-episode text screen; commercial/indeterminate use mus_read_m.
  const isDoom1 = gamemode === GameMode_t.shareware ||
                  gamemode === GameMode_t.registered ||
                  gamemode === GameMode_t.retail;
  S_ChangeMusic(isDoom1 ? mus_victor : mus_read_m, true);
}

export function F_Responder(ev) {
  if (!_active) return false;
  if (_castActive) return F_CastResponder(ev);
  // f_finale.c:F_Responder only handles cast keydowns. Chapter skipping is
  // driven by ticcmd buttons in F_Ticker. Vanilla accepts any nonzero button
  // byte here, including BT_CHANGE and BT_SPECIAL, but never movement alone.
  return false;
}

export function F_Ticker() {
  if (_active === false || _completionQueued) return;
  if (_commercial) {
    const buttons = players.map((player) => player?.cmd?.buttons ?? 0);
    if (F_ShouldAdvanceCommercial(_finalecount, buttons)) {
      if (gamemap === 30) F_StartCast();
      else {
        // The queued ga_worlddone cannot be handled until the next tic. Keep
        // this completed frame active so the intervening presentation draws.
        _completionQueued = true;
        _done(); // G_WorldDone supplied a ga_worlddone callback.
      }
    }
  }
  _finalecount++;
  if (_castActive) { F_CastTicker(); return; }
  // Doom II holds its text screen until a ticcmd button; MAP30 enters the cast.
  if (_commercial) return;
  if (_stage === 0 && _finalecount > F_TEXTWAIT + _finaleText.length * F_TEXTSPEED) {
    _stage = 1;
    _finalecount = 0;
    // f_finale.c:245 — stage changes do not change gamestate, so explicitly
    // invalidate D_Display's remembered state to melt text into the art page.
    set_wipegamestate(-1);
    // f_finale.c:247 — the E3 bunny scroller gets its own track.
    if (gameepisode === 3) S_StartMusic(mus_bunny);
  }
}

const _flatCanvasCache = new Map();

export function F_Stop() {
  _active = false;
  _completionQueued = false;
  _done = null;
  _cast = null;
  _castActive = false;
}

export function F_Shutdown() {
  F_Stop();
  _flatCanvasCache.clear();
  _stage = 0;
  _finalecount = 0;
  _finaleText = '';
  _finaleFlat = '';
  _commercial = false;
}
function getFlatCanvas(name) {
  if (_flatCanvasCache.has(name)) return _flatCanvasCache.get(name);
  if (typeof document === 'undefined') return null;
  const lumpnum = W_CheckNumForName(name);
  if (lumpnum < 0) { _flatCanvasCache.set(name, null); return null; }
  const bytes = W_CacheLumpNum(lumpnum, 0);
  if (bytes.length < 64 * 64) { _flatCanvasCache.set(name, null); return null; }
  const indices = new Uint8Array(320 * 200);
  const alphas = new Uint8Array(320 * 200);
  alphas.fill(255);
  for (let y = 0; y < 200; y++) {
    for (let x = 0; x < 320; x++) {
      indices[y * 320 + x] = bytes[(y & 63) * 64 + (x & 63)];
    }
  }
  const info = V_CreatePaletteCanvasInfo(indices, alphas, 320, 200);
  _flatCanvasCache.set(name, info);
  return info;
}

export function F_TextWrite(ctx, dx, dy, dw, dh) {
  const background = getFlatCanvas(_finaleFlat);
  if (background !== null) ctx.drawImage(background.canvas, dx, dy, dw, dh);
  else { ctx.fillStyle = V_PaletteCSS(0); ctx.fillRect(dx, dy, dw, dh); }
  const sx = dw / 320, sy = dh / 200;
  // f_finale.c:F_TextWrite — `count = (finalecount - 10) / TEXTSPEED`
  // counts newlines and unsupported characters too. The reference stops the
  // whole reveal as soon as a proportional glyph would cross SCREENWIDTH.
  const maxChars = F_GetFinaleTextCount(_finalecount);
  const layout = HU_LayoutText(_finaleText, HU_GetFont(), {
    x: 10,
    y: 10,
    maxChars,
    lineHeight: 11,
    maxX: 320,
  });
  HU_DrawLayout(ctx, layout, dx, dy, sx, sy);
}

// F_BunnyScroll — E3 ending. Two 320-wide images (PFUB1 + PFUB2) scroll
// horizontally over ~3 seconds, then DOOM-style "THE END" END0..END6 patches
// pop in stage-by-stage with a pistol shot per frame.
function F_BunnyScroll(ctx, dx, dy, dw, dh) {
  const sx = dw / 320, sy = dh / 200;
  const p1 = getPatch('PFUB2'); // left image (drawn first)
  const p2 = getPatch('PFUB1'); // right image
  const scrolled = F_GetBunnyScroll(_finalecount);
  // Composite: 320-pixel-wide viewport sourced from p1 (cols 0..320-scrolled-1)
  // followed by p2 (cols 0..scrolled-1). Pillarbox black if absent.
  ctx.fillStyle = V_PaletteCSS(0);
  ctx.fillRect(dx, dy, dw, dh);
  if (p1 !== null) {
    const visW = 320 - scrolled;
    if (visW > 0) ctx.drawImage(p1.canvas, scrolled, 0, visW, p1.h, dx, dy, visW * sx, dh);
  }
  if (p2 !== null && scrolled > 0) {
    ctx.drawImage(p2.canvas, 0, 0, scrolled, p2.h, dx + (320 - scrolled) * sx, dy, scrolled * sx, dh);
  }
  const bunny = F_UpdateBunnyStage(_finalecount, _bunnyLastStage);
  _bunnyLastStage = bunny.laststage;
  if (bunny.stage < 0) return;
  if (bunny.playPistol) S_StartSound(null, sfx_pistol);
  const stage = bunny.stage;
  const end = getPatch(`END${stage}`);
  if (end !== null) {
    const ex = dx + ((320 - end.w) / 2) * sx;
    const ey = dy + ((200 - end.h) / 2) * sy;
    ctx.drawImage(end.canvas, ex, ey, end.w * sx, end.h * sy);
  }
}

export function F_Drawer(ctx, dx, dy, dw, dh) {
  if (!_active) return;
  if (_castActive) { F_CastDrawer(ctx, dx, dy, dw, dh); return; }
  if (_stage === 0) { F_TextWrite(ctx, dx, dy, dw, dh); return; }
  // Stage 1: still picture (or bunny scroll for E3).
  if (gameepisode === 3) { F_BunnyScroll(ctx, dx, dy, dw, dh); return; }
  const sx = dw / 320, sy = dh / 200;
  ctx.fillStyle = V_PaletteCSS(0);
  ctx.fillRect(dx, dy, dw, dh);
  const patchName = F_GetDoom1ArtPatch(gamemode, gameepisode);
  const pic = patchName === null ? null : getPatch(patchName);
  if (pic !== null) ctx.drawImage(pic.canvas, dx, dy, pic.w * sx, pic.h * sy);
}

export function F_isActive() { return _active; }

// ---------- F_CastDrawer / F_Cast* (Doom 2 cast call) ----------
// The cast call is a roster of every Doom monster, one at a time, looped
// through their attack animation. Shareware doom1.wad has no MAP30 to trigger
// it, but the functions are here for source-map parity with f_finale.c.

let _cast = null;
let _castActive = false;

export function F_StartCast() {
  // f_finale.c:F_StartCast forces a wipe even though both screens are
  // GS_FINALE (MAP30 text -> cast call).
  set_wipegamestate(-1);
  _castActive = true;
  _cast = F_CreateCastState();
  S_ChangeMusic(mus_evil, true);
}
export function F_CastTicker() {
  if (!_castActive || _cast === null) return;
  const sound = F_TickCast(_cast);
  if (sound !== 0) S_StartSound(null, sound);
}
export function F_CastResponder(ev) {
  if (!_castActive || _cast === null || ev?.type !== 0) return false;
  const sound = F_KillCast(_cast);
  if (sound !== 0) S_StartSound(null, sound);
  return true;
}
export function F_CastPrint(ctx, text, dx, dy, dw, dh) {
  const sx = dw / 320, sy = dh / 200;
  const layout = HU_LayoutCenteredText(text, HU_GetFont(), 160, 180);
  HU_DrawLayout(ctx, layout, dx, dy, sx, sy);
}
export function F_CastDrawer(ctx, dx, dy, dw, dh) {
  if (!_castActive || _cast === null) return;
  const sx = dw / 320, sy = dh / 200;
  ctx.fillStyle = V_PaletteCSS(0);
  ctx.fillRect(dx, dy, dw, dh);
  // Background — use BOSSBACK if present (Doom 2 only), else solid.
  const bg = getPatch('BOSSBACK');
  if (bg !== null) ctx.drawImage(bg.canvas, dx, dy, bg.w * sx, bg.h * sy);
  // f_finale.c:F_CastPrint centers proportional STCFN patches at y=180.
  const cast = F_GetCastDisplay(_cast);
  F_CastPrint(ctx, cast.name, dx, dy, dw, dh);
  // f_finale.c:F_CastDrawer selects rotation 0 from the actual spriteframe,
  // including its flip bit; names such as POSSA0 cannot represent every state.
  const spriteDef = sprites?.[cast.state.sprite];
  const spriteFrame = spriteDef?.spriteframes?.[cast.state.frame & 0x7fff];
  const relativeLump = spriteFrame?.lump?.[0] ?? -1;
  const lump = relativeLump < 0 ? null : lumpinfo[firstspritelump + relativeLump];
  const sp = lump === null || lump === undefined ? null : getPatch(lump.name);
  if (sp !== null) {
    const x = dx + (160 - sp.leftoffset) * sx;
    const y = dy + (170 - sp.topoffset)  * sy;
    if (spriteFrame.flip[0] === 1) {
      ctx.save();
      ctx.translate(x + sp.w * sx, y);
      ctx.scale(-1, 1);
      ctx.drawImage(sp.canvas, 0, 0, sp.w * sx, sp.h * sy);
      ctx.restore();
    } else {
      ctx.drawImage(sp.canvas, x, y, sp.w * sx, sp.h * sy);
    }
  }
}
export function F_CastActive() { return _castActive; }
