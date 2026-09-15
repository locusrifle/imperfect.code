// Pure MAP30 cast state machine, ported from f_finale.c:F_StartCast,
// F_CastTicker, and F_CastResponder. Rendering and audio playback stay in
// f_finale.js; this module returns the sound id for each transition.

import {
  states, mobjinfo, S_NULL, S_PLAY_ATK1,
  S_POSS_ATK2, S_SPOS_ATK2, S_VILE_ATK2,
  S_SKEL_FIST2, S_SKEL_FIST4, S_SKEL_MISS2,
  S_FATT_ATK2, S_FATT_ATK5, S_FATT_ATK8,
  S_CPOS_ATK2, S_CPOS_ATK3, S_CPOS_ATK4,
  S_TROO_ATK3, S_SARG_ATK2, S_BOSS_ATK2, S_BOS2_ATK2,
  S_HEAD_ATK2, S_SKULL_ATK2, S_SPID_ATK2, S_SPID_ATK3,
  S_BSPI_ATK2, S_CYBER_ATK2, S_CYBER_ATK4, S_CYBER_ATK6,
  S_PAIN_ATK3,
  MT_POSSESSED, MT_SHOTGUY, MT_CHAINGUY, MT_TROOP, MT_SERGEANT,
  MT_SKULL, MT_HEAD, MT_KNIGHT, MT_BRUISER, MT_BABY, MT_PAIN,
  MT_UNDEAD, MT_FATSO, MT_VILE, MT_SPIDER, MT_CYBORG, MT_PLAYER,
} from './info.js';
import {
  sfx_dshtgn, sfx_pistol, sfx_shotgn, sfx_vilatk,
  sfx_skeswg, sfx_skepch, sfx_skeatk, sfx_firsht,
  sfx_claw, sfx_sgtatk, sfx_sklatk, sfx_plasma, sfx_rlaunc,
} from './sounds.js';
import {
  CC_ZOMBIE, CC_SHOTGUN, CC_HEAVY, CC_IMP, CC_DEMON, CC_LOST,
  CC_CACO, CC_HELL, CC_BARON, CC_ARACH, CC_PAIN, CC_REVEN,
  CC_MANCU, CC_ARCH, CC_SPIDER, CC_CYBER, CC_HERO,
} from './d_englsh.js';

export const F_CAST_ORDER = Object.freeze([
  Object.freeze({ name: CC_ZOMBIE,  type: MT_POSSESSED }),
  Object.freeze({ name: CC_SHOTGUN, type: MT_SHOTGUY }),
  Object.freeze({ name: CC_HEAVY,   type: MT_CHAINGUY }),
  Object.freeze({ name: CC_IMP,     type: MT_TROOP }),
  Object.freeze({ name: CC_DEMON,   type: MT_SERGEANT }),
  Object.freeze({ name: CC_LOST,    type: MT_SKULL }),
  Object.freeze({ name: CC_CACO,    type: MT_HEAD }),
  Object.freeze({ name: CC_HELL,    type: MT_KNIGHT }),
  Object.freeze({ name: CC_BARON,   type: MT_BRUISER }),
  Object.freeze({ name: CC_ARACH,   type: MT_BABY }),
  Object.freeze({ name: CC_PAIN,    type: MT_PAIN }),
  Object.freeze({ name: CC_REVEN,   type: MT_UNDEAD }),
  Object.freeze({ name: CC_MANCU,   type: MT_FATSO }),
  Object.freeze({ name: CC_ARCH,    type: MT_VILE }),
  Object.freeze({ name: CC_SPIDER,  type: MT_SPIDER }),
  Object.freeze({ name: CC_CYBER,   type: MT_CYBORG }),
  Object.freeze({ name: CC_HERO,    type: MT_PLAYER }),
]);

function castInfo(cast) {
  return mobjinfo[F_CAST_ORDER[cast.num].type];
}

function soundForState(state) {
  switch (state) {
    case S_PLAY_ATK1: return sfx_dshtgn;
    case S_POSS_ATK2: return sfx_pistol;
    case S_SPOS_ATK2: return sfx_shotgn;
    case S_VILE_ATK2: return sfx_vilatk;
    case S_SKEL_FIST2: return sfx_skeswg;
    case S_SKEL_FIST4: return sfx_skepch;
    case S_SKEL_MISS2: return sfx_skeatk;
    case S_FATT_ATK2:
    case S_FATT_ATK5:
    case S_FATT_ATK8: return sfx_firsht;
    case S_CPOS_ATK2:
    case S_CPOS_ATK3:
    case S_CPOS_ATK4: return sfx_shotgn;
    case S_TROO_ATK3: return sfx_claw;
    case S_SARG_ATK2: return sfx_sgtatk;
    case S_BOSS_ATK2:
    case S_BOS2_ATK2:
    case S_HEAD_ATK2: return sfx_firsht;
    case S_SKULL_ATK2: return sfx_sklatk;
    case S_SPID_ATK2:
    case S_SPID_ATK3: return sfx_shotgn;
    case S_BSPI_ATK2: return sfx_plasma;
    case S_CYBER_ATK2:
    case S_CYBER_ATK4:
    case S_CYBER_ATK6: return sfx_rlaunc;
    case S_PAIN_ATK3: return sfx_sklatk;
    default: return 0;
  }
}

export function F_CreateCastState() {
  const state = mobjinfo[F_CAST_ORDER[0].type].seestate;
  return {
    num: 0,
    state,
    tics: states[state].tics,
    death: false,
    frames: 0,
    onMelee: 0,
    attacking: false,
  };
}

export function F_GetCastDisplay(cast) {
  return { name: F_CAST_ORDER[cast.num].name, state: states[cast.state] };
}

// Advances one finale tic and returns a sound id (0 means silence).
export function F_TickCast(cast) {
  if (--cast.tics > 0) return 0;

  let sound = 0;
  let stopAttack = false;
  const current = states[cast.state];
  if (current.tics === -1 || current.nextstate === S_NULL) {
    cast.num = (cast.num + 1) % F_CAST_ORDER.length;
    cast.death = false;
    const info = castInfo(cast);
    sound = info.seesound;
    cast.state = info.seestate;
    cast.frames = 0;
  } else if (cast.state === S_PLAY_ATK1) {
    // The original's deliberate player-animation hack jumps to stopattack.
    stopAttack = true;
  } else {
    cast.state = current.nextstate;
    cast.frames++;
    sound = soundForState(cast.state);
  }

  if (!stopAttack && cast.frames === 12) {
    cast.attacking = true;
    const info = castInfo(cast);
    cast.state = cast.onMelee ? info.meleestate : info.missilestate;
    cast.onMelee ^= 1;
    if (cast.state === S_NULL) {
      cast.state = cast.onMelee ? info.meleestate : info.missilestate;
    }
  }

  if (cast.attacking &&
      (stopAttack || cast.frames === 24 || cast.state === castInfo(cast).seestate)) {
    cast.attacking = false;
    cast.frames = 0;
    cast.state = castInfo(cast).seestate;
  }

  cast.tics = states[cast.state].tics;
  if (cast.tics === -1) cast.tics = 15;
  return sound;
}

// Enters the current actor's death state and returns its death sound id.
export function F_KillCast(cast) {
  if (cast.death) return 0;
  cast.death = true;
  const info = castInfo(cast);
  cast.state = info.deathstate;
  cast.tics = states[cast.state].tics;
  cast.frames = 0;
  cast.attacking = false;
  return info.deathsound;
}
