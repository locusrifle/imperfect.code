// Ported from: linuxdoom-1.10/wi_stuff.c — intermission ("between missions")
// screen. Faithful port of the single-player, co-op, and deathmatch paths:
// animated background, count-up state machines, stat tables, and the Doom 1
// world map ("Entering …" with splats and the flashing "You Are Here" pointer).
//
// Rendering uses the Canvas2D overlay (v_video.js V_DecodePatchToCanvas /
// V_DrawPatchAtCanvas) instead of the software framebuffer, but every patch,
// coordinate and timing value is taken verbatim from wi_stuff.c so the screen
// matches vanilla pixel-for-pixel. WI_Drawer receives (ctx, dx, dy, dw, dh):
// the on-canvas rectangle the 320x200 virtual screen maps to; we scale virtual
// coords by sx=dw/320, sy=dh/200.
//
import { deathmatch, gamemode, language, netgame, players, playeringame } from './doomstat.js';
import { GameMode_t, Language_t, MAXPLAYERS, TICRATE, SCREENWIDTH, SCREENHEIGHT } from './doomdef.js';
import { S_StartSound, S_ChangeMusic } from './s_sound.js';
import { M_Random } from './m_random.js';
import { mus_inter, mus_dm2int, sfx_pistol, sfx_barexp, sfx_sgcock } from './sounds.js';
import { V_DecodePatchToCanvas, V_DrawPatchAtCanvas } from './v_video.js';
import { V_PaletteCSS } from './v_palette.js';
import { WI_CheckForAccelerate } from './wi_input_logic.js';
import { G_IntermissionParTime } from './g_completion.js';
import {
  WI_InitDeathmatchStats,
  WI_InitNetgameStats,
  WI_UpdateDeathmatchStats,
  WI_UpdateNetgameStats,
} from './wi_multiplayer.js';

// ----------------------------------------------------------------------------
// Constants (wi_stuff.c / wi_stuff.h)
// ----------------------------------------------------------------------------

const NUMMAPS = 9;

// GLOBAL LOCATIONS
const WI_TITLEY = 2;
const WI_SPACINGY = 33;

// SINGLE-PLAYER STUFF
const SP_STATSX = 50;
const SP_STATSY = 50;
const SP_TIMEX  = 16;
const SP_TIMEY  = SCREENHEIGHT - 32;

// NET GAME STUFF
const NG_STATSY = 50;
const NG_SPACINGX = 64;

// DEATHMATCH STUFF
const DM_MATRIXX = 42;
const DM_MATRIXY = 68;
const DM_SPACINGX = 40;
const DM_TOTALSX = 269;
const DM_KILLERSX = 10;
const DM_KILLERSY = 100;
const DM_VICTIMSX = 5;
const DM_VICTIMSY = 50;

// in seconds
const SHOWNEXTLOCDELAY = 4;

// stateenum_t
const NoState     = -1;
const StatCount   = 0;
const ShowNextLoc = 1;

// animenum_t
const ANIM_ALWAYS = 0;
const ANIM_RANDOM = 1;
const ANIM_LEVEL  = 2;

// ----------------------------------------------------------------------------
// "You Are Here" level dot coordinates lnodes[episode][map] (wi_stuff.c:177)
// ----------------------------------------------------------------------------
const lnodes = [
  // Episode 0 World Map
  [ [185,164],[148,143],[69,122],[209,102],[116,89],[166,55],[71,56],[135,29],[71,24] ],
  // Episode 1 World Map
  [ [254,25],[97,50],[188,64],[128,78],[214,92],[133,130],[208,136],[148,140],[235,158] ],
  // Episode 2 World Map
  [ [156,168],[48,154],[174,95],[265,75],[130,48],[279,23],[198,48],[140,25],[281,136] ],
];

// ----------------------------------------------------------------------------
// Animation tables (wi_stuff.c:226). One mutable anim_t per entry; runtime
// fields (p[], nexttic, ctr, state) are reset by WI_initAnimatedBack and the
// frame graphics filled by WI_loadData — both run once per intermission, never
// per frame, so no allocation happens in the tick/draw loop.
// ----------------------------------------------------------------------------
const P3 = (TICRATE / 3) | 0; // 11
const P4 = (TICRATE / 4) | 0; // 8

function mkanim(type, period, nanims, x, y, data1, data2) {
  return {
    type, period, nanims, loc: { x, y },
    data1: data1 | 0, data2: data2 | 0,
    p: [null, null, null],
    nexttic: 0, ctr: -1,
  };
}

const epsd0animinfo = [
  mkanim(ANIM_ALWAYS, P3, 3, 224, 104),
  mkanim(ANIM_ALWAYS, P3, 3, 184, 160),
  mkanim(ANIM_ALWAYS, P3, 3, 112, 136),
  mkanim(ANIM_ALWAYS, P3, 3,  72, 112),
  mkanim(ANIM_ALWAYS, P3, 3,  88,  96),
  mkanim(ANIM_ALWAYS, P3, 3,  64,  48),
  mkanim(ANIM_ALWAYS, P3, 3, 192,  40),
  mkanim(ANIM_ALWAYS, P3, 3, 136,  16),
  mkanim(ANIM_ALWAYS, P3, 3,  80,  16),
  mkanim(ANIM_ALWAYS, P3, 3,  64,  24),
];

const epsd1animinfo = [
  mkanim(ANIM_LEVEL, P3, 1, 128, 136, 1),
  mkanim(ANIM_LEVEL, P3, 1, 128, 136, 2),
  mkanim(ANIM_LEVEL, P3, 1, 128, 136, 3),
  mkanim(ANIM_LEVEL, P3, 1, 128, 136, 4),
  mkanim(ANIM_LEVEL, P3, 1, 128, 136, 5),
  mkanim(ANIM_LEVEL, P3, 1, 128, 136, 6),
  mkanim(ANIM_LEVEL, P3, 1, 128, 136, 7),
  mkanim(ANIM_LEVEL, P3, 3, 192, 144, 8),
  mkanim(ANIM_LEVEL, P3, 1, 128, 136, 8),
];

const epsd2animinfo = [
  mkanim(ANIM_ALWAYS, P3, 3, 104, 168),
  mkanim(ANIM_ALWAYS, P3, 3,  40, 136),
  mkanim(ANIM_ALWAYS, P3, 3, 160,  96),
  mkanim(ANIM_ALWAYS, P3, 3, 104,  80),
  mkanim(ANIM_ALWAYS, P3, 3, 120,  32),
  mkanim(ANIM_ALWAYS, P4, 3,  40,   0),
];

const anims    = [epsd0animinfo, epsd1animinfo, epsd2animinfo];
const NUMANIMS = [epsd0animinfo.length, epsd1animinfo.length, epsd2animinfo.length];

// ----------------------------------------------------------------------------
// General data (wi_stuff.c "GENERAL DATA")
// ----------------------------------------------------------------------------

let acceleratestage = 0;   // accelerate/skip a stage
let me = 0;                // wbs.pnum
let state = StatCount;     // current state
let wbs = null;            // wbstartstruct passed into intermission
let plrs = null;           // wbs.plyr[]
let cnt = 0;               // general timing
let bcnt = 0;              // background-animation timing
let cnt_kills = 0, cnt_items = 0, cnt_secret = 0; // single-player [0] slots
let cnt_time = 0, cnt_par = 0, cnt_pause = 0;
let sp_state = 0;
let dm_stats = null;
let ng_stats = null;
let dofrags = 0;            // static in wi_stuff.c; intentionally persists
let snl_pointeron = false;

let _active = false;       // gates ticker/drawer/responder when not running
let _onDone = null;        // called at end of NoState (vanilla G_WorldDone)
let _completionQueued = false; // keep the last frame drawable until state exit

// ----------------------------------------------------------------------------
// Graphics (decoded patch infos: { canvas, w, h, leftoffset, topoffset } | null)
// ----------------------------------------------------------------------------
let bg        = null;        // background (map of levels)
const yah     = [null, null]; // "You Are Here" (+ alt)
let splat     = null;        // visited-level splat
let percent   = null, colon = null, wiminus = null;
const num     = new Array(10).fill(null); // 0-9
let finished  = null, entering = null, sp_secret = null;
let kills     = null, secret = null, items = null, frags = null;
let time      = null, par = null, sucks = null;
let killers   = null, victims = null, total = null;
let star      = null, bstar = null;
const playerPatches = new Array(MAXPLAYERS).fill(null);
const grayPlayerPatches = new Array(MAXPLAYERS).fill(null);
let lnames    = [];          // level-name patches (centered)
const _splatArr = [null];    // [splat] wrapper for WI_drawOnLnode; filled by WI_loadData

// ----------------------------------------------------------------------------
// Per-frame draw context (set by WI_Drawer). Virtual 320x200 -> device pixels.
// ----------------------------------------------------------------------------
let _ctx = null, _ox = 0, _oy = 0, _sx = 1, _sy = 1;

// Draw a decoded patch at virtual (vx, vy). V_DrawPatchAtCanvas applies the
// patch's leftoffset/topoffset (scaled) exactly like vanilla V_DrawPatch, so
// passing virtual coords reproduces vanilla placement under scaling.
function drawPatch(info, vx, vy) {
  if (info == null) return; // null or undefined (e.g. out-of-range lnames[])
  V_DrawPatchAtCanvas(_ctx, info, _ox + vx * _sx, _oy + vy * _sy, _sx, _sy);
}

// ----------------------------------------------------------------------------
// CODE
// ----------------------------------------------------------------------------

// wi_stuff.c:406 — vanilla memcpy's the prepared background screen over the
// framebuffer. Here we fill the letterbox black then blit the full-screen
// background patch.
function WI_slamBackground() {
  _ctx.fillStyle = V_PaletteCSS(0);
  _ctx.fillRect(_ox, _oy, SCREENWIDTH * _sx, SCREENHEIGHT * _sy);
  drawPatch(bg, 0, 0);
}

// Draws "<Levelname> Finished!" (wi_stuff.c:421)
function WI_drawLF() {
  let y = WI_TITLEY;
  const ln = lnames[wbs.last];
  // draw <LevelName>
  if (ln !== null && ln !== undefined) {
    drawPatch(ln, ((SCREENWIDTH - ln.w) / 2) | 0, y);
    // draw "Finished!"
    y += ((5 * ln.h) / 4) | 0;
  }
  if (finished !== null) drawPatch(finished, ((SCREENWIDTH - finished.w) / 2) | 0, y);
}

// Draws "Entering <LevelName>" (wi_stuff.c:439)
function WI_drawEL() {
  let y = WI_TITLEY;
  const ln = lnames[wbs.next];
  // draw "Entering"
  if (entering !== null) drawPatch(entering, ((SCREENWIDTH - entering.w) / 2) | 0, y);
  // draw level
  if (ln !== null && ln !== undefined) {
    y += ((5 * ln.h) / 4) | 0;
    drawPatch(ln, ((SCREENWIDTH - ln.w) / 2) | 0, y);
  }
}

// Draws patch c[i] (first variant that fits on screen) at lnodes[epsd][n]
// (wi_stuff.c:455). c is an array of 1 or 2 patch infos.
function WI_drawOnLnode(n, c) {
  if (wbs.epsd < 0 || wbs.epsd > 2 || n < 0 || n >= NUMMAPS) return;
  const node = lnodes[wbs.epsd][n];
  let i = 0;
  let fits = false;
  do {
    const ci = c[i];
    if (ci === null || ci === undefined) { i++; continue; }
    const left   = node[0] - ci.leftoffset;
    const top    = node[1] - ci.topoffset;
    const right  = left + ci.w;
    const bottom = top + ci.h;
    if (left >= 0 && right < SCREENWIDTH && top >= 0 && bottom < SCREENHEIGHT) fits = true;
    else i++;
  } while (fits === false && i !== 2);

  if (fits === true && i < 2) {
    drawPatch(c[i], node[0], node[1]);
  } else {
    console.log(`WI: Could not place patch on level ${n + 1}`);
  }
}

// --- Animated background (wi_stuff.c:503) ---

function WI_initAnimatedBack() {
  if (gamemode === GameMode_t.commercial) return;
  if (wbs.epsd > 2) return;

  for (let i = 0; i < NUMANIMS[wbs.epsd]; i++) {
    const a = anims[wbs.epsd][i];
    a.ctr = -1; // init
    // specify the next time to draw it
    if (a.type === ANIM_ALWAYS)
      a.nexttic = bcnt + 1 + (M_Random() % a.period);
    else if (a.type === ANIM_RANDOM)
      a.nexttic = bcnt + 1 + a.data2 + (M_Random() % a.data1);
    else if (a.type === ANIM_LEVEL)
      a.nexttic = bcnt + 1;
  }
}

function WI_updateAnimatedBack() {
  if (gamemode === GameMode_t.commercial) return;
  if (wbs.epsd > 2) return;

  for (let i = 0; i < NUMANIMS[wbs.epsd]; i++) {
    const a = anims[wbs.epsd][i];
    if (bcnt === a.nexttic) {
      switch (a.type) {
        case ANIM_ALWAYS:
          if (++a.ctr >= a.nanims) a.ctr = 0;
          a.nexttic = bcnt + a.period;
          break;
        case ANIM_RANDOM:
          a.ctr++;
          if (a.ctr === a.nanims) {
            a.ctr = -1;
            a.nexttic = bcnt + a.data2 + (M_Random() % a.data1);
          } else a.nexttic = bcnt + a.period;
          break;
        case ANIM_LEVEL:
          // gawd-awful hack for level anims
          if (!(state === StatCount && i === 7) && wbs.next === a.data1) {
            a.ctr++;
            if (a.ctr === a.nanims) a.ctr--;
            a.nexttic = bcnt + a.period;
          }
          break;
      }
    }
  }
}

function WI_drawAnimatedBack() {
  if (gamemode === GameMode_t.commercial) return;
  if (wbs.epsd > 2) return;

  for (let i = 0; i < NUMANIMS[wbs.epsd]; i++) {
    const a = anims[wbs.epsd][i];
    if (a.ctr >= 0) drawPatch(a.p[a.ctr], a.loc.x, a.loc.y);
  }
}

// Draws a number. If digits > 0, use that many minimum; if < 0, only as many as
// necessary. Returns new x. (wi_stuff.c:611)
function WI_drawNum(x, y, n, digits) {
  const fontwidth = (num[0] !== null) ? num[0].w : 0;
  let temp;

  if (digits < 0) {
    if (n === 0) {
      digits = 1; // variable-length zero is 1 digit
    } else {
      digits = 0;
      temp = n;
      while (temp !== 0) { temp = (temp / 10) | 0; digits++; }
    }
  }

  const neg = n < 0;
  if (neg === true) n = -n;

  // if non-number, do not draw it
  if (n === 1994) return 0;

  // draw the new number
  while (digits-- > 0) {
    x -= fontwidth;
    drawPatch(num[n % 10], x, y);
    n = (n / 10) | 0;
  }

  // draw a minus sign if necessary
  if (neg === true) { x -= 8; drawPatch(wiminus, x, y); }

  return x;
}

function WI_drawPercent(x, y, p) {
  if (p < 0) return;
  drawPatch(percent, x, y);
  WI_drawNum(x, y, p, -1);
}

// Display level completion time and par, or "sucks" on overflow (wi_stuff.c:687)
function WI_drawTime(x, y, t) {
  if (t < 0) return;

  if (t <= 61 * 59) {
    let div = 1;
    const colw = (colon !== null) ? colon.w : 0;
    do {
      const n = ((t / div) | 0) % 60;
      x = WI_drawNum(x, y, n, 2) - colw;
      div *= 60;
      // draw colon
      if (div === 60 || ((t / div) | 0) !== 0) drawPatch(colon, x, y);
    } while (((t / div) | 0) !== 0);
  } else {
    // "sucks"
    if (sucks !== null) drawPatch(sucks, x - sucks.w, y);
  }
}

export function WI_Stop() {
  _active = false;
  _completionQueued = false;
  _onDone = null;
  WI_unloadData();
}

function WI_initNoState() {
  state = NoState;
  acceleratestage = 0;
  cnt = 10;
}

function WI_updateNoState() {
  WI_updateAnimatedBack();
  cnt--;
  if (cnt === 0) {
    // G_Ticker cannot drain this newly queued action until the next tic. Keep
    // the completed intermission drawable for the presentation in between.
    _completionQueued = true;
    _onDone(); // vanilla: G_WorldDone()
  }
}

function WI_initShowNextLoc() {
  state = ShowNextLoc;
  acceleratestage = 0;
  cnt = SHOWNEXTLOCDELAY * TICRATE;
  WI_initAnimatedBack();
}

function WI_updateShowNextLoc() {
  WI_updateAnimatedBack();
  cnt--;
  if (cnt === 0 || acceleratestage === 1) WI_initNoState();
  else snl_pointeron = (cnt & 31) < 20;
}

function WI_drawShowNextLoc() {
  WI_slamBackground();
  WI_drawAnimatedBack();

  if (gamemode !== GameMode_t.commercial) {
    if (wbs.epsd > 2) { WI_drawEL(); return; }

    const last = (wbs.last === 8) ? wbs.next - 1 : wbs.last;

    // draw a splat on taken cities
    for (let i = 0; i <= last; i++) WI_drawOnLnode(i, _splatArr);

    // splat the secret level?
    if (wbs.didsecret === true) WI_drawOnLnode(8, _splatArr);

    // draw flashing ptr
    if (snl_pointeron === true) WI_drawOnLnode(wbs.next, yah);
  }

  // draws which level you are entering
  if (gamemode !== GameMode_t.commercial || wbs.next !== 30) WI_drawEL();
}

function WI_drawNoState() {
  snl_pointeron = true;
  WI_drawShowNextLoc();
}

// --- Deathmatch stats (wi_stuff.c:843-1072) ---

function WI_initDeathmatchStats() {
  state = StatCount;
  acceleratestage = 0;
  dm_stats = WI_InitDeathmatchStats(playeringame);
  WI_initAnimatedBack();
}

function WI_updateDeathmatchStats() {
  WI_updateAnimatedBack();
  const result = WI_UpdateDeathmatchStats(
    dm_stats,
    plrs,
    playeringame,
    bcnt,
    acceleratestage,
  );
  acceleratestage = result.accelerate;
  for (const sound of result.sounds) S_StartSound(null, sound);
  if (result.advance) {
    if (gamemode === GameMode_t.commercial) WI_initNoState();
    else WI_initShowNextLoc();
  }
}

function WI_drawDeathmatchStats() {
  WI_slamBackground();
  WI_drawAnimatedBack();
  WI_drawLF();

  drawPatch(total, DM_TOTALSX - ((total.w / 2) | 0), DM_MATRIXY - WI_SPACINGY + 10);
  drawPatch(killers, DM_KILLERSX, DM_KILLERSY);
  drawPatch(victims, DM_VICTIMSX, DM_VICTIMSY);

  let x = DM_MATRIXX + DM_SPACINGX;
  let y = DM_MATRIXY;
  for (let i = 0; i < playerPatches.length; i++) {
    const patch = playerPatches[i];
    if (playeringame[i] === true) {
      const halfWidth = (patch.w / 2) | 0;
      drawPatch(patch, x - halfWidth, DM_MATRIXY - WI_SPACINGY);
      drawPatch(patch, DM_MATRIXX - halfWidth, y);
      if (i === me) {
        drawPatch(bstar, x - halfWidth, DM_MATRIXY - WI_SPACINGY);
        drawPatch(star, DM_MATRIXX - halfWidth, y);
      }
    }
    x += DM_SPACINGX;
    y += WI_SPACINGY;
  }

  y = DM_MATRIXY + 10;
  const numberWidth = num[0].w;
  for (let i = 0; i < playerPatches.length; i++) {
    x = DM_MATRIXX + DM_SPACINGX;
    if (playeringame[i] === true) {
      for (let j = 0; j < playerPatches.length; j++) {
        if (playeringame[j] === true) WI_drawNum(x + numberWidth, y, dm_stats.frags[i][j], 2);
        x += DM_SPACINGX;
      }
      WI_drawNum(DM_TOTALSX + numberWidth, y, dm_stats.totals[i], 2);
    }
    y += WI_SPACINGY;
  }
}

// --- Co-op stats (wi_stuff.c:1074-1314) ---

function WI_initNetgameStats() {
  state = StatCount;
  acceleratestage = 0;
  ng_stats = WI_InitNetgameStats(plrs, playeringame, dofrags);
  dofrags = ng_stats.dofrags ? 1 : 0;
  WI_initAnimatedBack();
}

function WI_updateNetgameStats() {
  WI_updateAnimatedBack();
  const result = WI_UpdateNetgameStats(
    ng_stats,
    wbs,
    playeringame,
    bcnt,
    acceleratestage,
  );
  acceleratestage = result.accelerate;
  for (const sound of result.sounds) S_StartSound(null, sound);
  if (result.advance) {
    if (gamemode === GameMode_t.commercial) WI_initNoState();
    else WI_initShowNextLoc();
  }
}

function WI_drawNetgameStats() {
  WI_slamBackground();
  WI_drawAnimatedBack();
  WI_drawLF();

  const statsX = 32 + ((star.w / 2) | 0) + 32 * (ng_stats.dofrags ? 0 : 1);
  drawPatch(kills, statsX + NG_SPACINGX - kills.w, NG_STATSY);
  drawPatch(items, statsX + 2 * NG_SPACINGX - items.w, NG_STATSY);
  drawPatch(secret, statsX + 3 * NG_SPACINGX - secret.w, NG_STATSY);
  if (ng_stats.dofrags) {
    drawPatch(frags, statsX + 4 * NG_SPACINGX - frags.w, NG_STATSY);
  }

  let y = NG_STATSY + kills.h;
  const percentWidth = percent.w;
  for (let i = 0; i < playerPatches.length; i++) {
    if (playeringame[i] !== true) continue;
    let x = statsX;
    drawPatch(playerPatches[i], x - playerPatches[i].w, y);
    if (i === me) drawPatch(star, x - playerPatches[i].w, y);

    x += NG_SPACINGX;
    WI_drawPercent(x - percentWidth, y + 10, ng_stats.kills[i]);
    x += NG_SPACINGX;
    WI_drawPercent(x - percentWidth, y + 10, ng_stats.items[i]);
    x += NG_SPACINGX;
    WI_drawPercent(x - percentWidth, y + 10, ng_stats.secret[i]);
    x += NG_SPACINGX;
    if (ng_stats.dofrags) WI_drawNum(x, y + 10, ng_stats.frags[i], -1);

    y += WI_SPACINGY;
  }
}

// --- Single-player stats (wi_stuff.c:1316) ---

function _pctTarget(count, max) {
  // (count * 100) / max, integer-truncated like C. max is >=1 (WI_initVariables).
  return ((count * 100) / max) | 0;
}

function WI_initStats() {
  state = StatCount;
  acceleratestage = 0;
  sp_state = 1;
  cnt_kills = cnt_items = cnt_secret = -1;
  cnt_time = cnt_par = -1;
  cnt_pause = TICRATE;
  WI_initAnimatedBack();
}

function WI_updateStats() {
  WI_updateAnimatedBack();

  if (acceleratestage === 1 && sp_state !== 10) {
    acceleratestage = 0;
    cnt_kills  = _pctTarget(plrs[me].skills,  wbs.maxkills);
    cnt_items  = _pctTarget(plrs[me].sitems,  wbs.maxitems);
    cnt_secret = _pctTarget(plrs[me].ssecret, wbs.maxsecret);
    cnt_time   = (plrs[me].stime / TICRATE) | 0;
    cnt_par    = (wbs.partime / TICRATE) | 0;
    S_StartSound(null, sfx_barexp);
    sp_state = 10;
  }

  if (sp_state === 2) {
    cnt_kills += 2;
    if ((bcnt & 3) === 0) S_StartSound(null, sfx_pistol);
    const t = _pctTarget(plrs[me].skills, wbs.maxkills);
    if (cnt_kills >= t) { cnt_kills = t; S_StartSound(null, sfx_barexp); sp_state++; }
  } else if (sp_state === 4) {
    cnt_items += 2;
    if ((bcnt & 3) === 0) S_StartSound(null, sfx_pistol);
    const t = _pctTarget(plrs[me].sitems, wbs.maxitems);
    if (cnt_items >= t) { cnt_items = t; S_StartSound(null, sfx_barexp); sp_state++; }
  } else if (sp_state === 6) {
    cnt_secret += 2;
    if ((bcnt & 3) === 0) S_StartSound(null, sfx_pistol);
    const t = _pctTarget(plrs[me].ssecret, wbs.maxsecret);
    if (cnt_secret >= t) { cnt_secret = t; S_StartSound(null, sfx_barexp); sp_state++; }
  } else if (sp_state === 8) {
    if ((bcnt & 3) === 0) S_StartSound(null, sfx_pistol);
    const tTime = (plrs[me].stime / TICRATE) | 0;
    const tPar  = (wbs.partime / TICRATE) | 0;
    cnt_time += 3;
    if (cnt_time >= tTime) cnt_time = tTime;
    cnt_par += 3;
    if (cnt_par >= tPar) {
      cnt_par = tPar;
      if (cnt_time >= tTime) { S_StartSound(null, sfx_barexp); sp_state++; }
    }
  } else if (sp_state === 10) {
    if (acceleratestage === 1) {
      S_StartSound(null, sfx_sgcock);
      if (gamemode === GameMode_t.commercial) WI_initNoState();
      else WI_initShowNextLoc();
    }
  } else if ((sp_state & 1) === 1) {
    cnt_pause--;
    if (cnt_pause === 0) { sp_state++; cnt_pause = TICRATE; }
  }
}

function WI_drawStats() {
  // line height
  const lh = (num[0] !== null) ? ((3 * num[0].h) / 2) | 0 : 0;

  WI_slamBackground();
  WI_drawAnimatedBack();
  WI_drawLF();

  drawPatch(kills, SP_STATSX, SP_STATSY);
  WI_drawPercent(SCREENWIDTH - SP_STATSX, SP_STATSY, cnt_kills);

  drawPatch(items, SP_STATSX, SP_STATSY + lh);
  WI_drawPercent(SCREENWIDTH - SP_STATSX, SP_STATSY + lh, cnt_items);

  drawPatch(sp_secret, SP_STATSX, SP_STATSY + 2 * lh);
  WI_drawPercent(SCREENWIDTH - SP_STATSX, SP_STATSY + 2 * lh, cnt_secret);

  drawPatch(time, SP_TIMEX, SP_TIMEY);
  WI_drawTime((SCREENWIDTH / 2) - SP_TIMEX, SP_TIMEY, cnt_time);

  if (wbs.epsd < 3) {
    drawPatch(par, (SCREENWIDTH / 2) + SP_TIMEX, SP_TIMEY);
    WI_drawTime(SCREENWIDTH - SP_TIMEX, SP_TIMEY, cnt_par);
  }
}

// ----------------------------------------------------------------------------
// Ticker / responder / drawer / start
// ----------------------------------------------------------------------------

// wi_stuff.c:412-417 — timing-sensitive intermission input is never driven by
// raw events. WI_Ticker polls the active players' attack/use ticcmd edges.
export function WI_Responder(_ev) {
  return false;
}

// Updates stuff each tick (wi_stuff.c:1502).
export function WI_Ticker() {
  if (_active !== true || _completionQueued) return;

  // counter for general background animation
  bcnt++;

  if (bcnt === 1) {
    // intermission music
    if (gamemode === GameMode_t.commercial) S_ChangeMusic(mus_dm2int, true);
    else S_ChangeMusic(mus_inter, true);
  }

  // wi_stuff.c:1517 — poll after the music edge and before the state update.
  if (WI_CheckForAccelerate(players, playeringame)) acceleratestage = 1;

  switch (state) {
    case StatCount:
      if (deathmatch !== 0) WI_updateDeathmatchStats();
      else if (netgame) WI_updateNetgameStats();
      else WI_updateStats();
      break;
    case ShowNextLoc: WI_updateShowNextLoc(); break;
    case NoState:     WI_updateNoState();      break;
  }
}

function WI_loadData() {
  // background
  let name;
  if (gamemode === GameMode_t.commercial) name = 'INTERPIC';
  else name = 'WIMAP' + wbs.epsd;
  if (gamemode === GameMode_t.retail && wbs.epsd === 3) name = 'INTERPIC';
  bg = V_DecodePatchToCanvas(name);

  if (gamemode === GameMode_t.commercial) {
    lnames = new Array(32);
    for (let i = 0; i < 32; i++) lnames[i] = V_DecodePatchToCanvas('CWILV' + String(i).padStart(2, '0'));
  } else {
    lnames = new Array(NUMMAPS);
    for (let i = 0; i < NUMMAPS; i++) lnames[i] = V_DecodePatchToCanvas('WILV' + wbs.epsd + i);

    // you are here (+ alt)
    yah[0] = V_DecodePatchToCanvas('WIURH0');
    yah[1] = V_DecodePatchToCanvas('WIURH1');

    // splat
    splat = V_DecodePatchToCanvas('WISPLAT');
    _splatArr[0] = splat;

    if (wbs.epsd < 3) {
      for (let j = 0; j < NUMANIMS[wbs.epsd]; j++) {
        const a = anims[wbs.epsd][j];
        for (let i = 0; i < a.nanims; i++) {
          // MONDO HACK! Episode 1 anim 8 reuses anim 4's frames.
          if (wbs.epsd !== 1 || j !== 8) {
            a.p[i] = V_DecodePatchToCanvas('WIA' + wbs.epsd + String(j).padStart(2, '0') + String(i).padStart(2, '0'));
          } else {
            a.p[i] = anims[1][4].p[i];
          }
        }
      }
    }
  }

  // minus sign
  wiminus = V_DecodePatchToCanvas('WIMINUS');
  // numbers 0-9
  for (let i = 0; i < 10; i++) num[i] = V_DecodePatchToCanvas('WINUM' + i);
  // percent sign
  percent = V_DecodePatchToCanvas('WIPCNT');
  // "finished" / "entering"
  finished = V_DecodePatchToCanvas('WIF');
  entering = V_DecodePatchToCanvas('WIENTER');
  // "kills"
  kills = V_DecodePatchToCanvas('WIOSTK');
  // "scrt" (co-op table label)
  secret = V_DecodePatchToCanvas('WIOSTS');
  // "secret" (single-player label)
  sp_secret = V_DecodePatchToCanvas('WISCRT2');
  // French co-op uses its alternate "objects" label (wi_stuff.c:1654-1663).
  const itemPatch = language === Language_t.french && netgame && deathmatch === 0
    ? 'WIOBJ'
    : 'WIOSTI';
  items = V_DecodePatchToCanvas(itemPatch);
  // "frgs"
  frags = V_DecodePatchToCanvas('WIFRGS');
  // ":"
  colon = V_DecodePatchToCanvas('WICOLON');
  // "time"
  time = V_DecodePatchToCanvas('WITIME');
  // "sucks"
  sucks = V_DecodePatchToCanvas('WISUCKS');
  // "par"
  par = V_DecodePatchToCanvas('WIPAR');
  // deathmatch matrix labels
  killers = V_DecodePatchToCanvas('WIKILRS');
  victims = V_DecodePatchToCanvas('WIVCTMS');
  total = V_DecodePatchToCanvas('WIMSTT');
  // local-player face markers
  star = V_DecodePatchToCanvas('STFST01');
  bstar = V_DecodePatchToCanvas('STFDEAD0');
  for (let i = 0; i < playerPatches.length; i++) {
    playerPatches[i] = V_DecodePatchToCanvas('STPB' + i);
    grayPlayerPatches[i] = V_DecodePatchToCanvas('WIBP' + (i + 1));
  }
}

// Decoded patches live in v_video's central cache, but the intermission also
// keeps direct references. Drop those references so shutdown can release every
// backing canvas and a later intermission re-resolves cleanly.
function WI_unloadData() {
  bg = null;
  yah.fill(null);
  splat = null;
  percent = null;
  colon = null;
  wiminus = null;
  num.fill(null);
  finished = null;
  entering = null;
  sp_secret = null;
  kills = null;
  secret = null;
  items = null;
  frags = null;
  time = null;
  par = null;
  sucks = null;
  killers = null;
  victims = null;
  total = null;
  star = null;
  bstar = null;
  playerPatches.fill(null);
  grayPlayerPatches.fill(null);
  lnames = [];
  _splatArr[0] = null;
  for (const episode of anims) {
    for (const animation of episode) animation.p.fill(null);
  }
  _ctx = null;
  _ox = 0;
  _oy = 0;
  _sx = 1;
  _sy = 1;
}

export function WI_Shutdown() {
  WI_Stop();
}

export function WI_Drawer(ctx, dx, dy, dw, dh) {
  if (_active !== true) return;
  _ctx = ctx; _ox = dx; _oy = dy; _sx = dw / 320; _sy = dh / 200;

  switch (state) {
    case StatCount:
      if (deathmatch !== 0) WI_drawDeathmatchStats();
      else if (netgame) WI_drawNetgameStats();
      else WI_drawStats();
      break;
    case ShowNextLoc: WI_drawShowNextLoc(); break;
    case NoState:     WI_drawNoState();      break;
  }
}

function WI_initVariables(wbstartstruct) {
  wbs = wbstartstruct;

  acceleratestage = 0;
  cnt = bcnt = 0;
  me = wbs.pnum;
  plrs = wbs.plyr;

  if (wbs.maxkills  <= 0) wbs.maxkills  = 1;
  if (wbs.maxitems  <= 0) wbs.maxitems  = 1;
  if (wbs.maxsecret <= 0) wbs.maxsecret = 1;

  if (gamemode !== GameMode_t.retail) { if (wbs.epsd > 2) wbs.epsd -= 3; }

  // External fixtures may omit partime; production G_DoCompleted supplies it.
  if (wbs.partime === undefined || wbs.partime === null)
    wbs.partime = G_IntermissionParTime(gamemode, wbs.epsd + 1, wbs.last + 1);
}

export function WI_Start(wbstartstruct, onDone) {
  WI_Stop();
  _onDone = (onDone !== null && onDone !== undefined) ? onDone : (() => {});
  _completionQueued = false;
  WI_initVariables(wbstartstruct);
  WI_loadData();
  if (deathmatch !== 0) WI_initDeathmatchStats();
  else if (netgame) WI_initNetgameStats();
  else WI_initStats();
  _active = true;
}
