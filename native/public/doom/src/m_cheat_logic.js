// Pure action helpers for st_stuff.c's status-bar cheats.

import { GameMode_t, powertype_t, weapontype_t } from './doomdef.js';

export function M_TogglePowerCheat(player, power, givePower) {
  if (player.powers[power] === 0) {
    givePower(player, power);
  } else if (power !== powertype_t.pw_strength) {
    player.powers[power] = 1;
  } else {
    player.powers[power] = 0;
  }
}

export function M_ApplyChoppersCheat(player) {
  player.weaponowned[weapontype_t.wp_chainsaw] = true;
  player.powers[powertype_t.pw_invulnerability] = 1;
}

export function M_PlayerPositionMessage(mobj) {
  return `ang=0x${(mobj.angle >>> 0).toString(16)};` +
    `x,y=(0x${(mobj.x >>> 0).toString(16)},0x${(mobj.y >>> 0).toString(16)})`;
}

export function M_ParseClev(gamemode, firstChar, secondChar) {
  const first = firstChar - 0x30;
  const second = secondChar - 0x30;
  if (first < 0 || first > 9 || second < 0 || second > 9) return null;

  let episode;
  let map;
  if (gamemode === GameMode_t.commercial) {
    // The released Doom II behavior accepts MAP01-MAP34. Linuxdoom's checked-in
    // source assigns episode 0 and then accidentally rejects it; normalize the
    // unused episode field to 1 so the intended commercial path remains usable.
    episode = 1;
    map = first * 10 + second;
  } else {
    episode = first;
    map = second;
  }

  if (episode < 1 || map < 1) return null;
  if (gamemode === GameMode_t.retail && (episode > 4 || map > 9)) return null;
  if (gamemode === GameMode_t.registered && (episode > 3 || map > 9)) return null;
  if (gamemode === GameMode_t.shareware && (episode > 1 || map > 9)) return null;
  if (gamemode === GameMode_t.commercial && map > 34) return null;
  return { episode, map };
}
